/* overview.js — раздел «Обзор»: первый экран (стоимость, день, три цифры, фраза сравнения, мини-график)
   и три панели под ним: что повлияло на день, крупнейшие позиции, ближайшие выплаты. */
'use strict';

function renderOverview() {
  $('stamp').innerHTML = `<span class="qdot ${LIVE.state}"></span>` + esc(LIVE.cached ? `Цены на ${dmy(LIVE.cached.date).slice(0, 5)}${LIVE.cached.time ? ', ' + LIVE.cached.time.slice(0, 5) : ''} · обновляем` : LIVE.state === 'live' ? `Живые цены · ${LIVE.time} мск` : LIVE.state === 'closed' ? `Торги закрыты · ${LIVE.time} мск` : `Закрытие ${dmy(asOf)}`); $('stamp').title = quoteLabel();
  $('quoteState').innerHTML = `<span class="qdot ${LIVE.state}"></span>${esc(quoteLabel())}`;
  $('loadedState').hidden = !D.loadedOn;
  if (D.loadedOn) { $('loadedState').textContent = 'Операции загружены ' + dLong(D.loadedOn); $('loadedState').title = 'Последняя операция — ' + dLong(D.lastOperation || D.loadedOn) + '. Новые операции подтягивает агент: попросите его «обнови портфель». Цены обновляются на странице сами.'; }
  $('heroLabel').textContent = 'Стоимость портфеля' + (isLive() ? ' сейчас' : ' на ' + dLong(asOf));
  $('heroValue').innerHTML = int(TOTAL) + '<span class="cur">₽</span>';
  $('heroSplit').innerHTML = hasCash() ? `Бумаги <b class="num">${rub(SEC)}</b> + валюта <b class="num">${LIVE.cashKnown ? rub(CASH) : 'нет курса'}</b> <span class="muted">(${cashText()})</span>` : '';
  $('heroSplit').hidden = !hasCash();
  const dayLbl = isLive() ? `изменение стоимости за торговый день к закрытию ${dmy(LIVE.prevDate)}${CASHDAY ? ', с учётом курса валюты' : ''}` : `изменение стоимости бумаг за торговый день ${dmy(asOf)}` + (LAST > 0 ? ` к ${dmy(days[LAST - 1])}` : '');
  $('heroDay').innerHTML = `<span class="${cls(DAYABS)} num">${rub(DAYABS, true)} · ${pct(DAYPCT, 2, true)}</span><span class="small">${dayLbl}</span>`;
  const first = days[0];
  const profit = D.totals.profit + (SEC - SEC_CLOSE);
  const kp = [
    ['Прибыль за всё время', rub(profit, true), `С ${dmy(first)}: стоимость бумаг, продажи и выплаты после налога за вычетом покупок, комиссий и налогов${D.totals.movedIn || D.totals.movedOut ? '; бумаги, переведённые между своими счетами, — по себестоимости' : ''}`, cls(profit)],
    ['Годовая доходность (XIRR)', D.xirr != null ? pct(D.xirr, 2) : '—', `За всю историю с ${dmy(first)}, по ценам закрытия ${dmy(asOf)}, с учётом дат каждой покупки, продажи и выплаты`, ''],
    ['Выплаты за 12 месяцев вперёд', rub(fwdTotal), fwdTotal ? `После налога 15 %, прогноз. В среднем ${rub(fwdTotal / 12)} в месяц; приходят неравномерно` : 'По бумагам в портфеле выплат в ближайший год не ожидается', '']
  ];
  $('kpis').innerHTML = kp.map(k => `<div class="kpi"><span class="k-l">${k[0]}</span><span class="k-v num ${k[3]}">${k[1]}</span><span class="k-n">${k[2]}</span></div>`).join('');
  renderThesis();
  // день: вклад бумаг
  const contrib = P.map(p => ({ p, v: p.dayAbs })).filter(x => Math.abs(x.v) >= 1).sort((x, y) => Math.abs(y.v) - Math.abs(x.v));
  const top5 = contrib.slice(0, 5), mx = Math.max(1, ...top5.map(x => Math.abs(x.v)));
  $('dayDate').textContent = (isLive() ? `сейчас к ${dmy(LIVE.prevDate)}` : dmy(asOf)) + ', по вкладу в рублях';
  $('dayRows').innerHTML = top5.length ? top5.map(x => `<div class="row"><span class="r-n">${esc(x.p.name)}<span class="tk">${pct(x.p.dayChangePct / 100, 2, true)}</span></span><span class="r-v num ${cls(x.v)}">${rub(x.v, true)}</span>
    <span class="bar div"><b class="${cls(x.v)}" style="${x.v >= 0 ? 'left:50%' : 'right:50%'};width:${Math.abs(x.v) / mx * 50}%"></b></span></div>`).join('') : '<p class="small muted" style="margin:0">Цены за день не изменились.</p>';
  const sumC = contrib.reduce((s, x) => s + x.v, 0);
  $('dayNote').textContent = isLive()
    ? `Вклад = количество × изменение цены к закрытию ${dmy(LIVE.prevDate)}. Сумма по бумагам ${rub(sumC, true)}${CASHDAY ? `, курс валюты ${rub(CASHDAY, true)}` : ''}.`
    : `Вклад = стоимость бумаги × изменение её цены за день. Сумма по бумагам ${rub(sumC, true)}; изменение стоимости бумаг ${rub(DAYABS, true)}.`;
  // крупнейшие
  $('topRows').innerHTML = P.length ? P.slice(0, 5).map(p => { const sh = TOTAL ? p.value / TOTAL : 0; return `<div class="row"><span class="r-n">${esc(p.name)}</span><span class="r-v num">${pct(sh, 1)} · ${mln(p.value)} ₽</span><span class="bar"><b style="left:0;width:${sh * 100}%"></b></span></div>`; }).join('')
    : '<p class="small muted" style="margin:0">В портфеле пока нет бумаг.</p>';
  // ближайшие выплаты: купоны облигаций (в среднем в месяц) и четыре ближайшие даты реестра
  const fc = D.forecast.slice().sort((x, y) => x.recordDate < y.recordDate ? -1 : 1).slice(0, 4);
  const bd = bonds().filter(p => p.fwdIncome);
  const html = bd.map(b => `<div class="row"><span class="r-n">${esc(b.name)}<span class="tk">купоны, в среднем в месяц</span></span><span class="r-v num">≈${rub(b.fwdIncome / 12)}</span><span class="small muted" style="grid-column:1/-1">после налога, оценка <span class="pill est">оценка</span></span></div>`).join('') +
    fc.map(f => `<div class="row"><span class="r-n">${esc(f.name)}<span class="tk">реестр ${dmy(f.recordDate)}</span></span><span class="r-v num">${rub(f.net)}</span><span class="small muted" style="grid-column:1/-1">${dec(f.perShare, 2)} ₽ × ${int(f.qty)} шт., после налога <span class="pill ${f.status === 'объявлен' ? 'an' : 'fc'}">${f.status === 'объявлен' ? 'объявлен' : 'прогноз'}</span></span></div>`).join('');
  $('nextPay').innerHTML = html || '<p class="small muted" style="margin:0">Ожидаемых выплат в данных нет.</p>';
}

/* фраза сравнения с главным индексом за год (или за всю историю, если она короче года) */
function renderThesis() {
  const k = mainIdx(), a = yearAgo(LAST), c = k ? compare(k, a, LAST) : null;
  if (!c || a === LAST) { $('thesis').innerHTML = `<span class="small muted">Сравнение с индексом появится, когда в данных будет история индекса и портфеля хотя бы за несколько дней.</span>`; return; }
  const span = a === 0 && LAST < 365 ? 'С начала истории' : 'За год';
  const verb = c.X >= 0 ? 'обгоняет рынок' : 'отстаёт от рынка';
  const iname = k === 'MCFTR' ? 'индекса Мосбиржи полной доходности (MCFTR)' : `индекса ${k}`;
  $('thesis').innerHTML = `${span} портфель <b>${verb} на ${rub(Math.abs(c.X))}</b> (${pct(Math.abs(c.Y), 1)}).` +
    `<span class="small muted">${dmy(days[a])} – ${dmy(asOf)}, бумаги по ценам закрытия против ${iname} при тех же покупках и продажах. <button class="link" type="button" id="toReturns">Подробнее</button></span>`;
  $('toReturns').onclick = () => { setPeriod('1y'); location.hash = '#returns'; document.getElementById('returns').scrollIntoView(); };
}

function drawMini() {
  $('miniTitle').textContent = `Стоимость бумаг${hasCash() ? ' (без валюты)' : ''} и себестоимость с ${dLong(days[0])}`;
  lineChart($('miniChart'), {
    a: 0, b: LAST, height: 150, compact: true, yFmt: v => mlnAxis(v), extra: liveExtra(),
    series: [{ get: i => D.value[i], color: C['s-port'], width: 1.75, fill: true }, { get: i => D.invested[i], color: C['s-inv'], width: 1.25, dash: [4, 4], live: D.invested[LAST] }],
    tip: i => `<div class="t-d">${dLong(days[i])}</div>` + tipRow('Стоимость бумаг', rub(D.value[i]), C['s-port']) + tipRow('Вложено', rub(D.invested[i]), C['s-inv']),
    label: 'Стоимость бумаг и вложенные деньги с ' + days[0].slice(0, 4) + ' года'
  });
}
