#!/usr/bin/env node
// Проверки разбивки по брокерам и счетам без сети: выдуманный портфель на три счёта у двух брокеров с переводами бумаг
// между счетами; правильные ответы посчитаны руками в комментариях.
// Запуск: node tests/accounts.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveMoves } from '../engine/merge.mjs';
import { compute } from '../engine/model.mjs';
import { build, planPortfolios, computePortfolios } from '../engine/build.mjs';

let failed = 0, passed = 0;
function eq(name, got, want, tol = 0.005) {
  const near = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol;
  const same = (a, b) => (typeof b === 'number' ? near(a, b)
    : Array.isArray(b) ? Array.isArray(a) && a.length === b.length && b.every((x, i) => same(a[i], x))
      : b && typeof b === 'object' ? a && typeof a === 'object' && Object.keys(b).every((k) => same(a[k], b[k])) && Object.keys(a).length === Object.keys(b).length
        : a === b);
  if (same(got, want)) passed++; else { failed++; console.log(`FAIL ${name}:\n  получилось ${JSON.stringify(got)}\n  должно быть ${JSON.stringify(want)}`); }
}
const section = (t) => console.log(`— ${t}`);
const op = (account, date, event, symbol, qty, price = 0, extra = {}) => ({ date, time: `${date} 12:00:00`, account, symbol, exchange: 'MCX', event, qty, price,
  amount: extra.amount ?? qty * price, currency: 'RUB', fee: extra.fee ?? 0, nkd: 0, netRecorded: false, noCash: false, note: '', src: { source: extra.src || '1:csv' } });
const px = (m) => ({ days: Object.fromEntries(Object.entries(m).map(([d, p]) => [d, [p, 0, null, null]])) });

// ---------------------------------------------------------------------------------------------
// Счета: «Брокерский» и «ИИС» у «Брокера А», «Основной» у «Брокера Б». Цены AAA: 01.01 — 100, 02.01 — 110, 03.01 — 120,
// 04.01 — 125, 05.01 — 130, 06.01 — 140; BBB: 01.01 — 200, 06.01 — 220. День оценки 06.01.
//   01.01  Брокерский: купил AAA 10 по 100, комиссия 10      → себестоимость 1 010
//   01.01  Основной:   купил BBB 5 по 200                      → 1 000
//   02.01  ИИС:        купил AAA 5 по 110                      → 550
//   03.01  4 AAA: Брокерский → Основной (между брокерами)      себестоимость 1 010 × 4/10 = 404; по рынку 4 × 120 = 480
//   04.01  6 AAA: Брокерский → ИИС (внутри Брокера А)          себестоимость 1 010 − 404 = 606; по рынку 6 × 125 = 750
//   05.01  ИИС:        продал AAA 3 по 130                     → 390
//   05.01  Основной:   дивиденд BBB 10, налог 1                → 9 после налога
//   06.01  2 AAA: Основной → ИИС (цепочка: эти бумаги пришли с Брокерского) 404 × 2/4 = 202; по рынку 2 × 140 = 280
const ops0 = [
  op('Брокерский', '2024-01-01', 'BUY', 'AAA', 10, 100, { fee: 10 }),
  op('Основной', '2024-01-01', 'BUY', 'BBB', 5, 200, { src: '2:csv' }),
  op('ИИС', '2024-01-02', 'BUY', 'AAA', 5, 110),
  op('Брокерский', '2024-01-03', 'TRANSFER_OUT', 'AAA', 4),
  op('Основной', '2024-01-03', 'TRANSFER_IN', 'AAA', 4, 0, { src: '2:csv' }),
  op('Брокерский', '2024-01-04', 'TRANSFER_OUT', 'AAA', 6),
  op('ИИС', '2024-01-04', 'TRANSFER_IN', 'AAA', 6),
  op('ИИС', '2024-01-05', 'SELL', 'AAA', 3, 130),
  op('Основной', '2024-01-05', 'DIVIDEND', 'BBB', 10, 0, { amount: 10, fee: 1, src: '2:csv' }),
  op('Основной', '2024-01-06', 'TRANSFER_OUT', 'AAA', 2, 0, { src: '2:csv' }),
  op('ИИС', '2024-01-06', 'TRANSFER_IN', 'AAA', 2),
];
const market = {
  asOf: '2024-01-06', rates: {}, meta: {}, indexes: {},
  prices: { AAA: px({ '2024-01-01': 100, '2024-01-02': 110, '2024-01-03': 120, '2024-01-04': 125, '2024-01-05': 130, '2024-01-06': 140 }), BBB: px({ '2024-01-01': 200, '2024-01-06': 220 }) },
};
const { ops, internal, stats } = resolveMoves(ops0);
eq('переводы между своими счетами найдены', [stats.internal, internal.length], [3, 3]);

section('счета и брокеры для переключателя');
const settingsSources = [{ type: 'csv', broker: 'Брокер А' }, { type: 'csv', broker: 'Брокер Б' }];
const accounts = ['Брокерский', 'Основной', 'ИИС'];
const sourcesOf = (acc) => [settingsSources[acc === 'Основной' ? 1 : 0]];
const plan = planPortfolios(accounts, sourcesOf);
// у «Брокера А» два счёта — группа и два счёта под ней; у «Брокера Б» один — только счёт, брокер в скобках
eq('список портфелей', plan.map((p) => [p.id, p.label, p.kind, p.parent || '', p.accounts.join('+')]), [
  ['b-broker-a', 'Брокер А', 'broker', '', 'Брокерский+ИИС'],
  ['a-brokerskiy', 'Брокерский', 'account', 'b-broker-a', 'Брокерский'],
  ['a-iis', 'ИИС', 'account', 'b-broker-a', 'ИИС'],
  ['a-osnovnoy', 'Основной (Брокер Б)', 'account', '', 'Основной'],
]);
eq('id — только латиница, цифры и дефис', plan.every((p) => /^[a-z0-9-]+$/.test(p.id)), true);
// брокер по умолчанию: у Т-Инвестиций — «Т-Инвестиции», у выгрузки Snowball — сам счёт; один брокер на все счета — без группы
const plan2 = planPortfolios(['ИИС', 'Брокерский', 'БКС'], (a) => [a === 'БКС' ? { type: 'snowball' } : { type: 'tinvest' }]);
eq('брокер по типу источника', plan2.map((p) => [p.label, p.kind, p.parent || '']), [
  ['Т-Инвестиции', 'broker', ''], ['ИИС', 'account', 'b-t-investitsii'], ['Брокерский', 'account', 'b-t-investitsii'], ['БКС', 'account', '']]);
eq('один брокер на все счета — группы нет', planPortfolios(['ИИС', 'Брокерский'], () => [{ type: 'tinvest' }]).map((p) => [p.label, p.kind]),
  [['ИИС (Т-Инвестиции)', 'account'], ['Брокерский (Т-Инвестиции)', 'account']]);

// ---------------------------------------------------------------------------------------------
const all = compute({ ops, ...market });
const { results, cost } = computePortfolios({ ops, internal, plan, market });
const R = (id) => results[id].r;
const last = (r) => r.value[r.value.length - 1];

section('«Все счета» — переводов не видно');
// AAA: 10 + 5 − 3 = 12 шт. × 140 = 1 680; BBB 5 × 220 = 1 100 → 2 780
// прибыль: 2 780 + продажи 390 − покупки 2 550 − комиссии 10 + выплаты 9 = 619
eq('стоимость', last(all), 2780);
eq('итоги', all.totals, { buys: 2550, fees: 10, sells: 390, divNet: 9, divTax: 1, profit: 619 });
eq('переводов в ленте нет', all.operations.filter((o) => /MOVE|TRANSFER/.test(o.event)).length, 0);

section('себестоимость переводов (в том числе по цепочке)');
eq('себестоимость каждого перевода', [cost[0], cost[1], cost[2]], [404, 606, 202]);

section('счёт «Брокерский»: все бумаги ушли переводами');
// стоимость: 10 × 100; 10 × 110; после ухода 4 — 6 × 120 = 720; дальше 0
eq('стоимость по дням', R('a-brokerskiy').value, [1000, 1100, 720, 0, 0, 0]);
eq('себестоимость по дням', R('a-brokerskiy').invested, [1010, 1010, 606, 0, 0, 0]);
// притоки индекса: покупка +1 010; ушли бумаги — по рынку: −480 и −750
eq('притоки индекса', R('a-brokerskiy').flows, { '2024-01-01': 1010, '2024-01-03': -480, '2024-01-04': -750 });
// перевод — не продажа и не прибыль: 0 + 0 − 1 000 − 10 + ушло по себестоимости 1 010 = 0
eq('итоги: продаж нет, прибыль 0', R('a-brokerskiy').totals, { buys: 1000, fees: 10, movedOut: 1010, profit: 0 });

section('счёт «ИИС»: пришли бумаги с двух счетов');
// 02.01: 5 × 110 = 550; 03.01: 5 × 120 = 600; 04.01: (5 + 6) × 125 = 1 375; 05.01: 8 × 130 = 1 040; 06.01: 10 × 140 = 1 400
eq('стоимость по дням', R('a-iis').value, [550, 600, 1375, 1040, 1400]);
// себестоимость: 550; +606 = 1 156; продал 3 из 11 → 1 156 × 8/11 = 840,73; +202 = 1 042,73
eq('себестоимость по дням', R('a-iis').invested, [550, 550, 1156, 841, 1043]);
const iisAAA = R('a-iis').positions.find((p) => p.ticker === 'AAA');
eq('AAA: количество, себестоимость, средняя', [iisAAA.qty, iisAAA.cost, iisAAA.avg], [10, 1042.73, 104.2727], 0.0001 + 0.005);
// притоки: покупка +550; пришли по рынку +750; продажа −390; пришли по рынку +280
eq('притоки индекса', R('a-iis').flows, { '2024-01-02': 550, '2024-01-04': 750, '2024-01-05': -390, '2024-01-06': 280 });
// 1 400 + 390 − 550 − пришло по себестоимости (606 + 202) = 432; покупками переводы не считаются
eq('итоги', R('a-iis').totals, { buys: 550, fees: 0, sells: 390, movedIn: 808, profit: 432 });

section('счёт «Основной» (Брокер Б): пришли и частично ушли дальше');
// 01.01: 5 × 200 = 1 000; 03.01: + 4 AAA × 120 = 1 480; 04.01: 1 000 + 500 = 1 500; 05.01: 1 000 + 520 = 1 520;
// 06.01: BBB 5 × 220 = 1 100 + 2 AAA × 140 = 280 → 1 380
eq('стоимость по дням', R('a-osnovnoy').value, [1000, 1000, 1480, 1500, 1520, 1380]);
// притоки: +1 000; пришли +480; 06.01 ушли −280 и списывается отложенная выплата −9 → −289
eq('притоки индекса', R('a-osnovnoy').flows, { '2024-01-01': 1000, '2024-01-03': 480, '2024-01-06': -289 });
// 1 380 + 0 − 1 000 + 9 + ушло 202 − пришло 404 = 187
eq('итоги', R('a-osnovnoy').totals, { buys: 1000, fees: 0, divNet: 9, divTax: 1, movedIn: 404, movedOut: 202, profit: 187 });

section('брокер «Брокер А»: перевод внутри брокера не виден');
// AAA: 10 (1 010) + 5 (550) = 15 (1 560); ушли 4 на «Основной» по себестоимости 404 → 11 (1 156);
// продал 3 → 8 (840,73); пришли 2 по 202 → 10 (1 042,73) — так же, как на «ИИС»
const brA = R('b-broker-a');
eq('стоимость на конец', last(brA), 1400);
eq('себестоимость на конец', brA.invested[brA.invested.length - 1], 1043);
eq('переводы в ленте брокера — только с «Основным»', brA.operations.filter((o) => o.event.startsWith('MOVE')).map((o) => [o.date, o.event, o.qty, o.amountRub, o.cost]),
  [['2024-01-06', 'MOVE_IN', 2, 280, 202], ['2024-01-03', 'MOVE_OUT', 4, 480, 404]]);
// 1 400 + 390 − 1 550 − 10 + ушло 404 − пришло 202 = 432 = Брокерский 0 + ИИС 432
eq('итоги', brA.totals, { buys: 1550, fees: 10, sells: 390, movedOut: 404, movedIn: 202, profit: 432 });

section('сходится с «Все счета»');
const accs = plan.filter((p) => p.kind === 'account').map((p) => p.id);
eq('сумма стоимостей счетов = стоимость «Все счета»', accs.reduce((s, id) => s + last(R(id)), 0), last(all));
eq('сумма прибыли счетов = прибыль «Все счета» (перевод не создаёт прибыли)', accs.reduce((s, id) => s + R(id).totals.profit, 0), all.totals.profit);
eq('сумма прибыли счетов брокера = прибыль брокера', R('a-brokerskiy').totals.profit + R('a-iis').totals.profit, brA.totals.profit);
const own = (r) => r.operations.filter((o) => !o.event.startsWith('MOVE'));
eq('сумма операций по счетам = все операции', accs.reduce((s, id) => s + own(R(id)).length, 0), all.operations.length);
eq('переводов в счетах — по два на перевод', accs.reduce((s, id) => s + R(id).operations.length - own(R(id)).length, 0), 2 * internal.length);
const qtyAll = Object.fromEntries(all.positions.map((p) => [p.ticker, p.qty]));
const qtyAcc = {};
for (const id of accs) for (const p of R(id).positions) qtyAcc[p.ticker] = (qtyAcc[p.ticker] || 0) + p.qty;
eq('бумаг по счетам вместе = бумаг в «Все счета»', qtyAcc, qtyAll);

// ---------------------------------------------------------------------------------------------
// XIRR и перевод: X купил 10 бумаг по 50 (500 ₽) 01.01.2022, через год (цена 100) перевёл их на Y, ещё через год цена 110.
//   X: −500 → +1 000 через 365 дней (ушли по рынку) → 100 % годовых;
//   Y: −1 000 (пришли по рынку) → +1 100 через 365 дней → 10 % годовых. Себестоимость на Y — 500, прибыль по бумаге 600.
section('XIRR: ушедшие и пришедшие бумаги — поток денег по рыночной стоимости дня');
const opsX = [op('X', '2022-01-01', 'BUY', 'CCC', 10, 50), op('X', '2023-01-01', 'TRANSFER_OUT', 'CCC', 10), op('Y', '2023-01-01', 'TRANSFER_IN', 'CCC', 10)];
const mv = resolveMoves(opsX);
const planX = planPortfolios(['X', 'Y'], () => [{ type: 'csv' }]);
const mx = { asOf: '2024-01-01', rates: {}, meta: {}, indexes: {}, prices: { CCC: px({ '2022-01-01': 50, '2023-01-01': 100, '2024-01-01': 110 }) } };
const rx = computePortfolios({ ops: mv.ops, internal: mv.internal, plan: planX, market: mx }).results;
const allX = compute({ ops: mv.ops, ...mx });
eq('XIRR счёта X', rx['a-x'].r.xirr, 1.0, 1e-6);
eq('XIRR счёта Y', rx['a-y'].r.xirr, 0.10, 1e-6);
const py = rx['a-y'].r.positions[0];
eq('Y: себестоимость перенесена, прибыль по бумаге с покупки', [py.cost, py.avg, py.profit], [500, 50, 600]);
eq('прибыль X + Y = «Все счета»', rx['a-x'].r.totals.profit + rx['a-y'].r.totals.profit, allX.totals.profit);

// ---------------------------------------------------------------------------------------------
section('сборка целиком без сети: формат DATA');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-accounts-'));
const head = 'Дата;Счёт;Тип;Тикер или ISIN;Количество;Цена;Сумма;Валюта;Комиссия;Налог;НКД;Примечание';
fs.writeFileSync(path.join(TMP, 'a.csv'), [head,
  '01.01.2024;Брокерский;Покупка;AAA;10;100;;RUB;10;;;',
  '02.01.2024;ИИС;Покупка;AAA;5;110;;RUB;;;;',
  '03.01.2024;Брокерский;Перевод бумаг (расход);AAA;4;;;RUB;;;;',
  '04.01.2024;Брокерский;Перевод бумаг (расход);AAA;6;;;RUB;;;;',
  '04.01.2024;ИИС;Перевод бумаг (приход);AAA;6;;;RUB;;;;',
  '05.01.2024;ИИС;Продажа;AAA;3;130;;RUB;;;;',
  '06.01.2024;ИИС;Перевод бумаг (приход);AAA;2;;;RUB;;;;',
  '06.01.2024;ИИС;Покупка;AAA;1;140;;RUB;;;;',
].join('\n'));
fs.writeFileSync(path.join(TMP, 'b.csv'), [head,
  '01.01.2024;Основной;Покупка;BBB;5;200;;RUB;;;;',
  '03.01.2024;Основной;Перевод бумаг (приход);AAA;4;;;RUB;;;;',
  '05.01.2024;Основной;Дивиденд;BBB;;;10;RUB;;1;;',
  '06.01.2024;Основной;Перевод бумаг (расход);AAA;2;;;RUB;;;;',
  '06.01.2024;Основной;Покупка;BBB;1;220;;RUB;;;;',
].join('\n'));
const settings = {
  title: 'Проверка счетов', asOf: '2024-01-06', watchlist: [],
  cash: [{ currency: 'RUB', name: 'Рубль', amount: 1000, account: 'ИИС' }, { currency: 'RUB', name: 'Рубль', amount: 500 }, { currency: 'CNY', amount: 1, account: 'Нет такого' }],
  sources: [{ type: 'csv', file: 'a.csv', account: 'Брокерский', broker: 'Брокер А' }, { type: 'csv', file: 'b.csv', account: 'Основной', broker: 'Брокер Б' }],
};
fs.writeFileSync(path.join(TMP, 'settings.json'), JSON.stringify(settings));
const { data, report } = await build({ workdir: TMP, offline: true, quiet: true });
eq('portfolios', data.portfolios, [
  { id: 'b-broker-a', label: 'Брокер А', kind: 'broker' },
  { id: 'a-brokerskiy', label: 'Брокерский', kind: 'account', parent: 'b-broker-a' },
  { id: 'a-iis', label: 'ИИС', kind: 'account', parent: 'b-broker-a' },
  { id: 'a-osnovnoy', label: 'Основной (Брокер Б)', kind: 'account' },
]);
eq('byPortfolio — на каждый портфель', Object.keys(data.byPortfolio), data.portfolios.map((p) => p.id));
const baseKeys = Object.keys(data).filter((k) => k !== 'portfolios' && k !== 'byPortfolio');
eq('у портфеля те же ключи, что у «Все счета»', Object.values(data.byPortfolio).every((d) => JSON.stringify(Object.keys(d)) === JSON.stringify(baseKeys)), true);
eq('валюта: «Все счета» — вся, ИИС и его брокер — своя, Основной — нет', [data.cash.length, data.byPortfolio['a-iis'].cash.length,
  data.byPortfolio['b-broker-a'].cash.length, data.byPortfolio['a-osnovnoy'].cash.length], [3, 1, 1, 0]);
eq('предупреждение про валюту на неизвестном счёте', report.warnings.some((w) => /«Нет такого»/.test(w)), true);
const v = (d) => d.value[d.value.length - 1];
// цены — по собственным сделкам (без сети): AAA 140, BBB 220 на 06.01; AAA 10 + 1 = 11 шт. на ИИС, BBB 6 на Основном + 2 AAA
eq('стоимость «Все счета»', v(data), 13 * 140 + 6 * 220);
eq('сумма стоимостей счетов = «Все счета»', ['a-brokerskiy', 'a-iis', 'a-osnovnoy'].reduce((s, id) => s + v(data.byPortfolio[id]), 0), v(data));
eq('сумма прибыли счетов = «Все счета»', ['a-brokerskiy', 'a-iis', 'a-osnovnoy'].reduce((s, id) => s + data.byPortfolio[id].totals.profit, 0), data.totals.profit);
eq('в report.json — портфели', report.portfolios.map((p) => [p.id, p.value]), [['b-broker-a', 11 * 140], ['a-brokerskiy', 0], ['a-iis', 11 * 140], ['a-osnovnoy', 2 * 140 + 6 * 220]]);
// один счёт — ключей нет
fs.writeFileSync(path.join(TMP, 'settings.json'), JSON.stringify({ ...settings, sources: [{ type: 'csv', file: 'b.csv', account: 'Основной' }] }));
const one = await build({ workdir: TMP, offline: true, quiet: true });
eq('один счёт — без portfolios и byPortfolio', ['portfolios', 'byPortfolio'].filter((k) => k in one.data), []);
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`${failed ? 'FAIL' : 'OK  '} accounts.test: проверок ${passed + failed}, не прошло ${failed}`);
process.exit(failed ? 1 : 0);
