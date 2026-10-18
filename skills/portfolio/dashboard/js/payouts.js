/* payouts.js — раздел «Выплаты»: календарь на 12 месяцев по датам реестра, история по годам (столбики и таблица),
   последние поступления. Купоны облигаций распределяются по месяцам поровну — это оценка. */
'use strict';

let years = [], selYear = '';
function yearLabel(y) { return y === asOf.slice(0, 4) ? `${y}, по ${dLong(asOf).replace(' ' + y, '')}` : y; }

function renderPayouts() {
  years = Object.keys(D.divByYear).sort();
  if (!selYear || !years.includes(selYear)) selYear = years[years.length - 1] || '';
  // календарь
  const start = new Date(Date.UTC(+asOf.slice(0, 4), +asOf.slice(5, 7) - 1, 1));
  const bd = bonds().filter(p => p.fwdIncome), bondYear = bd.reduce((s, p) => s + p.fwdIncome, 0), bondM = bondYear / 12;
  const months = [];
  for (let m = 0; m < 12; m++) { const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1 + m, 1)); months.push(d.toISOString().slice(0, 7)); }
  const endIso = iso(Date.UTC(+asOf.slice(0, 4) + 1, +asOf.slice(5, 7) - 1, +asOf.slice(8, 10)));
  const fc = D.forecast.filter(f => f.recordDate > asOf && f.recordDate <= endIso);
  $('cal').hidden = !fc.length && !bd.length; // нет ни реестров, ни купонов — пустой календарь не рисуем
  $('cal').innerHTML = months.map(ym => {
    const its = fc.filter(f => f.recordDate.startsWith(ym)).sort((x, y) => x.recordDate < y.recordDate ? -1 : 1);
    const tot = its.reduce((s, f) => s + f.net, 0) + bondM;
    return `<div class="mon ${its.length ? 'has' : ''}"><div class="m-h"><span>${MONN[+ym.slice(5) - 1]} ${ym.slice(0, 4)}</span><b class="num">${rub(tot)}</b></div>` +
      its.map(f => `<div class="it">${+f.recordDate.slice(8)}${NB}${MONS[+f.recordDate.slice(5, 7) - 1]} · ${esc(f.name)}<br><span class="num">${rub(f.net)}</span> <span class="pill ${f.status === 'объявлен' ? 'an' : 'fc'}">${f.status}</span></div>`).join('') +
      (bd.length ? `<div class="it muted">+ ${bd.length > 1 ? 'купоны облигаций' : 'купон облигации'} ≈${NB}${rub(bondM)}</div>` : '') + '</div>';
  }).join('');
  const fcSum = fc.reduce((s, f) => s + f.net, 0);
  $('fcSub').textContent = `${dmy(days[LAST])} – ${dmy(endIso)} · после налога 15 %`;
  $('fcNote').innerHTML = (fcSum || bondYear)
    ? `Всего за 12 месяцев: <b class="num">${rub(fcSum + bondYear)}</b> после налога — ${rub(fcSum)} по датам реестра акций${bd.length ? ` и ${rub(bondYear)} купонами облигаций` : ''}. Месяц — по дате реестра; деньги обычно приходят позже, до нескольких недель. «Прогноз» — оценка, «объявлен» — решение компании.` + (bd.length ? ' Купоны облигаций разложены по месяцам поровну, поэтому это оценка.' : '')
    : 'Ожидаемых выплат в ближайшие 12 месяцев в данных нет.';
  // история
  const hasHist = years.length > 0;
  $('divChart').hidden = !hasHist; $('yearTable').hidden = !hasHist;
  if (hasHist) {
    const gross = years.map(y => Object.values(D.divByYear[y]).reduce((s, v) => s + v[0], 0));
    const net = years.map(y => Object.values(D.divByYear[y]).reduce((s, v) => s + v[1], 0));
    const draw = () => barChart($('divChart'), {
      cats: years.map(y => y === asOf.slice(0, 4) ? y + '*' : y), height: 240, yFmt: v => mlnAxis(v), selected: years.indexOf(selYear), label: 'Выплаты по годам',
      groups: [{ name: 'После налога', color: C.gold, vals: net, top: gross.map((g, i) => g - net[i]) }],
      tip: i => `<div class="t-d">${yearLabel(years[i])}</div>` + tipRow('До налога', rub(gross[i])) + tipRow('Налог', rub(gross[i] - net[i])) + tipRow('После налога', rub(net[i]), C.gold),
      onClick: i => { selYear = years[i]; draw(); renderYear(); }
    });
    draw(); renderPayouts.draw = draw;
    $('yearPick').innerHTML = `<select id="ySel" class="btn" aria-label="Год">${years.map(y => `<option ${y === selYear ? 'selected' : ''}>${y}</option>`).join('')}</select>`;
    $('ySel').onchange = e => { selYear = e.target.value; draw(); renderYear(); };
  } else { renderPayouts.draw = null; $('yearPick').innerHTML = ''; }
  renderYear();
  // последние
  const lp = D.payments.slice().sort((x, y) => x.date < y.date ? 1 : -1).slice(0, 8);
  $('lastPay').querySelector('tbody').innerHTML = lp.length ? lp.map(p => `<tr><td class="num">${dmy(p.date)}</td><td style="text-align:left;white-space:normal">${esc(p.name)}</td><td class="num">${rub(p.gross)}</td><td class="num">${rub(p.net)}</td><td>${p.netEstimated ? '<span class="pill est">после налога, оценка</span>' : '<span class="pill fact">по выписке</span>'}</td></tr>`).join('')
    : '<tr><td colspan="5" style="text-align:left;white-space:normal" class="muted">Выплат пока не было.</td></tr>';
  const nEst = D.payments.filter(p => p.netEstimated).length;
  $('estNote').textContent = nEst ? `«После налога, оценка» — в данных записана только сумма после налога или налог посчитан по ставке; таких записей ${nEst} из ${D.payments.length}. «По выписке» — налог удержан брокером и записан отдельно.` : (D.payments.length ? '«По выписке» — налог удержан брокером и записан отдельно.' : '');
}

function renderYear() {
  if (!selYear) { $('yearTitle').textContent = 'Выплаты по годам'; $('yearTable').querySelector('tbody').innerHTML = ''; $('yearTable').querySelector('tfoot').innerHTML = ''; showNoHistory(); return; }
  if ($('ySel')) $('ySel').value = selYear;
  $('yearTitle').textContent = 'Выплаты за ' + yearLabel(selYear);
  const rows = Object.entries(D.divByYear[selYear]).sort((x, y) => y[1][0] - x[1][0]);
  const g = rows.reduce((s, r) => s + r[1][0], 0), n = rows.reduce((s, r) => s + r[1][1], 0);
  $('yearTable').querySelector('tbody').innerHTML = rows.map(([t, v]) => `<tr><td style="white-space:normal"><span class="nm" style="min-width:0">${esc(nameOf[t] || t)}</span><span class="tk">${esc(t)}</span></td><td class="num">${rub(v[0])}</td><td class="num">${rub(v[0] - v[1])}</td><td class="num">${rub(v[1])}</td></tr>`).join('');
  $('yearTable').querySelector('tfoot').innerHTML = `<tr><td>Итого</td><td class="num">${rub(g)}</td><td class="num">${rub(g - n)}</td><td class="num">${rub(n)}</td></tr>`;
}
function showNoHistory() {
  const host = $('divChart').parentElement;
  if (host.querySelector('.no-hist')) return;
  const hint = $('divChart').nextElementSibling; if (hint) hint.hidden = true; // «Нажмите на год…»
  $('divChart').insertAdjacentHTML('afterend', '<p class="small muted no-hist" style="margin:0">Выплат пока не было — история появится после первого дивиденда или купона.</p>');
}
