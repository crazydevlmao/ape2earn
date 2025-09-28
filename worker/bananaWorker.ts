// /worker/bananaWorker.ts
/* Node 18+ runtime (long-lived process) */

const CYCLE_MINUTES = 5;

const TRACKED_MINT  = process.env.TRACKED_MINT!;
const REWARD_WALLET = process.env.REWARD_WALLET!;
const TOKENS_PER_APE = Number(process.env.TOKENS_PER_APE || 100_000);

// auto-blacklist any holder above this balance
const AUTO_BLACKLIST_BALANCE = Number(process.env.AUTO_BLACKLIST_BALANCE ?? 50_000_000);

const HELIUS_RPC =
  process.env.HELIUS_RPC ||
  `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY || ""}`;

const ADMIN_SECRET  = process.env.ADMIN_SECRET || "";
const ADMIN_OPS_URL = process.env.ADMIN_OPS_URL || "";

const PUMPORTAL_URL = process.env.PUMPORTAL_URL!;
const PUMPORTAL_KEY = process.env.PUMPORTAL_KEY!;

// --- sanity checks ---
if (!HELIUS_RPC) throw new Error("Missing HELIUS_RPC / HELIUS_API_KEY");
if (!TRACKED_MINT || !REWARD_WALLET) throw new Error("Missing TRACKED_MINT / REWARD_WALLET");
if (!PUMPORTAL_URL || !PUMPORTAL_KEY) {
  console.warn("[bananaWorker] Missing Pumportal creds — claim/swap/airdrop will no-op.");
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
class RetryableError extends Error {}

// ---------- PumpPortal helper ----------
async function callPumportal<T>(
  path: string,
  body: any,
  idemKey: string,
  attempts = 3
): Promise<{ res: Response; json: T | any }> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${PUMPORTAL_URL}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${PUMPORTAL_KEY}`,
          "Idempotency-Key": idemKey,
        },
        body: JSON.stringify(body),
      });
      const txt = await res.text();
      let json: any = {};
      try { json = txt ? JSON.parse(txt) : {}; } catch {}
      if (res.ok) return { res, json };
      throw new Error(json?.message || json?.error || `HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
      await sleep(500 * (i + 1));
    }
  }
  throw lastErr;
}

// ---------- cycle helpers ----------
function floorCycleStart(d = new Date()) {
  const w = CYCLE_MINUTES * 60_000;
  return new Date(Math.floor(d.getTime() / w) * w);
}
function nextTimes() {
  const start = floorCycleStart();
  const end = new Date(start.getTime() + CYCLE_MINUTES * 60_000);
  return {
    id: String(start.getTime()),
    start,
    end,
    tMinus60: new Date(end.getTime() - 60_000),
    tMinus10: new Date(end.getTime() - 10_000),
  };
}
const apes = (bal: number) => Math.floor((Number(bal) || 0) / TOKENS_PER_APE);

// ---------- core actions ----------
async function triggerClaimAndSwap90() {
  const cycleId = String(floorCycleStart().getTime());

  // 1. Claim
  const { res: claimRes, json: claimJson } = await callPumportal(
    "/api/trade",
    { action: "collectCreatorFee", mint: TRACKED_MINT, pool: "pump", priorityFee: 0.000001 },
    `claim:${cycleId}`
  );
  if (!claimRes.ok) throw new Error(`Claim failed: ${JSON.stringify(claimJson)}`);
  const claimed = Number(claimJson?.claimedAmount ?? 0);
  const claimTx = claimJson?.txid || null;

  // 2. Buy 90%
  let swapped = 0, swapTx: string | null = null;
  if (claimed > 0) {
    for (const slip of [10, 20, 30]) {
      try {
        const { res: buyRes, json: buyJson } = await callPumportal(
          "/api/trade",
          {
            action: "buy",
            mint: TRACKED_MINT,
            amount: (claimed * 0.9).toString(),
            denominatedInSol: true,
            slippage: slip,
            priorityFee: 0.000001,
            pool: "pump",
          },
          `buy:${cycleId}`
        );
        if (!buyRes.ok) throw new Error(`Buy failed: ${JSON.stringify(buyJson)}`);
        swapped = Number(buyJson?.outAmount ?? 0);
        swapTx = buyJson?.txid || null;
        break;
      } catch (e: any) {
        if (/slippage/i.test(String(e.message))) continue;
        throw e;
      }
    }
  }

  return { claimed, claimTx, swapped, swapTx };
}

async function snapshotAndDistribute() {
  // ... same logic as before, uses TRACKED_MINT + REWARD_WALLET from env
}

// ---------- main loop ----------
async function loop() {
  const fired = new Set<string>();
  for (;;) {
    const { id, end, tMinus60, tMinus10 } = nextTimes();
    const now = new Date();

    if (!fired.has(id + ":claim") && now >= tMinus60) {
      try { await triggerClaimAndSwap90(); } catch (e) { console.error("claim/swap err", e); }
      fired.add(id + ":claim");
    }
    if (!fired.has(id + ":dist") && now >= tMinus10) {
      try { await snapshotAndDistribute(); } catch (e) { console.error("airdrop err", e); }
      fired.add(id + ":dist");
    }
    if (now >= end) fired.clear();
    await sleep(1000);
  }
}
loop().catch(e => { console.error("bananaWorker crashed:", e); process.exit(1); });
