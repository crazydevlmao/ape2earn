// /worker/bananaWorker.ts
/* Node 18+ runtime */

import {
  Connection,
  PublicKey,
  Keypair,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createBurnCheckedInstruction,
} from "@solana/spl-token";
import bs58 from "bs58";

/* ================= CONFIG ================= */
const CYCLE_SECONDS = 60;

const TRACKED_MINT = process.env.TRACKED_MINT || "";
const REWARD_WALLET = process.env.REWARD_WALLET || "";
const DEV_WALLET_PRIVATE_KEY = process.env.DEV_WALLET_PRIVATE_KEY || "";

const HELIUS_RPC =
  process.env.HELIUS_RPC ||
  `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY || ""}`;
const QUICKNODE_RPC = process.env.QUICKNODE_RPC || ""; // optional

// PumpPortal for claiming
const PUMPORTAL_KEY = (process.env.PUMPORTAL_KEY || "").trim();
const PUMPORTAL_BASE = "https://pumpportal.fun";

/* ===== guards ===== */
if (!TRACKED_MINT || !REWARD_WALLET || !DEV_WALLET_PRIVATE_KEY) {
  throw new Error("Missing TRACKED_MINT, REWARD_WALLET, or DEV_WALLET_PRIVATE_KEY");
}
if (!HELIUS_RPC) throw new Error("Missing HELIUS_RPC / HELIUS_API_KEY");
if (!PUMPORTAL_KEY) console.warn("[WARN] No PumpPortal key set. Claiming will be skipped.");

/* ================= Connection / Keys ================= */
const RPCS = [HELIUS_RPC, QUICKNODE_RPC].filter(Boolean);
let rpcIdx = 0;
function newConnection(): Connection { return new Connection(RPCS[rpcIdx]!, "confirmed"); }
function rotateConnection(): Connection {
  rpcIdx = (rpcIdx + 1) % RPCS.length;
  return new Connection(RPCS[rpcIdx]!, "confirmed");
}
let connection = newConnection();

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
    `[WARN] REWARD_WALLET (${REWARD_WALLET}) != DEV wallet (${devWallet.publicKey.toBase58()}).`
  );
}

/* ================= Utils ================= */
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
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

/* ================= Simple chain helpers ================= */
async function getSolBalance(conn: Connection, pubkey: PublicKey, comm: "confirmed" | "finalized" = "confirmed") {
  return (await conn.getBalance(pubkey, comm)) / LAMPORTS_PER_SOL;
}
async function pollSolDelta(conn: Connection, owner: PublicKey, preSol: number) {
  for (let i = 0; i < 18; i++) {
    const b = await getSolBalance(conn, owner);
    const d = Math.max(0, b - preSol);
    if (d > 0) return { postSol: b, deltaSol: d };
    await sleep(900);
  }
  const b = await getSolBalance(conn, owner);
  return { postSol: b, deltaSol: Math.max(0, b - preSol) };
}
async function getMintDecimals(mintPk: PublicKey): Promise<number> {
  const info = await withConnRetries(c => c.getParsedAccountInfo(mintPk, "confirmed")) as any;
  const dec = info?.value?.data?.parsed?.info?.decimals;
  if (typeof dec !== "number") throw new Error("Unable to fetch mint decimals");
  return dec;
}
async function getTokenBalanceUi(owner: PublicKey, mint: PublicKey) {
  const resp = await withConnRetries(c => c.getParsedTokenAccountsByOwner(owner, { mint }, "confirmed")) as any;
  let total = 0;
  for (const it of resp.value as any[]) {
    const parsed: any = (it.account.data as any)?.parsed?.info?.tokenAmount;
    const v = typeof parsed?.uiAmount === "number" ? parsed.uiAmount : Number(parsed?.uiAmountString ?? 0);
    total += v || 0;
  }
  return total;
}

/* ================= PumpPortal (claim) ================= */
function portalUrl(path: string) {
  const u = new URL(path, PUMPORTAL_BASE);
  if (PUMPORTAL_KEY && !u.searchParams.has("api-key")) u.searchParams.set("api-key", PUMPORTAL_KEY);
  return u.toString();
}
async function callPumportal(path: string, body: any, idemKey: string) {
  const url = portalUrl(path);
  const res = await fetch(url, {
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
  return { res, json };
}
function extractSig(j: any): string | null {
  return j?.signature || j?.tx || j?.txid || j?.txId || j?.result || j?.sig || null;
}

/* ================= Jupiter (Ultra first, Legacy fallback) ================= */
function abortableFetch(url: string, init: RequestInit = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

// Ultra /order (POST) – requires `taker`. If Ultra can’t produce a transaction, fall back to Legacy v6 /quote.
async function jupQuoteSolToToken(outMint: string, solUiAmount: number, slippageBps: number): Promise<any> {
  const inputMint = "So11111111111111111111111111111111111111112";
  const amountLamports = Math.max(1, Math.floor(solUiAmount * LAMPORTS_PER_SOL));
  const taker = devWallet.publicKey.toBase58();

  // For tiny trades Ultra often returns no tx — use Legacy directly to reduce noise.
  if (amountLamports < 5_000_000) {
    return await legacyQuote(inputMint, outMint, amountLamports, slippageBps);
  }

  const bases = ["https://lite-api.jup.ag", "https://api.jup.ag"];
  let lastErr: any = null;

  for (const base of bases) {
    try {
      const body = { inputMint, outputMint: outMint, amount: amountLamports, slippageBps, taker };
      const orderResp = await withRetries(async () => {
        const r = await abortableFetch(`${base}/ultra/v1/order`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json" },
          body: JSON.stringify(body),
        }, 12000);

        if (!r.ok) {
          const txt = await r.text().catch(() => "");
          throw new Error(`Ultra /order HTTP ${r.status} ${txt}`);
        }

        const j = await r.json();
        const txB64 = j?.transaction;
        const reqId = j?.requestId;
        if (!txB64 || typeof txB64 !== "string" || txB64.length === 0 || !reqId) {
          throw new Error("Ultra /order missing transaction/requestId");
        }
        j._ultraBase = base;
        return j;
      }, 3, 400);

      return orderResp;
    } catch (e) {
      lastErr = e;
      // try next base
    }
  }

  // Ultra couldn't produce a transaction — use Legacy v6 quote
  return await legacyQuote(inputMint, outMint, amountLamports, slippageBps);

  async function legacyQuote(inputMint: string, outputMint: string, amountLamports: number, slippageBps: number) {
    const url =
      "https://quote-api.jup.ag/v6/quote" +
      `?inputMint=${inputMint}` +
      `&outputMint=${outputMint}` +
      `&amount=${amountLamports}` +
      `&slippageBps=${slippageBps}` +
      `&enableDexes=pump,meteora,raydium` +
      `&onlyDirectRoutes=false`;

    const q = await withRetries(async () => {
      const r = await abortableFetch(url, { method: "GET", headers: { "Accept": "application/json" } }, 10000);
      if (!r.ok) throw new Error(`Legacy /quote HTTP ${r.status}`);
      const j = await r.json();
      if (!j?.routePlan?.length) throw new Error("Legacy /quote returned no routePlan");
      j._legacy = true;
      return j;
    }, 3, 400);

    return q;
  }
}

// Ultra /execute (POST) if Ultra order was used; otherwise Legacy /swap.
// If Ultra execute fails with 401/5xx on one base, retry on the other base using the same signed tx.
async function jupSwap(conn: Connection, signer: Keypair, quoteOrOrderResp: any) {
  // Ultra path
  if (quoteOrOrderResp?.transaction && quoteOrOrderResp?.requestId) {
    const txBytes = Uint8Array.from(Buffer.from(quoteOrOrderResp.transaction, "base64"));
    const tx = VersionedTransaction.deserialize(txBytes);
    tx.sign([signer]);
    const signedBase64 = Buffer.from(tx.serialize()).toString("base64");
    const requestId = String(quoteOrOrderResp.requestId);

    const bases = ["https://lite-api.jup.ag", "https://api.jup.ag"];
    const preferredFirst =
      quoteOrOrderResp._ultraBase && bases.includes(quoteOrOrderResp._ultraBase)
        ? [quoteOrOrderResp._ultraBase, ...bases.filter(b => b !== quoteOrOrderResp._ultraBase)]
        : bases;

    let lastErr: any = null;
    for (const base of preferredFirst) {
      try {
        const sig = await withRetries(async () => {
          const r = await abortableFetch(`${base}/ultra/v1/execute`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            body: JSON.stringify({ signedTransaction: signedBase64, requestId }),
          }, 15000);

          if (!r.ok) {
            const txt = await r.text().catch(() => "");
            throw new Error(`Ultra /execute HTTP ${r.status} ${txt}`);
          }

          const j = await r.json();
          const signature = j?.signature || j?.txid || j?.txId || null;
          if (!signature) throw new Error(`Ultra /execute no signature: ${JSON.stringify(j)}`);

          await conn.confirmTransaction(signature, "confirmed");
          return signature;
        }, 3, 500);

        return sig;
      } catch (e) {
        lastErr = e;
        // loop tries other base once
      }
    }
    throw lastErr;
  }

  // Legacy path
  if (quoteOrOrderResp?._legacy && quoteOrOrderResp?.routePlan?.length) {
    const JUP_SWAP = "https://quote-api.jup.ag/v6/swap";
    const swapReq = {
      quoteResponse: quoteOrOrderResp,
      userPublicKey: signer.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    };

    const signature = await withRetries(async () => {
      const r = await abortableFetch(JUP_SWAP, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(swapReq),
      }, 15000);

      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        throw new Error(`Legacy /swap HTTP ${r.status} ${txt}`);
      }

      const { swapTransaction } = await r.json();
      const txBytes = Uint8Array.from(Buffer.from(swapTransaction, "base64"));
      const tx = VersionedTransaction.deserialize(txBytes);
      tx.sign([signer]);
      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
      await conn.confirmTransaction(sig, "confirmed");
      return sig;
    }, 3, 500);

    return signature;
  }

  throw new Error("Invalid Jupiter response: neither Ultra nor Legacy paths were usable");
}

/* ================= Core ops ================= */
async function claimCreatorRewards(): Promise<{ claimedSol: number, claimSig: string | null }> {
  if (!PUMPORTAL_KEY) return { claimedSol: 0, claimSig: null };

  const preSol = await getSolBalance(connection, devWallet.publicKey);

  const { res, json } = await withRetries(
    () => callPumportal(
      "/api/trade",
      { action: "collectCreatorFee", priorityFee: 0.000001, pool: "pump", mint: TRACKED_MINT },
      `claim:${Date.now()}`
    ),
    5
  );
  if (!res.ok) throw new Error(`Claim failed: ${JSON.stringify(json)}`);

  const claimSig = extractSig(json);
  const { deltaSol } = await pollSolDelta(connection, devWallet.publicKey, preSol);
  const claimedSol = Math.max(0, deltaSol);

  console.log(`[CLAIM] Claimed ~${claimedSol} SOL | ${claimSig ? `https://solscan.io/tx/${claimSig}` : "(no sig)"}`);
  return { claimedSol, claimSig };
}

async function swapSolToCA(solToSpend: number): Promise<string | null> {
  if (solToSpend <= 0) return null;
  const currentSol = await getSolBalance(connection, devWallet.publicKey);
  const reserve = 0.02;
  const maxSpend = Math.max(0, currentSol - reserve);
  const target = Math.min(solToSpend, maxSpend);
  if (target <= 0.00001) {
    console.log(`[SWAP] Skipped. target=${target}, balance=${currentSol}`);
    return null;
  }

  const SLIPPAGES_BPS = [100, 200, 500];
  let lastErr: any = null;
  for (const s of SLIPPAGES_BPS) {
    try {
      const quoteOrOrder = await jupQuoteSolToToken(TRACKED_MINT, target, s);
      const sig = await jupSwap(connection, devWallet, quoteOrOrder);
      console.log(`[SWAP] Spent ${target} SOL @${s}bps | https://solscan.io/tx/${sig}`);
      return sig;
    } catch (e) {
      lastErr = e;
      console.warn(`[SWAP] attempt failed @${s}bps:`, String(e));
      await sleep(700);
    }
  }
  console.error("[SWAP] Jupiter failed after retries:", String(lastErr?.message || lastErr));
  return null;
}

async function burnAllCA(): Promise<string | null> {
  const decimals = await getMintDecimals(mintPubkey);
  const caBalanceUi = await getTokenBalanceUi(devWallet.publicKey, mintPubkey);
  if (!(caBalanceUi > 0)) {
    console.log("[BURN] No CA balance to burn.");
    return null;
  }

  const factor = 10 ** decimals;
  const amountBase = BigInt(Math.floor(caBalanceUi * factor));

  const ata = getAssociatedTokenAddressSync(mintPubkey, devWallet.publicKey, false);
  const ixs = [
    createAssociatedTokenAccountIdempotentInstruction(
      devWallet.publicKey, ata, devWallet.publicKey, mintPubkey
    ),
    createBurnCheckedInstruction(
      ata, mintPubkey, devWallet.publicKey, amountBase, decimals
    ),
  ];

  const { blockhash } = await withConnRetries(c => c.getLatestBlockhash("finalized"));
  const tx = new (await import("@solana/web3.js")).Transaction().add(...ixs);
  tx.feePayer = devWallet.publicKey;
  tx.recentBlockhash = blockhash;

  const sig = await connection.sendTransaction(tx, [devWallet], { skipPreflight: false, maxRetries: 3 });
  await connection.confirmTransaction(sig, "confirmed");

  console.log(`[BURN] Burned ${caBalanceUi} CA | https://solscan.io/tx/${sig}`);
  return sig;
}

/* ================= Main loop ================= */
async function cycleOnce() {
  try {
    const { claimedSol } = await claimCreatorRewards();
    const spend = Number((claimedSol * 0.70).toFixed(6));
    if (spend > 0) await swapSolToCA(spend);
    else console.log("[SWAP] Nothing to spend from claim.");
    await burnAllCA();
  } catch (e) {
    console.error("[CYCLE ERROR]", e);
  }
}

async function loop() {
  while (true) {
    const t0 = Date.now();
    await cycleOnce();
    const elapsed = Date.now() - t0;
    const sleepMs = Math.max(0, CYCLE_SECONDS * 1000 - elapsed);
    await sleep(sleepMs);
  }
}

loop().catch((err) => {
  console.error("worker crashed:", err);
  process.exit(1);
});
