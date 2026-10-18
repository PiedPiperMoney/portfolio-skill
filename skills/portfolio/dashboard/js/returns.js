/* returns.js — раздел «Доходность»: периоды, выбор индексов, карточки «портфель против индекса», большой график,
   результат по годам и «из чего сложилась прибыль». Расчёт сравнения — в benchmark.js (не менять). */
'use strict';

const PERIODS = [['1m', '1 мес', 1], ['3m', '3 мес', 3], ['6m', '6 мес', 6], ['ytd', 'С начала года'], ['1y', '1 год', 12], ['3y', '3 года', 36], ['5y', '5 лет', 60], ['all', 'Всё время']];
let per = '1y', A = 0, B = 0, mode = 'rub';
let sel = new Set();
let lastCmp = {};

function setPeriod(p) {
  per = p; B = LAST;
  const def = PERIODS.find(x => x[0] === p);
  if (p === 'all') A = 0; else if (p === 'ytd') A = Math.max(0, idxOf(days[LAST].slice(0, 4) + '-01-01')); else A = monthsBack(LAST, def[2]);
  renderReturns();
}
function onDates() {
  const f = $('dFrom').value, t = $('dTo').value; if (!f || !t) return;
  let a = Math.max(0, Math.min(LAST, idxOf(f))), b = Math.max(0, Math.min(LAST, idxOf(t)));
  if (b <= a) { if (a >= LAST) a = LAST - 1; b = a + 1; }
  A = Math.max(0, a); B = Math.min(LAST, b); per = 'custom'; renderReturns();
}

function initReturns() {
  A = yearAgo(LAST); B = LAST;
  const def = mainIdx();
  sel = new Set(def ? [def] : []);
  try { const s = JSON.parse(localStorage.getItem('pf-idx') || 'null'); if (Array.isArray(s) && s.length) sel = new Set(s.filter(k => IDX.includes(k))); } catch (e) {}
  if (!sel.size && def) sel = new Set([def]);
  $('periodSeg').innerHTML = PERIODS.map(p => `<button type="button" data-p="${p[0]}">${p[1]}</button>`).join('');
  $('periodSeg').querySelectorAll('button').forEach(b => b.onclick = () => setPeriod(b.dataset.p));
  $('dFrom').min = $('dTo').min = days[0]; $('dFrom').max = $('dTo').max = days[LAST];
  $('dFrom').addEventListener('change', onDates); $('dTo').addEventListener('change', onDates);
  $('idxChips').innerHTML = IDX.map(k => `<button class="chip" type="button" data-k="${k}" style="--c:var(--s-${k})" title="${esc(D.indexNames[k] || IDX_SHORT[k])}"><span class="sw"></span>${k}<span class="muted small">${CHIP[k]}</span></button>`).join('');
  $('idxChips').querySelectorAll('.chip').forEach(c => c.onclick = () => { const k = c.dataset.k; if (sel.has(k)) { if (sel.size > 1) sel.delete(k); } else sel.add(k); try { localStorage.setItem('pf-idx', JSON.stringify([...sel])); } catch (e) {} renderReturns(); });
  document.querySelectorAll('#modeSeg button').forEach(b => b.onclick = () => { mode = b.dataset.m; renderReturns(); });
}

function renderReturns() {
  $('periodSeg').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.p === per)));
  document.querySelectorAll('#modeSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.m === mode)));
  $('idxChips').querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', String(sel.has(c.dataset.k))));
  $('dFrom').value = days[A]; $('dTo').value = days[B];
  const a = A, b = B, perName = per === 'custom' ? 'Выбранный период' : PERIODS.find(x => x[0] === per)[1];
  const dp = D.value[b] - D.value[a], fl = flowsSum(a, b), res = dp - fl;
  $('periodTitle').textContent = `${perName}: ${dmy(days[a])} – ${dmy(days[b])}`;
  $('periodSub').innerHTML = `Стоимость ${rub(D.value[a])} → ${rub(D.value[b])} · результат без покупок и продаж <b class="num ${cls(res)}">${rub(res, true)}</b>`;
  const T = twr(a, b);
  lastCmp = {};
  const cards = IDX.filter(k => sel.has(k)).map(k => {
    const c = compare(k, a, b); lastCmp[k] = c;
    const col = `var(--s-${k})`;
    if (!c) return `<div class="vs"><div class="v-h"><i class="sw" style="background:${col}"></i>${k} · ${esc(IDX_SHORT[k])}</div><div class="v-main">Недостаточно данных: индекс считается с ${dmy(days[firstIdx[k]])}. Выберите период позже этой даты.</div></div>`;
    const ir = D.indexes[k][b] / D.indexes[k][a] - 1;
    const word = c.X >= 0 ? 'обгоняет индекс на' : 'отстаёт от индекса на';
    return `<div class="vs"><div class="v-h"><i class="sw" style="background:${col}"></i><span>${k} · ${esc(IDX_SHORT[k])}</span></div>
      <div class="v-main">Портфель ${word}<b class="num ${cls(c.X)}">${rub(Math.abs(c.X))} · ${pct(Math.abs(c.Y), 2)}</b></div>
      <dl><dt>Портфель изменился на</dt><dd class="num">${rub(c.dp, true)}</dd>
      <dt>Те же деньги в индексе изменились на</dt><dd class="num">${rub(c.di, true)}</dd>
      <dt>Модель в индексе на ${dmy(days[b])}</dt><dd class="num">${rub(c.end)}</dd>
      <dt>Доходность без покупок и продаж: портфель / индекс</dt><dd class="num">${pct(T[T.length - 1], 1, true)} / ${pct(ir, 1, true)}</dd></dl></div>`;
  });
  $('vsCards').innerHTML = cards.length ? cards.join('') : '<p class="small muted" style="margin:0">В данных нет истории индексов — сравнивать не с чем.</p>';
  // график
  const leg = [`<span><i style="border-color:var(--s-port);border-top-width:3px"></i>Портфель</span>`];
  if (mode === 'rub') leg.push(`<span><i class="dash" style="border-color:var(--s-inv)"></i>Вложено</span>`);
  IDX.filter(k => sel.has(k) && lastCmp[k]).forEach(k => leg.push(`<span><i style="border-color:var(--s-${k})"></i>${mode === 'rub' ? 'Те же деньги в ' + k : k}</span>`));
  $('bigLegend').innerHTML = leg.join('');
  $('modeNote').textContent = mode === 'rub'
    ? `Здесь только бумаги${hasCash() ? ', без валюты на счёте' : ''}; история — по ценам закрытия` + (isLive() ? ', пунктир в конце — бумаги по живым ценам сейчас' : '') + '. Линия индекса — модель: в первый день периода в индекс вложена стоимость портфеля, дальше в те же дни докупается на сумму покупок и продаётся на сумму продаж и полученных выплат. % — разница в рублях к модели на конец периода.'
    : 'Доходность без влияния покупок и продаж: прирост стоимости за каждый день, связанный в цепочку (выплаты считаются доходом). Индекс — изменение его значения с первого дня периода.';
  drawBig(T);
  renderYears();
}

function drawBig(T) {
  const a = A, b = B, ks = IDX.filter(k => sel.has(k) && lastCmp[k]);
  const series = [];
  if (mode === 'rub') {
    series.push({ get: i => D.value[i], color: C['s-port'], width: 2.25, fill: true, name: 'Портфель' });
    ks.forEach(k => series.push({ get: i => lastCmp[k].series[i - a], color: C['s-' + k], width: 1.5, name: k }));
    series.push({ get: i => D.invested[i], color: C['s-inv'], width: 1.25, dash: [5, 4], name: 'Вложено' });
  } else {
    series.push({ get: i => T[i - a] * 100, color: C['s-port'], width: 2.25, name: 'Портфель' });
    ks.forEach(k => { const I = D.indexes[k], i0 = I[a]; series.push({ get: i => (I[i] / i0 - 1) * 100, color: C['s-' + k], width: 1.5, name: k }); });
  }
  const H = window.innerWidth < 700 ? 280 : 400;
  // «сейчас»: портфель по живым ценам, модель индекса = её паи на последнее закрытие × живое значение индекса
  let extra = null;
  if (mode === 'rub' && b === LAST && isLive()) {
    const now = {};
    ks.forEach(k => { const s = lastCmp[k].series; now[k] = s[b - a] / D.indexes[k][b] * idxNow(k); });
    series.forEach(s => { if (now[s.name] != null) s.live = now[s.name]; else if (s.name === 'Вложено') s.live = D.invested[LAST]; });
    extra = { v: SEC, tip: `<div class="t-d">Сейчас, ${LIVE.time} мск</div>` + tipRow('Портфель по живым ценам', rub(SEC), C['s-port']) +
      ks.map(k => tipRow('Те же деньги в ' + k, rub(now[k]), C['s-' + k])).join('') + tipRow('Вложено', rub(D.invested[LAST]), C['s-inv']) +
      ks.map(k => { const x = (SEC - D.value[a]) - (now[k] - lastCmp[k].series[0]); return `<div class="t-r"><span>Разница с ${k}</span><b class="num ${cls(x)}">${rub(x, true)}</b></div>`; }).join('') };
  }
  lineChart($('bigChart'), {
    a, b, height: H, zero: mode === 'pct', extra,
    yFmt: mode === 'rub' ? (v => mlnAxis(v)) : (v => dec(v, Math.abs(v) < 10 && v % 1 ? 1 : 0) + NB + '%'),
    series, label: 'Портфель и индексы за выбранный период',
    tip: i => {
      let h = `<div class="t-d">${dLong(days[i])}</div>`;
      if (mode === 'rub') {
        h += tipRow('Портфель', rub(D.value[i]), C['s-port']);
        ks.forEach(k => h += tipRow('Те же деньги в ' + k, rub(lastCmp[k].series[i - a]), C['s-' + k]));
        h += tipRow('Вложено', rub(D.invested[i]), C['s-inv']);
        ks.forEach(k => { const x = (D.value[i] - D.value[a]) - (lastCmp[k].series[i - a] - lastCmp[k].series[0]); h += `<div class="t-r"><span>Разница с ${k}</span><b class="num ${cls(x)}">${rub(x, true)}</b></div>`; });
        if (flowAt[i] && i > a) h += `<div class="t-r"><span>Покупки − продажи − выплаты</span><b class="num">${rub(flowAt[i], true)}</b></div>`;
      } else {
        h += tipRow('Портфель', pct(T[i - a], 2, true), C['s-port']);
        ks.forEach(k => h += tipRow(k, pct(D.indexes[k][i] / D.indexes[k][a] - 1, 2, true), C['s-' + k]));
      }
      return h;
    }
  });
}

function renderYears() {
  const k = IDX.find(x => sel.has(x) && x !== 'IMOEX') || [...sel][0];
  const y0 = +days[0].slice(0, 4), y1 = +days[LAST].slice(0, 4), cats = [], vp = [], vi = [], info = [];
  for (let y = y0; y <= y1; y++) {
    const a = y === y0 ? 0 : idxOf((y - 1) + '-12-31'), b = y === y1 ? LAST : idxOf(y + '-12-31');
    const res = D.value[b] - D.value[a] - flowsSum(a, b), c = k ? compare(k, a, b) : null;
    cats.push(y === y1 ? y + '*' : String(y)); vp.push(res); vi.push(c ? c.di - flowsSum(a, b) : 0); info.push({ a, b, c, res });
  }
  $('yearsSub').textContent = `₽ · * ${y1} по ${dmy(asOf)}`;
  $('yearsLegend').innerHTML = `<span><i style="border-color:var(--s-port);border-top-width:8px"></i>Портфель</span>` + (k ? `<span><i style="border-color:var(--s-${k});border-top-width:8px"></i>Те же деньги в ${k}</span>` : '');
  const groups = [{ name: 'Портфель', color: C['s-port'], vals: vp }];
  if (k) groups.push({ name: k, color: C['s-' + k], vals: vi });
  barChart($('yearsChart'), {
    cats, height: 260, yFmt: v => mlnAxis(v), label: 'Результат по годам', groups,
    tip: i => { const x = info[i]; let h = `<div class="t-d">${cats[i].replace('*', '')}: ${dmy(days[x.a])} – ${dmy(days[x.b])}</div>` + tipRow('Портфель', rub(x.res, true), C['s-port']); if (x.c) { h += tipRow('Те же деньги в ' + k, rub(vi[i], true), C['s-' + k]); h += `<div class="t-r"><span>Разница</span><b class="num ${cls(x.c.X)}">${rub(x.c.X, true)}</b></div>`; } else h += '<div class="t-r"><span>Индекс</span><b>нет данных</b></div>'; return h; }
  });
}

function renderChain() {
  const t = D.totals;
  $('chainFrom').textContent = dmy(days[0]);
  $('chainTo').textContent = dmy(asOf);
  const rows = [
    ['', 'Стоимость бумаг сейчас', SEC, (isLive() ? `по ценам Мосбиржи на ${LIVE.time} мск` : `на ${dmy(asOf)}`) + (hasCash() ? '; валюта на счёте не входит' : '')],
    ['+', 'Продажи и погашения', t.sells, 'за всё время'],
    ['−', 'Покупки', -t.buys, 'за всё время'],
    ['−', 'Комиссии по сделкам', -t.fees, ''],
    ['−', 'Налоги и сборы отдельными записями', -t.otherTaxFees, 'НДФЛ, плата по тарифу'],
    ['+', 'Выплаты после налога', t.divNet, `дивиденды и купоны; налог с них ${rub(t.divTax)}`]
  ];
  // переводы бумаг между своими счетами (только в портфеле счёта или брокера): по себестоимости, без прибыли
  if (t.movedOut) rows.push(['+', 'Бумаги ушли на другие свои счета', t.movedOut, 'по себестоимости, не продажа']);
  if (t.movedIn) rows.push(['−', 'Бумаги пришли с других своих счетов', -t.movedIn, 'по себестоимости, не покупка']);
  const total = t.profit + SEC - SEC_CLOSE;
  $('chain').innerHTML = rows.map(r => `<div><span class="op-s">${r[0]}</span><span>${r[1]}${r[3] ? `<span class="small muted">${r[3]}</span>` : ''}</span><span class="num">${rub(Math.abs(r[2]))}</span></div>`).join('') +
    `<div class="tot"><span class="op-s">=</span><span>Прибыль за всё время${total > 0 && t.divNet ? `<span class="small muted" style="font-weight:400">из неё выплаты — ${pct(t.divNet / total, 0)}</span>` : ''}</span><span class="num ${cls(total)}">${rub(total, true)}</span></div>`;
}
