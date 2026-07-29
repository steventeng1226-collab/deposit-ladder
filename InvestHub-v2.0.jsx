// ============================================================
//  投資理財 App  v2.0   (前身：定存階梯 v1.1)
//  越南 VND 定存（美元基準）＋ 台股（TWD 基準）統一看盤
//  架構：React .jsx / localStorage(主) + GAS ⇄ Google Sheets(雙向)
//  匯率：fawazahmed0 currency-api｜台股報價：GAS→Yahoo Finance
//  v2.0：改名、多模組(總覽/定存/台股)、股票停損停利紀律儀表、PWA
//  版本：v2.0  (2026-07)
// ============================================================
// ============================================================

import React, { useState, useEffect, useMemo, useRef } from 'react';

/* ---------- 安全儲存 (localStorage 失效時退回記憶體) ---------- */
const memStore = {};
const store = {
  get(k) {
    try { const v = localStorage.getItem(k); return v == null ? null : v; }
    catch (e) { return memStore[k] ?? null; }
  },
  set(k, v) {
    try { localStorage.setItem(k, v); }
    catch (e) { memStore[k] = v; }
  },
};
const loadJSON = (k, fallback) => {
  const raw = store.get(k);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (e) { return fallback; }
};
const saveJSON = (k, v) => store.set(k, JSON.stringify(v));

/* ---------- 日期 / 數字工具 ---------- */
const pad = (n) => String(n).padStart(2, '0');
const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseISO = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const todayISO = () => toISO(new Date());
const addMonths = (iso, n) => { const d = parseISO(iso); d.setMonth(d.getMonth() + Number(n)); return toISO(d); };
const daysBetween = (a, b) => Math.round((parseISO(b) - parseISO(a)) / 86400000);
const ms = (iso) => parseISO(iso).getTime();
const fmtDate = (iso) => { if (!iso) return '—'; const d = parseISO(iso); return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`; };
const monthsUntil = (a, b) => {
  const da = parseISO(a), db = parseISO(b);
  let m = (db.getFullYear() - da.getFullYear()) * 12 + (db.getMonth() - da.getMonth());
  if (db.getDate() < da.getDate()) m -= 1;
  return m;
};

const fmtVND = (n) => (n == null || isNaN(n)) ? '—' : Math.round(n).toLocaleString('en-US');
const fmtUSD = (n) => (n == null || isNaN(n)) ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtRate = (n) => (n == null || isNaN(n)) ? '—' : Math.round(n).toLocaleString('en-US');
const fmtPct = (n) => (n == null || isNaN(n)) ? '—' : (n >= 0 ? '+' : '') + n.toFixed(2) + '%';

/* ---------- 定存計算 ---------- */
function calcDeposit(d) {
  const maturityDate = addMonths(d.startDate, d.termMonths);
  const days = daysBetween(d.startDate, maturityDate);
  const amt = Number(d.amountVND) || 0;
  const rate = Number(d.annualRate) || 0;
  const cr = Number(d.convertRate) || 0;
  const interest = amt * (rate / 100) * (days / 365);
  const total = amt + interest;
  const usdCost = cr > 0 ? amt / cr : 0;
  const breakeven = usdCost > 0 ? total / usdCost : 0;
  return { maturityDate, days, interest, total, usdCost, breakeven };
}

/* ---------- 股票計算（台股 / TWD） ---------- */
function calcStock(s, q, dividends) {
  const shares = Number(s.shares) || 0;
  const cps = Number(s.costPerShare) || 0;
  const cost = shares * cps;
  const price = (q && q.price != null) ? Number(q.price) : null;
  const stopPct = s.stopLossPct != null && s.stopLossPct !== '' ? Number(s.stopLossPct) : 10;
  const tpPct = s.takeProfitPct != null && s.takeProfitPct !== '' ? Number(s.takeProfitPct) : 20;
  const stopPrice = cps * (1 - stopPct / 100);
  const profitPrice = cps * (1 + tpPct / 100);
  const mv = price != null ? price * shares : null;
  const upnl = price != null ? (price - cps) * shares : null;
  const upnlPct = (price != null && cps > 0) ? (price / cps - 1) * 100 : null;
  const distStop = (price != null && stopPrice > 0) ? (price / stopPrice - 1) * 100 : null;   // 現價高於停損 %
  const distProfit = (price != null) ? (profitPrice / price - 1) * 100 : null;                 // 距停利 %
  const rr = stopPct > 0 ? tpPct / stopPct : null;
  let status = 'normal';
  if (price != null) { if (price <= stopPrice) status = 'stop'; else if (price >= profitPrice) status = 'profit'; }
  const sym = String(s.symbol).trim();
  const divTotal = (dividends || []).filter((d) => String(d.symbol).trim() === sym).reduce((a, d) => a + (Number(d.amount) || 0), 0);
  const totalReturn = (upnl != null ? upnl : 0) + divTotal;
  return { shares, cps, cost, price, stopPct, tpPct, stopPrice, profitPrice, mv, upnl, upnlPct, distStop, distProfit, rr, status, divTotal, totalReturn };
}

/* ---------- 匯率 API ---------- */
const TERMS = [3, 6, 9, 12, 13, 18];

async function fetchVNDon(dateStr, timeoutMs = 8000) {
  const urls = [
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${dateStr}/v1/currencies/usd.json`,
    `https://${dateStr}.currency-api.pages.dev/v1/currencies/usd.json`,
  ];
  for (const u of urls) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const r = await fetch(u, { signal: ctrl.signal });
      clearTimeout(t);
      if (r.ok) {
        const j = await r.json();
        const vnd = j && j.usd && j.usd.vnd;
        if (vnd) return vnd;
      }
    } catch (e) { /* try next */ }
  }
  return null;
}

function pastMonthlyDates(n) {
  const arr = [];
  const now = new Date();
  for (let i = n; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    arr.push(toISO(d));
  }
  return arr;
}

/* ---------- GAS 同步 ---------- */
async function gasGet(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(t);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
async function gasPost(url, payload, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // 用純文字送出避免 CORS preflight
    const r = await fetch(url, { method: 'POST', body: JSON.stringify(payload), redirect: 'follow' });
    clearTimeout(t);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

/* ---------- 照片壓縮（Cloudinary 標準：最長邊 1200 / JPEG 75%）---------- */
function compressImage(file, maxDim = 1200, quality = 0.75) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      let { width, height } = img;
      if (width > height && width > maxDim) { height = Math.round(height * maxDim / width); width = maxDim; }
      else if (height > maxDim) { width = Math.round(width * maxDim / height); height = maxDim; }
      const cv = document.createElement('canvas');
      cv.width = width; cv.height = height;
      cv.getContext('2d').drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      const dataUrl = cv.toDataURL('image/jpeg', quality);
      resolve(dataUrl.split(',')[1]); // 只回 base64 內容
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('圖片讀取失敗')); };
    img.src = url;
  });
}

/* ---------- 貼照片 → GAS proxy → Claude 解析 ---------- */
async function parsePhotoViaGAS(gasUrl, token, file, timeoutMs = 45000) {
  if (!gasUrl) throw new Error('尚未設定 GAS 網址');
  const b64 = await compressImage(file);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(gasUrl, {
      method: 'POST', redirect: 'follow',
      body: JSON.stringify({ action: 'parse', token, image: b64, media_type: 'image/jpeg' }),
    });
    clearTimeout(t);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || '解析失敗');
    return j.parsed || {};
  } finally { clearTimeout(t); }
}

/* ============================================================
   SVG 折線圖
   series: [{type:'line'|'scatter'|'hline', color, dashed, label, data:[{x,y}], value}]
   ============================================================ */
function Chart({ series, height = 240, yFmt = (v) => v, xIsDate = true, yPad = 0.06 }) {
  const W = 340, H = height, padL = 46, padR = 14, padT = 14, padB = 26;
  const pts = [];
  series.forEach((s) => {
    if (s.type === 'hline') return;
    (s.data || []).forEach((p) => pts.push(p));
  });
  const hasData = pts.length > 0;
  let xMin = 0, xMax = 1, yMin = 0, yMax = 1;
  if (hasData) {
    xMin = Math.min(...pts.map((p) => p.x));
    xMax = Math.max(...pts.map((p) => p.x));
    yMin = Math.min(...pts.map((p) => p.y));
    yMax = Math.max(...pts.map((p) => p.y));
    series.forEach((s) => { if (s.type === 'hline' && s.value != null) { yMin = Math.min(yMin, s.value); yMax = Math.max(yMax, s.value); } });
    if (xMin === xMax) { xMin -= 86400000; xMax += 86400000; }
    const span = (yMax - yMin) || Math.abs(yMax) || 1;
    yMin -= span * yPad; yMax += span * yPad;
  }
  const sx = (x) => padL + ((x - xMin) / (xMax - xMin || 1)) * (W - padL - padR);
  const sy = (y) => padT + (1 - (y - yMin) / (yMax - yMin || 1)) * (H - padT - padB);

  const yTicks = [];
  for (let i = 0; i <= 3; i++) yTicks.push(yMin + ((yMax - yMin) * i) / 3);
  const xTicks = [];
  if (hasData) for (let i = 0; i <= 3; i++) xTicks.push(xMin + ((xMax - xMin) * i) / 3);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block' }}>
      {yTicks.map((v, i) => (
        <g key={'y' + i}>
          <line x1={padL} y1={sy(v)} x2={W - padR} y2={sy(v)} stroke="#243049" strokeWidth="1" />
          <text x={padL - 6} y={sy(v) + 3} fontSize="9" fill="#7688a3" textAnchor="end">{yFmt(v)}</text>
        </g>
      ))}
      {hasData && xTicks.map((v, i) => (
        <text key={'x' + i} x={sx(v)} y={H - 8} fontSize="9" fill="#7688a3" textAnchor="middle">
          {xIsDate ? `${new Date(v).getMonth() + 1}/${new Date(v).getFullYear() % 100}` : Math.round(v)}
        </text>
      ))}
      {series.map((s, si) => {
        if (s.type === 'hline') {
          if (s.value == null) return null;
          return <line key={si} x1={padL} y1={sy(s.value)} x2={W - padR} y2={sy(s.value)}
            stroke={s.color} strokeWidth="1.5" strokeDasharray="5 4" opacity="0.9" />;
        }
        if (s.type === 'scatter') {
          return (s.data || []).map((p, pi) => (
            <circle key={si + '-' + pi} cx={sx(p.x)} cy={sy(p.y)} r="4" fill={s.color} stroke="#0e1420" strokeWidth="1.5" />
          ));
        }
        // line
        const d = (s.data || []).slice().sort((a, b) => a.x - b.x)
          .map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
        return <path key={si} d={d} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />;
      })}
      {!hasData && <text x={W / 2} y={H / 2} fontSize="11" fill="#7688a3" textAnchor="middle">尚無資料</text>}
    </svg>
  );
}

/* ---------- 損益平衡儀表（招牌元件） ---------- */
function BreakevenGauge({ wavgCost, breakeven, sellRate }) {
  if (!breakeven) return null;
  const lo = Math.min(wavgCost || breakeven, breakeven, sellRate || breakeven) * 0.985;
  const hi = breakeven * 1.02;
  const pos = (v) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
  const inProfit = sellRate && sellRate < breakeven;
  const cushion = sellRate ? ((breakeven - sellRate) / sellRate) * 100 : null;
  return (
    <div style={{ marginTop: 14 }}>
      <div className="dl-row" style={{ marginBottom: 6 }}>
        <span className="dl-muted" style={{ fontSize: 12 }}>損益平衡緩衝</span>
        {cushion != null && (
          <span style={{ fontSize: 12, fontWeight: 700, color: inProfit ? '#3ecf8e' : '#f2647a' }}>
            {inProfit ? `還有 ${cushion.toFixed(1)}% 空間` : `已低於平衡 ${Math.abs(cushion).toFixed(1)}%`}
          </span>
        )}
      </div>
      <div style={{ position: 'relative', height: 30 }}>
        <div style={{ position: 'absolute', top: 13, left: 0, right: 0, height: 5, borderRadius: 3, background: 'linear-gradient(90deg,#25543f,#3ecf8e33)' }} />
        {/* breakeven marker */}
        <Marker x={pos(breakeven)} color="#f2647a" label="平衡" val={fmtRate(breakeven)} />
        {wavgCost ? <Marker x={pos(wavgCost)} color="#d4a544" label="成本" val={fmtRate(wavgCost)} /> : null}
        {sellRate ? <Marker x={pos(sellRate)} color="#5b9bd5" label="現價" val={fmtRate(sellRate)} up /> : null}
      </div>
    </div>
  );
}
function Marker({ x, color, label, val, up }) {
  return (
    <div style={{ position: 'absolute', left: `${x}%`, top: 0, transform: 'translateX(-50%)', textAlign: 'center' }}>
      {up && <div style={{ fontSize: 8, color, fontWeight: 700 }}>{label}</div>}
      <div style={{ width: 2, height: 16, background: color, margin: '0 auto' }} />
      {!up && <div style={{ fontSize: 8, color, fontWeight: 700 }}>{label}</div>}
      <div style={{ fontSize: 8, color: '#9fb0c9' }}>{val}</div>
    </div>
  );
}

/* ============================================================
   主程式
   ============================================================ */
export default function App() {
  const [view, setView] = useState('overview');   // overview | deposit | stock
  const [depTab, setDepTab] = useState('list');    // list | charts | rates
  const [showSettings, setShowSettings] = useState(false);
  const [deposits, setDeposits] = useState(() => loadJSON('dl_deposits', []));
  const [rateLog, setRateLog] = useState(() => loadJSON('dl_ratelog', []));
  const [stocks, setStocks] = useState(() => loadJSON('dl_stocks', []));
  const [dividends, setDividends] = useState(() => loadJSON('dl_dividends', []));
  const [quotes, setQuotes] = useState(() => loadJSON('dl_quotes', {}));
  const [settings, setSettings] = useState(() => loadJSON('dl_settings', { bankName: '', residenceExpiry: '', gasUrl: '', sellRate: '', appToken: '' }));
  const [fxCache, setFxCache] = useState(() => loadJSON('dl_fxcache', {}));
  const [sync, setSync] = useState({ state: 'idle', msg: '' });
  const [quoteMsg, setQuoteMsg] = useState('');

  const persist = (kind, val) => {
    const next = { deposits, rateLog, stocks, dividends, settings };
    if (kind === 'deposits') { setDeposits(val); saveJSON('dl_deposits', val); next.deposits = val; }
    if (kind === 'ratelog') { setRateLog(val); saveJSON('dl_ratelog', val); next.rateLog = val; }
    if (kind === 'stocks') { setStocks(val); saveJSON('dl_stocks', val); next.stocks = val; }
    if (kind === 'dividends') { setDividends(val); saveJSON('dl_dividends', val); next.dividends = val; }
    if (kind === 'settings') { setSettings(val); saveJSON('dl_settings', val); next.settings = val; }
    pushGAS(next);
  };

  /* ---- GAS 雙向 ---- */
  const pushGAS = async (d) => {
    if (!d.settings.gasUrl) return;
    setSync({ state: 'syncing', msg: '同步中…' });
    try {
      await gasPost(d.settings.gasUrl, { action: 'save', token: d.settings.appToken || '', deposits: d.deposits, rateLog: d.rateLog, stocks: d.stocks, dividends: d.dividends, settings: d.settings });
      setSync({ state: 'ok', msg: '已同步' });
    } catch (e) { setSync({ state: 'err', msg: '同步失敗（已存本機）' }); }
  };
  const pullGAS = async (url) => {
    if (!url) return;
    setSync({ state: 'syncing', msg: '讀取中…' });
    try {
      const tok = settings.appToken || '';
      const full = tok ? url + (url.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(tok) : url;
      const data = await gasGet(full);
      if (data && data.ok) {
        if (Array.isArray(data.deposits)) { setDeposits(data.deposits); saveJSON('dl_deposits', data.deposits); }
        if (Array.isArray(data.rateLog)) { setRateLog(data.rateLog); saveJSON('dl_ratelog', data.rateLog); }
        if (Array.isArray(data.stocks)) { setStocks(data.stocks); saveJSON('dl_stocks', data.stocks); }
        if (Array.isArray(data.dividends)) { setDividends(data.dividends); saveJSON('dl_dividends', data.dividends); }
        if (data.settings && typeof data.settings === 'object') {
          const merged = { ...data.settings, gasUrl: url };
          setSettings(merged); saveJSON('dl_settings', merged);
        }
        setSync({ state: 'ok', msg: '已從雲端載入' });
      } else setSync({ state: 'err', msg: '雲端無資料' });
    } catch (e) { setSync({ state: 'err', msg: '雲端讀取失敗' }); }
  };

  /* ---- 台股報價（GAS → Yahoo） ---- */
  const refreshQuotes = async () => {
    const syms = Array.from(new Set(stocks.map((s) => String(s.symbol).trim()).filter(Boolean)));
    if (!syms.length) return;
    if (!settings.gasUrl) { setQuoteMsg('請先在設定頁填 GAS 網址'); return; }
    setQuoteMsg('更新報價中…');
    try {
      const r = await gasPost(settings.gasUrl, { action: 'quote', token: settings.appToken || '', symbols: syms });
      if (r && r.ok && r.quotes) {
        const merged = { ...quotes };
        Object.keys(r.quotes).forEach((k) => { merged[k] = Object.assign({}, r.quotes[k], { t: Date.now() }); });
        setQuotes(merged); saveJSON('dl_quotes', merged);
        setQuoteMsg('報價已更新 ' + new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }));
      } else setQuoteMsg('報價取得失敗');
    } catch (e) { setQuoteMsg('報價取得失敗：' + (e.message || e)); }
  };

  useEffect(() => { if (settings.gasUrl) pullGAS(settings.gasUrl); /* eslint-disable-next-line */ }, []);

  /* ---- 匯率回補 ---- */
  useEffect(() => {
    (async () => {
      const cache = { ...fxCache };
      const dates = pastMonthlyDates(12);
      let changed = false;
      for (const d of dates) { if (cache[d] == null) { const v = await fetchVNDon(d); if (v) { cache[d] = v; changed = true; } } }
      const v = await fetchVNDon('latest'); if (v) { cache[todayISO()] = v; changed = true; }
      if (changed) { setFxCache(cache); saveJSON('dl_fxcache', cache); }
    })();
    /* eslint-disable-next-line */
  }, []);

  /* ---- 衍生數據 ---- */
  const rows = useMemo(() => deposits.map((d) => ({ ...d, calc: calcDeposit(d) })), [deposits]);
  const port = useMemo(() => {
    const totalVND = rows.reduce((s, r) => s + (Number(r.amountVND) || 0), 0);
    const totalUsdCost = rows.reduce((s, r) => s + r.calc.usdCost, 0);
    const totalMaturity = rows.reduce((s, r) => s + r.calc.total, 0);
    const wavgCost = totalUsdCost > 0 ? totalVND / totalUsdCost : 0;
    const breakeven = totalUsdCost > 0 ? totalMaturity / totalUsdCost : 0;
    const sell = Number(settings.sellRate) || 0;
    const curUSD = sell > 0 ? totalMaturity / sell : 0;
    const pnl = sell > 0 ? curUSD - totalUsdCost : 0;
    const pnlPct = totalUsdCost > 0 && sell > 0 ? (pnl / totalUsdCost) * 100 : null;
    return { totalVND, totalUsdCost, totalMaturity, wavgCost, breakeven, sell, curUSD, pnl, pnlPct };
  }, [rows, settings.sellRate]);

  const fxSeries = useMemo(() => {
    const market = Object.keys(fxCache).sort().map((d) => ({ x: ms(d), y: fxCache[d] }));
    const mine = deposits.filter((d) => d.convertDate && d.convertRate)
      .map((d) => ({ x: ms(d.convertDate), y: Number(d.convertRate) }));
    const s = [{ type: 'line', color: '#5b9bd5', data: market, label: '市場中間價' }];
    if (mine.length) s.push({ type: 'scatter', color: '#d4a544', data: mine, label: '我的換匯' });
    if (port.wavgCost) s.push({ type: 'hline', color: '#d4a544', value: port.wavgCost, label: '平均成本' });
    if (port.breakeven) s.push({ type: 'hline', color: '#f2647a', value: port.breakeven, label: '損益平衡' });
    return s;
  }, [fxCache, deposits, port]);

  /* ---- 股票衍生數據 ---- */
  const stockRows = useMemo(() => stocks.map((s) => {
    const q = quotes[String(s.symbol).trim()] || {};
    return Object.assign({}, s, { q, calc: calcStock(s, q, dividends) });
  }), [stocks, quotes, dividends]);
  const sport = useMemo(() => {
    const cost = stockRows.reduce((a, r) => a + r.calc.cost, 0);
    const mv = stockRows.reduce((a, r) => a + (r.calc.mv || 0), 0);
    const upnl = stockRows.reduce((a, r) => a + (r.calc.upnl || 0), 0);
    const div = stockRows.reduce((a, r) => a + r.calc.divTotal, 0);
    const total = upnl + div;
    const totalPct = cost > 0 ? (total / cost) * 100 : null;
    const priced = stockRows.some((r) => r.q && r.q.price);
    return { cost, mv, upnl, div, total, totalPct, priced };
  }, [stockRows]);

  useEffect(() => { if (settings.gasUrl && stocks.length) refreshQuotes(); /* eslint-disable-next-line */ }, [settings.gasUrl]);

  const subMap = { overview: '定存 · 台股 統一看盤', deposit: settings.bankName || '越南 VND · 美元基準', stock: '台股 · 台幣基準' };
  return (
    <div className="dl-app">
      <style>{CSS}</style>

      <header className="dl-head">
        <div>
          <div className="dl-title">投資理財</div>
          <div className="dl-sub">{subMap[view]}</div>
        </div>
        <div className="dl-headr">
          <span className={'dl-syncdot ' + sync.state} title={sync.msg} />
          <button className="dl-icon" onClick={() => setShowSettings(true)} aria-label="設定">⚙</button>
        </div>
      </header>

      <main className="dl-main">
        {view === 'overview' && (
          <>
            <Overview port={port} rows={rows} settings={settings} onSell={(v) => persist('settings', { ...settings, sellRate: v })} />
            <StockSummary sport={sport} count={stocks.length} onGo={() => setView('stock')} />
          </>
        )}

        {view === 'deposit' && (
          <>
            <div className="dl-seg">
              {[['list', '清單'], ['charts', '圖表'], ['rates', '利率']].map(([k, l]) => (
                <button key={k} className={depTab === k ? 'on' : ''} onClick={() => setDepTab(k)}>{l}</button>
              ))}
            </div>
            {depTab === 'list' && <Deposits rows={rows} settings={settings} onSave={(list) => persist('deposits', list)} />}
            {depTab === 'charts' && <Charts fxSeries={fxSeries} rateLog={rateLog} deposits={deposits} />}
            {depTab === 'rates' && <Rates rateLog={rateLog} onSave={(list) => persist('ratelog', list)} />}
          </>
        )}

        {view === 'stock' && (
          <Stocks stockRows={stockRows} sport={sport} quoteMsg={quoteMsg} dividends={dividends}
            onRefresh={refreshQuotes}
            onSaveStocks={(list) => persist('stocks', list)}
            onSaveDividends={(list) => persist('dividends', list)} />
        )}
      </main>

      <nav className="dl-nav">
        {[['overview', '總覽', '◆'], ['deposit', '定存', '▤'], ['stock', '台股', '▦']].map(([k, l, ic]) => (
          <button key={k} className={'dl-navb' + (view === k ? ' on' : '')} onClick={() => setView(k)}>
            <span className="dl-navic">{ic}</span><span>{l}</span>
          </button>
        ))}
      </nav>

      {showSettings && <Settings settings={settings} sync={sync}
        onClose={() => setShowSettings(false)}
        onSave={(s) => persist('settings', s)}
        onPull={() => pullGAS(settings.gasUrl)} />}
    </div>
  );
}

/* ---------- 總覽 ---------- */
function Overview({ port, rows, settings, onSell }) {
  const next = rows.slice().sort((a, b) => ms(a.calc.maturityDate) - ms(b.calc.maturityDate))
    .find((r) => ms(r.calc.maturityDate) >= Date.now());
  return (
    <div>
      <div className="dl-card dl-hero">
        <div className="dl-heroTop">
          <div>
            <div className="dl-muted" style={{ fontSize: 12 }}>美元總成本</div>
            <div className="dl-big">${fmtUSD(port.totalUsdCost)}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="dl-muted" style={{ fontSize: 12 }}>估到期損益</div>
            <div className="dl-big" style={{ color: port.pnl >= 0 ? '#3ecf8e' : '#f2647a' }}>
              {port.sell ? (port.pnl >= 0 ? '+' : '') + '$' + fmtUSD(port.pnl) : '—'}
            </div>
            <div style={{ fontSize: 12, color: port.pnl >= 0 ? '#3ecf8e' : '#f2647a' }}>{port.pnlPct != null ? fmtPct(port.pnlPct) : ''}</div>
          </div>
        </div>

        <div className="dl-grid3">
          <Stat label="總投入 VND" val={fmtVND(port.totalVND)} />
          <Stat label="平均成本匯率" val={fmtRate(port.wavgCost)} unit="₫/$" />
          <Stat label="整體損益平衡" val={fmtRate(port.breakeven)} unit="₫/$" accent />
        </div>

        <BreakevenGauge wavgCost={port.wavgCost} breakeven={port.breakeven} sellRate={port.sell} />

        <div className="dl-sellbox">
          <label className="dl-muted" style={{ fontSize: 12 }}>今日銀行美元賣價（算即時損益）</label>
          <input className="dl-input" inputMode="numeric" placeholder="例：26700"
            value={settings.sellRate || ''} onChange={(e) => onSell(e.target.value.replace(/[^0-9.]/g, ''))} />
        </div>
      </div>

      {next && (
        <div className="dl-card">
          <div className="dl-muted" style={{ fontSize: 12, marginBottom: 4 }}>下一筆到期</div>
          <div className="dl-row">
            <b>{fmtVND(next.calc.total)} ₫</b>
            <span className="dl-muted">{fmtDate(next.calc.maturityDate)}</span>
          </div>
          <div className="dl-muted" style={{ fontSize: 12, marginTop: 2 }}>
            剩 {Math.max(0, daysBetween(todayISO(), next.calc.maturityDate))} 天 · 損益平衡 {fmtRate(next.calc.breakeven)} ₫/$
          </div>
        </div>
      )}
      {rows.length === 0 && <Empty text="還沒有定存。到「定存」分頁新增第一筆。" />}
    </div>
  );
}
function Stat({ label, val, unit, accent }) {
  return (
    <div className="dl-stat">
      <div className="dl-muted" style={{ fontSize: 11 }}>{label}</div>
      <div style={{ fontWeight: 700, color: accent ? '#f2647a' : '#e6ebf2' }}>{val}<span className="dl-unit">{unit || ''}</span></div>
    </div>
  );
}

/* ---------- 定存清單 + 表單 ---------- */
function Deposits({ rows, settings, onSave }) {
  const [form, setForm] = useState(null);
  const [photo, setPhoto] = useState({ busy: false, msg: '' });
  const fileRef = useRef(null);
  const blank = { id: '', convertDate: todayISO(), convertRate: '', amountVND: '', startDate: todayISO(), termMonths: 13, annualRate: '' };

  const onPhoto = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!settings.gasUrl) { setPhoto({ busy: false, msg: '請先在設定頁填 GAS 網址' }); return; }
    setPhoto({ busy: true, msg: '讀取中…' });
    try {
      const p = await parsePhotoViaGAS(settings.gasUrl, settings.appToken || '', file);
      const next = { ...form };
      let note = '';
      if (p.type === 'deposit') {
        if (p.amountVND != null) next.amountVND = String(p.amountVND);
        if (p.startDate) next.startDate = p.startDate;
        if (p.termMonths != null) next.termMonths = Number(p.termMonths);
        if (p.annualRate != null) next.annualRate = String(p.annualRate);
        // 對帳：拿銀行利息比對 App 自算
        if (p.bankInterest != null && next.amountVND && next.annualRate) {
          const mine = calcDeposit(next).interest;
          const diff = Math.abs(mine - Number(p.bankInterest));
          note = diff <= Math.max(50, mine * 0.005)
            ? `✓ 利息對帳一致（銀行 ${fmtVND(p.bankInterest)}）`
            : `⚠ 利息與銀行不符：App ${fmtVND(mine)} vs 銀行 ${fmtVND(p.bankInterest)}`;
        }
        setPhoto({ busy: false, msg: note || '已填入定存資料，記得補換匯匯率/換匯日' });
      } else if (p.type === 'fx') {
        if (p.convertDate) next.convertDate = p.convertDate;
        if (p.convertRate != null) next.convertRate = String(p.convertRate);
        setPhoto({ busy: false, msg: '已填入換匯日/匯率' });
      } else {
        setPhoto({ busy: false, msg: '認不出這張截圖，請確認是定存或換匯確認畫面' });
      }
      setForm(next);
    } catch (err) {
      setPhoto({ busy: false, msg: '解析失敗：' + (err.message || err) });
    }
  };

  const guard = useMemo(() => {
    if (!form || !settings.residenceExpiry) return null;
    const mat = addMonths(form.startDate, form.termMonths);
    const over = ms(mat) > ms(settings.residenceExpiry);
    const maxM = monthsUntil(form.startDate, settings.residenceExpiry);
    return { over, maxM, mat };
  }, [form, settings.residenceExpiry]);

  const save = () => {
    const f = { ...form };
    if (!f.convertRate || !f.amountVND || !f.annualRate) { alert('請填換匯匯率、定存金額、年利率'); return; }
    let list;
    if (f.id) list = rows.map((r) => (r.id === f.id ? f : stripCalc(r)));
    else { f.id = 'd' + Date.now(); list = [...rows.map(stripCalc), f]; }
    onSave(list);
    setForm(null);
  };
  const del = (id) => { if (confirm('刪除這筆定存？')) onSave(rows.filter((r) => r.id !== id).map(stripCalc)); };

  const sorted = rows.slice().sort((a, b) => ms(a.calc.maturityDate) - ms(b.calc.maturityDate));

  return (
    <div>
      {!form && <button className="dl-primary" onClick={() => setForm(blank)}>＋ 新增定存</button>}

      {form && (
        <div className="dl-card">
          <div className="dl-formTitle">{form.id ? '編輯定存' : '新增定存（1 換匯 = 1 定存）'}</div>

          <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onPhoto} />
          <button className="dl-photo" disabled={photo.busy} onClick={() => fileRef.current && fileRef.current.click()}>
            {photo.busy ? '解析中…' : '📷 貼照片自動填（定存或換匯確認畫面）'}
          </button>
          {photo.msg && <div className={'dl-photomsg' + (photo.msg.indexOf('⚠') >= 0 || photo.msg.indexOf('失敗') >= 0 || photo.msg.indexOf('認不出') >= 0 ? ' warn' : '')}>{photo.msg}</div>}

          <Field label="換匯日" type="date" v={form.convertDate} on={(v) => setForm({ ...form, convertDate: v })} />
          <Field label="換匯匯率 ₫/$" v={form.convertRate} on={(v) => setForm({ ...form, convertRate: v })} ph="25931" num />
          <Field label="定存金額 VND" v={form.amountVND} on={(v) => setForm({ ...form, amountVND: v })} ph="30000000" num />
          <Field label="存入日" type="date" v={form.startDate} on={(v) => setForm({ ...form, startDate: v })} />
          <div className="dl-field">
            <label>天期（月）</label>
            <div className="dl-terms">
              {TERMS.map((t) => (
                <button key={t} className={'dl-term' + (Number(form.termMonths) === t ? ' on' : '')}
                  onClick={() => setForm({ ...form, termMonths: t })}>{t}M</button>
              ))}
            </div>
          </div>
          <Field label="年利率 %" v={form.annualRate} on={(v) => setForm({ ...form, annualRate: v })} ph="6.70" num />

          {guard && (
            <div className={'dl-guard' + (guard.over ? ' bad' : ' ok')}>
              🛂 到期日 {fmtDate(guard.mat)}｜居留證 {fmtDate(settings.residenceExpiry)}<br />
              {guard.over
                ? `到期晚於換證日！換證前最長可存約 ${Math.max(0, guard.maxM)} 個月`
                : `在換證日前到期，安全（換證前最長可存 ${guard.maxM} 個月）`}
            </div>
          )}

          <Preview f={form} />
          <div className="dl-row" style={{ gap: 8, marginTop: 12 }}>
            <button className="dl-ghost" onClick={() => setForm(null)}>取消</button>
            <button className="dl-primary" style={{ flex: 1 }} onClick={save}>儲存</button>
          </div>
        </div>
      )}

      {sorted.map((r) => {
        const overdue = ms(r.calc.maturityDate) < Date.now();
        const near = !overdue && daysBetween(todayISO(), r.calc.maturityDate) <= 30;
        return (
          <div key={r.id} className="dl-card dl-dep" onClick={() => setForm({ ...stripCalc(r) })}>
            <div className="dl-row">
              <b>{fmtVND(r.amountVND)} ₫</b>
              <span className={'dl-tag' + (overdue ? ' od' : near ? ' near' : '')}>
                {overdue ? '已到期' : `剩 ${daysBetween(todayISO(), r.calc.maturityDate)} 天`}
              </span>
            </div>
            <div className="dl-depmeta">
              {r.termMonths}M · {r.annualRate}% · 到期 {fmtDate(r.calc.maturityDate)}
            </div>
            <div className="dl-depgrid">
              <span>本利和 <b>{fmtVND(r.calc.total)}</b></span>
              <span>美元成本 <b>${fmtUSD(r.calc.usdCost)}</b></span>
              <span>換匯 <b>{fmtRate(r.convertRate)}</b></span>
              <span>平衡價 <b style={{ color: '#f2647a' }}>{fmtRate(r.calc.breakeven)}</b></span>
            </div>
            <button className="dl-del" onClick={(e) => { e.stopPropagation(); del(r.id); }}>刪除</button>
          </div>
        );
      })}
      {rows.length === 0 && !form && <Empty text="新增你的第一筆定存，App 會自動算到期本利和、美元成本與損益平衡價。" />}
    </div>
  );
}
const stripCalc = (r) => { const { calc, ...rest } = r; return rest; };

function Preview({ f }) {
  if (!f.convertRate || !f.amountVND || !f.annualRate) return null;
  const c = calcDeposit(f);
  return (
    <div className="dl-preview">
      <div className="dl-row"><span>到期日</span><b>{fmtDate(c.maturityDate)}（{c.days} 天）</b></div>
      <div className="dl-row"><span>利息</span><b>{fmtVND(c.interest)} ₫</b></div>
      <div className="dl-row"><span>到期本利和</span><b>{fmtVND(c.total)} ₫</b></div>
      <div className="dl-row"><span>美元成本</span><b>${fmtUSD(c.usdCost)}</b></div>
      <div className="dl-row"><span>損益平衡價</span><b style={{ color: '#f2647a' }}>{fmtRate(c.breakeven)} ₫/$</b></div>
    </div>
  );
}

/* ---------- 圖表 ---------- */
function Charts({ fxSeries, rateLog, deposits }) {
  const [view, setView] = useState('fx');
  const [term, setTerm] = useState(13);
  const rateSeries = useMemo(() => {
    const line = rateLog.filter((r) => r.rates && r.rates[term] != null)
      .map((r) => ({ x: ms(r.date), y: Number(r.rates[term]) }));
    const mine = deposits.filter((d) => Number(d.termMonths) === term && d.startDate && d.annualRate)
      .map((d) => ({ x: ms(d.startDate), y: Number(d.annualRate) }));
    const s = [{ type: 'line', color: '#3ecf8e', data: line }];
    if (mine.length) s.push({ type: 'scatter', color: '#d4a544', data: mine });
    return s;
  }, [rateLog, deposits, term]);

  return (
    <div>
      <div className="dl-seg">
        <button className={view === 'fx' ? 'on' : ''} onClick={() => setView('fx')}>匯率走勢</button>
        <button className={view === 'rate' ? 'on' : ''} onClick={() => setView('rate')}>利率走勢</button>
      </div>

      {view === 'fx' && (
        <div className="dl-card">
          <Chart series={fxSeries} yFmt={(v) => Math.round(v).toLocaleString('en-US')} />
          <Legend items={[['#5b9bd5', '市場中間價'], ['#d4a544', '我的換匯 / 平均成本'], ['#f2647a', '損益平衡']]} />
          <p className="dl-note">市場價來自公開 API（參考中間價）；你的換匯點通常略低於市場線，差距就是換匯價差。</p>
        </div>
      )}

      {view === 'rate' && (
        <div className="dl-card">
          <div className="dl-terms" style={{ marginBottom: 10 }}>
            {TERMS.map((t) => (
              <button key={t} className={'dl-term' + (term === t ? ' on' : '')} onClick={() => setTerm(t)}>{t}M</button>
            ))}
          </div>
          <Chart series={rateSeries} yFmt={(v) => v.toFixed(2)} />
          <Legend items={[['#3ecf8e', '銀行利率（今日利率記錄）'], ['#d4a544', '我實際鎖定']]} />
          <p className="dl-note">到「利率」分頁按下記錄，這條線就會長出來。可切換天期看不同期別的走勢。</p>
        </div>
      )}
    </div>
  );
}
function Legend({ items }) {
  return (
    <div className="dl-legend">
      {items.map(([c, l], i) => (
        <span key={i}><i style={{ background: c }} />{l}</span>
      ))}
    </div>
  );
}

/* ---------- 利率記錄 ---------- */
function Rates({ rateLog, onSave }) {
  const [form, setForm] = useState(null);
  const openNew = () => setForm({ id: '', date: todayISO(), rates: {} });
  const save = () => {
    const f = { ...form };
    const has = TERMS.some((t) => f.rates[t] != null && f.rates[t] !== '');
    if (!has) { alert('至少填一個天期的利率'); return; }
    const clean = {}; TERMS.forEach((t) => { if (f.rates[t] !== '' && f.rates[t] != null) clean[t] = Number(f.rates[t]); });
    f.rates = clean;
    let list;
    if (f.id) list = rateLog.map((r) => (r.id === f.id ? f : r));
    else { f.id = 'r' + Date.now(); list = [...rateLog, f]; }
    onSave(list);
    setForm(null);
  };
  const del = (id) => { if (confirm('刪除這筆利率記錄？')) onSave(rateLog.filter((r) => r.id !== id)); };
  const sorted = rateLog.slice().sort((a, b) => ms(b.date) - ms(a.date));

  return (
    <div>
      {!form && <button className="dl-primary" onClick={openNew}>＋ 記錄今日利率</button>}
      {form && (
        <div className="dl-card">
          <div className="dl-formTitle">記錄今日利率（照銀行利率圖輸入，個人 Cá nhân）</div>
          <Field label="日期" type="date" v={form.date} on={(v) => setForm({ ...form, date: v })} />
          <div className="dl-ratetable">
            {TERMS.map((t) => (
              <div key={t} className="dl-ratecell">
                <label>{t}M</label>
                <input className="dl-input" inputMode="decimal" placeholder="—"
                  value={form.rates[t] ?? ''} onChange={(e) => setForm({ ...form, rates: { ...form.rates, [t]: e.target.value.replace(/[^0-9.]/g, '') } })} />
              </div>
            ))}
          </div>
          <div className="dl-row" style={{ gap: 8, marginTop: 12 }}>
            <button className="dl-ghost" onClick={() => setForm(null)}>取消</button>
            <button className="dl-primary" style={{ flex: 1 }} onClick={save}>儲存</button>
          </div>
        </div>
      )}
      {sorted.map((r) => (
        <div key={r.id} className="dl-card dl-dep" onClick={() => setForm({ ...r, rates: { ...r.rates } })}>
          <div className="dl-row"><b>{fmtDate(r.date)}</b><span className="dl-muted" style={{ fontSize: 12 }}>個人利率</span></div>
          <div className="dl-ratechips">
            {TERMS.map((t) => r.rates[t] != null ? <span key={t} className="dl-chip">{t}M · {r.rates[t]}%</span> : null)}
          </div>
          <button className="dl-del" onClick={(e) => { e.stopPropagation(); del(r.id); }}>刪除</button>
        </div>
      ))}
      {rateLog.length === 0 && !form && <Empty text="每次查銀行利率就記一筆，利率走勢圖會慢慢長出來。" />}
    </div>
  );
}

/* ---------- 設定 ---------- */
function Settings({ settings, sync, onClose, onSave, onPull }) {
  const [s, setS] = useState({ ...settings });
  return (
    <div className="dl-modal" onClick={onClose}>
      <div className="dl-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="dl-formTitle">設定</div>
        <Field label="我的銀行" v={s.bankName} on={(v) => setS({ ...s, bankName: v })} ph="例：VPBank" />
        <Field label="居留證到期日（換證日）" type="date" v={s.residenceExpiry} on={(v) => setS({ ...s, residenceExpiry: v })} />
        <Field label="GAS 網址（Google Sheets 同步）" v={s.gasUrl} on={(v) => setS({ ...s, gasUrl: v })} ph="貼上 Web App 網址" />
        <Field label="APP_TOKEN（選填，與 GAS 設一致以防盜用）" v={s.appToken} on={(v) => setS({ ...s, appToken: v })} ph="自訂一組通關密語" />
        <p className="dl-note">同步狀態：{sync.msg || '尚未設定'}</p>
        <div className="dl-row" style={{ gap: 8, marginTop: 8 }}>
          <button className="dl-ghost" onClick={onPull}>從雲端載入</button>
          <button className="dl-primary" style={{ flex: 1 }} onClick={() => { onSave(s); onClose(); }}>儲存</button>
        </div>
        <button className="dl-close" onClick={onClose}>關閉</button>
      </div>
    </div>
  );
}

/* ---------- 共用小元件 ---------- */
function Field({ label, v, on, ph, type, num }) {
  return (
    <div className="dl-field">
      <label>{label}</label>
      <input className="dl-input" type={type || 'text'} placeholder={ph || ''} value={v || ''}
        inputMode={num ? 'decimal' : undefined}
        onChange={(e) => on(num ? e.target.value.replace(/[^0-9.]/g, '') : e.target.value)} />
    </div>
  );
}
function Empty({ text }) { return <div className="dl-empty">{text}</div>; }

/* ================= 股票模組 ================= */
function StockSummary({ sport, count, onGo }) {
  return (
    <div className="dl-card dl-stockcard" onClick={onGo}>
      <div className="dl-row" style={{ marginBottom: 8 }}>
        <span className="dl-muted" style={{ fontSize: 12 }}>台股部位（TWD）· {count} 檔</span>
        <span className="dl-muted" style={{ fontSize: 12 }}>看台股 ›</span>
      </div>
      {count === 0 ? <div className="dl-muted" style={{ fontSize: 13 }}>還沒有持股，到「台股」分頁新增。</div> : (
        <>
          <div className="dl-row">
            <span className="dl-muted" style={{ fontSize: 12 }}>總報酬（未實現＋股利）</span>
            <b style={{ fontSize: 20, color: sport.total >= 0 ? '#3ecf8e' : '#f2647a' }}>
              {sport.total >= 0 ? '+' : ''}{fmtVND(sport.total)}<span className="dl-unit">元</span>
            </b>
          </div>
          <div className="dl-grid3" style={{ marginTop: 10 }}>
            <Stat label="總市值" val={sport.priced ? fmtVND(sport.mv) : '—'} unit="元" />
            <Stat label="未實現" val={sport.priced ? fmtVND(sport.upnl) : '—'} unit="元" />
            <Stat label="已領股利" val={fmtVND(sport.div)} unit="元" />
          </div>
        </>
      )}
    </div>
  );
}

function StockGauge({ stopPrice, profitPrice, price, cps }) {
  if (!stopPrice || !profitPrice) return null;
  const lo = stopPrice * 0.99, hi = profitPrice * 1.01;
  const pos = (v) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
  return (
    <div style={{ position: 'relative', height: 30, margin: '14px 0 4px' }}>
      <div style={{ position: 'absolute', top: 13, left: 0, right: 0, height: 5, borderRadius: 3, background: 'linear-gradient(90deg,#f2647a55,#3a4763,#3ecf8e55)' }} />
      <Marker x={pos(stopPrice)} color="#f2647a" label="停損" val={fmtRate(stopPrice)} />
      <Marker x={pos(cps)} color="#8a97ab" label="成本" val={fmtRate(cps)} />
      {price != null && <Marker x={pos(price)} color="#5b9bd5" label="現價" val={fmtRate(price)} up />}
      <Marker x={pos(profitPrice)} color="#3ecf8e" label="停利" val={fmtRate(profitPrice)} />
    </div>
  );
}

function Stocks({ stockRows, sport, quoteMsg, dividends, onRefresh, onSaveStocks, onSaveDividends }) {
  const [form, setForm] = useState(null);
  const [divFor, setDivFor] = useState(null); // symbol id 開配息表單
  const blank = { id: '', symbol: '', name: '', shares: '', costPerShare: '', stopLossPct: 10, takeProfitPct: 20 };

  const saveStock = () => {
    const f = { ...form };
    if (!f.symbol || !f.shares || !f.costPerShare) { alert('請填代號、股數、成本/股'); return; }
    f.symbol = String(f.symbol).trim();
    let list;
    if (f.id) list = stockRows.map((r) => (r.id === f.id ? f : strip(r)));
    else { f.id = 's' + Date.now(); list = [...stockRows.map(strip), f]; }
    onSaveStocks(list);
    setForm(null);
    setTimeout(onRefresh, 300);
  };
  const delStock = (id) => { if (confirm('刪除這檔持股？')) onSaveStocks(stockRows.filter((r) => r.id !== id).map(strip)); };

  const addDiv = (sym, date, amount) => {
    if (!amount) { alert('請填配息金額'); return; }
    onSaveDividends([...dividends, { id: 'v' + Date.now(), symbol: String(sym).trim(), date: date || todayISO(), amount: Number(amount) }]);
    setDivFor(null);
  };
  const delDiv = (id) => onSaveDividends(dividends.filter((d) => d.id !== id));

  return (
    <div>
      <div className="dl-card">
        <div className="dl-row">
          <div>
            <div className="dl-muted" style={{ fontSize: 12 }}>總報酬（未實現＋股利）</div>
            <div style={{ fontSize: 24, fontWeight: 800, color: sport.total >= 0 ? '#3ecf8e' : '#f2647a' }}>
              {sport.total >= 0 ? '+' : ''}{fmtVND(sport.total)}<span className="dl-unit">元</span>
              <span style={{ fontSize: 13, marginLeft: 6 }}>{sport.totalPct != null ? fmtPct(sport.totalPct) : ''}</span>
            </div>
          </div>
          <button className="dl-refresh" onClick={onRefresh}>↻ 更新報價</button>
        </div>
        <div className="dl-grid3" style={{ marginTop: 12 }}>
          <Stat label="總市值" val={sport.priced ? fmtVND(sport.mv) : '—'} unit="元" />
          <Stat label="未實現損益" val={sport.priced ? fmtVND(sport.upnl) : '—'} unit="元" />
          <Stat label="已領股利" val={fmtVND(sport.div)} unit="元" />
        </div>
        {quoteMsg && <p className="dl-note">{quoteMsg}</p>}
      </div>

      {!form && <button className="dl-primary" onClick={() => setForm(blank)}>＋ 新增持股</button>}

      {form && (
        <div className="dl-card">
          <div className="dl-formTitle">{form.id ? '編輯持股' : '新增持股（台股）'}</div>
          <Field label="股票代號" v={form.symbol} on={(v) => setForm({ ...form, symbol: v })} ph="例：2330" />
          <Field label="名稱（選填，更新報價後自動帶入）" v={form.name} on={(v) => setForm({ ...form, name: v })} ph="台積電" />
          <Field label="股數" v={form.shares} on={(v) => setForm({ ...form, shares: v })} ph="1000" num />
          <Field label="成本 / 股" v={form.costPerShare} on={(v) => setForm({ ...form, costPerShare: v })} ph="900" num />
          <div className="dl-row" style={{ gap: 10 }}>
            <div style={{ flex: 1 }}><Field label="停損 %（低於成本）" v={form.stopLossPct} on={(v) => setForm({ ...form, stopLossPct: v })} ph="10" num /></div>
            <div style={{ flex: 1 }}><Field label="停利 %（高於成本）" v={form.takeProfitPct} on={(v) => setForm({ ...form, takeProfitPct: v })} ph="20" num /></div>
          </div>
          {Number(form.stopLossPct) > 0 && (
            <div className="dl-rr">風險報酬比 R:R ≈ 1 : {(Number(form.takeProfitPct) / Number(form.stopLossPct)).toFixed(1)}
              　停損價 {fmtRate(Number(form.costPerShare) * (1 - Number(form.stopLossPct) / 100))}
              ／停利價 {fmtRate(Number(form.costPerShare) * (1 + Number(form.takeProfitPct) / 100))}</div>
          )}
          <div className="dl-row" style={{ gap: 8, marginTop: 12 }}>
            <button className="dl-ghost" onClick={() => setForm(null)}>取消</button>
            <button className="dl-primary" style={{ flex: 1 }} onClick={saveStock}>儲存</button>
          </div>
        </div>
      )}

      {stockRows.map((r) => {
        const c = r.calc;
        const nm = (r.q && r.q.name) || r.name || '';
        const badge = c.status === 'stop' ? { t: '⚠ 跌破停損', c: 'od' } : c.status === 'profit' ? { t: '✓ 達停利', c: 'near' } : null;
        return (
          <div key={r.id} className="dl-card dl-dep">
            <div className="dl-row" onClick={() => setForm({ ...strip(r) })}>
              <div>
                <b>{r.symbol}</b> <span className="dl-muted" style={{ fontSize: 13 }}>{nm}</span>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontWeight: 700 }}>{c.price != null ? fmtRate(c.price) : '報價 —'}</div>
                {c.upnlPct != null && <div style={{ fontSize: 12, color: c.upnl >= 0 ? '#3ecf8e' : '#f2647a' }}>{fmtPct(c.upnlPct)}</div>}
              </div>
            </div>

            {badge && <div className={'dl-tag ' + badge.c} style={{ display: 'inline-block', marginTop: 6 }}>{badge.t}</div>}

            <StockGauge stopPrice={c.stopPrice} profitPrice={c.profitPrice} price={c.price} cps={c.cps} />

            <div className="dl-depgrid">
              <span>市值 <b>{c.mv != null ? fmtVND(c.mv) : '—'}</b></span>
              <span>未實現 <b style={{ color: c.upnl >= 0 ? '#3ecf8e' : '#f2647a' }}>{c.upnl != null ? fmtVND(c.upnl) : '—'}</b></span>
              <span>距停損 <b>{c.distStop != null ? '+' + c.distStop.toFixed(1) + '%' : '—'}</b></span>
              <span>距停利 <b>{c.distProfit != null ? c.distProfit.toFixed(1) + '%' : '—'}</b></span>
              <span>已領股利 <b>{fmtVND(c.divTotal)}</b></span>
              <span>R:R <b>1:{c.rr != null ? c.rr.toFixed(1) : '—'}</b></span>
            </div>

            <div className="dl-divrow">
              {dividends.filter((d) => String(d.symbol).trim() === String(r.symbol).trim())
                .sort((a, b) => ms(b.date) - ms(a.date)).map((d) => (
                  <span key={d.id} className="dl-chip" onClick={() => { if (confirm('刪除這筆配息？')) delDiv(d.id); }}>
                    {fmtDate(d.date)} · {fmtVND(d.amount)} ✕
                  </span>
                ))}
              {divFor === r.id
                ? <DivForm onCancel={() => setDivFor(null)} onAdd={(date, amt) => addDiv(r.symbol, date, amt)} />
                : <button className="dl-adddiv" onClick={() => setDivFor(r.id)}>＋記配息</button>}
            </div>

            <button className="dl-del" onClick={() => delStock(r.id)}>刪除</button>
          </div>
        );
      })}

      {stockRows.length === 0 && !form && <Empty text="新增台股持股，設好停損%/停利%，App 會抓現價、算損益、畫紀律儀表，並提醒你何時跌破停損或達停利。" />}
      {stockRows.length > 0 && <p className="dl-note">報價來自 Yahoo（延遲約 15 分鐘），僅供追蹤參考，不是即時成交價。</p>}
    </div>
  );
}

function DivForm({ onCancel, onAdd }) {
  const [date, setDate] = useState(todayISO());
  const [amt, setAmt] = useState('');
  return (
    <div className="dl-divform">
      <input className="dl-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      <input className="dl-input" inputMode="decimal" placeholder="配息金額" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ''))} />
      <button className="dl-ghost" onClick={onCancel}>取消</button>
      <button className="dl-primary" onClick={() => onAdd(date, amt)}>加</button>
    </div>
  );
}
const strip = (r) => { const { calc, q, ...rest } = r; return rest; };


/* ============================================================ CSS ============================================================ */
const CSS = `
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
.dl-app { max-width: 480px; margin: 0 auto; min-height: 100vh; background: #0e1420; color: #e6ebf2;
  font-family: -apple-system, "Segoe UI", Roboto, "Noto Sans TC", system-ui, sans-serif; padding-bottom: 72px; }
.dl-app :is(input,button){ font-family: inherit; }
.dl-muted { color: #8a97ab; }
.dl-row { display: flex; align-items: center; justify-content: space-between; }
.dl-unit { font-size: 10px; color: #8a97ab; margin-left: 2px; font-weight: 400; }

.dl-head { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; justify-content: space-between;
  padding: 14px 16px; background: #0e1420ee; backdrop-filter: blur(8px); border-bottom: 1px solid #1c2740; }
.dl-title { font-size: 19px; font-weight: 800; letter-spacing: .5px; }
.dl-sub { font-size: 11px; color: #8a97ab; margin-top: 1px; }
.dl-headr { display: flex; align-items: center; gap: 10px; }
.dl-icon { background: none; border: none; color: #b9c6da; font-size: 20px; padding: 4px; cursor: pointer; }
.dl-syncdot { width: 8px; height: 8px; border-radius: 50%; background: #3a4763; }
.dl-syncdot.syncing { background: #d4a544; animation: dlp 1s infinite; }
.dl-syncdot.ok { background: #3ecf8e; } .dl-syncdot.err { background: #f2647a; }
@keyframes dlp { 50% { opacity: .35; } }

.dl-main { padding: 14px 14px 20px; }
.dl-card { background: #161d2b; border: 1px solid #212c44; border-radius: 16px; padding: 16px; margin-bottom: 12px; }
.dl-hero { background: linear-gradient(160deg,#182338,#141b29); }
.dl-heroTop { display: flex; justify-content: space-between; align-items: flex-start; }
.dl-big { font-size: 27px; font-weight: 800; letter-spacing: .5px; font-variant-numeric: tabular-nums; margin-top: 2px; }
.dl-grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-top: 16px; }
.dl-stat { background: #10192a; border: 1px solid #1e2840; border-radius: 11px; padding: 9px 8px; }
.dl-stat > div:last-child { font-variant-numeric: tabular-nums; font-size: 14px; margin-top: 3px; }
.dl-sellbox { margin-top: 14px; }

.dl-nav { position: fixed; bottom: 0; left: 0; right: 0; max-width: 480px; margin: 0 auto; display: flex;
  background: #10161f; border-top: 1px solid #1c2740; }
.dl-navb { flex: 1; background: none; border: none; color: #6f7f96; padding: 9px 0 11px; font-size: 11px;
  display: flex; flex-direction: column; align-items: center; gap: 3px; cursor: pointer; }
.dl-navb.on { color: #d4a544; }
.dl-navic { font-size: 17px; }

.dl-primary { width: 100%; background: #d4a544; color: #201700; border: none; border-radius: 12px;
  padding: 13px; font-size: 15px; font-weight: 700; cursor: pointer; }
.dl-ghost { background: #1c2740; color: #c7d3e6; border: none; border-radius: 12px; padding: 13px 18px; font-weight: 600; cursor: pointer; }
.dl-photo { width: 100%; background: #10192a; border: 1px dashed #3a4a6b; color: #b9c6da; border-radius: 12px;
  padding: 12px; font-size: 14px; font-weight: 600; cursor: pointer; margin-bottom: 10px; }
.dl-photo:disabled { opacity: .6; }
.dl-photomsg { font-size: 12px; color: #8fe3b8; background: #12271d; border: 1px solid #22503a; border-radius: 9px; padding: 8px 10px; margin-bottom: 12px; line-height: 1.5; }
.dl-photomsg.warn { color: #f2a3b6; background: #2a1620; border-color: #5a2740; }

.dl-field { margin-bottom: 11px; }
.dl-field > label, .dl-ratecell label { display: block; font-size: 12px; color: #8a97ab; margin-bottom: 5px; }
.dl-input { width: 100%; background: #0f1826; border: 1px solid #26324c; color: #e6ebf2; border-radius: 10px;
  padding: 11px 12px; font-size: 15px; outline: none; font-variant-numeric: tabular-nums; }
.dl-input:focus { border-color: #d4a544; }
.dl-formTitle { font-size: 15px; font-weight: 700; margin-bottom: 12px; }

.dl-terms { display: flex; gap: 6px; flex-wrap: wrap; }
.dl-term { flex: 1; min-width: 44px; background: #0f1826; border: 1px solid #26324c; color: #b9c6da;
  border-radius: 9px; padding: 9px 0; font-weight: 600; cursor: pointer; }
.dl-term.on { background: #d4a544; color: #201700; border-color: #d4a544; }

.dl-guard { margin-top: 10px; border-radius: 10px; padding: 10px 12px; font-size: 12.5px; line-height: 1.5; }
.dl-guard.ok { background: #12271d; border: 1px solid #22503a; color: #8fe3b8; }
.dl-guard.bad { background: #2a1620; border: 1px solid #5a2740; color: #f2a3b6; }

.dl-preview { margin-top: 12px; background: #0f1826; border: 1px solid #22304a; border-radius: 11px; padding: 12px; }
.dl-preview .dl-row { padding: 4px 0; font-size: 13.5px; }
.dl-preview .dl-row span { color: #8a97ab; }
.dl-preview .dl-row { font-variant-numeric: tabular-nums; }

.dl-dep { position: relative; cursor: pointer; }
.dl-depmeta { font-size: 12px; color: #8a97ab; margin-top: 3px; }
.dl-depgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 12px; margin-top: 10px; font-size: 12.5px; color: #8a97ab; font-variant-numeric: tabular-nums; }
.dl-depgrid b { color: #e6ebf2; font-weight: 600; }
.dl-tag { font-size: 11px; background: #1c2740; color: #9fb0c9; padding: 3px 9px; border-radius: 20px; }
.dl-tag.near { background: #33290f; color: #e6b84a; } .dl-tag.od { background: #2a1620; color: #f2647a; }
.dl-del { position: absolute; top: 14px; right: 14px; background: none; border: none; color: #5b6b84; font-size: 12px; cursor: pointer; display: none; }
.dl-dep:hover .dl-del { display: block; }

.dl-seg { display: flex; background: #10161f; border: 1px solid #212c44; border-radius: 12px; padding: 4px; margin-bottom: 12px; }
.dl-seg button { flex: 1; background: none; border: none; color: #8a97ab; padding: 9px; border-radius: 9px; font-weight: 600; cursor: pointer; }
.dl-seg button.on { background: #212c44; color: #e6ebf2; }
.dl-note { font-size: 11.5px; color: #7688a3; line-height: 1.55; margin: 10px 0 0; }
.dl-legend { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 10px; font-size: 11.5px; color: #9fb0c9; }
.dl-legend span { display: flex; align-items: center; gap: 5px; }
.dl-legend i { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }

.dl-ratetable { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
.dl-ratecell label { text-align: center; }
.dl-ratechips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.dl-chip { font-size: 11.5px; background: #10192a; border: 1px solid #22304a; color: #b9c6da; padding: 4px 9px; border-radius: 20px; font-variant-numeric: tabular-nums; }

.dl-modal { position: fixed; inset: 0; background: #000a; z-index: 20; display: flex; align-items: flex-end; justify-content: center; }
.dl-sheet { width: 100%; max-width: 480px; background: #161d2b; border-radius: 20px 20px 0 0; padding: 20px 16px 28px; border-top: 1px solid #2a3652; }
.dl-close { width: 100%; background: none; border: none; color: #7688a3; margin-top: 12px; padding: 8px; cursor: pointer; }

.dl-empty { text-align: center; color: #6f7f96; font-size: 13px; line-height: 1.6; padding: 30px 20px; }

.dl-stockcard { cursor: pointer; }
.dl-refresh { background: #1c2740; color: #b9c6da; border: none; border-radius: 10px; padding: 9px 12px; font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap; }
.dl-rr { margin-top: 8px; font-size: 12px; color: #9fb0c9; background: #0f1826; border: 1px solid #22304a; border-radius: 9px; padding: 8px 10px; line-height: 1.5; }
.dl-divrow { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 10px; }
.dl-adddiv { background: none; border: 1px dashed #3a4a6b; color: #9fb0c9; border-radius: 20px; padding: 4px 12px; font-size: 12px; cursor: pointer; }
.dl-divform { display: flex; flex-wrap: wrap; gap: 6px; width: 100%; margin-top: 6px; align-items: center; }
.dl-divform .dl-input { flex: 1; min-width: 96px; padding: 8px 10px; font-size: 13px; }
.dl-divform .dl-ghost, .dl-divform .dl-primary { padding: 8px 14px; font-size: 13px; }
`;
