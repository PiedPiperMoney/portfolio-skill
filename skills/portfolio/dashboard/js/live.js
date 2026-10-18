/* live.js — живые котировки Мосбиржи (ISS) и курсы валют (Мосбиржа, ЦБ) прямо из браузера.
   НЕ МЕНЯТЬ расчёт стоимости в applyQuotes (облигации: % от номинала × номинал × курс + НКД) — от него зависят
   стоимость, изменение за день и результат. Новые источники цен добавлять рядом, не переписывая этот. */
'use strict';

const ISS = 'https://iss.moex.com/iss';
async function getJSON(url) { const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000); try { const r = await fetch(url, { cache: 'no-store', signal: ctl.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); } finally { clearTimeout(t); } }
const tbl = b => b && b.columns ? b.data.map(r => Object.fromEntries(b.columns.map((k, i) => [k, r[i]]))) : [];
const MD_COLS = { shares: 'SECID,LAST,MARKETPRICE,UPDATETIME,TRADINGSTATUS', bonds: 'SECID,LAST,MARKETPRICE,UPDATETIME,TRADINGSTATUS', selt: 'SECID,LAST,MARKETPRICE,UPDATETIME,TRADINGSTATUS', forts: 'SECID,LAST,UPDATETIME' };
const SEC_COLS = { shares: 'SECID,PREVPRICE,PREVDATE', bonds: 'SECID,PREVPRICE,PREVDATE,ACCRUEDINT,FACEVALUE,FACEUNIT', selt: 'SECID,PREVPRICE', forts: 'SECID,PREVPRICE' };

/* list: [{ticker, engine, market, board}] → {ТИКЕР: {last, prev, src, time, status, prevDate, accr, face, faceunit, market}} */
async function fetchQuotes(list) {
  const groups = {};
  list.forEach(x => { const k = x.engine + '|' + x.market + '|' + (x.engine === 'futures' ? '' : x.board); (groups[k] = groups[k] || []).push(x.ticker); });
  const out = {};
  await Promise.all(Object.entries(groups).map(async ([k, tks]) => {
    const [e, m, b] = k.split('|');
    const path = e === 'futures' ? `${ISS}/engines/futures/markets/forts/securities.json` : `${ISS}/engines/${e}/markets/${m}/boards/${b}/securities.json`;
    const url = `${path}?iss.meta=off&iss.only=marketdata,securities&securities=${encodeURIComponent([...new Set(tks)].join(','))}&marketdata.columns=${MD_COLS[m] || MD_COLS.shares}&securities.columns=${SEC_COLS[m] || SEC_COLS.shares}`;
    try {
      const j = await getJSON(url);
      const sec = {}; tbl(j.securities).forEach(r => sec[r.SECID] = r);
      tbl(j.marketdata).forEach(r => {
        const s = sec[r.SECID] || {}, prev = s.PREVPRICE != null ? +s.PREVPRICE : null;
        const last = r.LAST != null ? +r.LAST : r.MARKETPRICE != null ? +r.MARKETPRICE : prev;
        out[r.SECID] = { last, prev, src: r.LAST != null ? 'last' : r.MARKETPRICE != null ? 'market' : 'prev', time: (r.UPDATETIME || '').slice(0, 5), status: r.TRADINGSTATUS || '', prevDate: s.PREVDATE || '', accr: s.ACCRUEDINT, face: s.FACEVALUE, faceunit: s.FACEUNIT, market: m };
      });
    } catch (err) { console.warn('Мосбиржа, ' + m + ':', err.message); }
  }));
  return out;
}
/* живые значения индексов; если Мосбиржа не ответила — последнее значение из данных */
async function fetchIndexLive() {
  if (!IDX.length) return {};
  try {
    const j = await getJSON(`${ISS}/engines/stock/markets/index/securities.json?iss.meta=off&iss.only=marketdata&securities=${IDX.join(',')}&marketdata.columns=SECID,CURRENTVALUE,LASTVALUE,UPDATETIME`);
    const o = {}; tbl(j.marketdata).forEach(r => { const v = r.CURRENTVALUE != null ? +r.CURRENTVALUE : r.LASTVALUE != null ? +r.LASTVALUE : null; if (v) o[r.SECID] = v; }); return o;
  } catch (e) { console.warn('Мосбиржа, индексы:', e.message); return {}; }
}
const idxNow = k => LIVE.idx[k] != null ? LIVE.idx[k] : D.indexes[k][LAST];
async function fetchCBR() { try { const j = await getJSON('https://www.cbr-xml-daily.ru/daily_json.js'); return j.Valute; } catch (e) { console.warn('ЦБ:', e.message); return null; } }

function applyQuotes(q) {
  const usd = LIVE.fx.USD;
  P.forEach(p => {
    const x = q[p.ticker], c = p.close;
    p.liveSrc = null; p.bondPct = null;
    const reset = () => { p.price = c.price; p.value = c.value; p.dayChangePct = c.dayChangePct; p.profit = c.profit; p.dayAbs = c.value - c.value / (1 + c.dayChangePct / 100); };
    if (!x || x.last == null) return reset();
    let unit, prevUnit;
    if (x.market === 'bonds') {
      const fx = x.faceunit === 'USD' ? usd : (x.faceunit === 'SUR' || x.faceunit === 'RUB') ? 1 : null;
      if (!fx) return reset();
      const nkd = +x.accr || 0;
      unit = x.last / 100 * x.face * fx + nkd; prevUnit = x.prev != null ? x.prev / 100 * x.face * fx + nkd : unit;
      p.bondPct = x.last;
    } else { unit = x.last; prevUnit = x.prev != null ? x.prev : unit; }
    p.price = unit; p.value = p.qty * unit; p.dayAbs = p.qty * (unit - prevUnit); p.dayChangePct = prevUnit ? (unit / prevUnit - 1) * 100 : 0;
    p.profit = c.profit + (p.value - c.value); p.liveSrc = x.src; p.liveTime = x.time;
  });
}

/* валюты, курс которых нужен: из DATA.cash и доллар для валютных облигаций */
function fxNeeded() { const s = new Set(CASHL.map(c => c.currency).filter(c => c && c !== 'RUB')); s.add('USD'); return [...s]; }

async function refreshQuotes() {
  const list = P.map(p => Object.assign({ ticker: p.ticker }, D.quoteSources[p.ticker] || { engine: 'stock', market: 'shares', board: 'TQBR' }));
  const fxs = fxNeeded();
  fxs.filter(c => c !== 'USD').forEach(c => list.push({ ticker: c + 'RUB_TOM', engine: 'currency', market: 'selt', board: 'CETS' }));
  list.push({ ticker: 'USDRUBF', engine: 'futures', market: 'forts', board: 'RFUD' });
  const [q, cbr, ix] = await Promise.all([fetchQuotes(list), fetchCBR(), fetchIndexLive()]);
  if (!P.some(p => q[p.ticker] && q[p.ticker].last != null) && LIVE.cached) { LIVE.cacheFailed = true; LIVE.at = Date.now(); rerenderLive(); return; }
  takeQuotes(q, cbr, ix);
  if (LIVE.state !== 'error') saveQuoteCache(q, cbr, ix);
  LIVE.at = Date.now();
  rerenderLive();
}

/* разобрать полученные (или сохранённые) котировки: курсы, цены бумаг, состояние торгов */
function takeQuotes(q, cbr, ix) {
  LIVE.cached = null; LIVE.cacheFailed = false;
  const fxs = fxNeeded();
  LIVE.idx = ix;
  // доллар: курс ЦБ, если нет — вечный фьючерс
  if (cbr && cbr.USD) { LIVE.fx.USD = LIVE.fxPrev.USD = cbr.USD.Value / cbr.USD.Nominal; LIVE.fxSrc.USD = 'курс ЦБ'; }
  else if (q.USDRUBF && q.USDRUBF.last) { LIVE.fx.USD = LIVE.fxPrev.USD = q.USDRUBF.last; LIVE.fxSrc.USD = 'фьючерс USDRUBF'; }
  // остальные валюты: биржевой курс «завтра», если нет — ЦБ
  fxs.filter(c => c !== 'USD').forEach(c => {
    const x = q[c + 'RUB_TOM'];
    if (x && x.last) { LIVE.fx[c] = x.last; LIVE.fxPrev[c] = x.prev != null ? x.prev : x.last; LIVE.fxSrc[c] = 'Мосбиржа, ' + c + 'RUB_TOM'; }
    else if (cbr && cbr[c]) { LIVE.fx[c] = cbr[c].Value / cbr[c].Nominal; LIVE.fxPrev[c] = cbr[c].Previous / cbr[c].Nominal; LIVE.fxSrc[c] = 'курс ЦБ'; }
  });
  const got = P.filter(p => q[p.ticker] && q[p.ticker].last != null);
  if (!got.length) { LIVE.state = 'error'; applyQuotes({}); }
  else {
    applyQuotes(q);
    const qs = got.map(p => q[p.ticker]);
    LIVE.time = qs.map(x => x.time).filter(Boolean).sort().pop() || '';
    LIVE.prevDate = (qs.find(x => x.prevDate) || {}).prevDate || asOf;
    LIVE.state = qs.some(x => x.status === 'T') ? 'live' : 'closed';
    LIVE.missing = P.filter(p => !q[p.ticker] || q[p.ticker].last == null).map(p => p.name);
  }
  LIVE.quotes = q;
}

/* последние полученные цены — в памяти браузера, чтобы при следующем открытии сразу показать их, а не цены дня сборки */
const QCACHE_KEY = 'pf-quotes:' + location.pathname;
function saveQuoteCache(q, cbr, ix) {
  try {
    const old = JSON.parse(localStorage.getItem(QCACHE_KEY) || 'null');
    const keep = old && old.q ? old.q : {};   // у других счетов свои бумаги — не теряем их цены
    localStorage.setItem(QCACHE_KEY, JSON.stringify({ savedAt: Date.now(), q: Object.assign(keep, q), cbr, ix, wq: WQ }));
  } catch (e) {}
}
function loadQuoteCache() {
  let c = null;
  try { c = JSON.parse(localStorage.getItem(QCACHE_KEY) || 'null'); } catch (e) {}
  if (!c || !c.q || !c.savedAt) return false;
  const day = new Date(c.savedAt), iso = day.getFullYear() + '-' + String(day.getMonth() + 1).padStart(2, '0') + '-' + String(day.getDate()).padStart(2, '0');
  if (iso < asOf) return false;                // данные пересобраны позже — их цены свежее
  if (!P.some(p => c.q[p.ticker] && c.q[p.ticker].last != null)) return false;
  takeQuotes(c.q, c.cbr, c.ix || {});
  if (LIVE.state === 'error') { LIVE.state = 'close'; return false; }
  if (c.wq) WQ = c.wq;
  LIVE.cached = { date: iso, time: LIVE.time };
  return true;
}

/* живая точка для графиков: стоимость бумаг сейчас (история — только бумаги) */
function liveExtra() {
  if (!isLive()) return null;
  return { v: SEC, tip: `<div class="t-d">Сейчас, ${LIVE.time} мск</div>` + tipRow('Бумаги по живым ценам', rub(SEC), C['s-port']) + tipRow('Вложено', rub(D.invested[LAST]), C['s-inv']) + (hasCash() ? `<div class="t-r"><span>Валюта (не входит в график)</span><b class="num">${rub(CASH)}</b></div>` : '') };
}
