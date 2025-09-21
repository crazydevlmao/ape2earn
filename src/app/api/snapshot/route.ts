// app/api/snapshot/route.ts
// Edge snapshot – ALL holders via getProgramAccounts (legacy + token22), fail-open, fallback to largest ONLY if both miss

export const runtime = 'edge';
export const preferredRegion = 'iad1';

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY || '';

// === BANANA constants (edit these only) ===
const TRACKED_MINT       = 'BCtJf5K5NVqCgksEb9rervX6Eae17NDZ8BSdGSoEpump'; // $BANANA mint
const REWARD_WALLET      = '2dPD6abjP5YrjFo3T53Uf82EuV6XFJLAZaq5KDEnvqC7'; // reward pool wallet
const PUMPFUN_AMM_WALLET = 'AFavQw5TtcuRM8R1LbVh8DG9w3EdU7ExEQMvEn4yrSZM'; // exclude AMM
const TOKENS_PER_APE     = 100_000;
// ===========================================

// Cache tuned for 5s client polling
const S_MAXAGE = 5;
const STALE_WHILE_REVALIDATE = 25;

class RetryableError extends Error {}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// -------------------- Core RPC helpers --------------------
async function rpc(method: string, params: any[], attempts = 6): Promise<any> {
  if (!HELIUS_API_KEY) throw new Error('Missing HELIUS_API_KEY');
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(HELIUS_RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
      });
      const txt = await res.text();
      const json = txt ? JSON.parse(txt) : {};
      if (!res.ok || json?.error) {
        const msg = json?.error?.message || `HTTP ${res.status}`;
        if (res.status === 429 || res.status >= 500 || /rate ?limit/i.test(msg) || /Too Many/i.test(msg)) {
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

function coerceGPAList(j: any): any[] {
  if (Array.isArray(j?.result)) return j.result;
  if (Array.isArray(j?.result?.value)) return j.result.value;
  return [];
}

// -------------------- On-chain totals (reward pool & supply) --------------------
async function getRewardPoolAmount(mint: string, owner: string): Promise<number> {
  const j = await rpc('getTokenAccountsByOwner', [
    owner,
    { mint },
    { encoding: 'jsonParsed', commitment: 'confirmed' },
  ]);
  const list = coerceGPAList(j);
  let total = 0;
  for (const it of list) {
    const ta = it?.account?.data?.parsed?.info?.tokenAmount;
    const v =
      typeof ta?.uiAmount === 'number'
        ? ta.uiAmount
        : ta?.uiAmountString != null
        ? Number(ta.uiAmountString)
        : 0;
    if (Number.isFinite(v)) total += v;
  }
  return total;
}

async function getMintSupply(mint: string): Promise<number | null> {
  const j = await rpc('getTokenSupply', [mint, { commitment: 'confirmed' }], 4);
  const v = j?.result?.value;
  if (!v) return null;
  if (typeof v.uiAmount === 'number' && Number.isFinite(v.uiAmount)) return v.uiAmount;
  if (typeof v.uiAmountString === 'string') {
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

// === ALL holders via getProgramAccounts (legacy + token-2022), fail-open per program ===
async function getHolders(mint: string) {
  async function byProgram(programId: string, withDataSize165: boolean): Promise<Record<string, number>> {
    const filters: any[] = [{ memcmp: { offset: 0, bytes: mint } }];
    if (withDataSize165) filters.unshift({ dataSize: 165 }); // legacy SPL
    const j = await rpc('getProgramAccounts', [
      programId,
      { encoding: 'jsonParsed', commitment: 'confirmed', filters },
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

  let legacy: Record<string, number> = {};
  let t22:    Record<string, number> = {};

  try { legacy = await byProgram('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', true); } catch {}
  try { t22    = await byProgram('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCx2w6G3W', false); } catch {}

  const merged: Record<string, number> = {};
  for (const [k, v] of Object.entries(legacy)) merged[k] = (merged[k] ?? 0) + v;
  for (const [k, v] of Object.entries(t22))    merged[k] = (merged[k] ?? 0) + v;

  if (Object.keys(merged).length === 0) {
    try {
      const largest = await rpc('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }], 5);
      const vals: any[] = Array.isArray(largest?.result?.value) ? largest.result.value : [];
      const accounts = vals.map((row: any) => ({ address: row.address, balance: Number(row.uiAmount ?? 0) }));
      const pubkeys = accounts.map((a) => a.address);
      if (pubkeys.length) {
        const multi = await rpc('getMultipleAccounts', [pubkeys, { encoding: 'jsonParsed', commitment: 'confirmed' }], 5);
        const infos: any[] = Array.isArray(multi?.result?.value) ? multi.result.value : [];
        accounts.forEach((acc, i) => {
          const owner = infos[i]?.data?.parsed?.info?.owner ?? null;
          if (!owner) return;
          merged[owner] = (merged[owner] ?? 0) + Number(acc.balance ?? 0);
        });
      }
    } catch {
      // leave merged empty
    }
  }

  return Object.entries(merged)
    .filter(([addr, bal]) => addr !== PUMPFUN_AMM_WALLET && (bal as number) > 0)
    .map(([address, balance]) => ({ address, balance: Number(balance) }))
    .sort((a, b) => b.balance - a.balance);
}

// -------------------- Birdeye market-cap (server-only, cached) --------------------
type MarketCache = {
  ts: number;
  mint: string | null;
  price: number | null;
  cap: number | null;
  inflight: Promise<{ price: number | null; cap: number | null }> | null;
  lastDebug?: any;
};
const MARKET_CACHE: MarketCache = { ts: 0, mint: null, price: null, cap: null, inflight: null };

const num = (x: any): number | null => (Number.isFinite(Number(x)) ? Number(x) : null);
const pickNum = (...xs: any[]): number | null => {
  for (const v of xs) {
    const n = num(v);
    if (n && n > 0) return n;
  }
  return null;
};

// helper to call Birdeye with both header + query param for chain
async function getJson(url: string) {
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      'X-API-KEY': BIRDEYE_API_KEY,
      'x-chain': 'solana',
    },
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

async function fetchMarketData(mint: string) {
  // v3 market-data
  const v3 = await getJson(`https://public-api.birdeye.so/defi/v3/token/market-data?address=${encodeURIComponent(mint)}&x-chain=solana`);
  const d = v3.json?.data ?? {};
  const mcap = pickNum(d.marketcap, d.market_cap, d.circulating_marketcap, d.marketCap);
  const priceFromV3 = pickNum(d.price, d.last_price, d.priceUsd, d.usd_price);
  return { v3, mcap, priceFromV3 };
}

async function fetchPriceOnly(mint: string) {
  // simple price endpoint
  const p = await getJson(`https://public-api.birdeye.so/defi/price?address=${encodeURIComponent(mint)}&include_liquidity=true`);
  const price = pickNum(p.json?.data?.value, p.json?.data?.price);
  return { p, price };
}

async function getPriceAndCap(mint: string, holdersForFallback?: Array<{balance:number}>): Promise<{ price: number | null; cap: number | null }> {
  const now = Date.now();

  // throttle: 1 call / 3s
  if (MARKET_CACHE.mint === mint && now - MARKET_CACHE.ts < 3000) {
    return { price: MARKET_CACHE.price, cap: MARKET_CACHE.cap };
  }
  if (MARKET_CACHE.inflight) {
    try { return await MARKET_CACHE.inflight; } catch {}
  }

  const task = (async () => {
    try {
      let cap: number | null = null;
      let price: number | null = null;

      // 1) try v3 market data (direct cap)
      const { v3, mcap, priceFromV3 } = await fetchMarketData(mint);
      cap = mcap ?? null;
      price = priceFromV3 ?? null;

      // 2) if price still missing, try price endpoint
      if (!price) {
        const { p, price: pOnly } = await fetchPriceOnly(mint);
        price = pOnly ?? price;
        MARKET_CACHE.lastDebug = { v3, priceEndpoint: p };
      } else {
        MARKET_CACHE.lastDebug = { v3 };
      }

      // 3) compute cap if not present, from supply or holders sum
      if (!cap && price) {
        const supply = await getMintSupply(mint);
        if (supply && supply > 0) {
          const computed = price * supply;
          if (Number.isFinite(computed) && computed > 0) cap = computed;
        } else if (Array.isArray(holdersForFallback) && holdersForFallback.length) {
          const approxCirc = holdersForFallback.reduce((a, r) => a + (Number(r.balance) || 0), 0);
          const computed = price * approxCirc;
          if (Number.isFinite(computed) && computed > 0) cap = computed;
        }
      }

      // store (don’t overwrite with 0/null if we had a previous good value)
      MARKET_CACHE.ts = Date.now();
      MARKET_CACHE.mint = mint;
      MARKET_CACHE.price = price ?? MARKET_CACHE.price ?? null;
      MARKET_CACHE.cap = (cap && cap > 0) ? cap : (MARKET_CACHE.cap ?? null);

      return { price: MARKET_CACHE.price, cap: MARKET_CACHE.cap };
    } catch {
      MARKET_CACHE.ts = Date.now();
      MARKET_CACHE.mint = mint;
      return { price: MARKET_CACHE.price, cap: MARKET_CACHE.cap };
    } finally {
      MARKET_CACHE.inflight = null;
    }
  })();

  MARKET_CACHE.inflight = task;
  return task;
}

// --------------------------- GET handler ---------------------------
export async function GET(req: Request) {
  if (!HELIUS_API_KEY) {
    return new Response(JSON.stringify({ error: 'Missing HELIUS_API_KEY' }), { status: 500 });
  }

  const url = new URL(req.url);
  const mintParam = url.searchParams.get('mint')?.trim();
  const debug = url.searchParams.get('debug') === '1';
  const MINT =
    mintParam && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mintParam) ? mintParam : TRACKED_MINT;

  try {
    // holders first (so we can use them as a fallback for circulating supply)
    const holders = await getHolders(MINT);
    const [rewardPoolBanana, market] = await Promise.all([
      getRewardPoolAmount(MINT, REWARD_WALLET),
      getPriceAndCap(MINT, holders),
    ]);

    const payload: any = {
      updatedAt: new Date().toISOString(),
      mint: MINT,
      holders, // [{ address, balance }, ...]
      rewardPoolBanana,
      tokensPerApe: TOKENS_PER_APE,
      counts: { total: holders.length },
      marketCapUsd: market.cap ?? null,
      // marketPriceUsd: market.price ?? null,
    };

    if (debug) {
      payload._debug = {
        birdEyeKeyPresent: !!BIRDEYE_API_KEY,
        lastDebug: MARKET_CACHE.lastDebug ?? null,
      };
    }

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'Cache-Control': `public, max-age=0, s-maxage=${S_MAXAGE}, stale-while-revalidate=${STALE_WHILE_REVALIDATE}`,
      },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || 'snapshot failed' }), {
      status: 500,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}



