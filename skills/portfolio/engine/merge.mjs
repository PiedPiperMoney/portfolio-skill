// Объединение операций из нескольких источников в одну ленту:
//  1) дубли — одна и та же операция пришла из двух источников (например, выгрузка Snowball и Т-Инвестиции по API
//     на одном счёте): совпали счёт, дата, событие, бумага, количество, цена (у денег — сумма). Внутри одного
//     источника одинаковые строки не трогаем — это могут быть две настоящие сделки;
//  2) переводы бумаг (TRANSFER_IN / TRANSFER_OUT, CONVERT_IN / CONVERT_OUT, WRITE_OFF) — превращаем в то, что
//     понимает расчёт (model.mjs):
//     - ушли с одного своего счёта и пришли на другой (та же бумага и количество, даты рядом) → не сделка, обе
//       строки убираем из общего расчёта (бумага общая по всем счетам) и возвращаем парой в internal: из неё
//       build.mjs делает вывод / ввод бумаг (MOVE_OUT / MOVE_IN) в портфелях отдельных счетов и брокеров;
//     - на одном счёте в один день списали и зачислили ту же бумагу в другом количестве → дробление SPLIT;
//     - конвертация / замещение (списали одну бумагу, зачислили другую) → продажа старой и покупка новой
//       по себестоимости: прибыли нет, себестоимость переходит на новую бумагу;
//     - пришли без пары (из другого брокера, который не подключён) → покупка по цене из отчёта, нет цены —
//       по нулевой с предупреждением; ушли без пары → продажа по средней себестоимости (без прибыли);
//     - WRITE_OFF (делистинг, ликвидация) → продажа по нулевой цене.
import { addDays } from './model.mjs';

const r6 = (x) => Math.round((x || 0) * 1e6) / 1e6;
export function dupKey(o) {
  const money = ['BUY', 'SELL', 'SPLIT', 'TRANSFER_IN', 'TRANSFER_OUT', 'CONVERT_IN', 'CONVERT_OUT', 'WRITE_OFF', 'FX_BUY', 'FX_SELL'].includes(o.event)
    ? `${r6(o.qty)}|${r6(o.price)}` : `${r6(o.amount)}|${r6(o.fee)}`;
  return [o.account || '', o.date, o.event, (o.symbol || '').toUpperCase(), money].join('|');
}

// lists — [{ id, ops }] в порядке источников; возвращает { ops, dropped: { id: n } }
export function dedupe(lists) {
  const seen = new Map(); // ключ → сколько таких операций дали предыдущие источники
  const out = [], dropped = {};
  for (const { id, ops } of lists) {
    const mine = new Map();
    dropped[id] = 0;
    for (const o of ops) {
      const k = dupKey(o);
      const before = seen.get(k) || 0;
      const used = mine.get(k) || 0;
      if (used < before) { mine.set(k, used + 1); dropped[id]++; continue; }
      mine.set(k, used + 1);
      out.push(o);
    }
    for (const [k, n] of mine) seen.set(k, Math.max(seen.get(k) || 0, n));
  }
  return { ops: out, dropped };
}

const byTime = (a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0);
const MOVE = new Set(['TRANSFER_IN', 'TRANSFER_OUT', 'CONVERT_IN', 'CONVERT_OUT', 'WRITE_OFF']);

// Переводы и корпоративные действия → события расчёта. Возвращает { ops, notes, stats, internal },
// internal — [[ушли, пришли], …] — переводы между своими счетами в исходном виде (TRANSFER_OUT, TRANSFER_IN)
export function resolveMoves(ops, { pairDays = 7 } = {}) {
  const notes = [];
  const stats = { internal: 0, splits: 0, conversions: 0, inUnpaired: 0, outUnpaired: 0, writeOff: 0 };
  const internal = [];
  if (!ops.some((o) => MOVE.has(o.event))) return { ops, notes, stats, internal };
  const used = new Set();
  const moves = ops.filter((o) => MOVE.has(o.event));
  const ins = moves.filter((o) => o.event === 'TRANSFER_IN' || o.event === 'CONVERT_IN');
  const outs = moves.filter((o) => o.event === 'TRANSFER_OUT' || o.event === 'CONVERT_OUT');
  const replace = new Map(); // операция → что вместо неё ([] — убрать)

  // 1) между своими счетами: та же бумага и количество, разные счета, даты не дальше pairDays
  for (const o of outs) {
    if (o.event !== 'TRANSFER_OUT') continue;
    const p = ins.find((i) => !used.has(i) && i.event === 'TRANSFER_IN' && i.symbol === o.symbol && r6(i.qty) === r6(o.qty)
      && i.account !== o.account && i.date >= addDays(o.date, -pairDays) && i.date <= addDays(o.date, pairDays));
    if (p) { used.add(o); used.add(p); replace.set(o, []); replace.set(p, []); stats.internal++; internal.push([o, p]); }
  }
  // 2) на одном счёте в один день та же бумага: дробление (TRANSFER_* и CONVERT_* одинаково)
  for (const o of outs) {
    if (used.has(o)) continue;
    const p = ins.find((i) => !used.has(i) && i.symbol === o.symbol && i.account === o.account && i.date === o.date && r6(i.qty) !== r6(o.qty) && o.qty > 0);
    if (p) {
      used.add(o); used.add(p);
      replace.set(o, [{ ...o, event: 'SPLIT', price: p.qty / o.qty, qty: 0, amount: 0, note: o.note || `дробление ${o.qty} → ${p.qty}` }]);
      replace.set(p, []);
      stats.splits++;
    }
  }
  // 3) конвертация: на одном счёте в один день (или источник пометил CONVERT_*) списали одну бумагу, зачислили другую
  const convPairs = [];
  for (const o of outs) {
    if (used.has(o)) continue;
    const p = ins.find((i) => !used.has(i) && i.account === o.account && i.symbol !== o.symbol
      && (o.event === 'CONVERT_OUT' || i.event === 'CONVERT_IN') && i.date >= addDays(o.date, -pairDays) && i.date <= addDays(o.date, pairDays));
    if (p) { used.add(o); used.add(p); convPairs.push([o, p]); stats.conversions++; }
  }

  // себестоимость по ходу ленты — для конвертаций и для переводов без пары
  const sorted = [...ops].sort(byTime);
  const qty = new Map(), cost = new Map();
  const avg = (s) => ((qty.get(s) || 0) > 1e-9 ? (cost.get(s) || 0) / qty.get(s) : 0);
  const pending = new Map(convPairs);
  const convIn = new Set(convPairs.map(([, p]) => p));
  const track = (x) => {
    const s = x.symbol;
    if (x.event === 'BUY') { qty.set(s, (qty.get(s) || 0) + x.qty); cost.set(s, (cost.get(s) || 0) + x.qty * x.price + (x.fee || 0)); }
    else if (x.event === 'SELL') { const c = avg(s); qty.set(s, (qty.get(s) || 0) - x.qty); cost.set(s, (cost.get(s) || 0) - c * x.qty); }
    else if (x.event === 'SPLIT' && x.price > 0) qty.set(s, (qty.get(s) || 0) * x.price);
    else if (x.event === 'REPAYMENT') { qty.set(s, 0); cost.set(s, 0); }
  };
  for (const o of sorted) {
    const s = o.symbol;
    if (convIn.has(o)) continue; // вторая половина конвертации — разбирается вместе с первой
    if (pending.has(o)) {
      const p = pending.get(o);
      const c = avg(s) * o.qty;
      const sell = { ...o, event: 'SELL', price: o.qty ? c / o.qty : 0, amount: c, fee: 0, note: o.note || `конвертация в ${p.symbol}` };
      const buy = { ...p, date: o.date, time: o.time, event: 'BUY', price: p.qty ? c / p.qty : 0, amount: c, fee: 0, note: p.note || `конвертация из ${s}` };
      replace.set(o, [sell]); replace.set(p, [buy]);
      track(sell); track(buy);
      continue;
    }
    if (replace.has(o)) { replace.get(o).forEach(track); continue; }
    let x = o;
    if (o.event === 'TRANSFER_IN' || o.event === 'CONVERT_IN') {
      x = { ...o, event: 'BUY', amount: o.qty * o.price, fee: 0, note: o.note || 'перевод бумаг (приход)' };
      stats.inUnpaired++;
      if (!(o.price > 0)) notes.push(`${s}: ${o.qty} шт. пришли на «${o.account}» ${o.date} без цены покупки (перевод из другого брокера или депозитария) — взята нулевая цена, прибыль по бумаге завышена. Подключите счёт, откуда пришли бумаги, или допишите цену покупки в шаблон операций (CSV).`);
    } else if (o.event === 'TRANSFER_OUT' || o.event === 'CONVERT_OUT') {
      const c = avg(s);
      x = { ...o, event: 'SELL', price: c, amount: c * o.qty, fee: 0, note: o.note || 'перевод бумаг (расход)' };
      stats.outUnpaired++;
      notes.push(`${s}: ${o.qty} шт. ушли со счёта «${o.account}» ${o.date} без пары (перевод на счёт, который не подключён) — учтено как продажа по средней цене покупки, без прибыли.`);
    } else if (o.event === 'WRITE_OFF') {
      x = { ...o, event: 'SELL', price: 0, amount: 0, fee: 0, note: o.note || 'списание бумаг (делистинг)' };
      stats.writeOff++;
      notes.push(`${s}: ${o.qty} шт. списаны ${o.date} без выплаты (делистинг или ликвидация) — учтено как продажа по нулю.`);
    }
    if (x !== o) replace.set(o, [x]);
    track(x);
  }
  const out = [];
  for (const o of ops) {
    if (replace.has(o)) out.push(...replace.get(o));
    else out.push(o);
  }
  if (stats.internal) notes.push(`Переводы бумаг между своими счетами (${stats.internal}) не считаются покупкой и продажей.`);
  if (stats.conversions) notes.push(`Конвертации и замещения бумаг (${stats.conversions}): себестоимость перенесена на новую бумагу, прибыли нет.`);
  return { ops: out, notes, stats, internal };
}
