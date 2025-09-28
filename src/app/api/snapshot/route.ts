// src/app/api/snapshot/route.ts
// Edge snapshot – ALL holders via getProgramAccounts (legacy + token22), cached & single-flight.
// Also returns OPS + Metrics for transparency panel.

export const runtime = "edge";
export const preferredRegion = "iad1";

import { OPS, METRICS } from "@/lib/state";

// ===== ENV =====
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";
const HELIUS_RPC =
  process.env.HELIUS_RPC ||
  (HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}` : "");
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY || "";

const TRACKED_MINT       = process.env.TRACKED_MINT  || "D1GavULFQNrNVVsXkroLVH6obvn7QKBptcHJFH8Mpump";
const REWARD_WALLET      = process.env.REWARD_WALLET || "DSDpdNq7JLZ3BpngQKs89G9SW3Ex86rHYKLzRgN2zEwS";
const PUMPFUN_AMM_WALLET = process.env.PUMPFUN_AMM_WALLET || "";
const TOKENS_PER_APE     = Number(process.env.TOKENS_PER_APE || 100_000);
const AUTO_BLACKLIST_BALANCE = Number(process.env.AUTO_BLACKLIST_BALANCE ?? 50_000_000);

// ===== Cache controls (server memory) =====
const HOLDERS_TTL_MS = 5_000; // holders cache TTL
const MARKET_TTL_MS  = 3_000; // market throttle
const S_MAXAGE       = 5;     // CDN/browser freshness for the JSON
const STALE_REVAL    = 25;

// ===== Helpers =====
class RetryableError extends Error {}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function rpc(method: string, params: any[], attempts = 6): Promise<any> {
  if (!HELIUS_RPC) throw new Error("Missing HELIUS_RPC/HELIUS_API_KEY");
  let lastErr: any;
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
    } catch (e: any) {
      lastErr = e;
      if (!(e instanceof RetryableError) || i === attempts - 1) break;
      await sleep(300 * (i + 1) + Math.random() * 250);
    }
  }
  throw lastErr;
}

const coerceGPAList = (j: any): any[] =>
  Array.isArray(j?.result) ? j.result : (Array.isArray(j?.result?.value) ? j.result.value : []);

// ===== In-memory caches & single-flight =====
type Holder = { address: string; balance: number };
const g = globalThis as any;

type HoldersCache = { ts: number; mint: string; list: Holder[]; inflight?: Promise<Holder[]> | null };
type MarketCache  = { ts: number; mint: string; price: number | null; cap: number | null; inflight?: Promise<{price:number|null; cap:number|null}> | null };

if (!g.__BANANA_HOLDERS__) g.__BANANA_HOLDERS__ = { ts: 0, mint: "", list: [], inflight: null } as HoldersCache;
if (!g.__BANANA_MARKET__)  g.__BANANA_MARKET__  = { ts: 0, mint: "", price: null, cap: null, inflight: null } as MarketCache;

const HOLDERS: HoldersCache = g.__BANANA_HOLDERS__;
const MARKET:  MarketCache  = g.__BANANA_MARKET__;

// ===== RPC helpers =====
async function getRewardPoolAmount(mint: string, owner: string): Promise<number> {
  const j = await rpc("getTokenAccountsByOwner", [
    owner,
    { mint },
    { encoding: "jsonParsed", commitment: "confirmed" },
  ]);
  const list = coerceGPAList(j);
  let total = 0;
  for (const it of list) {
    const ta = it?.account?.data?.parsed?.info?.tokenAmount;
    const v =
      typeof ta?.uiAmount === "number"
        ? ta.uiAmount
        : ta?.uiAmountString != null
        ? Number(ta.uiAmountString)
        : 0;
    if (Number.isFinite(v)) total += v;
  }
  return total;
}

async function getMintSupply(mint: string): Promise<number | null> {
  const j = await rpc("getTokenSupply", [mint, { commitment: "confirmed" }], 4);
  const v = j?.result?.value;
  if (!v) return null;
  if (typeof v.uiAmount === "number" && Number.isFinite(v.uiAmount)) return v.uiAmount;
  if (typeof v.uiAmountString === "string") {
    const n = Number(v.uiAmountString);
    if (Number.isFinite(n)) return n;
  }
  const amount = Number(v.amount ?? NaN);
  const decimals = Number(v.decimals ?? NaN);
  if (Number.isFinite(amount) && Number.isFinite(decimals)) {
    return amount / Math.pow(10, decimals);
  }
  return null;
}

async function getHolders(mint: string): Promise<Holder[]> {
  // cache hit?
  const now = Date.now();
  if (HOLDERS.mint === mint && now - HOLDERS.ts < HOLDERS_TTL_MS && HOLDERS.list.length) {
    METRICS.cacheHits++;
    return HOLDERS.list;
  }

  // single-flight
  if (HOLDERS.inflight) {
    METRICS.cacheHits++;
    return HOLDERS.inflight;
  }

  const task = (async () => {
    const t0 = Date.now();

    async function byProgram(programId: string, withDataSize165: boolean): Promise<Record<string, number>> {
      const filters: any[] = [{ memcmp: { offset: 0, bytes: mint } }];
      if (withDataSize165) filters.unshift({ dataSize: 165 });
      const j = await rpc("getProgramAccounts", [
        programId,
        { encoding: "jsonParsed", commitment: "confirmed", filters },
      ]);
      const list = coerceGPAList(j);
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
      const a = await byProgram("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", true);
      for (const [k, v] of Object.entries(a)) merged[k] = (merged[k] ?? 0) + (v as number);
    } catch {}
    try {
      const b = await byProgram("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCx2w6G3W", false);
      for (const [k, v] of Object.entries(b)) merged[k] = (merged[k] ?? 0) + (v as number);
    } catch {}

    const list = Object.entries(merged)
      .filter(([addr, bal]) => addr !== PUMPFUN_AMM_WALLET && (bal as number) > 0)
      .map(([address, balance]) => ({ address, balance: Number(balance) }))
      .sort((a, b) => b.balance - a.balance);

    // update metrics
    METRICS.cacheMisses++;
    METRICS.lastRpcMs = Date.now() - t0;
    METRICS.lastSnapshotAt = new Date().toISOString();

    // store cache
    HOLDERS.mint = mint;
    HOLDERS.ts = Date.now();
    HOLDERS.list = list;

    return list;
  })();

  HOLDERS.inflight = task;
  try {
    const out = await task;
    return out;
  } finally {
    HOLDERS.inflight = null;
  }
}

// ===== Market (Birdeye) =====
async function getJson(url: string) {
  const res = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json", "X-API-KEY": BIRDEYE_API_KEY, "x-chain": "solana" },
    cache: "no-store",
  });
  const text = await res.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

const num = (x: any): number | null => (Number.isFinite(Number(x)) ? Number(x) : null);
const pickNum = (...xs: any[]): number | null => {
  for (const v of xs) {
    const n = num(v);
    if (n && n > 0) return n;
  }
  return null;
};

async function getPriceAndCap(
  mint: string,
  holdersForFallback?: Array<{ balance: number }>
): Promise<{ price: number | null; cap: number | null }> {
  const now = Date.now();
  if (MARKET.mint === mint && now - MARKET.ts < MARKET_TTL_MS)
    return { price: MARKET.price, cap: MARKET.cap };
  if (MARKET.inflight) return MARKET.inflight as Promise<{ price: number | null; cap: number | null }>;

  const task: Promise<{ price: number | null; cap: number | null }> = (async () => {
    try {
      // v3 market-data
      const v3 = await getJson(
        `https://public-api.birdeye.so/defi/v3/token/market-data?address=${encodeURIComponent(
          mint
        )}&x-chain=solana`
      );
      const d = v3.json?.data ?? {};
      let cap = pickNum(d.marketcap, d.market_cap, d.circulating_marketcap, d.marketCap);
      let price = pickNum(d.price, d.last_price, d.priceUsd, d.usd_price);

      // price-only fallback
      if (!price) {
        const p = await getJson(
          `https://public-api.birdeye.so/defi/price?address=${encodeURIComponent(
            mint
          )}&include_liquidity=true`
        );
        price = pickNum(p.json?.data?.value, p.json?.data?.price) ?? price;
      }

      // compute cap if missing
      if (!cap && price) {
        const supply = await getMintSupply(mint);
        if (supply && supply > 0) cap = price * supply;
        else if (holdersForFallback?.length) {
          const approxCirc = holdersForFallback.reduce(
            (a, r) => a + (Number(r.balance) || 0),
            0
          );
          const computed = price * approxCirc;
          if (Number.isFinite(computed) && computed > 0) cap = computed;
        }
      }

      MARKET.ts = Date.now();
      MARKET.mint = mint;
      MARKET.price = price ?? MARKET.price ?? null;
      MARKET.cap = cap && cap > 0 ? cap : MARKET.cap ?? null;

      return { price: MARKET.price, cap: MARKET.cap };
    } finally {
      MARKET.inflight = null;
    }
  })();

  MARKET.inflight = task;
  return task;
}

// ===== GET handler =====
export async function GET(req: Request) {
  if (!HELIUS_RPC) {
    return new Response(
      JSON.stringify({ error: "Missing HELIUS_RPC/HELIUS_API_KEY" }),
      { status: 500 }
    );
  }

  const url = new URL(req.url);
  const mintParam = url.searchParams.get("mint")?.trim();
  const MINT =
    mintParam && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mintParam)
      ? mintParam
      : TRACKED_MINT;

  try {
    const holdersRaw = await getHolders(MINT);

    // auto-blacklist wallets > threshold
    const holders = holdersRaw.filter(
      (h) => Number(h.balance) <= AUTO_BLACKLIST_BALANCE
    );

    const [rewardPoolBanana, market] = await Promise.all([
      getRewardPoolAmount(MINT, REWARD_WALLET),
      getPriceAndCap(MINT, holders), // use filtered for circ/fallback
    ]);

    const payload = {
      updatedAt: new Date().toISOString(),
      mint: MINT,
      holders, // filtered [{ address, balance }, ...]
      rewardPoolBanana,
      tokensPerApe: TOKENS_PER_APE,
      counts: { total: holders.length },
      marketCapUsd: market.cap ?? null,
      ops: { ...OPS },
      metrics: { ...METRICS },
    };

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "Cache-Control": `public, max-age=0, s-maxage=${S_MAXAGE}, stale-while-revalidate=${STALE_REVAL}`,
      },
    });
  } catch (e: any) {
    return new Response(
      JSON.stringify({ error: e?.message || "snapshot failed" }),
      {
        status: 500,
        headers: { "Cache-Control": "no-store" },
      }
    );
  }
}
