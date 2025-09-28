'use client';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

// ================== CONFIG ==================
const APE_UNIT = 100_000; // 1 APE = 100,000 $BANANA
const CYCLE_MINUTES = 5;
const USE_CEIL_FOR_APES = false;

// ================== TYPES ==================
type Holder = { wallet: string; balance: number };
type Row = { wallet: string; tokens: number; apes: number };
type MarketInfo = { marketCapUsd: number | null };
type OpsState = {
  lastClaim: { at: string; amount: number; tx: string | null } | null;
  lastSwap:  { at: string; amount: number; tx: string | null } | null;
};

// ================== HELPERS ==================
const toNum = (n: unknown, fb = 0) => (Number.isFinite(Number(n)) ? Number(n) : fb);
const numOrNull = (n: unknown) => (Number.isFinite(Number(n)) ? Number(n) : null);
function apesForHolder(tokens: number) {
  const t = toNum(tokens, 0);
  if (t <= 0) return 0;
  return USE_CEIL_FOR_APES ? Math.ceil(t / APE_UNIT) : Math.floor(t / APE_UNIT);
}
function floorCycleStart(d = new Date()) {
  const w = CYCLE_MINUTES * 60_000;
  return new Date(Math.floor(d.getTime() / w) * w);
}
function nextCycleBoundary(from = new Date()) {
  const d = floorCycleStart(from);
  return new Date(d.getTime() + CYCLE_MINUTES * 60_000);
}
function formatHMS(msRemaining: number) {
  const s = Math.max(0, Math.floor(msRemaining / 1000));
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}
function shortAddr(a?: string, head = 6, tail = 6) {
  const s = String(a || '');
  return s.length > head + tail ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
}
function splitPumpDisplay(m: string) {
  const mint = String(m || '');
  const endsPump = mint.toLowerCase().endsWith('pump');
  if (!mint) return { head: '', pump: '' };
  if (endsPump) {
    const head = mint.length > 12 ? `${mint.slice(0, 6)}…${mint.slice(-10, -4)}` : mint.slice(0, Math.max(0, mint.length - 4));
    return { head, pump: 'pump' };
  }
  return { head: shortAddr(mint), pump: '' };
}
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {}
  return false;
}
const solscanTx = (tx?: string | null) => (tx ? `https://solscan.io/tx/${tx}` : null);

// ================== UI PARTS ==================
const PulsingDot = () => (
  <div className="relative h-2.5 w-2.5">
    <div className="absolute inset-0 rounded-sm bg-yellow-400 z-10" />
    <motion.div
      className="absolute -inset-1 rounded-md bg-yellow-300/50"
      animate={{ scale: [0.9, 1.15, 0.9], opacity: [0.6, 0.2, 0.6] }}
      transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
    />
  </div>
);

const PixelInput: React.FC<React.InputHTMLAttributes<HTMLInputElement>> = (p) => (
  <input {...p} className={`h-9 w-48 rounded-xl border-2 border-yellow-300 bg-white px-3 text-xs font-mono text-neutral-800 outline-none shadow-[0_3px_0_#fde68a] focus:border-yellow-400 ${p.className||''}`} />
);

const PixelIconButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = ({ children, className = '', ...rest }) => (
  <button
    {...rest}
    className={`active:translate-y-0.5 relative inline-flex items-center justify-center rounded-xl border-2 border-yellow-400 bg-yellow-300 w-10 h-10 font-black text-black shadow-[0_4px_0_#facc15] transition-transform hover:-translate-y-0.5 ${className}`}
    style={{ fontFamily: '"Press Start 2P", Pixelify Sans, system-ui, sans-serif' }}
  >
    {children}
  </button>
);

const InfoDot: React.FC<{ title: string; body: string }> = ({ title, body }) => (
  <div className="relative inline-block group align-middle select-none">
    <div className="ml-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-yellow-400/90 text-black text-[10px] font-black border border-yellow-600 shadow-sm">i</div>
    <div className="absolute right-0 z-50 mt-2 hidden w-72 rounded-xl border border-yellow-300 bg-white p-3 text-xs leading-relaxed shadow-xl group-hover:block">
      <div className="font-semibold mb-1">{title}</div>
      <div className="text-neutral-700">{body}</div>
    </div>
  </div>
);

const StatCard: React.FC<{label:string; value:React.ReactNode; tooltip?: { title: string; body: string }}> = ({label, value, tooltip}) => (
  <div className="relative rounded-2xl border-2 border-yellow-300 bg-white px-4 py-3 shadow-[0_6px_0_#facc15]">
    <div className="flex items-center justify-between">
      <div className="text-[10px] uppercase tracking-widest text-neutral-500/80">{label}</div>
      {tooltip && <InfoDot title={tooltip.title} body={tooltip.body} />}
    </div>
    <div className="mt-1 text-2xl font-black text-yellow-600" style={{ fontFamily: '"Press Start 2P", Pixelify Sans, system-ui, sans-serif' }}>{value}</div>
  </div>
);

const CAHeaderPill: React.FC<{ mint: string; copied: boolean; onCopy: () => void }> = ({ mint, copied, onCopy }) => {
  const sp = splitPumpDisplay(mint);
  const shown = !!(mint && mint.length > 0);
  return (
    <div className="group relative">
      <div className="flex items-center gap-2 rounded-xl border-2 border-yellow-300 bg-white px-3 py-1 shadow-[0_3px_0_#fde68a]">
        <span className="text-[11px] uppercase tracking-widest text-neutral-600">ca:</span>
        {shown ? (
          <>
            <span className="font-mono text-xs text-black">{sp.head}</span>
            {sp.pump && <span className="font-mono text-xs pump-pulse">{sp.pump.toUpperCase()}</span>}
          </>
        ) : (
          <>
            <span className="font-mono text-xs text-black">....</span>
            <span className="font-mono text-xs pump-pulse">PUMP</span>
          </>
        )}
        <button
          onClick={onCopy}
          className="ml-1 inline-flex items-center justify-center w-7 h-7 rounded-lg border-2 border-yellow-400 bg-yellow-300 font-black text-black shadow-[0_3px_0_#facc15] active:translate-y-0.5"
          title="Copy contract address"
        >
          {copied ? '✓' : '⧉'}
        </button>
      </div>
      <div className="pointer-events-none absolute left-0 top-full mt-1 text-[10px] text-neutral-400 opacity-0 group-hover:opacity-100 transition-opacity">click to copy</div>
    </div>
  );
};

const MarketCapStrip: React.FC<{ valueUsd: number | null; delta?: number | null }> = ({ valueUsd, delta }) => {
  function compact(n: number) {
    try { return Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n); } catch { return n.toLocaleString(); }
  }
  const txt = valueUsd == null ? '--' : `$${compact(Math.max(0, valueUsd))}`;
  const deltaTxt = (delta == null || delta === 0) ? null : `${delta > 0 ? '▲' : '▼'} $${compact(Math.abs(delta))}`;
  return (
    <div className="relative rounded-2xl border-2 border-yellow-300 bg-white px-4 py-3 shadow-[0_8px_0_#facc15] overflow-visible">
      <div className="absolute inset-0 opacity-60 pointer-events-none" style={{ background: 'linear-gradient(90deg, rgba(250, 204, 21, 0.12), transparent 55%)' }} />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <PulsingDot />
          <span className="text-[10px] uppercase tracking-widest text-neutral-500/80">Market Cap</span>
        </div>
        <InfoDot title="Market Cap?" body={"If you really need this explained, stay away from trading at all costs 😅"} />
      </div>
      <div className="mt-1 flex items-baseline gap-3">
        <div className="text-2xl font-black text-yellow-600 tabular-nums tracking-wide" style={{ fontFamily: '"Press Start 2P", Pixelify Sans, system-ui, sans-serif' }}>{txt}</div>
        {deltaTxt && (
          <span className={`text-xs font-bold ${delta! > 0 ? 'text-green-600' : 'text-red-600'}`}>{deltaTxt}</span>
        )}
      </div>
    </div>
  );
};

function podiumStyle(rank: number): { style: React.CSSProperties; medal?: string } {
  const r = toNum(rank, 0);
  if (r === 1) return { style: { background: 'linear-gradient(90deg, rgba(255,215,0,0.12), transparent 55%)', boxShadow: 'inset 3px 0 0 rgba(255,215,0,0.85)' }, medal: '🥇' };
  if (r === 2) return { style: { background: 'linear-gradient(90deg, rgba(192,192,192,0.12), transparent 55%)', boxShadow: 'inset 3px 0 0 rgba(192,192,192,0.85)' }, medal: '🥈' };
  if (r === 3) return { style: { background: 'linear-gradient(90deg, rgba(205,127,50,0.12), transparent 55%)', boxShadow: 'inset 3px 0 0 rgba(205,127,50,0.85)' }, medal: '🥉' };
  return { style: {} };
}

const HolderRow: React.FC<{ renderIdx:number; rank:number; wallet:string; tokens:number; apes:number }> = ({ renderIdx, rank, wallet, tokens, apes }) => {
  const r = Number.isFinite(rank) ? rank : renderIdx + 1;
  const t = toNum(tokens, 0);
  const a = Math.max(0, toNum(apes, 0));
  const short = wallet?.length > 12 ? `${wallet.slice(0,6)}…${wallet.slice(-6)}` : wallet ?? '';
  const pod = podiumStyle(r);
  return (
    <motion.tr initial={{opacity:0,y:8}} animate={{opacity:1,y:0}} transition={{delay:0.02*renderIdx}} className="text-sm" style={pod.style}>
      <td className="py-2 pl-3 pr-2 font-mono text-neutral-700 whitespace-nowrap">#{r} {pod.medal && <span className="ml-1">{pod.medal}</span>}</td>
      <td className="py-2 px-2 font-mono text-neutral-900">{short}</td>
      <td className="py-2 px-2 font-mono text-right text-neutral-700 tabular-nums">{t.toLocaleString()}</td>
      <td className="py-2 pr-3 pl-2 font-black text-right text-yellow-600 tabular-nums" style={{ fontFamily: '"Press Start 2P", Pixelify Sans, system-ui, sans-serif' }}>{a.toLocaleString()}</td>
    </motion.tr>
  );
};

const NextDropCard: React.FC<{ msLeft:number; cycleMs:number }> = ({ msLeft, cycleMs }) => {
  const display = formatHMS(msLeft);
  const size=140, stroke=10, r=(size-stroke)/2, c=2*Math.PI*r, dash=c;
  const progress = 1 - Math.min(1, Math.max(0, toNum(msLeft, 0) / cycleMs));
  const offset = dash * (1 - progress);

  const drops = React.useMemo(() => {
    const N = 10;
    return Array.from({ length: N }, (_, i) => ({
      id: i,
      left: Math.max(2, Math.min(98, Math.random() * 100)),
      delay: Math.random() * 2.5,
      duration: 5 + Math.random() * 4,
    }));
  }, []);

  return (
    <motion.div key={Math.floor(toNum(msLeft, 0)/1000)} initial={{scale:0.98, filter:'drop-shadow(0 0 0 rgba(250,204,21,0))'}} animate={{scale:1, filter:'drop-shadow(0 0 12px rgba(250,204,21,0.35))'}} transition={{type:'spring', stiffness:200, damping:20}} className="relative flex items-center justify-center rounded-2xl border-2 border-yellow-300 bg-white p-4 shadow-[0_8px_0_#facc15]">
      <div className="absolute inset-0 rounded-2xl bg-[radial-gradient(closest-side,rgba(250,204,21,0.12),transparent)]" />
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        {drops.map((d) => (
          <motion.img
            key={d.id}
            src="/banana-pixel.png"
            alt=""
            className="absolute image-pixelate"
            style={{ left: `${d.left}%`, width: 20, height: 20, opacity: 0.5 }}
            initial={{ y: -24, scale: 0.75 }}
            animate={{ y: ['-24px', 'calc(100% + 24px)'] }}
            transition={{ duration: d.duration, delay: d.delay, repeat: Infinity, ease: 'easeInOut' }}
          />
        ))}
      </div>

      <svg width={size} height={size}>
        <circle cx={size/2} cy={size/2} r={r} stroke="#fef9c3" strokeWidth={stroke} fill="none" />
        <motion.circle cx={size/2} cy={size/2} r={r} stroke="#facc15" strokeWidth={stroke} fill="none" strokeDasharray={dash} animate={{strokeDashoffset:offset}} initial={false} strokeLinecap="round" />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="text-[10px] uppercase tracking-widest text-neutral-500/80">NEXT DROP</div>
        <motion.div key={display} initial={{y:6,opacity:0}} animate={{y:0,opacity:1}} transition={{type:'spring', stiffness:300, damping:20}} className="mt-1 text-3xl font-black text-yellow-600 tabular-nums tracking-widest" style={{ fontFamily: '"Press Start 2P", Pixelify Sans, system-ui, sans-serif' }}>{display}</motion.div>
      </div>
      <AnimatePresence>
        {toNum(msLeft, 0) < 750 && <motion.div initial={{opacity:0.8,scale:0.8}} animate={{opacity:0,scale:1.8}} transition={{duration:0.7,ease:'easeOut'}} className="absolute inset-0 rounded-2xl bg-yellow-300/40 pointer-events-none" />}
      </AnimatePresence>
    </motion.div>
  );
};

// ======== POPUP (shows at T=0 for ~3s) ========
const DropPopup: React.FC<{ show: boolean }> = ({ show }) => (
  <AnimatePresence>
    {show && (
      <motion.div
        initial={{ y: -50, opacity: 0, scale: 0.95 }}
        animate={{ y: 0, opacity: 1, scale: 1 }}
        exit={{ y: -40, opacity: 0, scale: 0.96 }}
        transition={{ type: 'spring', stiffness: 500, damping: 30, mass: 0.6 }}
        className="fixed top-3 left-1/2 z-[100] -translate-x-1/2"
      >
        <div className="flex items-center gap-3 rounded-2xl border-2 border-yellow-400 bg-yellow-300/95 px-4 py-3 shadow-[0_8px_0_#facc15]">
          <img src="/banana-pixel.png" alt="" className="w-6 h-6 image-pixelate" />
          <div className="text-sm font-black text-black" style={{ fontFamily: '"Press Start 2P", Pixelify Sans, system-ui, sans-serif' }}>
            Apes are receiving their $BANANA…
          </div>
        </div>
      </motion.div>
    )}
  </AnimatePresence>
);

// ================== APP ==================
export default function ApeBananaApp() {
  const [holders, setHolders] = useState<Holder[] | null>(null);
  const [pool, setPool] = useState<number | null>(null);
  const [market, setMarket] = useState<MarketInfo>({ marketCapUsd: null });
  const [mint, setMint] = useState<string>('');
  const lastMCRef = useRef<number | null>(null);
  const [mcDelta, setMcDelta] = useState<number | null>(null);
  const [copiedCA, setCopiedCA] = useState(false);
  const [ops, setOps] = useState<OpsState>({ lastClaim: null, lastSwap: null });

  // popup state
  const [showPopup, setShowPopup] = useState(false);
  const popupTimerRef = useRef<NodeJS.Timeout | null>(null);

  // single loader
const loadRef = useRef<() => Promise<void>>(async () => {});
  loadRef.current = async () => {
    try {
      // add ts param to smash caches at the edge
      const res = await fetch(`/api/snapshot?ts=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`Snapshot ${res.status}`);
      const j = await res.json();
      const hs: Holder[] = Array.isArray(j?.holders)
        ? j.holders.map((x: { address?: string; wallet?: string; balance?: number | string }) => ({ wallet: String(x.address ?? x.wallet ?? ''), balance: toNum(x.balance, 0) }))
        : [];
      setHolders(hs);
      setPool(toNum(j?.rewardPoolBanana, 0));
      setMint(String(j?.mint || ''));
      const mc = numOrNull(j?.marketCapUsd);
      setMcDelta(mc != null && lastMCRef.current != null ? mc - lastMCRef.current : null);
      setMarket({ marketCapUsd: mc });
      lastMCRef.current = mc ?? lastMCRef.current;
      if (j?.ops) setOps(j.ops);
    } catch {
      // leave previous data; no hard reset
    }
  };

  // initial + polling (faster near boundary)
  useEffect(() => {
    let alive = true;
    const run = async () => { if (!alive) return; await loadRef.current!(); };
    run();

    let id: NodeJS.Timeout | null = null;
    const tick = () => {
      const now = new Date();
      const msToBoundary = nextCycleBoundary(now).getTime() - now.getTime();
      const fast = msToBoundary <= 15_000;          // 15s to T0: refresh fast
      const interval = fast ? 1_000 : 4_000;
      if (id) clearInterval(id);
      id = setInterval(() => {
        if (document.visibilityState === 'visible') loadRef.current!();
        // re-evaluate cadence occasionally
        tick();
      }, interval);
    };
    tick();

    const onVis = () => document.visibilityState === 'visible' && loadRef.current!();
    document.addEventListener('visibilitychange', onVis);

    return () => {
      alive = false;
      if (id) clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  // table enrich
  const safe = Array.isArray(holders) ? holders : [];
  const enriched = useMemo(() => {
    const rows: Row[] = safe
      .map((h) => ({ wallet: h.wallet, tokens: toNum(h.balance, 0), apes: apesForHolder(toNum(h.balance, 0)) }))
      .filter((r) => r.apes > 0);
    rows.sort((a, b) => b.apes - a.apes || b.tokens - a.tokens);
    const totalApes = rows.reduce((a, r) => a + r.apes, 0);
    return { rows, totalApes };
  }, [safe]);

  const rankByWallet = useMemo(() => {
    const m = new Map<string, number>();
    enriched.rows.forEach((r, i) => m.set(r.wallet, i + 1));
    return m;
  }, [enriched.rows]);

  // paging + search
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const tableBoxRef = useRef<HTMLDivElement | null>(null);
  const tbodyRef = useRef<HTMLTableSectionElement | null>(null);
  const [rowsPerPage, setRowsPerPage] = useState<number>(8);

  const filtered = useMemo(
    () => enriched.rows.filter((r) => (query ? r.wallet.toLowerCase().includes(query.toLowerCase()) : true)),
    [enriched.rows, query]
  );

  useEffect(() => {
    const recalc = () => {
      const box = tableBoxRef.current; if (!box) return;
      const h = box.clientHeight;
      const headerH = 36;
      const firstRow = tbodyRef.current?.querySelector('tr');
      let rowH = firstRow ? Math.ceil(firstRow.getBoundingClientRect().height) : 42;
      if (!Number.isFinite(rowH) || rowH <= 0) rowH = 42;
      const available = Math.max(0, h - headerH - 8);
      const n = Math.max(3, Math.floor(available / rowH));
      setRowsPerPage(n);
    };
    recalc();
    const onResize = () => recalc();
    window.addEventListener('resize', onResize);
    const t = setTimeout(recalc, 250);
    return () => { window.removeEventListener('resize', onResize); clearTimeout(t); };
  }, [enriched.rows.length]);

  useEffect(() => setPage(1), [query, rowsPerPage]);
  const maxPage = Math.max(1, Math.ceil(filtered.length / Math.max(1, rowsPerPage)));
  const start = (page - 1) * Math.max(1, rowsPerPage);
  const pageRows = filtered.slice(start, start + Math.max(1, rowsPerPage));

  // timer + boundary behavior
  const [target, setTarget] = useState(() => nextCycleBoundary());
  const [now, setNow] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 250); return () => clearInterval(t); }, []);
  const msLeft = Math.max(0, target.getTime() - now.getTime());
  const cycleMs = CYCLE_MINUTES * 60 * 1000;

  // on exact/near zero: show popup, refetch hard, then roll to next target
  const crossedRef = useRef<number>(Date.now());
  useEffect(() => {
    if (msLeft <= 250) {
      // prevent repeat within same second
      const last = crossedRef.current;
      const nowTs = Date.now();
      if (nowTs - last > 800) {
        crossedRef.current = nowTs;

        // show popup for 3s
        setShowPopup(true);
        if (popupTimerRef.current) clearTimeout(popupTimerRef.current);
        popupTimerRef.current = setTimeout(() => setShowPopup(false), 3000);

        // rapid refresh burst around T0 to catch claim/swap + new balances
        (async () => {
          await loadRef.current!();
          setTimeout(() => loadRef.current && loadRef.current(), 1200);
          setTimeout(() => loadRef.current && loadRef.current(), 2500);
        })();

        // set the brand-new target immediately
        setTarget(nextCycleBoundary(new Date(nowTs + 500)));
      }
    }
  }, [msLeft]);

  const estPerApe = enriched.totalApes ? Math.floor(toNum(pool, 0) / enriched.totalApes) : 0;
  const isLoading = holders === null;

  return (
    <div className="h-screen w-full bg-white text-neutral-900 md:overflow-hidden overflow-y-auto">
      {/* Popup */}
      <DropPopup show={showPopup} />

      {/* Header */}
      <div className="sticky top-0 z-30 grid grid-cols-[1fr_auto_1fr] items-center border-b border-yellow-200/80 bg-white/90 px-4 py-3 backdrop-blur">
        <div className="flex items-center gap-2">
          <CAHeaderPill
            mint={mint}
            copied={copiedCA}
            onCopy={() => {
              const copyStr = mint && mint.length ? mint : '....PUMP';
              void copyToClipboard(copyStr);
              setCopiedCA(true);
              setTimeout(() => setCopiedCA(false), 1200);
            }}
          />
        </div>
        <div className="flex items-center justify-center"><img src="/banana-pixel.png" alt="logo" className="w-10 h-10 image-pixelate" /></div>
        <div className="flex justify-end">
          <a href="https://x.com/banana4apes" target="_blank" rel="noopener noreferrer"
             className="active:translate-y-0.5 relative inline-flex items-center justify-center rounded-xl border-2 border-yellow-400 bg-yellow-300 w-10 h-10 font-black text-black shadow-[0_4px_0_#facc15] transition-transform hover:-translate-y-0.5"
             style={{ fontFamily: '"Press Start 2P", Pixelify Sans, system-ui, sans-serif' }}
          >X</a>
        </div>
      </div>

      {/* Body grid */}
      <div className="mx-auto grid h-[calc(100vh-64px-48px)] max-w-6xl grid-cols-1 gap-4 px-4 py-4 sm:grid-cols-12 relative">
        <div className="pointer-events-none hidden sm:block absolute inset-y-2 w-px opacity-70" style={{ left: '41.666%', background: 'linear-gradient(180deg, transparent 0%, #fde047 35%, #fde047 65%, transparent 100%)' }} />

        {/* Left column */}
        <div className="sm:col-span-5 flex flex-col gap-4">
          <NextDropCard msLeft={msLeft} cycleMs={cycleMs} />
          <div className="grid grid-cols-2 gap-3 relative">
            <div className="pointer-events-none absolute inset-y-1 left-1/2 -translate-x-1/2 w-px opacity-60 hidden sm:block" style={{ background: 'linear-gradient(180deg, transparent, #fde047, transparent)' }} />
            <StatCard
              label="Total Apes"
              value={enriched.totalApes.toLocaleString()}
              tooltip={{ title: 'APE definition', body: 'Your APEs = floor($BANANA / 100,000). APEs determine your share of each 5-minute drop.' }}
            />
            <StatCard
              label="Reward Pool ($BANANA)"
              value={pool == null ? '--' : Math.floor(toNum(pool, 0)).toLocaleString()}
              tooltip={{ title: 'Buyback pool', body: 'Creator rewards are used to buy back $BANANA before each 5-minute drop. Snapshot can occur at a random moment within the window.' }}
            />
            <StatCard
              label="Est. per APE ($BANANA)"
              value={enriched.totalApes ? estPerApe.toLocaleString() : '--'}
              tooltip={{ title: 'Estimation', body: 'Estimated drop per APE = Reward Pool / Total Apes (actual distribution at T−10s based on APEs).' }}
            />
            <StatCard
              label="Cycle Length"
              value={`${CYCLE_MINUTES} min`}
              tooltip={{ title: 'Cycle', body: 'A new drop happens every 5 minutes.' }}
            />
          </div>

          {/* Market Cap strip */}
          <MarketCapStrip valueUsd={market.marketCapUsd} delta={mcDelta} />

          {/* Ops readout (two blocks, your requested UI) */}
          {(ops?.lastClaim || ops?.lastSwap) && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {ops?.lastClaim && (
                <div className="relative rounded-2xl border-2 border-yellow-300 bg-white px-4 py-3 shadow-[0_6px_0_#facc15]">
                  <div className="flex items-center justify-between">
                    <div className="text-[10px] uppercase tracking-widest text-neutral-500/80">Latest Creator Rewards Claimed</div>
                    <PulsingDot />
                  </div>
                  <div className="mt-1 text-2xl font-black text-yellow-600" style={{ fontFamily: '"Press Start 2P", Pixelify Sans, system-ui, sans-serif' }}>
                    {Math.floor(ops.lastClaim.amount).toLocaleString()}
                  </div>
                  <div className="mt-1 text-xs">
                    {ops.lastClaim.tx ? (
                      <a className="underline hover:no-underline" href={solscanTx(ops.lastClaim.tx)!} target="_blank" rel="noopener noreferrer">solscan tx</a>
                    ) : <span className="text-neutral-400">tx pending</span>}
                    <span className="opacity-60"> • {new Date(ops.lastClaim.at).toLocaleTimeString()}</span>
                  </div>
                </div>
              )}
              {ops?.lastSwap && (
                <div className="relative rounded-2xl border-2 border-yellow-300 bg-white px-4 py-3 shadow-[0_6px_0_#facc15]">
                  <div className="flex items-center justify-between">
                    <div className="text-[10px] uppercase tracking-widest text-neutral-500/80">$BANANA Swapped</div>
                    <PulsingDot />
                  </div>
                  <div className="mt-1 text-2xl font-black text-yellow-600" style={{ fontFamily: '"Press Start 2P", Pixelify Sans, system-ui, sans-serif' }}>
                    {Math.floor(ops.lastSwap.amount).toLocaleString()}
                  </div>
                  <div className="mt-1 text-xs">
                    {ops.lastSwap.tx ? (
                      <a className="underline hover:no-underline" href={solscanTx(ops.lastSwap.tx)!} target="_blank" rel="noopener noreferrer">solscan tx</a>
                    ) : <span className="text-neutral-400">tx pending</span>}
                    <span className="opacity-60"> • {new Date(ops.lastSwap.at).toLocaleTimeString()}</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right column */}
        <div className="sm:col-span-7 flex flex-col gap-4">
          <div className="rounded-2xl border-2 border-yellow-200 bg-white p-4 shadow-[0_6px_0_#fde68a]">
            <div className="mb-2 flex items-center gap-2"><PulsingDot /><div className="text-sm font-black" style={{ fontFamily: '"Press Start 2P", Pixelify Sans, system-ui, sans-serif' }}>How it works?</div></div>
            <ul className="list-disc pl-5 text-base text-neutral-700 leading-7">
              <li>Every <b>5 minutes</b>, creator rewards are claimed, swapped into $BANANA, then a snapshot is taken at <b>T−30/-10s</b>.</li>
              <li><b>1 APE = {APE_UNIT.toLocaleString()} $BANANA</b>. Your APEs = <b>floor</b>(your $BANANA / {APE_UNIT.toLocaleString()}).</li>
              <li>Distribution is proportional to <b>APEs</b>. Wallets without an open $BANANA token account (ATA) are skipped.</li>
            </ul>
          </div>

          <div className="flex-1 min-h-0 rounded-2xl border-2 border-yellow-300 bg-white p-4 shadow-[0_8px_0_#facc15]">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2"><PulsingDot /><div className="text-sm font-black" style={{ fontFamily: '"Press Start 2P", Pixelify Sans, system-ui, sans-serif' }}>Apelist</div></div>
              <div className="flex items-center gap-2"><PixelInput placeholder="Search wallet…" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
            </div>

            <div ref={tableBoxRef} className="h-[calc(100%-92px)] overflow-hidden rounded-xl border border-yellow-200 pr-2">
              <table className="w-full table-fixed">
                <thead>
                  <tr className="bg-yellow-50 text-xs uppercase tracking-widest text-neutral-600">
                    <th className="py-2 pl-3 pr-2 text-left">Rank</th>
                    <th className="py-2 px-2 text-left">Wallet</th>
                    <th className="py-2 px-2 text-right">$BANANA</th>
                    <th className="py-2 pr-3 pl-2 text-right">APEs</th>
                  </tr>
                </thead>
                <tbody ref={tbodyRef}>
                  {isLoading && (<tr><td colSpan={4} className="py-6 text-center text-sm text-neutral-500">Loading holders...</td></tr>)}
                  {!isLoading && filtered.length === 0 && (<tr><td colSpan={4} className="py-6 text-center text-sm text-neutral-500">No matches.</td></tr>)}
                  {!isLoading && pageRows.map((r, i) => (
                    <HolderRow
                      key={r.wallet}
                      renderIdx={start + i}
                      rank={rankByWallet.get(r.wallet) ?? (start + i + 1)}
                      wallet={r.wallet}
                      tokens={r.tokens}
                      apes={r.apes}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-3 flex items-center justify-between">
              <div className="text-xs text-neutral-500">Page {page} / {maxPage} • {filtered.length.toLocaleString()} wallets • showing {Math.min(pageRows.length, rowsPerPage)} / page</div>
              <div className="flex items-center gap-2">
                <PixelIconButton onClick={() => setPage(1)} aria-label="First" className="w-8 h-8">«</PixelIconButton>
                <PixelIconButton onClick={() => setPage(p => Math.max(1, p-1))} aria-label="Prev" className="w-8 h-8">‹</PixelIconButton>
                <PixelIconButton onClick={() => setPage(p => Math.min(maxPage, p+1))} aria-label="Next" className="w-8 h-8">›</PixelIconButton>
                <PixelIconButton onClick={() => setPage(maxPage)} aria-label="Last" className="w-8 h-8">»</PixelIconButton>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="fixed bottom-0 left-0 right-0 z-30 border-t border-yellow-200/80 bg-white/95 px-4 py-2 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-center gap-3 text-[11px] text-neutral-500 text-center">
          <span>(c) {new Date().getFullYear()} $BANANA — All rights reserved.</span>
          <span className="opacity-80">Made with 🍌 for Apes</span>
        </div>
      </footer>

      <style>{`
        .image-pixelate { image-rendering: pixelated; }
        @keyframes pulse-soft { 0% { transform: scale(0.95); opacity: 0.6; } 50% { transform: scale(1.05); opacity: 0.25; } 100% { transform: scale(0.95); opacity: 0.6; } }
        .animate-pulse-soft { animation: pulse-soft 1.6s ease-in-out infinite; }
        .pump-pulse { color: #facc15; font-weight: 900; animation: pulse-soft 1.4s ease-in-out infinite; }
      `}</style>
    </div>
  );
}


