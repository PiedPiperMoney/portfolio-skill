/* watchlist.js — раздел «Избранное»: бумаги, валюта, фьючерсы, за которыми человек следит (не владения).
   Исходный список — DATA.watchlist; правки человека хранятся в этом браузере (localStorage 'pf-watch'). */
'use strict';

const WATCH_KEY = 'pf-watch';
let DEF_WATCH = [], WATCH = [], WQ = {}, WATCH_AT = '';
const saveWatch = () => { try { localStorage.setItem(WATCH_KEY, JSON.stringify(WATCH)); } catch (e) {} };
const GROUP_MAP = { stock_shares: ['stock', 'shares'], stock_dr: ['stock', 'shares'], stock_etf: ['stock', 'shares'], stock_ppif: ['stock', 'shares'], stock_bonds: ['stock', 'bonds'], currency_selt: ['currency', 'selt'], futures_forts: ['futures', 'forts'] };
function wUnit(w) { return w.market === 'bonds' ? '%' : w.engine === 'futures' ? 'пункты' : '₽'; }
function wNum(v, w, ref) {
  if (v == null || isNaN(v)) return '—';
  const a = Math.abs(ref == null ? v : ref), d = a >= 10 ? 2 : a >= 1 ? 3 : 4;
  const s = dec(v, d);
  return w.market === 'bonds' ? s + NB + '%' : w.engine === 'futures' ? s : s + NB + '₽';
}
function renderWatch() {
  const rows = WATCH.map((w, i) => {
    const q = WQ[w.ticker];
    const last = q ? q.last : null, prev = q ? q.prev : null, ch = last != null && prev != null ? last - prev : null, chp = ch != null && prev ? ch / prev : null;
    const status = !q ? (WATCH_AT ? 'нет котировки' : 'загрузка…') : q.src === 'prev' ? 'цена закрытия' : q.status === 'N' ? (q.time ? q.time + ', торги закрыты' : 'торги закрыты') : q.time;
    return `<div class="wl"><span class="w-n"><b style="font-weight:500">${esc(w.name || w.ticker)}</b><span class="tk">${esc(w.ticker)}${w.engine === 'futures' ? ' · фьючерс' : w.engine === 'currency' ? ' · валютный рынок' : w.market === 'bonds' ? ' · облигация, % от номинала' : ''}</span></span>
      <span class="num">${wNum(last, w)}</span>
      <span class="num ${cls(chp || 0)}">${chp != null ? pct(chp, 2, true) : '—'}</span>
      <span class="num ${cls(ch || 0)}">${ch != null ? (ch > 0 ? '+' : '') + wNum(ch, w, last) : '—'}</span>
      <span class="small muted" style="text-align:right">${esc(status)}</span>
      <button class="rm" type="button" data-i="${i}" aria-label="Убрать ${esc(w.name || w.ticker)} из избранного" title="Убрать">×</button></div>`;
  });
  $('wlList').innerHTML = `<div class="wl h"><span>Инструмент</span><span>Цена</span><span>За день, %</span><span>За день</span><span style="text-align:right">Время, мск</span><span></span></div>` +
    (rows.length ? rows.join('') : `<p class="small muted" style="padding:16px 0;margin:0">Список пуст. Добавьте тикер выше${DEF_WATCH.length ? ' или верните исходный список' : ''}.</p>`);
  $('wlList').querySelectorAll('.rm').forEach(b => b.onclick = () => { const w = WATCH[+b.dataset.i]; WATCH.splice(+b.dataset.i, 1); saveWatch(); renderWatch(); $('wlMsg').textContent = `${w.name || w.ticker} убран из избранного.`; });
  $('wlNote').textContent = (WATCH_AT ? `Котировки Мосбиржи, обновлено в ${WATCH_AT} по вашему времени, раз в минуту, пока вкладка открыта. ` : 'Загружаем котировки Мосбиржи… ') +
    'Изменение за день — к цене закрытия прошлой торговой сессии. Фьючерсы — в пунктах контракта: Brent в долларах за баррель, индекс — в пунктах, доллар — в рублях. Список хранится в этом браузере.';
}
async function refreshWatch() {
  if (!WATCH.length) { renderWatch(); return; }
  WQ = await fetchQuotes(WATCH);
  WATCH_AT = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  try { const c = JSON.parse(localStorage.getItem(QCACHE_KEY) || 'null'); if (c) { c.wq = WQ; localStorage.setItem(QCACHE_KEY, JSON.stringify(c)); } } catch (e) {}
  renderWatch();
}
function addWatch(w) {
  if (WATCH.some(x => x.ticker === w.ticker)) { $('wlMsg').textContent = `${w.ticker} уже в избранном.`; return; }
  WATCH.push(w); saveWatch(); renderWatch(); $('wlMsg').textContent = `${w.name} (${w.ticker}) добавлен.`; $('wlInput').value = '';
  fetchQuotes([w]).then(q => { Object.assign(WQ, q); renderWatch(); });
}
function initWatch() {
  DEF_WATCH = D.watchlist.map(w => Object.assign({}, w));
  WATCH = DEF_WATCH.map(w => Object.assign({}, w));
  try { const s = JSON.parse(localStorage.getItem(WATCH_KEY) || 'null'); if (Array.isArray(s)) WATCH = s.filter(w => w && w.ticker && w.engine && w.market); } catch (e) {}
  $('wlReset').hidden = !DEF_WATCH.length;
  $('wlForm').addEventListener('submit', async e => {
    e.preventDefault();
    const q = $('wlInput').value.trim().toUpperCase(); if (!q) { $('wlMsg').textContent = 'Введите тикер, например MTSS.'; return; }
    if (WATCH.some(x => x.ticker === q)) { $('wlMsg').textContent = `${q} уже в избранном.`; return; }
    $('wlMsg').textContent = 'Ищем на Мосбирже…'; $('wlAdd').disabled = true;
    try {
      const j = await getJSON(`${ISS}/securities.json?q=${encodeURIComponent(q)}&iss.meta=off&limit=30&securities.columns=secid,shortname,primary_boardid,group`);
      const found = tbl(j.securities).filter(r => GROUP_MAP[r.group] && r.primary_boardid);
      const toW = r => ({ ticker: r.secid, name: r.shortname, engine: GROUP_MAP[r.group][0], market: GROUP_MAP[r.group][1], board: r.primary_boardid });
      const exact = found.find(r => String(r.secid).toUpperCase() === q);
      if (exact) addWatch(toW(exact));
      else if (found.length) {
        $('wlMsg').innerHTML = `Точного тикера ${esc(q)} нет. Похожие: <span class="sugg">${found.slice(0, 6).map((r, i) => `<button class="chip" type="button" data-i="${i}">${esc(r.secid)} · ${esc(r.shortname)}</button>`).join('')}</span>`;
        $('wlMsg').querySelectorAll('.chip').forEach(b => b.onclick = () => addWatch(toW(found[+b.dataset.i])));
      } else $('wlMsg').textContent = `Не нашёл ${q} среди акций, облигаций, фондов, валюты и фьючерсов Мосбиржи.`;
    } catch (err) { $('wlMsg').textContent = 'Мосбиржа не отвечает. Проверьте интернет и попробуйте ещё раз.'; }
    finally { $('wlAdd').disabled = false; }
  });
  $('wlReset').onclick = () => { WATCH = DEF_WATCH.map(w => Object.assign({}, w)); saveWatch(); WQ = {}; renderWatch(); refreshWatch(); $('wlMsg').textContent = 'Исходный список возвращён.'; };
}
