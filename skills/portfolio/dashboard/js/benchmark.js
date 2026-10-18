/* benchmark.js — сравнение портфеля с индексом. НЕ МЕНЯТЬ правило расчёта: оно сверено со Snowball до 0,05 %.
   Правило: в день a «индексный портфель» = стоимость портфеля в день a; каждый день (a, b] докупаем индекс на flows[d]
   (покупки − продажи − выплаты); bench[d] = units × index[d]. Разница изменений портфеля и модели — «обгоняет / отстаёт». */
'use strict';

/* известные индексы; на странице показываются только те, что есть в DATA.indexes */
const IDX_ALL = ['MCFTR', 'IMOEX', 'RGBITR', 'RUCBTRNS'];
const IDX_SHORT = { MCFTR: 'Мосбиржа полной доходности', IMOEX: 'Индекс Мосбиржи, без дивидендов', RGBITR: 'Гособлигации полной доходности', RUCBTRNS: 'Корпоративные облигации полной доходности' };
const CHIP = { MCFTR: 'акции с дивидендами', IMOEX: 'акции без дивидендов', RGBITR: 'гособлигации', RUCBTRNS: 'корп. облигации' };
let IDX = [], flowAt = null;
const firstIdx = {};

function initBenchmark() {
  flowAt = new Float64Array(N);
  for (const d in D.flows) { const i = idxOf(d); if (i >= 0 && i < N) flowAt[i] += D.flows[d]; }
  IDX = IDX_ALL.filter(k => Array.isArray(D.indexes[k]) && D.indexes[k].some(v => v != null));
  IDX.forEach(k => { firstIdx[k] = D.indexes[k].findIndex(v => v != null); });
}
/* главный индекс для фразы на первом экране: MCFTR, если есть */
const mainIdx = () => IDX.includes('MCFTR') ? 'MCFTR' : IDX[0];

function bench(key, a, b) {
  const I = D.indexes[key];
  if (!I || I[a] == null) return null;
  const out = new Float64Array(b - a + 1);
  let units = D.value[a] / I[a];
  out[0] = D.value[a];
  for (let i = a + 1; i <= b; i++) { if (flowAt[i]) units += flowAt[i] / I[i]; out[i - a] = units * I[i]; }
  return out;
}
function compare(key, a, b) {
  const s = bench(key, a, b); if (!s) return null;
  const dp = D.value[b] - D.value[a], di = s[s.length - 1] - s[0], X = dp - di;
  return { series: s, dp, di, X, Y: X / s[s.length - 1], end: s[s.length - 1] };
}
function flowsSum(a, b) { let f = 0; for (let i = a + 1; i <= b; i++) f += flowAt[i]; return f; }
function twr(a, b) { // доходность без влияния покупок и продаж (цепочка по дням)
  const out = new Float64Array(b - a + 1); let g = 1; out[0] = 0;
  for (let i = a + 1; i <= b; i++) { const pv = D.value[i - 1]; if (pv > 0) g *= (D.value[i] - flowAt[i]) / pv; out[i - a] = g - 1; }
  return out;
}
