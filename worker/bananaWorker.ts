// /worker/bananaWorker.ts
/* Node 18+ runtime (long-lived process) — no node-fetch needed */

const CYCLE_MINUTES = 5;

const TRACKED_MINT  = process.env.TRACKED_MINT  || "BCtJf5K5NVqCgksEb9rervX6Eae17NDZ8BSdGSoEpump";
const REWARD_WALLET = process.env.REWARD_WALLET || "2dPD6abjP5YrjFo3T53Uf82EuV6XFJLAZaq5KDEnvqC7";
const TOKENS_PER_APE = Number(process.env.TOKENS_PER_APE || 100_000);

// auto-blacklist any holder above this BANANA balance (default: 50,000,000)
const AUTO_BLACKLIST_BALANCE = Number(process.env.AUTO_BLACKLIST_BALANCE ?? 50_000_000);

const HELIUS_RPC =
  process.env.HELIUS_RPC ||
  `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY || ""}`;

const ADMIN_SECRET  = process.env.ADMIN_SECRET || "";
const ADMIN_OPS_URL = process.env.ADMIN_OPS_URL || "https://<your-domain>/api/admin/ops";

const PUMPORTAL_URL = process.env.PUMPORTAL_URL || ""; // e.g. https://api.pumportal.xyz
const PUMPORTAL_KEY = process.env.PUMPORTAL_KEY || ""; // Bearer key

// --- sanity checks (fail fast) ---
if (!HELIUS_RPC) throw new Error("Missing HELIUS_RPC / HELIUS_API_KEY");
if (!PUMPORTAL_URL || !PUMPORTAL_KEY) {
  console.warn("[bananaWorker] PUMPORTAL creds missing — claim/swap/airdrop will no-op.");
}
if (!ADMIN_SECRET || !ADMIN_OPS_URL) {
  console.warn("[bananaWorker] Admin ops wiring missing — UI ops readout will be empty.");
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
class RetryableError extends Error {}

// ---------------- Idempotent Pumportal helper ----------------
function jitter(ms: number) { return ms + Math.floor(Math.random() * 200); }
function isRetryableStatus(status: number) { return status === 429 || status >= 500; }
function looksTransient(msg: string) {
  return /rate ?limit|timeout|temporar(?:ily)? unavailable|gateway|network|ECONNRESET|ETIMEDOUT/i.test(msg);
}

/**
 * POST to Pumportal with:
 *  - Idempotency-Key header (required for safe retries)
 *  - up to `attempts` retries with backoff on 429/5xx or transient errors
 */
async function callPumportal<T>(
  path: string,
  body: any,
  idemKey: string,
  attempts = 3
): Promise<{ res: Response; json: T | any }> {
  if (!PUMPORTAL_URL || !PUMPORTAL_KEY) throw new Error("Missing Pumportal creds");
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
      const text = await res.text();
      let json: any = {};
      try { json = text ? JSON.parse(text) : {}; } catch {}
      if (res.ok) return { res, json };

      const msg = String(json?.message || json?.error || `HTTP ${res.status}`);
      if (isRetryableStatus(res.status) || looksTransient(msg)) {
        await sleep(jitter(500 * (i + 1)));
        continue;
      }
      throw new Error(msg);
    } catch (e: any) {
      lastErr = e;
      await sleep(jitter(500 * (i + 1)));
    }
  }
  throw lastErr;
}

// ---- JSON-RPC to Helius ----
async function rpc(method: string, params: any[], attempts = 6): Promise<any> {
  let last: any;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(HELIUS_RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
      });
      const txt = await res.text();
      const json = txt ? JSON.parse(txt) : {};
      if (!res.ok || json?.error) {
        const msg = json?.error?.message || `HTTP ${res.status}`;
        if (res.status === 429 || res.status >= 500 || /rate ?limit|too many/i.test(msg)) {
          throw new RetryableError(msg);
        }
        throw new Error(msg);
      }
      return json;
    } catch (e) {
      last = e;
      if (!(e instanceof RetryableError) || i === attempts - 1) break;
      await sleep(300 * (i + 1) + Math.random() * 200);
    }
  }
  throw last;
}

const coerce = (j: any) =>
  Array.isArray(j?.result) ? j.result : (Array.isArray(j?.result?.value) ? j.result.value : []);

// ---- cycle timing helpers ----
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

// ---- chain helpers ----
async function getHoldersAll(mint: string) {
  async function scan(pid: string, with165: boolean) {
    const filters: any[] = [{ memcmp: { offset: 0, bytes: mint } }];
    if (with165) filters.unshift({ dataSize: 165 });
    const j = await rpc("getProgramAccounts", [
      pid,
      { encoding: "jsonParsed", commitment: "confirmed", filters },
    ]);
    const list = coerce(j);
    const out: Record<string, number> = {};
    for (const it of list) {
      const info = it?.account?.data?.parsed?.info;
      const owner = info?.owner;
      const amt = Number(info?.tokenAmount?.uiAmount ?? 0);
      if (!owner || !(amt > 0)) continue;
      out[owner] = (out[owner] ?? 0) + amt;
    }
    return out;
  }
  let merged: Record<string, number> = {};
  try {
    const a = await scan("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", true);
    for (const [k, v] of Object.entries(a)) merged[k] = (merged[k] ?? 0) + Number(v);
  } catch {}
  try {
    const b = await scan("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCx2w6G3W", false);
    for (const [k, v] of Object.entries(b)) merged[k] = (merged[k] ?? 0) + Number(v);
  } catch {}
  return Object.entries(merged)
    .map(([wallet, balance]) => ({ wallet, balance: Number(balance) }))
    .filter((r) => r.balance > 0);
}

async function rewardPoolBalance(mint: string, owner: string) {
  const j = await rpc("getTokenAccountsByOwner", [
    owner,
    { mint },
    { encoding: "jsonParsed", commitment: "confirmed" },
  ]);
  let total = 0;
  for (const it of coerce(j)) {
    const ta = it?.account?.data?.parsed?.info?.tokenAmount;
    const v = typeof ta?.uiAmount === "number" ? ta.uiAmount : Number(ta?.uiAmountString ?? 0);
    if (Number.isFinite(v)) total += v;
  }
  return total;
}

// ---- admin ops recording (for UI readout) ----
async function recordOps(partial: { lastClaim?: any; lastSwap?: any }) {
  if (!ADMIN_SECRET || !ADMIN_OPS_URL) return;
  try {
    await fetch(ADMIN_OPS_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-secret": ADMIN_SECRET },
      body: JSON.stringify(partial),
    });
  } catch {}
}

// ---- T-1m: claim + swap 90% into BANANA ----
async function triggerClaimAndSwap90() {
  if (!PUMPORTAL_URL || !PUMPORTAL_KEY) return { ok: false, reason: "no pumportal creds" };

  const cycleId = String(floorCycleStart().getTime());

  // 1. Claim creator rewards
  const { res: claimRes, json: claimJson } = await callPumportal(
    "/api/trade",
    {
      action: "collectCreatorFee",
      mint: TRACKED_MINT,
      pool: "pump",
      priorityFee: 0.000001,
    },
    `claim:${cycleId}`,
    3
  );

  if (!claimRes.ok) throw new Error(`Claim failed: ${JSON.stringify(claimJson)}`);

  const claimed = Number(claimJson?.claimedAmount ?? 0);
  const claimTx = claimJson?.txid || null;

  let swapped = 0;
  let swapTx: string | null = null;

  // 2. Swap 90% of claimed SOL into BANANA
  if (claimed > 0) {
    const { res: swapRes, json: swapJson } = await callPumportal(
      "/api/trade",
      {
        action: "swap",
        mint: TRACKED_MINT,
        inAmount: claimed * 0.9,
        priorityFee: 0.000001,
        pool: "pump",
      },
      `swap:${cycleId}`,
      3
    );

    if (!swapRes.ok) throw new Error(`Swap failed: ${JSON.stringify(swapJson)}`);

    swapped = Number(swapJson?.outAmount ?? 0);
    swapTx = swapJson?.txid || null;
  }

  const now = new Date().toISOString();

  // 3. Record ops for UI
  await recordOps({
    lastClaim: { at: now, amount: claimed, tx: claimTx },
    lastSwap:  { at: now, amount: swapped, tx: swapTx },
  });

  return { ok: true, claimed, swapped, claimTx, swapTx };
}


// ---- T-10s: snapshot + distribute by APE (skip missing ATAs) ----
async function snapshotAndDistribute() {
  if (!PUMPORTAL_URL || !PUMPORTAL_KEY) return { ok: false, reason: "no pumportal creds" };

  // 1) Snapshot holders
  const holdersRaw = await getHoldersAll(TRACKED_MINT);

  // --- AUTO BLACKLIST by balance (> threshold) ---
  const holders = holdersRaw.filter(h => Number(h.balance) <= AUTO_BLACKLIST_BALANCE);

  const rows = holders
    .map((h) => ({ wallet: h.wallet, apes: apes(h.balance) }))
    .filter((r) => r.apes > 0);

  const totalApes = rows.reduce((a, r) => a + r.apes, 0);
  if (totalApes <= 0) return { ok: false, reason: "no apes" };

  // 2) Compute per-APE from current pool
  const pool = await rewardPoolBalance(TRACKED_MINT, REWARD_WALLET);
  const perApe = Math.floor(pool / totalApes);
  if (!(pool > 0) || perApe <= 0) {
    return { ok: false, reason: "pool empty or per-ape too small", pool, totalApes };
  }

  const distributions = rows
    .map((r) => ({ wallet: r.wallet, amount: perApe * r.apes }))
    .filter((x) => x.amount > 0);

  // 3) Airdrop to ATAs only (idempotent per cycle)
  const cycleId = String(floorCycleStart().getTime());
  const { res, json } = await callPumportal(
    "/v1/airdrop/spl",
    {
      mint: TRACKED_MINT,
      fromWallet: REWARD_WALLET,
      distributions,
      priorityFee: "auto",
      skipMissingAta: true,
    },
    `airdrop:${cycleId}`,
    3
  );

  return { ok: res.ok, count: distributions.length, perApe, json };
}

// ---- main loop (self-scheduling worker) ----
async function loop() {
  const fired = new Set<string>(); // de-dup within cycle
  for (;;) {
    const { id, end, tMinus60, tMinus10 } = nextTimes();
    const now = new Date();

    if (!fired.has(id + ":claim") && now >= tMinus60) {
      try { await triggerClaimAndSwap90(); } catch { /* continue */ }
      fired.add(id + ":claim");
    }

    if (!fired.has(id + ":dist") && now >= tMinus10) {
      try { await snapshotAndDistribute(); } catch { /* continue */ }
      fired.add(id + ":dist");
    }

    if (now >= end) {
      fired.clear(); // new cycle
    }

    await sleep(1000);
  }
}

loop().catch((err) => {
  console.error("bananaWorker crashed:", err);
  process.exit(1);
});

