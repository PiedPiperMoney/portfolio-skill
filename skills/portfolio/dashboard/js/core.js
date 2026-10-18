/* core.js — общее для всех разделов: форматирование чисел и дат, утилиты, цвета темы, состояние портфеля.
   Файлы дашборда — обычные скрипты (не модули): всё, что объявлено здесь на верхнем уровне, видно в остальных файлах.
   Порядок подключения — в index.html. Данные — window.DATA из dashboard-data.js. */
'use strict';

/* Портфель: «Все счета» — сам window.DATA; брокер или счёт — DATA.byPortfolio[id] того же формата.
   Выбор — в адресе (#p-<id>) и в этом браузере (localStorage 'pf-portfolio'); смена = новый адрес и перезагрузка. */
const PF_KEY = 'pf-portfolio';
const PF = (function () {
  const all = window.DATA || null;
  const list = all && Array.isArray(all.portfolios) && all.byPortfolio ? all.portfolios.filter(p => p && all.byPortfolio[p.id]) : [];
  const ok = id => id === 'all' || list.some(p => p.id === id);
  const m = /^#p-([A-Za-z0-9-]+)$/.exec(location.hash);
  let id = m && ok(m[1]) ? m[1] : null;
  if (id) { try { localStorage.setItem(PF_KEY, id); } catch (e) {} }
  else { try { const s = localStorage.getItem(PF_KEY); if (s && ok(s)) id = s; } catch (e) {} }
  if (!id || !list.length) id = 'all';
  const cur = list.find(p => p.id === id) || null;
  const parent = cur && cur.parent ? list.find(p => p.id === cur.parent) : null;
  return { id, list, cur, all, data: cur ? all.byPortfolio[id] : all,
    label: cur ? (parent && !cur.label.toLowerCase().includes(parent.label.toLowerCase()) ? parent.label + ' · ' : '') + cur.label : 'Все счета' };
})();
function selectPortfolio(id) {
  if (id === PF.id || PF.switching || !(id === 'all' || PF.list.some(p => p.id === id))) return;
  PF.switching = true;
  try { localStorage.setItem(PF_KEY, id); } catch (e) {}
  location.hash = 'p-' + id;
  location.reload();
}
window.addEventListener('hashchange', () => { const m = /^#p-([A-Za-z0-9-]+)$/.exec(location.hash); if (m && m[1] !== PF.id && PF.list.length) selectPortfolio(m[1]); });
const D = PF.data;

/* ---------- формат ---------- */
const NB = ' ', MINUS = '−';
const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const fix = s => s.replace(/-/g, MINUS).replace(/ /g, NB);
const int = n => fix(nf0.format(Math.round(n) === 0 ? 0 : Math.round(n)));
const rub = (n, sign) => (sign && Math.round(n) > 0 ? '+' : '') + int(n) + NB + '₽';
const dec = (n, d) => fix(new Intl.NumberFormat('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d }).format(n));
const pct = (x, d = 1, sign) => (sign && x > 0 ? '+' : '') + dec(x * 100, d) + NB + '%';
const mln = n => dec(n / 1e6, 1) + NB + 'млн';
const mlnAxis = n => { if (Math.abs(n) < 0.5) return '0'; const m = n / 1e6, d = Math.abs(m - Math.round(m)) < 1e-6 ? 0 : Math.abs(m * 10 - Math.round(m * 10)) < 1e-6 ? 1 : 2; return dec(m, d) + NB + 'млн'; };
const cls = n => n > 0 ? 'up' : n < 0 ? 'down' : '';
function price(p, cur) {
  const d = p >= 1000 ? 2 : p >= 100 ? 2 : p >= 10 ? 3 : 4;
  let s = fix(new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: d }).format(p));
  return s + NB + (cur === 'USD' ? '$' : cur === 'CNY' ? '¥' : '₽');
}
/* склонение: plural(5, 'бумага', 'бумаги', 'бумаг') → 'бумаг' */
function plural(n, one, few, many) { const a = Math.abs(n) % 100, b = a % 10; return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many; }
/* «А, Б и В» */
const andList = a => a.length > 1 ? a.slice(0, -1).join(', ') + ' и ' + a[a.length - 1] : (a[0] || '');
const MON = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
const MONS = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];
const MONN = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
const dmy = s => s.slice(8, 10) + '.' + s.slice(5, 7) + '.' + s.slice(0, 4);
const dLong = s => +s.slice(8, 10) + NB + MON[+s.slice(5, 7) - 1] + ' ' + s.slice(0, 4);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const $ = id => document.getElementById(id);
const tipRow = (label, val, color) => `<div class="t-r"><span>${color ? `<i class="sw" style="background:${color}"></i>` : ''}${label}</span><b class="num">${val}</b></div>`;
function groupBy(arr, f) { const o = {}; arr.forEach(p => { const k = f(p); o[k] = (o[k] || 0) + p.value; }); return o; }

/* ---------- цвета из темы (styles.css, :root) ---------- */
let C = {};
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  ['ink','muted','rule','sheet','paper','accent','gold','up','down','s-port','s-MCFTR','s-IMOEX','s-RGBITR','s-RUCBTRNS','s-inv'].forEach(k => C[k] = cs.getPropertyValue('--' + k).trim());
}
function alpha(hex, a) { const h = hex.replace('#', ''); const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; }

/* ---------- даты: индекс дня в D.days ---------- */
let days = [], N = 0, LAST = 0, DAY0 = 0, asOf = '';
const idxOf = s => Math.round((Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) - DAY0) / 864e5);
const iso = t => new Date(t).toISOString().slice(0, 10);
function monthsBack(i, m) { const s = days[i]; let y = +s.slice(0, 4), mo = +s.slice(5, 7) - 1 - m, d = +s.slice(8, 10); while (mo < 0) { mo += 12; y--; } const dim = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate(); const t = Date.UTC(y, mo, Math.min(d, dim)) + 864e5; return Math.max(0, idxOf(iso(t))); }
const yearAgo = i => monthsBack(i, 12);

/* ---------- названия событий ---------- */
const EV = { BUY: 'Покупка', SELL: 'Продажа', DIVIDEND: 'Выплата', TAX: 'Налог', FEE: 'Комиссия', CASH_IN: 'Пополнение', CASH_OUT: 'Вывод', CASH_CONVERT: 'Обмен валюты', TAX_RETURN: 'Корректировка налога', SPLIT: 'Сплит', CASH_GAIN: 'Доход на остаток', REPAYMENT: 'Погашение',
  AMORTIZATION: 'Амортизация', FX_BUY: 'Покупка валюты', FX_SELL: 'Продажа валюты', VARMARGIN: 'Вариационная маржа',
  MOVE_IN: 'Перевод бумаг с другого счёта', MOVE_OUT: 'Перевод бумаг на другой счёт' };
const isBond = t => /^(RU|SU)\d/.test(t);
function evName(o) { if (o.event === 'DIVIDEND') return isBond(o.ticker) ? 'Купон' : 'Дивиденд'; return EV[o.event] || o.event; }
const CUR_SIGN = { RUB: '₽', CNY: '¥', USD: '$', EUR: '€', HKD: 'HK$' };

/* ---------- состояние портфеля ----------
   P — позиции (сортировка по стоимости), p.close — значения на закрытие из данных, их не трогать.
   SEC — бумаги сейчас, CASH — валюта в рублях, TOTAL — всё вместе, DAYABS/DAYPCT — изменение за день. */
let P = [], SEC_CLOSE = 0, fwdTotal = 0, CASHL = [], OPS = [];
const nameOf = {};
let SEC = 0, CASH = 0, TOTAL = 0, sumPos = 0, DAYABS = 0, DAYPCT = 0, CASHDAY = 0;
/* Цены: 'close' — закрытие из данных (ждём сеть), 'live' — торги идут, 'closed' — торги закрыты, 'error' — Мосбиржа недоступна */
const LIVE = { state: 'close', time: '', prevDate: '', fx: { RUB: 1 }, fxPrev: { RUB: 1 }, fxSrc: { RUB: '' }, quotes: {}, idx: {}, at: 0, missing: [] };
const isLive = () => LIVE.state === 'live' || LIVE.state === 'closed';
const hasCash = () => CASHL.some(c => c.amount);
const bonds = () => P.filter(p => p.kind === 'Облигация');

function initCore() {
  // необязательные поля — пустые по умолчанию, чтобы разделы не падали
  ['payments', 'forecast', 'operations', 'warnings', 'positions', 'cash', 'watchlist'].forEach(k => { if (!Array.isArray(D[k])) D[k] = []; });
  ['flows', 'indexes', 'indexNames', 'divByYear', 'quoteSources'].forEach(k => { if (!D[k] || typeof D[k] !== 'object') D[k] = {}; });
  // итоги: у портфеля без продаж или выплат (например, одного счёта) части ключей нет — считаем их нулём
  D.totals = Object.assign({ buys: 0, sells: 0, fees: 0, otherTaxFees: 0, divNet: 0, divTax: 0, profit: 0 }, D.totals || {});
  D.source = D.source || '';
  days = D.days; N = days.length; LAST = N - 1; asOf = D.asOf || days[LAST];
  DAY0 = Date.UTC(+days[0].slice(0, 4), +days[0].slice(5, 7) - 1, +days[0].slice(8, 10));
  LIVE.prevDate = asOf;
  P = D.positions.slice().sort((x, y) => y.value - x.value);
  P.forEach(p => { p.close = { price: p.price, value: p.value, dayChangePct: p.dayChangePct || 0, profit: p.profit }; p.dayChangePct = p.dayChangePct || 0; p.dayAbs = p.value - p.value / (1 + p.dayChangePct / 100); });
  SEC_CLOSE = D.value[LAST];
  fwdTotal = P.reduce((s, p) => s + (p.fwdIncome || 0), 0);
  CASHL = D.cash;
  OPS = D.operations;
  D.payments.forEach(p => nameOf[p.ticker] = p.name); OPS.forEach(o => { if (o.ticker && !nameOf[o.ticker]) nameOf[o.ticker] = o.name; }); P.forEach(p => nameOf[p.ticker] = p.name);
  SEC = TOTAL = sumPos = SEC_CLOSE;
  initBenchmark();
}

/* пересчёт итогов после смены цен или курсов; формулу стоимости не менять (см. ПРАВИЛА.md) */
function recompute() {
  SEC = P.reduce((s, p) => s + p.value, 0); sumPos = SEC;
  CASH = 0; CASHDAY = 0; LIVE.cashKnown = true;
  CASHL.forEach(c => { const r = LIVE.fx[c.currency]; if (r == null) { LIVE.cashKnown = false; return; } CASH += c.amount * r; const rp = LIVE.fxPrev[c.currency]; if (rp != null && isLive()) CASHDAY += c.amount * (r - rp); });
  TOTAL = SEC + CASH;
  if (!isLive()) { DAYABS = LAST > 0 ? D.value[LAST] - D.value[LAST - 1] : 0; DAYPCT = LAST > 0 && D.value[LAST - 1] ? DAYABS / D.value[LAST - 1] : 0; }
  else { DAYABS = P.reduce((s, p) => s + p.dayAbs, 0) + CASHDAY; DAYPCT = TOTAL - DAYABS ? DAYABS / (TOTAL - DAYABS) : 0; }
}
function quoteLabel() {
  if (LIVE.cached) return `Цены Мосбиржи на ${dmy(LIVE.cached.date)}${LIVE.cached.time ? ', ' + LIVE.cached.time.slice(0, 5) + ' мск' : ''} · ` + (LIVE.cacheFailed ? 'Мосбиржа сейчас недоступна' : 'обновляем…');
  if (LIVE.state === 'live') return `Живые цены Мосбиржи · обновлено ${LIVE.time} мск`;
  if (LIVE.state === 'closed') return `Торги закрыты · последние цены Мосбиржи на ${LIVE.time} мск`;
  if (LIVE.state === 'error') return `Цены закрытия ${dmy(asOf)} · Мосбиржа недоступна`;
  return `Цены закрытия ${dmy(asOf)} · загружаем живые цены…`;
}
const cashText = () => CASHL.filter(c => c.amount).map(c => (c.currency === 'RUB' ? dec(c.amount, 2) : dec(c.amount, c.amount < 1 ? 2 : 0)) + NB + (CUR_SIGN[c.currency] || c.currency)).join(' + ');
