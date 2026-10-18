/* operations.js — раздел «Операции»: поиск, фильтры по типу, бумаге, году, итоги по фильтру, страницы по 25/50/100.
   opRub/opQty/opPrice используются и в карточке бумаги (assets.js). */
'use strict';

function opRub(o) { if (o.event === 'TAX' || o.event === 'FEE' || o.event === 'TAX_RETURN') return o.amountRub || o.fee; return o.amountRub; }
const isMove = o => o.event === 'MOVE_IN' || o.event === 'MOVE_OUT';
function opQty(o) { if (o.event === 'BUY' || o.event === 'SELL' || o.event === 'REPAYMENT' || isMove(o)) return int(o.qty) + NB + 'шт.'; return '—'; }
function opPrice(o) {
  if (o.event === 'BUY' || o.event === 'SELL' || o.event === 'REPAYMENT') return price(o.price, o.currency);
  if (isMove(o)) return price(o.price, 'RUB') + ' по рынку';
  if (o.event === 'DIVIDEND' && o.price > 0) return price(o.price, o.currency) + ' на бумагу';
  if (o.event === 'SPLIT') return 'коэф. ' + dec(o.price, 4);
  return '—';
}
function opCur(o) {
  if (isMove(o) && o.cost != null) return 'себестоимость ' + rub(o.cost);
  if (o.event === 'DIVIDEND' && o.currency !== 'RUB') return dec(o.qty, 2) + NB + (o.currency === 'USD' ? '$' : o.currency) + (o.fee ? ', налог ' + dec(o.fee, 2) + NB + (o.currency === 'USD' ? '$' : o.currency) : '');
  if ((o.event === 'CASH_IN' || o.event === 'CASH_OUT') && o.currency !== 'RUB') return dec(o.qty, 2) + NB + o.currency;
  if (o.event === 'DIVIDEND' && o.fee) return 'налог ' + rub(o.fee);
  if ((o.event === 'BUY' || o.event === 'SELL') && o.fee) return 'комиссия ' + dec(o.fee, 2) + NB + (o.currency === 'USD' ? '$' : '₽');
  if ((o.event === 'BUY' || o.event === 'SELL')) return 'комиссия 0';
  return '';
}

let page = 0;
function filtered() {
  const q = $('fQ').value.trim().toLowerCase(), t = $('fType').value, tk = $('fTicker').value, y = $('fYear').value;
  return OPS.filter(o => (!t || o.event === t) && (!tk || o.ticker === tk) && (!y || o.date.startsWith(y)) && (!q || (o.name + ' ' + o.ticker + ' ' + o.note + ' ' + evName(o)).toLowerCase().includes(q)));
}
function renderOps() {
  const list = filtered(), size = +$('pgSize').value, pages = Math.max(1, Math.ceil(list.length / size));
  page = Math.min(page, pages - 1);
  $('opsSub').textContent = OPS.length ? `${OPS.length} ${plural(OPS.length, 'запись', 'записи', 'записей')} с ${dmy(OPS[OPS.length - 1].date)} по ${dmy(OPS[0].date)}, новые сверху` : 'Операций в данных пока нет';
  const sum = {}; list.forEach(o => { sum[o.event] = (sum[o.event] || 0) + opRub(o); });
  const order = ['BUY', 'SELL', 'DIVIDEND', 'TAX', 'FEE', 'CASH_IN', 'CASH_OUT'];
  const active = [$('fQ').value && `поиск «${$('fQ').value}»`, $('fType').value && $('fType').selectedOptions[0].text, $('fTicker').value && $('fTicker').selectedOptions[0].text, $('fYear').value].filter(Boolean);
  $('opsSum').innerHTML = `<span><b>Найдено ${list.length}</b>${active.length ? ' · ' + esc(active.join(', ')) : ' · все операции'}</span>` +
    order.filter(k => sum[k]).map(k => `<span>${k === 'DIVIDEND' ? 'Выплаты, до налога' : EV[k]}: <b class="num">${rub(sum[k])}</b></span>`).join('');
  const rows = list.slice(page * size, page * size + size);
  $('opList').innerHTML = `<div class="op h"><span>Дата</span><span>Операция и бумага</span><span>Количество</span><span>Цена</span><span>Сумма, ₽</span></div>` +
    (rows.length ? rows.map(o => `<div class="op"><span class="num">${dmy(o.date)}</span><span class="o-a"><b style="font-weight:500">${evName(o)}</b> · ${esc(o.name || (o.event === 'TAX' || o.event === 'FEE' ? 'по счёту' : ''))}${o.note ? `<span class="o-n">${esc(o.note)}</span>` : ''}</span><span class="num${opQty(o) === '—' ? ' na' : ''}">${opQty(o)}</span><span class="num${opPrice(o) === '—' ? ' na' : ''}">${opPrice(o)}</span><span class="num">${rub(opRub(o))}${opCur(o) ? `<span class="o-t">${opCur(o)}</span>` : ''}</span></div>`).join('')
      : `<div style="padding:24px;text-align:center">Операции не найдены. <button class="link" type="button" onclick="document.getElementById('fReset').click()">Сбросить фильтры</button></div>`);
  $('pgInfo').textContent = list.length ? `Строки ${page * size + 1}–${Math.min(list.length, (page + 1) * size)} из ${list.length} · страница ${page + 1} из ${pages}` : '';
  $('pgPrev').disabled = page === 0; $('pgNext').disabled = page >= pages - 1;
}

function initOps() {
  const opYears = [...new Set(OPS.map(o => o.date.slice(0, 4)))].sort().reverse();
  const cashTk = new Set(['RUB', 'USD', 'CNY', 'EUR', 'HKD']);
  const opTickers = [...new Set(OPS.filter(o => o.ticker && !cashTk.has(o.ticker)).map(o => o.ticker))].sort((a, b) => (nameOf[a] || a).localeCompare(nameOf[b] || b, 'ru'));
  $('fType').innerHTML = '<option value="">Все операции</option>' + [['DIVIDEND', 'Дивиденды и купоны']].concat(Object.entries(EV).filter(e => e[0] !== 'DIVIDEND')).filter(e => OPS.some(o => o.event === e[0])).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  $('fTicker').innerHTML = '<option value="">Все бумаги</option>' + opTickers.map(t => `<option value="${esc(t)}">${esc(nameOf[t] || t)}</option>`).join('');
  $('fYear').innerHTML = '<option value="">Все годы</option>' + opYears.map(y => `<option>${y}</option>`).join('');
  ['fQ', 'fType', 'fTicker', 'fYear', 'pgSize'].forEach(id => $(id).addEventListener('input', () => { page = 0; renderOps(); }));
  $('fReset').onclick = () => { $('fQ').value = ''; $('fType').value = ''; $('fTicker').value = ''; $('fYear').value = ''; page = 0; renderOps(); };
  $('pgPrev').onclick = () => { page--; renderOps(); $('ops').scrollIntoView(); };
  $('pgNext').onclick = () => { page++; renderOps(); $('ops').scrollIntoView(); };
}
