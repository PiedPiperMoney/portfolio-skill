/* data.js — раздел «Данные»: какой портфель выбран (если счетов несколько), что требует сверки (DATA.warnings), источники,
   сверка со Snowball (только если есть DATA.snowballRef).
   У предупреждения можно задать поле hint — подсказку, как исправить; иначе показывается общая. */
'use strict';

function renderData() {
  const W = D.warnings, nEst = D.payments.filter(p => p.netEstimated).length;
  let html = W.map(w => `<div class="note"><b>Требуется сверка: ${esc(w.name || w.ticker)}${w.qty != null ? `, ${int(w.qty)} шт.` : ''}</b><br>${esc(String(w.text || '').replace(/(^|\s)-(\d)/g, '$1' + MINUS + '$2'))}<br><span class="muted">${esc(w.hint || 'Найдите в отчётах брокера недостающие операции, добавьте их в файл операций и пересоберите данные.')}</span></div>`).join('');
  if (nEst) html += `<div class="note" style="border-left-color:var(--muted)"><b>Выплаты после налога, оценка: ${nEst} ${plural(nEst, 'запись', 'записи', 'записей')}.</b><br>В выгрузке у них нет отдельного налога; сумма после налога посчитана или записана брокером сразу чистой. На прибыль это не влияет, на разбивку «до налога / налог» — влияет.</div>`;
  $('warns').innerHTML = html || '<p class="small muted" style="margin:0">Дыр в данных не найдено: количество бумаг по операциям сходится.</p>';
  const src = D.source.split(';').map(s => s.trim()).filter(Boolean);
  $('srcFacts').innerHTML = (PF.list.length ? `<div><span>Портфель</span><span>${esc(PF.label)}${PF.cur ? '' : ` (${int(PF.list.filter(p => p.kind === 'account').length)} ${plural(PF.list.filter(p => p.kind === 'account').length, 'счёт', 'счёта', 'счетов')})`}</span></div>` : '') +
    `<div><span>Дата данных</span><span>${dLong(asOf)}</span></div>` + src.map(s => { const [k, ...v] = s.split('—'); const kk = k.trim(); return v.length ? `<div><span>${esc(kk.charAt(0).toUpperCase() + kk.slice(1))}</span><span>${esc(v.join('—').trim())}</span></div>` : `<div><span>Операции</span><span>${esc(s)}</span></div>`; }).join('') +
    `<div><span>Дней в истории</span><span class="num">${int(N)} (с ${dmy(days[0])})</span></div><div><span>Операций</span><span class="num">${int(OPS.length)}</span></div>`;
  $('footSrc').textContent = (PF.list.length ? 'Портфель: ' + PF.label + '. ' : '') + 'Данные на ' + dLong(asOf) + '.' + (D.source ? ' ' + D.source + '.' : '');
  renderRecon();
}

/* Сверка со Snowball. Поля DATA.snowballRef: value (стоимость бумаг), xirr, passiveIncome — основные;
   необязательные: date ('ГГГГ-ММ-ДД'), totalValue (с валютой), notes {value, xirr, passiveIncome, totalValue} — пояснения. */
function renderRecon() {
  const sb = D.snowballRef;
  $('reconPanel').hidden = !sb;
  $('dataSub').textContent = sb ? 'Откуда цифры, сверка со Snowball и где в данных дыры' : 'Откуда цифры и где в данных дыры';
  if (!sb) return;
  const nt = sb.notes || {};
  $('reconSub').textContent = sb.date ? `Snowball — снимок ${dmy(sb.date)}` : 'Snowball — цифры из выгрузки';
  const when = isLive() ? ` · живые цены ${LIVE.time}` : ` · закрытие ${dmy(asOf)}`;
  const rows = [];
  if (sb.totalValue != null) rows.push(['Стоимость портфеля с валютой', rub(TOTAL) + when, rub(sb.totalValue), nt.totalValue || 'Разница — от цен и курсов разных дней и от того, как каждый сервис учитывает валюту.']);
  if (sb.value != null) rows.push(['Стоимость бумаг', rub(SEC) + when, rub(sb.value), nt.value || 'Snowball может брать цены другого дня и учитывать минусовые остатки бумаг. История стоимости и сравнение с индексами здесь — только по бумагам, без валюты, как у Snowball.']);
  if (sb.xirr != null && D.xirr != null) rows.push(['Годовая доходность (XIRR) за всё время', pct(D.xirr, 2), pct(sb.xirr, 2), nt.xirr || 'Те же денежные потоки; разница — от цен последнего дня.']);
  if (sb.passiveIncome != null) rows.push(['Выплаты за 12 месяцев вперёд, после налога', rub(fwdTotal), rub(sb.passiveIncome), nt.passiveIncome || 'Прогноз выплат у сервисов может различаться по отдельным бумагам.']);
  $('recon').querySelector('tbody').innerHTML = rows.map(r => `<tr><td>${r[0]}</td><td class="num">${r[1]}</td><td class="num">${r[2]}</td><td style="text-align:left;white-space:normal;min-width:260px" class="small">${esc(r[3])}</td></tr>`).join('');
}
