#!/usr/bin/env node
// Календарь выплат без сети: выдуманный портфель проходит настоящую сборку (engine/build.mjs, ответы Мосбиржи подложены
// в кэш), потом настоящие core.js и payouts.js рисуют раздел; проверяем то, что видит человек. Ответы посчитаны руками.
// Запуск: node tests/payouts.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from '../engine/build.mjs';

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0, passed = 0;
function eq(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else { failed++; console.log(`FAIL ${name}: получилось ${JSON.stringify(got)}, должно быть ${JSON.stringify(want)}`); }
}
const section = (t) => console.log(`— ${t}`);

// «1 360 ₽» → 1360
const money = (s) => Number(s.replace(/[^\d]/g, ''));

// рисует раздел настоящими скриптами страницы; DOM — только то, что раздел читает и пишет
function renderCalendar(data) {
  const els = {};
  const el = (id) => (els[id] ||= { id, hidden: false, innerHTML: '', textContent: '', querySelector: () => el(`${id} >`), parentElement: { querySelector: () => null }, insertAdjacentHTML() {} });
  const ctx = {
    window: { DATA: data, addEventListener() {} }, location: { hash: '' },
    localStorage: { getItem: () => null, setItem() {} }, document: { getElementById: el },
    console,
  };
  let history = null;
  ctx.barChart = (host, opt) => { if (host.id === 'divChart') history = opt; };
  vm.createContext(ctx);
  for (const f of ['core', 'benchmark', 'payouts']) vm.runInContext(fs.readFileSync(path.join(SKILL, 'dashboard', 'js', `${f}.js`), 'utf8'), ctx);
  vm.runInContext('initCore(); renderPayouts();', ctx);
  const months = {};
  for (const m of els.cal.innerHTML.matchAll(/<span>([^<]+)<\/span><b class="num">([^<]+)<\/b>/g)) months[m[1]] = money(m[2]);
  return {
    months, calHidden: els.cal.hidden, calHtml: els.cal.innerHTML, note: els.fcNote.innerHTML,
    total: money(/Всего за 12 месяцев: <b class="num">([^<]+)<\/b>/.exec(els.fcNote.innerHTML)?.[1] || ''),
    card: Math.round(vm.runInContext('fwdTotal', ctx)),
    history,
  };
}

// ---------------------------------------------------------------------------------------------
// День оценки 15.06.2026.
//   Акция AAA, 10 шт.: дивиденд 20.07.2025 — 1 000 ₽ до налога → прогноз на реестр 20.07.2026: 1 000 × 0,85 = 850.
//   Облигация SU26000TEST0, 10 шт., два купона в год: реестры 25.06.2026 и 25.12.2026 по 30 ₽ →
//     300 × 0,85 = 255 в каждую дату; купон 25.06.2027 уже за пределами двух ближайших; купон 25.12.2025 — в прошлом.
//   fwdIncome: 850 + 510 = 1 360. Купон 25.06.2026 приходится на остаток текущего месяца.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-payouts-'));
const BOND = 'SU26000TEST0';
fs.writeFileSync(path.join(TMP, 'a.csv'), [
  'Дата;Счёт;Тип;Тикер или ISIN;Количество;Цена;Сумма;Валюта;Комиссия;Налог;НКД;Примечание',
  '10.01.2025;Брокерский;Покупка;AAA;10;100;;RUB;;;;',
  '10.01.2025;Брокерский;Покупка;SU26000TEST0;10;1000;;RUB;;;;',
  '20.07.2025;Брокерский;Дивиденд;AAA;;;1000;RUB;;150;;',
].join('\n'));
fs.writeFileSync(path.join(TMP, 'settings.json'), JSON.stringify({
  title: 'Проверка календаря', asOf: '2026-06-15', watchlist: [], cash: [],
  sources: [{ type: 'csv', file: 'a.csv', account: 'Брокерский' }],
}));
fs.mkdirSync(path.join(TMP, '.cache'));
const cache = (name, v) => fs.writeFileSync(path.join(TMP, '.cache', name), JSON.stringify(v));
const FETCHED = '2099-01-01';
cache(`sec-info-${BOND}.json`, { shortname: 'Выдуманная ОФЗ', couponFrequency: 2, boards: [{ engine: 'stock', market: 'bonds', boardid: 'TQOB', is_primary: 1 }] });
cache(`sec-${BOND}.json`, { secid: BOND, market: 'bonds', board: 'TQOB', from: '2025-01-01', till: '2026-06-15', fetchedAt: FETCHED,
  days: { '2025-01-10': [100, 0, 1000, 'RUB'], '2026-06-15': [100, 0, 1000, 'RUB'] } });
cache(`coupons-${BOND}.json`, { fetchedAt: FETCHED, coupons: ['2025-12-25', '2026-06-25', '2026-12-25', '2027-06-25'].map((d) => ({ recordDate: d, payDate: d, amount: 30, currency: 'RUB' })) });

const { data } = await build({ workdir: TMP, offline: true, quiet: true });
fs.rmSync(TMP, { recursive: true, force: true });

section('данные движка: купоны лежат в forecast по датам');
const byTicker = Object.fromEntries(data.positions.map((p) => [p.ticker, p.fwdIncome]));
eq('fwdIncome по бумагам', byTicker, { [BOND]: 510, AAA: 850 });
eq('купоны в forecast', data.forecast.filter((f) => f.ticker === BOND).map((f) => [f.recordDate, f.net]), [['2026-06-25', 255], ['2026-12-25', 255]]);

section('календарь: итог равен сумме fwdIncome позиций');
const cal = renderCalendar(data);
eq('итог календаря = карточка «Выплаты за 12 месяцев вперёд»', [cal.total, cal.card], [1360, 1360]);
eq('сумма месяцев = итог', Object.values(cal.months).reduce((s, v) => s + v, 0), 1360);
eq('купон — в месяце своей даты реестра, дивиденд — в своём', [cal.months['Июнь 2026'], cal.months['Июль 2026'], cal.months['Декабрь 2026'], cal.months['Сентябрь 2026']], [255, 850, 255, 0]);
eq('купоны не размазаны по месяцам', cal.calHtml.includes('≈'), false);
eq('подпись называет купоны суммой за год', /510.*купонами облигаций/.test(cal.note.replace(/&nbsp;/g, ' ')), true);
eq('подпись не обещает разложение поровну', /поровну/.test(cal.note), false);

section('история по годам: последним столбиком — прогноз на 12 месяцев');
const bars = cal.history;
eq('последний столбик подписан «прогноз»', bars.cats[bars.cats.length - 1], 'прогноз');
eq('его высота — прогноз после налога', bars.groups[0].vals[bars.cats.length - 1], 1360);
eq('у прогноза нет надставки «налог»', bars.groups[0].top[bars.cats.length - 1], 0);
eq('прогноз другого цвета, чем факт', bars.groups[0].colors[bars.cats.length - 1] !== bars.groups[0].colors[0], true);

section('портфель без выплат');
const empty = renderCalendar({ ...data, forecast: [], positions: data.positions.map((p) => ({ ...p, fwdIncome: 0 })) });
eq('календаря нет, вместо него фраза', [empty.calHidden, /Ожидаемых выплат в ближайшие 12 месяцев в данных нет/.test(empty.note)], [true, true]);
eq('прогноза нет — и столбика нет', empty.history.cats.includes('прогноз'), false);

console.log(`${failed ? 'FAIL' : 'OK  '} payouts.test: проверок ${passed + failed}, не прошло ${failed}`);
process.exit(failed ? 1 : 0);
