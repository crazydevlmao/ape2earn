// /worker/bananaWorker.ts
/* Node 18+ runtime (long-lived process) */

import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  VersionedTransaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
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

// === PumpPortal (claim only) ===
const PUMP_HOST = "pumpportal.fun";
const RAW_PUMPORTAL_URL = (process.env.PUMPORTAL_URL || "").trim().replace(/\/+$/, "");
let PUMPORTAL_BASE: string;
try {
  const u = RAW_PUMPORTAL_URL ? new URL(RAW_PUMPORTAL_URL) : new URL(`https://${PUMP_HOST}`);
  u.hostname = PUMP_HOST; // normalize host
  PUMPORTAL_BASE = u.origin; // https://pumpportal.fun
} catch {
  PUMPORTAL_BASE = `https://${PUMP_HOST}`;
}
const PUMPORTAL_KEY = (process.env.PUMPORTAL_KEY || "").trim();
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
const SOL_MINT = "So11111111111111111111111111111111111111112";

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

// Signature extractor (PumpPortal)
function extractSig(j: any): string | null {
  return j?.signature || j?.tx || j?.txid || j?.txId || j?.result || j?.sig || null;
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

// ================= PumpPortal (claim) =================
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
      authorization: `Bearer ${PUMPORTAL_KEY}`,     // tolerated; main auth is ?api-key
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

// ================= Jupiter swap helpers (with adaptive retries) =================
async function jupQuoteSOLtoMint(
  outMint: string,
  lamportsIn: number,
  slippageBps = 1000,
) {
  const u = new URL("https://quote-api.jup.ag/v6/quote");
  u.searchParams.set("inputMint", SOL_MINT);
  u.searchParams.set("outputMint", outMint);
  u.searchParams.set("amount", String(lamportsIn));     // SOL in lamports
  u.searchParams.set("swapMode", "ExactIn");
  u.searchParams.set("slippageBps", String(slippageBps));
  u.searchParams.set("onlyDirectRoutes", "false");
  u.searchParams.set("asLegacyTransaction", "false");
  const res = await fetch(u.toString());
  const j = await res.json();
  if (!res.ok || j.error) throw new Error("Jupiter quote failed: " + (j.error || res.statusText));
  return j;
}

async function jupBuildSwap(quoteResponse: any, userPubkey: string) {
  const res = await fetch("https://api.jup.ag/swap/v1/swap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: userPubkey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      dynamicSlippage: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: { priorityLevel: "veryHigh", maxLamports: 1_500_000 },
      },
    }),
  });
  const j = await res.json();
  if (!res.ok || j.error) throw new Error("Jupiter swap build failed: " + (j.error || res.statusText));
  return j;
}

async function jupSendSignedSwap(swapTxB64: string) {
  const vtx = VersionedTransaction.deserialize(Buffer.from(swapTxB64, "base64"));
  vtx.sign([devWallet]);
  const sig = await withConnRetries(c => c.sendRawTransaction(vtx.serialize(), { skipPreflight: false, maxRetries: 3 }));
  try {
    const latest = await withConnRetries(c => c.getLatestBlockhash("finalized"));
    await withConnRetries(c => c.confirmTransaction({ signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, "confirmed"));
  } catch {}
  return sig;
}

// ONE place that performs swap with multiple re-quotes & adaptive settings
async function performJupiterSwapExactIn(outMint: string, maxLamports: number): Promise<string | null> {
  // protect against dust
  if (maxLamports < 50_000) return null;

  let attempt = 0;
  const maxAttempts = 6;
  let spendLamports = maxLamports;

  while (attempt < maxAttempts) {
    try {
      // Re-check spendable balance each attempt & keep a small reserve.
      const bal = await withConnRetries(c => c.getBalance(devWallet.publicKey, "confirmed"));
      const reserve = Math.floor(0.005 * LAMPORTS_PER_SOL);
      const capByBal = Math.max(0, Math.floor(bal * 0.9) - reserve);
      spendLamports = Math.min(spendLamports, capByBal);
      if (spendLamports < 50_000) return null;

      // Adaptive slippage & amount trim per attempt.
      const slippageBps = Math.min(1000 + attempt * 500, 4000); // 10% → 40% max for wild volatility
      const trimmed = Math.floor(spendLamports * (1 - attempt * 0.03)); // trim 3% per retry
      const toSpend = Math.max(trimmed, 50_000);

      const quote = await jupQuoteSOLtoMint(outMint, toSpend, slippageBps);
      const built = await jupBuildSwap(quote, devWallet.publicKey.toBase58());
      const sig = await jupSendSignedSwap(built.swapTransaction);
      return sig;
    } catch (e: any) {
      attempt++;
      if (attempt >= maxAttempts) throw e;
      await sleep(350 * attempt + Math.floor(Math.random() * 200));
    }
  }
  return null;
}

// ================= Claim + Swap (T-60s) =================
async function triggerClaimAndSwap90() {
  const cycleId = String(floorCycleStart().getTime());
  if (!PUMPORTAL_BASE || !PUMPORTAL_KEY) {
    console.warn("[CLAIM] Skipping claim; no PumpPortal creds.");
    return { claimed: 0, swapSig: null, claimSig: null };
  }

  // 1) Claim via PumpPortal (with retries)
  const { res: claimRes, json: claimJson } = await withRetries(
    () => callPumportal(
      "/api/trade",
      { action: "collectCreatorFee", priorityFee: 0.000001, pool: "pump", mint: TRACKED_MINT },
      `claim:${cycleId}`
    ),
    5
  );
  if (!claimRes.ok) throw new Error(`Claim failed: ${JSON.stringify(claimJson)}`);

  const claimSig = extractSig(claimJson);
  const claimed = Number(claimJson?.claimedAmount ?? 0);
  const claimUrl = claimSig ? `https://solscan.io/tx/${claimSig}` : null;
  console.log(`[CLAIM] ${claimed} SOL | ${claimUrl ?? "(no sig)"}`);

  // 2) Swap 90% of claimed SOL → TRACKED_MINT via Jupiter (adaptive retries)
  let swapSig: string | null = null;
  const balLamports = await withConnRetries(c => c.getBalance(devWallet.publicKey, "confirmed"));
  const reserveLamports = Math.floor(0.005 * LAMPORTS_PER_SOL); // keep ~0.005 SOL for fees
  const maxSpendByBal = Math.max(0, Math.floor(balLamports * 0.9) - reserveLamports);
  const maxSpendByClaim = Math.max(0, Math.floor(claimed * 0.9 * LAMPORTS_PER_SOL));
  const spendLamports = Math.min(maxSpendByBal, maxSpendByClaim);

  if (spendLamports >= 50_000) {
    swapSig = await performJupiterSwapExactIn(TRACKED_MINT, spendLamports);
    if (swapSig) {
      console.log(`[SWAP] ${(spendLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL → https://solscan.io/tx/${swapSig}`);
    } else {
      console.log("[SWAP] Skipped (insufficient after retries).");
    }
  } else {
    console.log("[SWAP] Skipped (spend too small).");
  }

  const now = new Date().toISOString();
  await recordOps({
    lastClaim: { at: now, amount: claimed, tx: claimSig, url: claimUrl },
    lastSwap:  { at: now, amount: null,  tx: swapSig,  url: swapSig ? `https://solscan.io/tx/${swapSig}` : null },
  });

  return { claimed, swapSig, claimSig };
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
    console.log(`[SNAPSHOT] Excluded ${excluded.length} wallets > ${AUTO_BLACKLIST_BALANCE}`);
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
