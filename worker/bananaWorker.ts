// /worker/bananaWorker.ts
/* Node 18+ runtime */

import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createTransferInstruction,
} from "@solana/spl-token";

// ================= CONFIG =================
const CYCLE_MINUTES = 5;

const TRACKED_MINT = process.env.TRACKED_MINT || "";
const REWARD_WALLET = process.env.REWARD_WALLET || "";
const DEV_WALLET_PRIVATE_KEY = process.env.DEV_WALLET_PRIVATE_KEY || "";
const TOKENS_PER_APE = Number(process.env.TOKENS_PER_APE || 100_000);
const AUTO_BLACKLIST_BALANCE = Number(process.env.AUTO_BLACKLIST_BALANCE ?? 50_000_000);

const HELIUS_RPC =
  process.env.HELIUS_RPC ||
  `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY || ""}`;

const PUMPORTAL_URL = process.env.PUMPORTAL_URL || "";
const PUMPORTAL_KEY = process.env.PUMPORTAL_KEY || "";

if (!TRACKED_MINT || !REWARD_WALLET || !DEV_WALLET_PRIVATE_KEY)
  throw new Error("Missing TRACKED_MINT, REWARD_WALLET, or DEV_WALLET_PRIVATE_KEY");

const connection = new Connection(HELIUS_RPC, "confirmed");
const devWallet = Keypair.fromSecretKey(
  Buffer.from(JSON.parse(DEV_WALLET_PRIVATE_KEY))
);
const mintPubkey = new PublicKey(TRACKED_MINT);

// ======================================================
// Helpers
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

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

// ======================================================
// PumpPortal helpers
async function callPumportal(path: string, body: any, idemKey: string) {
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
  try {
    json = text ? JSON.parse(text) : {};
  } catch {}
  return { res, json };
}

// ======================================================
// Chain helpers
async function getHoldersAll(mint: string) {
  const filters: any[] = [{ memcmp: { offset: 0, bytes: mint } }];
  const j = await connection.getProgramAccounts(
    new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    { filters, encoding: "jsonParsed", commitment: "confirmed" }
  );
  const out: Record<string, number> = {};
  for (const it of j) {
    const info = (it.account.data as any)?.parsed?.info;
    const owner = info?.owner;
    const amt = Number(info?.tokenAmount?.uiAmount ?? 0);
    if (!owner || !(amt > 0)) continue;
    out[owner] = (out[owner] ?? 0) + amt;
  }
  return Object.entries(out).map(([wallet, balance]) => ({
    wallet,
    balance,
  }));
}

async function tokenBalance(owner: PublicKey) {
  const accounts = await connection.getTokenAccountsByOwner(owner, {
    mint: mintPubkey,
  });
  let total = 0;
  for (const it of accounts.value) {
    const info: any = it.account.data;
    const parsed = info.parsed?.info?.tokenAmount;
    const v = Number(parsed?.uiAmountString ?? 0);
    total += v;
  }
  return total;
}

// ======================================================
// Claim + swap
async function triggerClaimAndSwap90() {
  const cycleId = String(floorCycleStart().getTime());

  // Claim creator rewards
  const { res: claimRes, json: claimJson } = await callPumportal(
    "/api/trade",
    {
      action: "collectCreatorFee",
      mint: TRACKED_MINT,
      pool: "pump",
      priorityFee: 0.000001,
    },
    `claim:${cycleId}`
  );
  if (!claimRes.ok) throw new Error(`Claim failed: ${JSON.stringify(claimJson)}`);

  const claimed = Number(claimJson?.claimedAmount ?? 0);
  const claimTx = claimJson?.txid || null;
  console.log(`[CLAIM] Claimed ${claimed} SOL | https://solscan.io/tx/${claimTx}`);

  let swapped = 0;
  let swapTx: string | null = null;

  if (claimed > 0) {
    const { res: swapRes, json: swapJson } = await callPumportal(
      "/api/trade",
      {
        action: "buy",
        mint: TRACKED_MINT,
        amount: (claimed * 0.9).toFixed(6),
        denominatedInSol: true,
        slippage: 5,
        priorityFee: 0.000001,
        pool: "pump",
      },
      `swap:${cycleId}`
    );
    if (!swapRes.ok) throw new Error(`Swap failed: ${JSON.stringify(swapJson)}`);

    swapped = Number(swapJson?.outAmount ?? 0);
    swapTx = swapJson?.txid || null;
    console.log(`[SWAP] Swapped ~${swapped} $BANANA | https://solscan.io/tx/${swapTx}`);
  }

  return { claimed, swapped, claimTx, swapTx };
}

// ======================================================
// Snapshot + Airdrop
async function snapshotAndDistribute() {
  const holdersRaw = await getHoldersAll(TRACKED_MINT);
  const holders = holdersRaw.filter(
    (h) => Number(h.balance) <= AUTO_BLACKLIST_BALANCE
  );

  const rows = holders
    .map((h) => ({ wallet: h.wallet, apes: apes(h.balance) }))
    .filter((r) => r.apes > 0);

  const totalApes = rows.reduce((a, r) => a + r.apes, 0);
  if (totalApes <= 0) {
    console.log(`[AIRDROP] no eligible apes`);
    return;
  }

  const pool = await tokenBalance(devWallet.publicKey);
  const perApe = Math.floor(pool / totalApes);
  if (!(pool > 0) || perApe <= 0) {
    console.log(`[AIRDROP] pool empty`);
    return;
  }

  const mintInfo = await connection.getParsedAccountInfo(mintPubkey);
  const decimals = (mintInfo.value?.data as any)?.parsed?.info?.decimals ?? 6;
  const perApeBase = BigInt(perApe) * BigInt(10 ** decimals);

  // Build transfers in chunks
  let i = 0;
  while (i < rows.length) {
    const batch = rows.slice(i, i + 15);
    i += 15;

    const tx = new Transaction();
    for (const r of batch) {
      const recipient = new PublicKey(r.wallet);
      const recipientAta = getAssociatedTokenAddressSync(mintPubkey, recipient);
      const senderAta = getAssociatedTokenAddressSync(
        mintPubkey,
        devWallet.publicKey
      );
      tx.add(
        createTransferInstruction(
          senderAta,
          recipientAta,
          devWallet.publicKey,
          perApeBase * BigInt(r.apes)
        )
      );
    }

    const sig = await sendAndConfirmTransaction(connection, tx, [devWallet], {
      skipPreflight: true,
      commitment: "confirmed",
    });
    console.log(
      `[AIRDROP] Sent batch of ${batch.length} wallets | per-APE=${perApe} | https://solscan.io/tx/${sig}`
    );
  }
}

// ======================================================
// Main loop
async function loop() {
  const fired = new Set<string>();
  for (;;) {
    const { id, end, tMinus60, tMinus10 } = nextTimes();
    const now = new Date();

    if (!fired.has(id + ":claim") && now >= tMinus60) {
      try {
        await triggerClaimAndSwap90();
      } catch (e) {
        console.error("Claim/swap error:", e);
      }
      fired.add(id + ":claim");
    }
    if (!fired.has(id + ":dist") && now >= tMinus10) {
      try {
        await snapshotAndDistribute();
      } catch (e) {
        console.error("Airdrop error:", e);
      }
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
