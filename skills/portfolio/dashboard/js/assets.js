/* assets.js — раздел «Активы»: структура (по бумагам, видам, отраслям), «на что обратить внимание»,
   таблица позиций (на телефоне — карточки) и карточка бумаги в окне. Виды бумаг в данных: 'Акция', 'Облигация', 'Фонд'. */
'use strict';

let structMode = 'pos';
const CONC_LIMIT = 0.25; // доля одной бумаги, выше которой показываем предупреждение
const KIND_PLURAL = { 'Акция': 'Акции', 'Облигация': 'Облигации', 'Фонд': 'Фонды' };
const priceCell = p => p.bondPct != null ? `${dec(p.bondPct, 2)}${NB}% · ${price(p.price)}` : price(p.price);
const share = v => TOTAL ? v / TOTAL : 0;

function renderAssets() {
  const shares = P.filter(p => p.kind === 'Акция');
  $('assetsSub').textContent = `${P.length} ${plural(P.length, 'бумага', 'бумаги', 'бумаг')}${hasCash() ? ' и валюта' : ''} на ${rub(TOTAL)} · ${quoteLabel()}`;
  // таблица
  const tb = $('posTable').querySelector('tbody');
  const fxOther = CASHL.filter(c => c.amount && c.currency !== 'RUB').map(c => c.currency);
  const fxCell = fxOther.length ? fxOther.map(cur => LIVE.fx[cur] ? `${CUR_SIGN[cur] || cur}1 = ${dec(LIVE.fx[cur], 4)} ₽<br><span class="tk">${esc(LIVE.fxSrc[cur] || '')}</span>` : `<span class="tk">${cur}: нет курса</span>`).join('<br>') : '';
  tb.innerHTML = P.map((p, i) => {
    const sh = share(p.value), dy = p.price ? (p.fwdDivPerUnit || 0) / p.price : 0;
    return `<tr class="click" tabindex="0" data-i="${i}"><td><span class="nm">${esc(p.name)}</span><span class="tk">${esc(p.ticker)} · ${esc(String(p.kind || '').toLowerCase())}</span></td>
      <td class="num">${int(p.qty)} шт.</td><td class="num">${priceCell(p)}<br><span class="tk ${cls(p.dayChangePct)}">${pct(p.dayChangePct / 100, 2, true)} за день</span></td><td class="num">${rub(p.value)}</td><td class="num">${pct(sh, 1)}</td>
      <td class="num">${price(p.avg)}</td><td class="num ${cls(p.profit)}">${rub(p.profit, true)}</td><td class="num">${rub(p.divReceived || 0)}</td>
      <td class="num">${p.fwdIncome ? rub(p.fwdIncome) + `<br><span class="tk">${pct(dy, 1)} к цене</span>` : '<span class="tk">без выплат</span>'}</td></tr>`;
  }).join('') + (hasCash() ? `<tr><td><span class="nm">Валюта на счёте</span><span class="tk">${cashText()}</span></td><td class="num"></td><td class="num">${fxCell}</td><td class="num">${LIVE.cashKnown ? rub(CASH) : '—'}</td><td class="num">${pct(share(CASH), 1)}</td><td></td><td></td><td></td><td></td></tr>` : '');
  const tp = P.reduce((s, p) => s + p.profit, 0), td = P.reduce((s, p) => s + (p.divReceived || 0), 0);
  $('posTable').querySelector('tfoot').innerHTML = `<tr><td>Итого${hasCash() ? `: бумаги ${rub(sumPos)} + валюта` : ''}</td><td></td><td></td><td class="num">${rub(TOTAL)}</td><td class="num">100 %</td><td></td><td class="num ${cls(tp)}">${rub(tp, true)}</td><td class="num">${rub(td)}</td><td class="num">${rub(fwdTotal)}</td></tr>`;
  tb.querySelectorAll('tr.click').forEach(tr => { tr.onclick = () => openCard(P[+tr.dataset.i]); tr.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCard(P[+tr.dataset.i]); } }; });
  $('posCards').innerHTML = P.map((p, i) => `<button class="card" type="button" data-i="${i}"><span class="c-top"><b>${esc(p.name)}</b><span class="num">${pct(share(p.value), 1)}</span></span>
    <span class="tk muted small">${esc(p.ticker)} · ${esc(String(p.kind || '').toLowerCase())} · ${int(p.qty)} шт. по ${priceCell(p)}</span>
    <dl><dt>Стоимость</dt><dd class="num">${rub(p.value)}</dd><dt>За день</dt><dd class="num ${cls(p.dayAbs)}">${rub(p.dayAbs, true)} · ${pct(p.dayChangePct / 100, 2, true)}</dd><dt>Результат за всё время</dt><dd class="num ${cls(p.profit)}">${rub(p.profit, true)}</dd><dt>Выплаты 12 мес, прогноз</dt><dd class="num">${p.fwdIncome ? rub(p.fwdIncome) : 'нет'}</dd></dl></button>`).join('') +
    (hasCash() ? `<div class="card" style="cursor:default"><span class="c-top"><b>Валюта на счёте</b><span class="num">${pct(share(CASH), 1)}</span></span><span class="tk muted small">${cashText()}</span><dl><dt>Стоимость</dt><dd class="num">${LIVE.cashKnown ? rub(CASH) : 'нет курса'}</dd></dl></div>` : '');
  $('posCards').querySelectorAll('button.card').forEach(c => c.onclick = () => openCard(P[+c.dataset.i]));
  renderConcentration(shares);
  renderStruct();
}

/* «На что обратить внимание»: высокая доля бумаги, крупнейшая отрасль, классы активов, дыры в данных */
function renderConcentration(shares) {
  const big = P.filter(p => share(p.value) > CONC_LIMIT);
  const sectors = groupBy(shares, p => p.sector || 'Без отрасли'), shareTotal = shares.reduce((s, p) => s + p.value, 0);
  const topSec = Object.entries(sectors).sort((x, y) => y[1] - x[1])[0];
  let html = big.map(p => `<div class="note"><b>${esc(p.name)} — ${pct(share(p.value), 1)} портфеля.</b> Это больше порога ${Math.round(CONC_LIMIT * 100)} %, который здесь отмечается как высокая доля одной бумаги.</div>`).join('');
  if (topSec && shares.length > 1) html += `<div class="note" style="border-left-color:var(--muted)"><b>${esc(topSec[0])} — ${pct(share(topSec[1]), 1)} портфеля</b> (${pct(topSec[1] / shareTotal, 1)} от акций). ${esc(shares.filter(p => (p.sector || 'Без отрасли') === topSec[0]).map(p => p.name).join(', '))}.</div>`;
  const parts = Object.entries(groupBy(P, p => p.kind)).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${KIND_PLURAL[k] || k} — ${pct(share(v), 1)}`);
  if (hasCash()) parts.push(`валюта — ${pct(share(CASH), 1)}`);
  if (parts.length) { const t = parts.join(', '); html += `<div class="note" style="border-left-color:var(--muted)"><b>${t.split(', ')[0]}</b>${parts.length > 1 ? ', ' + parts.slice(1).join(', ').toLowerCase() : ''}.</div>`; }
  const W = D.warnings.length;
  if (W) html += `<div class="note"><b>В данных ${W} ${plural(W, 'дыра', 'дыры', 'дыр')}:</b> ${andList(D.warnings.map(w => esc(w.name)))} — минус в количестве бумаг. <a href="#data">Что это и как исправить</a></div>`;
  $('concentration').innerHTML = html || '<p class="small muted" style="margin:0">Ничего необычного: высоких долей и дыр в данных нет.</p>';
}

function renderStruct() {
  document.querySelectorAll('#structSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.m === structMode)));
  let items, base = TOTAL, note = '';
  const noteAll = hasCash() ? 'Доля от стоимости портфеля: бумаги и валюта на счёте.' : 'Доля от стоимости портфеля.';
  if (structMode === 'pos') { items = P.map(p => [p.name, p.value, p.ticker]); if (CASH > 0) items.push(['Валюта', CASH]); note = noteAll; }
  else if (structMode === 'kind') { items = Object.entries(groupBy(P, p => p.kind)).map(([k, v]) => [KIND_PLURAL[k] || k, v]); if (CASH > 0) items.push(['Валюта', CASH]); note = noteAll; }
  else { const sh = P.filter(p => p.kind === 'Акция'); base = sh.reduce((s, p) => s + p.value, 0); items = Object.entries(groupBy(sh, p => p.sector || 'Без отрасли')).map(([k, v]) => [k, v]); note = sh.length ? `Только акции: ${rub(base)}, ${pct(share(base), 1)} портфеля. Облигации и фонды в отрасли не входят.` : 'Акций в портфеле нет — разбивать по отраслям нечего.'; }
  items.sort((x, y) => y[1] - x[1]);
  const shades = [1, .82, .66, .52, .4, .3, .22];
  const sh = v => base ? v / base : 0;
  $('strip').innerHTML = items.map((it, i) => { const w = sh(it[1]) * 100; return `<div style="flex:${w} 0 0;background:${alpha(C.accent, shades[i] || .18)};color:${i < 3 ? C.sheet : C.ink}" title="${esc(it[0])}: ${pct(sh(it[1]), 1)}">${w > 12 ? esc(it[0].split(' ')[0]) : ''}</div>`; }).join('');
  $('strip').hidden = !items.length;
  $('strip').setAttribute('aria-label', items.map(it => it[0] + ' ' + pct(sh(it[1]), 1)).join(', '));
  $('structRows').innerHTML = items.map((it, i) => `<div class="row"><span class="r-n"><i style="display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:8px;background:${alpha(C.accent, shades[i] || .18)}"></i>${esc(it[0])}</span><span class="r-v num">${pct(sh(it[1]), 1)} · ${rub(it[1])}</span></div>`).join('');
  $('structNote').textContent = note + (items.length > 1 ? ' Доли округлены до десятых, в сумме может выйти 99,9–100,1' + NB + '%.' : '');
}

function openCard(p) {
  const ops = OPS.filter(o => o.ticker === p.ticker);
  const pays = D.payments.filter(x => x.ticker === p.ticker);
  const buys = ops.filter(o => o.event === 'BUY').reduce((s, o) => s + o.amountRub, 0);
  const sells = ops.filter(o => o.event === 'SELL').reduce((s, o) => s + o.amountRub, 0);
  const fc = D.forecast.filter(f => f.ticker === p.ticker);
  $('dlgTitle').textContent = p.name;
  $('dlgSub').textContent = [p.ticker, String(p.kind || '').toLowerCase(), p.sector].filter(Boolean).join(' · ');
  const unreal = p.value - p.cost;
  const f = [
    ['Количество', int(p.qty) + ' шт.'], [p.liveSrc ? `Цена, Мосбиржа ${p.liveTime || ''} мск` : 'Цена закрытия ' + dmy(asOf), priceCell(p) + (p.kind === 'Облигация' ? ' за облигацию, с купонным доходом' + (p.bondPct != null && LIVE.fxSrc.USD ? ` (доллар — ${LIVE.fxSrc.USD})` : '') : '')],
    ['Изменение цены за день', `<span class="${cls(p.dayChangePct)}">${pct(p.dayChangePct / 100, 2, true)}</span>`], ['Стоимость', rub(p.value)],
    ['Доля в портфеле', pct(share(p.value), 1)], ['Средняя цена покупки', price(p.avg)],
    ['Себестоимость открытой позиции', rub(p.cost)], ['Изменение стоимости открытой позиции', `<span class="${cls(unreal)}">${rub(unreal, true)}${p.cost ? ` (${pct(unreal / p.cost, 1, true)})` : ''}</span>`],
    ['Покупки за всё время', rub(buys)], ['Продажи за всё время', rub(sells)],
    ['Выплаты получены, после налога', rub(p.divReceived || 0)], ['Результат за всё время', `<span class="${cls(p.profit)}">${rub(p.profit, true)}</span>`],
    ['Выплаты за 12 мес вперёд, после налога', p.fwdIncome ? rub(p.fwdIncome) + ' · прогноз' : 'нет: выплат не ожидается'], ['Дивдоходность вперёд к цене', p.fwdIncome && p.price ? pct(p.fwdDivPerUnit / p.price, 1) : '—']
  ];
  let h = `<div class="facts">${f.map(r => `<div><span>${r[0]}</span><span class="num">${r[1]}</span></div>`).join('')}</div>`;
  if (fc.length) h += `<div><h3 style="font-size:16px;margin-bottom:6px">Ожидаемые выплаты</h3>${fc.map(x => `<div class="row" style="padding:4px 0"><span class="r-n">Реестр ${dmy(x.recordDate)} · ${dec(x.perShare, 2)} ₽ на акцию <span class="pill ${x.status === 'объявлен' ? 'an' : 'fc'}">${x.status}</span></span><span class="r-v num">${rub(x.net)}</span></div>`).join('')}</div>`;
  h += `<div><h3 style="font-size:16px;margin-bottom:6px">Операции (${ops.length}) и выплаты (${pays.length})</h3><div class="tbl-wrap"><table><thead><tr><th>Дата</th><th>Операция</th><th>Количество</th><th>Цена</th><th>Сумма, ₽</th></tr></thead><tbody>` +
    ops.map(o => { const q = opQty(o), pr = opPrice(o); return `<tr><td class="num">${dmy(o.date)}</td><td style="text-align:left">${evName(o)}</td><td class="num">${q}</td><td class="num">${pr}</td><td class="num">${rub(opRub(o))}</td></tr>`; }).join('') + '</tbody></table></div></div>';
  $('dlgBody').innerHTML = h;
  $('dlg').showModal();
}

function initAssets() {
  document.querySelectorAll('#structSeg button').forEach(b => b.onclick = () => { structMode = b.dataset.m; renderStruct(); });
  $('dlgClose').onclick = () => $('dlg').close();
  $('dlg').addEventListener('click', e => { if (e.target === $('dlg')) $('dlg').close(); });
}
