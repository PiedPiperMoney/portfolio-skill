#!/usr/bin/env node
// Проверки расчёта без сети: маленькие выдуманные портфели, цены и индекс подставлены вручную,
// правильные ответы посчитаны руками в комментариях.
// Запуск: node tests/model.test.mjs [--dashboard <папка с index.html и js/>]
//   --dashboard — проверить js/benchmark.js и синтаксис скриптов в папке человека, а не в шаблоне навыка.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { compute, xirr } from '../engine/model.mjs';
import { readSnowball } from '../engine/sources/snowball.mjs';

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argDash = process.argv.indexOf('--dashboard');
const DASH = argDash > 0 ? path.resolve(process.argv[argDash + 1]) : path.join(SKILL, 'dashboard');

let failed = 0, passed = 0;
function eq(name, got, want, tol = 0.005) {
  const near = (a, b) => typeof a === 'number' && Math.abs(a - b) <= tol;
  const ok = typeof want === 'number' ? near(got, want)
    : Array.isArray(want) && want.every((w) => typeof w === 'number') ? got?.length === want.length && want.every((w, i) => near(got[i], w))
      : JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++; else { failed++; console.log(`FAIL ${name}: получилось ${JSON.stringify(got)}, должно быть ${JSON.stringify(want)}`); }
}
function section(title) { console.log(`— ${title}`); }

// операция в общем формате (как из sources/snowball.mjs); у выплаты qty = сумма до налога, fee = налог
function op(date, event, symbol, qty, price = 0, fee = 0) {
  return { date, time: `${date} 12:00:00`, account: 'тест', symbol, exchange: 'MCX', event, qty, price,
    amount: event === 'DIVIDEND' ? qty : qty * price, currency: 'RUB', fee, nkd: 0, netRecorded: false, noCash: false, note: '' };
}
const px = (map) => ({ days: Object.fromEntries(Object.entries(map).map(([d, p]) => [d, [p, 0, null, null]])) });

// ---------------------------------------------------------------------------------------------
// Портфель 1: две акции за пять дней.
//   01.01  купил AAA 10 шт. по 100, комиссия 0          → в индекс +1 000
//   02.01  дивиденд AAA 50, налог 5 → после налога 45   → откладывается до следующей сделки (правило Snowball)
//   03.01  купил BBB 5 шт. по 200, комиссия 1           → +1 001 − отложенные 45 = +956
//   04.01  продал AAA 4 шт. по 120, комиссия 0          → −480
//   05.01  дивиденд BBB 10, налог 1 → 9; сделок после нет → списывается в последний день: −9
// Цены: AAA 100 (01.01), 120 (04.01), 130 (05.01); BBB 200 (03.01), 210 (05.01). День оценки 05.01.
section('портфель 1: стоимость, себестоимость, прибыль, притоки индекса');
const ops1 = [
  op('2024-01-01', 'CASH_IN', 'RUB', 5000, 1),
  op('2024-01-01', 'BUY', 'AAA', 10, 100, 0),
  op('2024-01-02', 'DIVIDEND', 'AAA', 50, 5, 5),
  op('2024-01-03', 'BUY', 'BBB', 5, 200, 1),
  op('2024-01-04', 'SELL', 'AAA', 4, 120, 0),
  op('2024-01-05', 'DIVIDEND', 'BBB', 10, 2, 1),
];
const prices1 = { AAA: px({ '2024-01-01': 100, '2024-01-04': 120, '2024-01-05': 130 }), BBB: px({ '2024-01-03': 200, '2024-01-05': 210 }) };
const index1 = { MCFTR: { '2024-01-01': 1000, '2024-01-02': 1010, '2024-01-03': 1020, '2024-01-04': 1000, '2024-01-05': 1050 } };
const r1 = compute({ ops: ops1, asOf: '2024-01-05', rates: {}, prices: prices1, meta: {}, indexes: index1 });

// стоимость по дням: 10×100; 10×100 (цена 02.01 — с прошлого дня); 1 000 + 5×200; 6×120 + 1 000; 6×130 + 5×210
eq('стоимость по дням', r1.value, [1000, 1000, 2000, 1720, 1830]);
// себестоимость открытых позиций: AAA 1 000; после продажи 4 из 10 — 1 000 × 6/10 = 600; BBB 5×200 + 1 = 1 001
eq('себестоимость по дням', r1.invested, [1000, 1000, 2001, 1601, 1601]);
// притоки индексного портфеля (пополнение CASH_IN в них не входит)
eq('притоки индекса', r1.flows, { '2024-01-01': 1000, '2024-01-03': 956, '2024-01-04': -480, '2024-01-05': -9 });
// прибыль по бумаге = стоимость + продажи − покупки − комиссии + выплаты после налога
//   AAA: 780 + 480 − 1 000 − 0 + 45 = 305;  BBB: 1 050 + 0 − 1 000 − 1 + 9 = 58
const pos1 = Object.fromEntries(r1.positions.map((p) => [p.ticker, p]));
eq('AAA: количество', pos1.AAA.qty, 6);
eq('AAA: стоимость', pos1.AAA.value, 780);
eq('AAA: себестоимость', pos1.AAA.cost, 600);
eq('AAA: средняя цена', pos1.AAA.avg, 100);
eq('AAA: прибыль', pos1.AAA.profit, 305);
eq('AAA: выплаты после налога', pos1.AAA.divReceived, 45);
eq('BBB: прибыль', pos1.BBB.profit, 58);
eq('BBB: изменение за день, %', pos1.BBB.dayChangePct, 5); // 210 / 200 − 1
// итоги: покупки 2 000, продажи 480, комиссии 1, выплаты 54 после налога, налог 6; прибыль 305 + 58 = 363
eq('итоги', r1.totals, { buys: 2000, fees: 1, divNet: 54, divTax: 6, sells: 480, profit: 363 });
eq('выплаты по годам: [до налога, после]', r1.divByYear, { 2024: { AAA: [50, 45], BBB: [10, 9] } });
eq('предупреждений нет', r1.warnings, []);

// ---------------------------------------------------------------------------------------------
// Сравнение с индексом — тот же код, что в дашборде (js/benchmark.js), на данных портфеля 1.
// Индексный портфель: 01.01 на 1 000 ₽ куплено 1 000 / 1 000 = 1 пай.
//   02.01: 1 × 1 010 = 1 010
//   03.01: +956 / 1 020 = 0,937254902 пая → 1,937254902 × 1 020 = 1 976
//   04.01: −480 / 1 000 = −0,48 → 1,457254902 × 1 000 = 1 457,254902
//   05.01: −9 / 1 050 = −0,008571429 → 1,448683473 × 1 050 = 1 521,117647
// Портфель за период: 1 830 − 1 000 = +830; индекс: 1 521,117647 − 1 000 = +521,117647;
// портфель обгоняет на 830 − 521,117647 = 308,882353 ₽, это 308,882353 / 1 521,117647 = 20,3063 %.
section(`сравнение с индексом (${path.relative(process.cwd(), path.join(DASH, 'js', 'benchmark.js')) || 'benchmark.js'})`);
function loadBenchmark(data) {
  const ctx = { window: { DATA: data }, Float64Array, Math, console };
  vm.createContext(ctx);
  // из core.js нужны только D, N и idxOf — задаём их так же, как core.js
  vm.runInContext(`const D = window.DATA; const N = D.days.length; const DAY0 = Date.parse(D.days[0] + 'T00:00:00Z');
    const idxOf = s => Math.round((Date.parse(s + 'T00:00:00Z') - DAY0) / 864e5);`, ctx);
  vm.runInContext(fs.readFileSync(path.join(DASH, 'js', 'benchmark.js'), 'utf8'), ctx);
  vm.runInContext('initBenchmark()', ctx);
  return (code) => vm.runInContext(code, ctx);
}
const run1 = loadBenchmark({ days: r1.days, value: r1.value, flows: r1.flows, indexes: r1.indexes });
eq('индексный портфель по дням', Array.from(run1('bench("MCFTR", 0, 4)')), [1000, 1010, 1976, 1457.254902, 1521.117647], 1e-5);
const c1 = run1('compare("MCFTR", 0, 4)');
eq('изменение портфеля', c1.dp, 830, 1e-6);
eq('изменение индексного портфеля', c1.di, 521.117647, 1e-5);
eq('обгоняет на, ₽', c1.X, 308.882353, 1e-5);
eq('обгоняет на, доля', c1.Y, 0.203063, 1e-6);
// только последние два дня: старт 04.01 — 1 720 / 1 000 = 1,72 пая; 05.01: −9 / 1 050 → 1,711428571 × 1 050 = 1 797;
// портфель +110, индекс +77 → обгоняет на 33 ₽
const c2 = run1('compare("MCFTR", 3, 4)');
eq('за два дня: обгоняет на, ₽', c2.X, 33, 1e-6);
eq('сумма притоков за период', run1('flowsSum(0, 4)'), 956 - 480 - 9, 1e-9);

// ---------------------------------------------------------------------------------------------
// XIRR простого случая: 100 000 ₽ ровно через год (365 дней) стали 110 000 ₽ → 10 % годовых.
section('XIRR');
eq('xirr() напрямую', xirr([['2023-01-01', -100000], ['2024-01-01', 110000]]), 0.10, 1e-7);
const r2 = compute({
  ops: [op('2023-01-01', 'BUY', 'CCC', 1000, 100, 0)], asOf: '2024-01-01', rates: {},
  prices: { CCC: px({ '2023-01-01': 100, '2024-01-01': 110 }) }, meta: {}, indexes: {},
});
eq('XIRR портфеля: купил на 100 000, через год стоит 110 000', r2.xirr, 0.10, 1e-7);
eq('стоимость на конец', r2.value[r2.value.length - 1], 110000);
// с выплатой: −100 000 в начале, +5 000 через полгода (182 дня), 100 000 стоимость через год
// уравнение: −100 000 + 5 000/(1+r)^(182/365) + 100 000/(1+r) = 0 → r ≈ 5,1269 %
// (проверка подстановкой: 5 000 / 1,051269^(182/365) = 4 876,9; 100 000 / 1,051269 = 95 123,1; сумма 100 000,0)
eq('XIRR с выплатой посередине', xirr([['2023-01-01', -100000], ['2023-07-02', 5000], ['2024-01-01', 100000]]), 0.051269, 1e-5);

// ---------------------------------------------------------------------------------------------
// Минусовой остаток: продажа без покупки (в выгрузке не хватает покупок) → в стоимость не входит, предупреждение.
section('минусовой остаток');
const r3 = compute({
  ops: [op('2024-03-01', 'BUY', 'DDD', 2, 50, 0), op('2024-03-02', 'SELL', 'EEE', 3, 100, 0)],
  asOf: '2024-03-02', rates: {}, prices: { DDD: px({ '2024-03-01': 50 }), EEE: px({ '2024-03-01': 100 }) },
  meta: { EEE: { name: 'Бумага Е' } }, indexes: {},
});
eq('стоимость без минусовой бумаги: 2 × 50', r3.value[r3.value.length - 1], 100);
eq('в позициях только DDD', r3.positions.map((p) => p.ticker), ['DDD']);
eq('предупреждение', r3.warnings.map((w) => [w.ticker, w.qty]), [['EEE', -3]]);
eq('текст предупреждения', /Бумага Е: -3 шт\. — в выгрузке не хватает покупок/.test(r3.warnings[0]?.text || ''), true);

// ---------------------------------------------------------------------------------------------
// Разбор тестовой выгрузки Snowball (sample/snowball-sample.csv): строки и события.
section('разбор sample/snowball-sample.csv');
const s = readSnowball(path.join(SKILL, 'sample', 'snowball-sample.csv'));
const ev = s.ops.reduce((m, o) => ((m[o.event] = (m[o.event] || 0) + 1), m), {});
eq('события', ev, { CASH_IN: 5, BUY: 11, DIVIDEND: 37, FEE: 3, SELL: 2, TAX: 1 });
eq('нет предупреждений разбора', s.warnings, []);
// первый дивиденд: SBER 18,7 × 200 = 3 740 до налога, налог 13 % = 486,2
const d0 = s.ops.find((o) => o.event === 'DIVIDEND');
eq('дивиденд: сумма из колонки Quantity', [d0.symbol, d0.amount, d0.fee], ['SBER', 3740, 486.2]);
const b0 = s.ops.find((o) => o.event === 'BUY');
eq('покупка: дробное с запятой', [b0.symbol, b0.qty, b0.price, b0.fee], ['SBER', 200, 263.5, 26.35]);

// ---------------------------------------------------------------------------------------------
// Синтаксис скриптов дашборда (в том числе custom.js), чтобы правка не оставила страницу пустой.
section(`синтаксис скриптов (${DASH})`);
const scripts = [...fs.readdirSync(path.join(DASH, 'js')).filter((f) => f.endsWith('.js')).map((f) => path.join(DASH, 'js', f)),
  ...['custom.js'].map((f) => path.join(DASH, f)).filter((f) => fs.existsSync(f))];
for (const f of scripts) {
  try { new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f }); passed++; } catch (e) { failed++; console.log(`FAIL ${path.basename(f)}: ${e.message}`); }
}
const html = fs.readFileSync(path.join(DASH, 'index.html'), 'utf8');
for (const src of [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1])) {
  if (src === 'dashboard-data.js' || src === 'custom.js') continue;
  eq(`index.html подключает существующий ${src}`, fs.existsSync(path.join(DASH, src)), true);
}
eq('строка «не является индивидуальной инвестиционной рекомендацией» на месте', /не является индивидуальной инвестиционной рекомендацией/.test(
  html + scripts.map((f) => fs.readFileSync(f, 'utf8')).join('')), true);

console.log(`${failed ? 'FAIL' : 'OK  '} model.test: проверок ${passed + failed}, не прошло ${failed}`);
process.exit(failed ? 1 : 0);
