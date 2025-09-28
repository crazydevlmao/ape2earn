// src/lib/state.ts
export type TxRef = { at: string; amount: number; tx: string | null };

export type OpsState = {
  lastClaim: TxRef | null;  // creator rewards claimed
  lastSwap:  TxRef | null;  // amount of BANANA received from swap
};

export type Metrics = {
  cacheHits: number;
  cacheMisses: number;
  lastRpcMs: number | null;      // last snapshot RPC latency in ms
  lastSnapshotAt: string | null; // ISO timestamp when we last did a fresh RPC
};

// global singletons (safe across hot reload, best-effort in serverless)
const g = globalThis as any;

if (!g.__BANANA_OPS__) {
  g.__BANANA_OPS__ = { lastClaim: null, lastSwap: null } as OpsState;
}
if (!g.__BANANA_METRICS__) {
  g.__BANANA_METRICS__ = { cacheHits: 0, cacheMisses: 0, lastRpcMs: null, lastSnapshotAt: null } as Metrics;
}

export const OPS: OpsState = g.__BANANA_OPS__;
export const METRICS: Metrics = g.__BANANA_METRICS__;
