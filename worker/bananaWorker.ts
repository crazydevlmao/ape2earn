// /worker/bananaWorker.ts
/* Node 18+ runtime (long-lived process) */

import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
} from "@solana/spl-token";
import bs58 from "bs58";

// ================= CONFIG =================
const CYCLE_MINUTES = 5;

const TRACKED_MINT = process.env.TRACKED_MINT || "";
const REWARD_WALLET = process.env.REWARD_WALLET || ""; // should match dev wallet pubkey
const DEV_WALLET_PRIVATE_KEY = process.env.DEV_WALLET_PRIVATE_KEY || "";
const TOKENS_PER_APE = Number(process.env.TOKENS_PER_APE || 100_000);
const AUTO_BLACKLIST_BALANCE = Number(process.env.AUTO_BLACKLIST_BALANCE ?? 50_000_000);

const HELIUS_RPC =
  process.env.HELIUS_RPC ||
  `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY || ""}`;
const QUICKNODE_RPC = process.env.QUICKNODE_RPC || ""; // optional failover

// === PumpPortal config (bulletproof) ===
const PUMP_HOST = "pumpportal.fun";
const RAW_PUMPORTAL_URL = (process.env.PUMPORTAL_URL || "").trim().replace(/\/+$/, "");
let PUMPORTAL_BASE: string;
try {
  const u = RAW_PUMPORTAL_URL ? new URL(RAW_PUMPORTAL_URL) : new URL(`https://${PUMP_HOST}`);
  u.hostname = PUMP_HOST; // force correct host even if env is wrong
  PUMPORTAL_BASE = u.origin;
} catch {
  PUMPORTAL_BASE = `https://${PUMP_HOST}`;
}
const PUMPORTAL_KEY = (process.env.PUMPORTAL_KEY || "").trim();
const PUMPORTAL_WALLET = (process.env.PUMPORTAL_WALLET || "").trim(); // optional: Lightning wallet pubkey (for logging)
console.log("[CONFIG] PumpPortal base:", PUMPORTAL_BASE);

const ADMIN_SECRET  = process.env.ADMIN_SECRET || "";
const ADMIN_OPS_URL = process.env.ADMIN_OPS_URL || "";

if (!TRACKED_MINT || !REWARD_WALLET || !DEV_WALLET_PRIVATE_KEY) {
  throw new Error("Missing TRACKED_MINT, REWARD_WALLET, or DEV_WALLET_PRIVATE_KEY");
}
if (!HELIUS_RPC) throw new Error("Missing HELIUS_RPC / HELIUS_API_KEY");

// ================= Connection / Keys =================
const RPCS = [HELIUS_RPC, QUICKNODE_RPC].filter(Boolean);
let rpcIdx = 0;
function newConnection(): Connection { return new Connection(RPCS[rpcIdx]!, "confirmed"); }
function rotateConnection(): Connection { rpcIdx = (rpcIdx + 1) % RPCS.length; return new Connection(RPCS[rpcIdx]!, "confirmed"); }
let connection = newConnection();

// accept JSON array secret or bs58
function toKeypair(secret: string): Keypair {
  try {
    const arr = JSON.parse(secret);
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  } catch {
    return Keypair.fromSecretKey(bs58.decode(secret));
  }
}
const devWallet = toKeypair(DEV_WALLET_PRIVATE_KEY);
const mintPubkey = new PublicKey(TRACKED_MINT);

if (REWARD_WALLET !== devWallet.publicKey.toBase58()) {
  console.warn(
    `[WARN] REWARD_WALLET (${REWARD_WALLET}) != DEV wallet (${devWallet.publicKey.toBase58()}). Airdrop spends from DEV wallet ATA.`
  );
}

// ================= Small Utils =================
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function floorCycleStart(d = new Date()) {
  const w = CYCLE_MINUTES * 60_000;
  return new Date(Math.floor(d.getTime() / w) * w);
}
function nextTimes() {
  const start = floorCycleStart();
  const end   = new Date(start.getTime() + CYCLE_MINUTES * 60_000);
  return { id: String(start.getTime()), start, end, tMinus60: new Date(end.getTime() - 60_000), tMinus10: new Date(end.getTime() - 10_000) };
}
const apes = (bal: number) => Math.floor((Number(bal) || 0) / TOKENS_PER_APE);
function chunks<T>(arr: T[], size: number): T[][] { const out: T[][] = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; }
function looksRetryableMessage(msg: string) {
  return /rate.?limit|429|timeout|temporar|connection|ECONNRESET|ETIMEDOUT|blockhash|Node is behind|Transaction was not confirmed/i.test(msg);
}
async function withRetries<T>(fn: () => Promise<T>, attempts = 5, baseMs = 350): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e: any) {
      lastErr = e;
      const msg = String(e?.message || e);
      if (i === attempts - 1 || !looksRetryableMessage(msg)) break;
      const delay = baseMs * Math.pow(1.7, i) + Math.floor(Math.random() * 200);
      await sleep(delay);
    }
  }
  throw lastErr;
}
async function withConnRetries<T>(fn: (c: Connection) => Promise<T>, attempts = 5) {
  let c = connection;
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(c); }
    catch (e: any) {
      lastErr = e;
      const msg = String(e?.message || e);
      if (i === attempts - 1 || !looksRetryableMessage(msg) || RPCS.length <= 1) break;
      c = connection = rotateConnection();
      await sleep(250 * (i + 1));
    }
  }
  throw lastErr;
}

// ================= Admin ops → front page =================
async function recordOps(partial: { lastClaim?: any; lastSwap?: any; lastAirdrop?: any }) {
  if (!ADMIN_SECRET || !ADMIN_OPS_URL) return;
  try {
    await fetch(ADMIN_OPS_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-secret": ADMIN_SECRET },
      body: JSON.stringify(partial),
    });
  } catch { /* swallow */ }
}

// ================= PumpPortal helpers =================
function portalUrl(path: string) {
  const u = new URL(path, PUMPORTAL_BASE);
  if (PUMPORTAL_KEY && !u.searchParams.has("api-key")) u.searchParams.set("api-key", PUMPORTAL_KEY);
  return u.toString();
}

async function callPumportal(path: string, body: any, idemKey: string) {
  if (!PUMPORTAL_BASE || !PUMPORTAL_KEY) throw new Error("Missing PumpPortal config");
  const url = portalUrl(path);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${PUMPORTAL_KEY}`, // keep header too
      "Idempotency-Key": idemKey,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch {}
  return { res, json };
}

// ================= Chain helpers =================
async function getHoldersAll(mint: string) {
  const mintPk = new PublicKey(mint);

  async function scan(programId: string, addFilter165 = false) {
    const filters: any[] = [{ memcmp: { offset: 0, bytes: mintPk.toBase58() } }];
    if (addFilter165) filters.unshift({ dataSize: 165 });
    const accs = await withConnRetries(c =>
      c.getParsedProgramAccounts(new PublicKey(programId), { filters, commitment: "confirmed" })
    ) as any[];
    const out: Record<string, number> = {};
    for (const it of accs) {
      const info: any = it?.account?.data?.parsed?.info;
      const owner = info?.owner;
      const ta = info?.tokenAmount;
      const amt =
        typeof ta?.uiAmount === "number" ? ta.uiAmount : Number(ta?.uiAmountString ?? 0);
      if (!owner || !(amt > 0)) continue;
      out[owner] = (out[owner] ?? 0) + amt;
    }
    return out;
  }

  const merged: Record<string, number> = {};
  try { Object.entries(await scan("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", true)).forEach(([k, v]) => merged[k] = (merged[k] ?? 0) + Number(v)); } catch {}
  try { Object.entries(await scan("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCx2w6G3W", false)).forEach(([k, v]) => merged[k] = (merged[k] ?? 0) + Number(v)); } catch {}

  return Object.entries(merged).map(([wallet, balance]) => ({ wallet, balance: Number(balance) })).filter(r => r.balance > 0);
}

async function tokenBalance(owner: PublicKey) {
  const resp = await withConnRetries(c => c.getParsedTokenAccountsByOwner(owner, { mint: mintPubkey }, "confirmed")) as any;
  let total = 0;
  for (const it of resp.value as any[]) {
    const parsed: any = (it.account.data as any)?.parsed?.info?.tokenAmount;
    const v = typeof parsed?.uiAmount === "number" ? parsed.uiAmount : Number(parsed?.uiAmountString ?? 0);
    total += v || 0;
  }
  return total;
}

async function getMintDecimals(mintPk: PublicKey): Promise<number> {
  const info = await withConnRetries(c => c.getParsedAccountInfo(mintPk, "confirmed")) as any;
  const dec = info?.value?.data?.parsed?.info?.decimals;
  if (typeof dec !== "number") throw new Error("Unable to fetch mint decimals");
  return dec;
}

// helper (optional): log lightning wallet SOL
async function logPortalWalletSol() {
  if (!PUMPORTAL_WALLET) return;
  try {
    const bal = await withConnRetries(c => c.getBalance(new PublicKey(PUMPORTAL_WALLET), "confirmed"));
    console.log(`[PORTAL WALLET] ${PUMPORTAL_WALLET} SOL=${(bal/1e9).toFixed(6)}`);
  } catch {}
}

// ================= Claim + Swap (T-60s) =================
async function triggerClaimAndSwap90() {
  const cycleId = String(floorCycleStart().getTime());
  if (!PUMPORTAL_BASE || !PUMPORTAL_KEY) {
    console.warn("[CLAIM] Skipping claim/swap; no PumpPortal creds.");
    return { claimed: 0, swapped: 0, claimTx: null, swapTx: null };
  }

  // Claim (with retries)
  const { res: claimRes, json: claimJson } = await withRetries(
    () => callPumportal(
      "/api/trade",
      // NOTE: Docs say mint not strictly required for pump curve, but harmless to include.
      { action: "collectCreatorFee", mint: TRACKED_MINT, pool: "pump", priorityFee: 0.00005 },
      `claim:${cycleId}`
    ),
    5
  );
  if (!claimRes.ok) throw new Error(`Claim failed: ${JSON.stringify(claimJson)}`);

  const claimed = Number(claimJson?.claimedAmount ?? 0);
  const claimTx = claimJson?.txid || null;
  const claimUrl = claimTx ? `https://solscan.io/tx/${claimTx}` : null;
  console.log(`[CLAIM] ${claimed} SOL | ${claimUrl ?? ""}`);

  // tiny settle gap helps portal wallet update before buy
  await sleep(1500);
  await logPortalWalletSol();

  let swapped = 0;
  let swapTx: string | null = null;
  let swapUrl: string | null = null;

  if (claimed > 0) {
    const spend = Math.max(0, Number((claimed * 0.9).toFixed(6)));
    const { res: swapRes, json: swapJson } = await withRetries(
      () => callPumportal(
        "/api/trade",
        {
          action: "buy",
          mint: TRACKED_MINT,
          amount: spend,
          denominatedInSol: true,
          slippage: 10,          // a bit wider to avoid sim fails
          priorityFee: 0.00005,  // realistic tip as per docs
          pool: "pump",
        },
        `swap:${cycleId}`
      ),
      5
    );

    if (!swapRes.ok) {
      console.error("[SWAP ERROR]", swapJson); // show exact reason (eg Insufficient SOL)
      throw new Error(`Swap failed: ${JSON.stringify(swapJson)}`);
    }

    swapped = Number(swapJson?.outAmount ?? 0);
    swapTx = swapJson?.txid || null;
    swapUrl = swapTx ? `https://solscan.io/tx/${swapTx}` : null;
    console.log(`[SWAP] ~${swapped} tokens | ${swapUrl ?? ""}`);
  }

  const now = new Date().toISOString();
  await recordOps({
    lastClaim: { at: now, amount: claimed, tx: claimTx, url: claimUrl },
    lastSwap:  { at: now, amount: swapped, tx: swapTx,  url: swapUrl  },
  });

  return { claimed, swapped, claimTx, swapTx };
}

// ================= Snapshot + Airdrop (T-10s) =================
const sentCycles = new Set<string>();

async function sendAirdropBatch(ixs: any[]) {
  return await withRetries(async () => {
    const tx = new Transaction();
    for (const ix of ixs) tx.add(ix);
    tx.feePayer = devWallet.publicKey;
    const lbh = await withConnRetries(c => c.getLatestBlockhash("finalized"));
    tx.recentBlockhash = lbh.blockhash;
    return await sendAndConfirmTransaction(connection, tx, [devWallet], {
      skipPreflight: true,
      commitment: "confirmed",
    });
  }, 5);
}

async function snapshotAndDistribute() {
  const cycleId = String(floorCycleStart().getTime());
  if (sentCycles.has(cycleId)) return;

  const holdersRaw = await getHoldersAll(TRACKED_MINT);

  // Exclude > cap (default 50,000,000 UI units)
  const excluded = holdersRaw.filter(h => h.balance > AUTO_BLACKLIST_BALANCE);
  if (excluded.length > 0) {
    console.log(`[SNAPSHOT] Excluded ${excluded.length} wallets over cap ${AUTO_BLACKLIST_BALANCE}`);
  }

  const holders = holdersRaw.filter(h => h.balance <= AUTO_BLACKLIST_BALANCE);
  const rows = holders.map(h => ({ wallet: h.wallet, apes: apes(h.balance) }))
                      .filter(r => r.apes > 0);

  const totalApes = rows.reduce((a, r) => a + r.apes, 0);
  if (totalApes <= 0) { console.log(`[AIRDROP] no eligible apes`); return; }

  // 90% of available token balance in the DEV wallet
  const poolUi   = await tokenBalance(devWallet.publicKey);
  const toSendUi = Math.floor(poolUi * 0.90);
  if (!(toSendUi > 0)) { console.log(`[AIRDROP] pool empty after 90% rule`); return; }

  const perApeUi = Math.floor(toSendUi / totalApes);
  if (!(perApeUi > 0)) { console.log(`[AIRDROP] per-APE too small`); return; }

  const decimals = await getMintDecimals(mintPubkey);
  const factor = 10 ** decimals;
  const uiToBase = (x: number) => BigInt(Math.floor(x * factor));

  const fromAta = getAssociatedTokenAddressSync(mintPubkey, devWallet.publicKey, false);

  let batches = 0;
  for (const group of chunks(rows, 12)) {
    const ixs: any[] = [];
    for (const r of group) {
      const recipient = new PublicKey(r.wallet);
      const toAta = getAssociatedTokenAddressSync(mintPubkey, recipient, false);

      ixs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          devWallet.publicKey, toAta, recipient, mintPubkey
        )
      );

      const amountBase = uiToBase(perApeUi * r.apes);
      ixs.push(
        createTransferCheckedInstruction(
          fromAta, mintPubkey, toAta, devWallet.publicKey, amountBase, decimals
        )
      );
    }

    const sig = await sendAirdropBatch(ixs);
    batches++;
    console.log(`[AIRDROP] batch ${batches} (${group.length}) | per-APE=${perApeUi} | https://solscan.io/tx/${sig}`);
  }

  sentCycles.add(cycleId);

  await recordOps({
    lastAirdrop: {
      at: new Date().toISOString(),
      cycleId,
      perApeUi,
      count: rows.length,
    }
  });

  console.log(`[AIRDROP] done | wallets=${rows.length} | per-APE=${perApeUi} | cycle=${cycleId}`);
}

// ================= Main loop =================
async function loop() {
  const fired = new Set<string>();
  for (;;) {
    const { id, end, tMinus60, tMinus10 } = nextTimes();
    const now = new Date();

    if (!fired.has(id + ":claim") && now >= tMinus60) {
      try { await triggerClaimAndSwap90(); } catch (e) { console.error("Claim/swap error:", e); }
      fired.add(id + ":claim");
    }
    if (!fired.has(id + ":dist") && now >= tMinus10) {
      try { await snapshotAndDistribute(); } catch (e) { console.error("Airdrop error:", e); }
      fired.add(id + ":dist");
    }
    if (now >= end) fired.clear();

    await sleep(1000);
  }
}

loop().catch((err) => {
  console.error("bananaWorker crashed:", err);
  process.exit(1);
});
