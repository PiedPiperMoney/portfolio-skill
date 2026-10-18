// Расчёт портфеля по операциям в общем формате (см. sources/snowball.mjs и lib/common.mjs) и рыночным данным.
// События брокерских источников: AMORTIZATION (частичное погашение) — как продажа без уменьшения количества;
// FX_BUY / FX_SELL (сделки с валютой), VARMARGIN (вариационная маржа) — только в ленте операций, в доходность не входят;
// переводы и конвертации до расчёта превращает merge.mjs.
// MOVE_OUT / MOVE_IN — перевод бумаг между своими счетами в портфеле одного счёта или брокера (их добавляет build.mjs;
// в общем портфеле их нет): не сделка и не прибыль. Себестоимость уходит и приходит одной суммой costRub (у ушедших
// без costRub — средняя по портфелю, итог — в extra.moveCost[moveId]); для притоков индекса и XIRR это поток денег
// наружу / внутрь по рыночной стоимости бумаг в день перевода (нет цены — по себестоимости).
// Расчёт сверен с выгрузкой Snowball на настоящем портфеле:
// - позиции по дням, себестоимость — средняя (при продаже списывается пропорционально);
// - стоимость: акции и фонды — цена закрытия; облигации — % от номинала × номинал (валютный — по курсу ЦБ) + НКД;
//   бумаги без цен Мосбиржи (американские) — по ценам собственных сделок × курс ЦБ;
// - притоки индексного портфеля как в Snowball: покупки с комиссией − продажи − выплаты после налога,
//   выплаты списываются в день следующей сделки (нет сделок после — в последний день);
// - XIRR: покупки −, продажи +, погашения +, выплаты после налога +, отдельные налоги и комиссии −,
//   в конце + стоимость бумаг без денег на счёте; пополнения и выводы не участвуют;
// - отрицательные остатки (в выгрузке нет части покупок) в стоимость не входят — предупреждение.

const EPS = 1e-9;
// выплата, записанная уже после налога (налог 0, «не трогать кэш»): до налога = сумма ÷ (1 − 13 %)
export const NET_RECORDED_TAX = 0.13;

// round() как в Python: до целого — банковское округление половины, с знаками — по точному значению
export function pyRound(x, n = 0) {
  if (x == null || !Number.isFinite(x)) return x;
  if (n === 0) {
    const f = Math.floor(x), d = x - f;
    if (d === 0.5) return f % 2 === 0 ? f : f + 1;
    return Math.round(x);
  }
  return Number(x.toFixed(n));
}

export function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function dayRange(from, till) {
  const out = [];
  for (let d = from; d <= till; d = addDays(d, 1)) out.push(d);
  return out;
}
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);

// значение ряда на каждый день с переносом последнего известного вперёд
export function ffill(series, days) {
  const keys = Object.keys(series || {}).sort();
  const out = {};
  let i = 0, last = null;
  for (const d of days) {
    while (i < keys.length && keys[i] <= d) last = series[keys[i++]];
    out[d] = last;
  }
  return out;
}

// курс ЦБ на дату: последний известный не позже даты; рубль — 1; нет курса — 1 (как в эталоне)
export function makeFx(rates) {
  const sorted = {};
  for (const [cur, t] of Object.entries(rates)) {
    const keys = Object.keys(t).sort();
    sorted[cur] = { keys, vals: keys.map((k) => t[k]) };
  }
  return function fx(cur, d) {
    if (!cur || cur === 'RUB' || cur === 'SUR') return 1.0;
    const s = sorted[cur];
    if (!s) return 1.0;
    let lo = 0, hi = s.keys.length - 1, best = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (s.keys[mid] <= d) { best = s.vals[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    return best || 1.0;
  };
}

// XIRR делением отрезка пополам (как в эталоне): год = 365 дней
export function xirr(flows) {
  const fl = [...flows].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  const t0 = fl[0][0];
  const ts = fl.map(([d, a]) => [daysBetween(t0, d) / 365.0, a]);
  const npv = (r) => ts.reduce((s, [t, a]) => s + a / (1 + r) ** t, 0);
  let lo = -0.9, hi = 5.0;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (npv(mid) > 0) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// дробление: один раз на бумагу, дату и коэффициент (в выгрузке бывает по записи на каждый счёт)
function splitKey(o) { return `${o.symbol}|${o.date}|${o.price}`; }

const byTime = (a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0);

// Остатки бумаг на конец дня day (сделки, погашения, дробления)
export function holdingsOn(ops, day) {
  const qty = new Map();
  const seenSplit = new Set();
  for (const o of [...ops].sort(byTime)) {
    if (o.date > day) break;
    const q = qty.get(o.symbol) || 0;
    if (o.event === 'BUY') qty.set(o.symbol, q + o.qty);
    else if (o.event === 'SELL') qty.set(o.symbol, q - o.qty);
    else if (o.event === 'MOVE_IN') qty.set(o.symbol, q + o.qty);
    else if (o.event === 'MOVE_OUT') qty.set(o.symbol, q - o.qty);
    else if (o.event === 'REPAYMENT') qty.set(o.symbol, 0);
    else if (o.event === 'SPLIT' && q && o.price > 0 && !seenSplit.has(splitKey(o))) {
      seenSplit.add(splitKey(o));
      qty.set(o.symbol, q * o.price);
    }
  }
  return qty;
}

/**
 * Главный расчёт.
 * ops — операции (порядок как в источнике); asOf — день оценки; rates — {валюта: {дата: курс}};
 * prices — {бумага: {own: валюта | undefined, days: {дата: [цена, НКД, номинал, валюта номинала]}}};
 * meta — {бумага: {name, sector, kind, quote}}; indexes — {код: {дата: закрытие}};
 * fwd — {бумага: {grossPerUnit (₽ до налога на 12 мес)}}; forecastItems — [{recordDate, ticker, perShare, status}];
 * tax — налог для прогноза; xirrEnd — дата конечной стоимости в XIRR.
 */
export function compute({ ops, asOf, rates, prices, meta, indexes, fwd = {}, forecastItems = [], tax = 0.15, xirrEnd }) {
  const fx = makeFx(rates);
  const nameOf = (s) => meta[s]?.name ?? s;
  const start = ops.reduce((m, o) => (o.date < m ? o.date : m), asOf);
  const days = dayRange(start, asOf);
  const sorted = [...ops].sort(byTime);
  const k = (o) => fx(o.currency, o.date);
  const usd = ffill(rates.USD || {}, days);

  const syms = [...new Set(ops.filter((o) => ['BUY', 'SELL', 'MOVE_IN', 'MOVE_OUT'].includes(o.event)).map((o) => o.symbol))].sort();
  const pf = {};
  for (const s of syms) pf[s] = ffill(prices[s]?.days || {}, days);
  const ownFx = (s, day) => fx(prices[s]?.own, day);

  // цена одной бумаги в рублях на день (null — нет цены)
  function unitValue(s, day) {
    const px = pf[s]?.[day];
    if (!px) return null;
    const [price, accint, face, unit] = px;
    if (prices[s]?.own) return price * ownFx(s, day);
    if (face) return (price / 100) * face * (unit && unit !== 'RUB' && unit !== 'SUR' ? fx(unit, day) : 1.0) + accint;
    return price;
  }
  // переводы между своими счетами: рыночная стоимость в день перевода и перенесённая себестоимость
  const moveCost = new Map(), opCost = new Map();
  const moveVal = (o, fallback) => { const one = unitValue(o.symbol, o.date); return one == null ? fallback : o.qty * one; };

  // --- позиции по дням, себестоимость, стоимость, притоки индекса
  const qty = new Map(), cost = new Map(), holes = new Map();
  const flowsSnow = new Map();
  const addFlow = (d, v) => flowsSnow.set(d, (flowsSnow.get(d) || 0) + v);
  const seenSplit = new Set();
  const valueSeries = [], investedSeries = [];
  let oi = 0, pendingDiv = 0;
  for (const day of days) {
    let traded = false;
    while (oi < sorted.length && sorted[oi].date <= day) {
      const o = sorted[oi++];
      const s = o.symbol, q = o.qty, p = o.price, f = o.fee, kk = k(o);
      if (o.event === 'BUY') {
        qty.set(s, (qty.get(s) || 0) + q);
        cost.set(s, (cost.get(s) || 0) + (q * p + f) * kk);
        addFlow(day, (q * p + f) * kk);
        traded = true;
      } else if (o.event === 'SELL') {
        const have = qty.get(s) || 0;
        if (have > 0) cost.set(s, (cost.get(s) || 0) - ((cost.get(s) || 0) * Math.min(q, have)) / have);
        qty.set(s, have - q);
        addFlow(day, -(q * p - f) * kk);
        traded = true;
      } else if (o.event === 'REPAYMENT') {
        qty.set(s, 0);
        cost.set(s, 0);
      } else if (o.event === 'AMORTIZATION') {
        // частичное погашение: бумаги остаются, себестоимость уменьшается на полученную сумму, деньги — как продажа
        cost.set(s, Math.max(0, (cost.get(s) || 0) - o.amount * kk));
        addFlow(day, -o.amount * kk);
      } else if (o.event === 'DIVIDEND') {
        pendingDiv += (o.amount - f) * kk;
      } else if (o.event === 'SPLIT') {
        const have = qty.get(s) || 0;
        if (have && p > 0 && !seenSplit.has(splitKey(o))) { seenSplit.add(splitKey(o)); qty.set(s, have * p); }
      } else if (o.event === 'MOVE_OUT') {
        const have = qty.get(s) || 0, c0 = cost.get(s) || 0;
        const part = o.costRub != null ? o.costRub : have > 0 ? (c0 * Math.min(q, have)) / have : 0;
        cost.set(s, have - q > EPS ? Math.max(0, c0 - part) : 0);
        qty.set(s, have - q);
        moveCost.set(o.moveId, part); opCost.set(o, part);
        addFlow(day, -moveVal(o, part));
        traded = true;
      } else if (o.event === 'MOVE_IN') {
        const c = o.costRub != null ? o.costRub : moveVal(o, 0);
        qty.set(s, (qty.get(s) || 0) + q);
        cost.set(s, (cost.get(s) || 0) + c);
        opCost.set(o, c);
        addFlow(day, moveVal(o, c));
        traded = true;
      }
    }
    if (traded && pendingDiv) { addFlow(day, -pendingDiv); pendingDiv = 0; }
    let total = 0;
    for (const [s, q] of qty) {
      if (q <= EPS) { if (q < -EPS) holes.set(s, q); continue; }
      const one = unitValue(s, day);
      if (one == null) continue;
      total += q * one;
    }
    valueSeries.push(pyRound(total));
    let inv = 0;
    for (const [s, c] of cost) if ((qty.get(s) || 0) > EPS) inv += c;
    investedSeries.push(pyRound(inv));
  }
  if (pendingDiv) addFlow(asOf, -pendingDiv);
  const totalNow = valueSeries[valueSeries.length - 1];

  // --- итоги по бумаге за всю историю
  const agg = new Map();
  const A = (s) => { if (!agg.has(s)) agg.set(s, { buy: 0, sell: 0, fee: 0, div: 0, divGross: 0 }); return agg.get(s); };
  for (const o of ops) {
    const kk = k(o), a = A(o.symbol);
    if (o.event === 'BUY') { a.buy += o.qty * o.price * kk; a.fee += o.fee * kk; }
    else if (o.event === 'SELL') { a.sell += o.qty * o.price * kk; a.fee += o.fee * kk; }
    else if (o.event === 'DIVIDEND') { a.div += (o.amount - o.fee) * kk; a.divGross += o.amount * kk; }
    else if (o.event === 'REPAYMENT') a.sell += o.qty * o.price * kk;
    else if (o.event === 'AMORTIZATION') a.sell += o.amount * kk;
    else if (o.event === 'MOVE_OUT') a.sell += opCost.get(o) ?? o.costRub ?? 0;
    else if (o.event === 'MOVE_IN') a.buy += opCost.get(o) ?? o.costRub ?? 0;
  }

  // --- текущие позиции
  const positions = [], noPrice = [];
  const prevDay = days.length > 1 ? days[days.length - 2] : null;
  for (const [s, q] of qty) {
    if (q <= EPS) continue;
    const one = unitValue(s, asOf);
    if (one == null) { noPrice.push(s); continue; }
    const val = q * one, a = A(s), c = cost.get(s) || 0;
    const profit = val + a.sell - a.buy - a.fee + a.div;
    const fwdUnit = (fwd[s]?.grossPerUnit || 0) * (1 - tax);
    const m = meta[s] || {};
    const pNow = pf[s][asOf], pPrev = prevDay ? pf[s][prevDay] : null;
    positions.push({
      ticker: s, name: nameOf(s), sector: m.sector || 'Прочее', kind: m.kind || 'Акция',
      qty: q, price: pyRound(one, 4), value: pyRound(val, 2), cost: pyRound(c, 2),
      avg: pyRound(c / q, 4), divReceived: pyRound(a.div, 2), profit: pyRound(profit, 2),
      fwdDivPerUnit: pyRound(fwdUnit, 4), fwdIncome: pyRound(fwdUnit * q, 2),
      dayChangePct: pPrev ? pyRound((pNow[0] / pPrev[0] - 1) * 100, 2) : 0,
    });
  }
  positions.sort((a, b) => b.value - a.value);

  // --- выплаты по годам и бумагам
  const payYear = new Map();
  const payments = [];
  for (const o of ops) {
    if (o.event !== 'DIVIDEND') continue;
    const kk = k(o);
    const gross = o.netRecorded ? (o.amount * kk) / (1 - NET_RECORDED_TAX) : o.amount * kk;
    const net = (o.amount - o.fee) * kk;
    const y = o.date.slice(0, 4);
    if (!payYear.has(y)) payYear.set(y, new Map());
    const ym = payYear.get(y);
    const v = ym.get(o.symbol) || [0, 0];
    v[0] += gross; v[1] += net;
    ym.set(o.symbol, v);
    payments.push({ date: o.date, ticker: o.symbol, name: nameOf(o.symbol), gross: pyRound(gross, 2), net: pyRound(net, 2),
      netEstimated: o.netRecorded });
  }

  // --- прогноз выплат по датам реестра (только бумаги в портфеле)
  const forecast = [];
  for (const it of forecastItems) {
    const q = qty.get(it.ticker) || 0;
    if (q <= EPS || !it.perShare) continue;
    forecast.push({ recordDate: it.recordDate, ticker: it.ticker, name: nameOf(it.ticker), perShare: it.perShare, qty: q,
      gross: pyRound(it.perShare * q, 2), net: pyRound(it.perShare * q * (1 - tax), 2), status: it.status });
  }
  forecast.sort((a, b) => (a.recordDate < b.recordDate ? -1 : a.recordDate > b.recordDate ? 1 : 0));

  // --- XIRR (все операции выгрузки, конец — стоимость бумаг на день оценки)
  const xf = [];
  for (const o of ops) {
    const kk = k(o), q = o.qty, p = o.price, f = o.fee;
    if (o.event === 'BUY') xf.push([o.date, -(q * p + f) * kk]);
    else if (o.event === 'SELL') xf.push([o.date, (q * p - f) * kk]);
    else if (o.event === 'DIVIDEND') xf.push([o.date, (o.amount - f) * kk]);
    else if (o.event === 'REPAYMENT') xf.push([o.date, q * p * kk]);
    else if (o.event === 'AMORTIZATION') xf.push([o.date, o.amount * kk]);
    else if (o.event === 'TAX' || o.event === 'FEE') xf.push([o.date, -f * kk]);
    else if (o.event === 'MOVE_OUT') xf.push([o.date, moveVal(o, opCost.get(o) ?? o.costRub ?? 0)]);
    else if (o.event === 'MOVE_IN') xf.push([o.date, -moveVal(o, opCost.get(o) ?? o.costRub ?? 0)]);
  }
  xf.push([xirrEnd || asOf, totalNow]);
  const xirrValue = xf.length > 1 ? xirr(xf) : null;

  // --- лента операций (новые сверху)
  const amountRub = (o) => {
    const kk = k(o);
    if (o.event === 'BUY' || o.event === 'SELL' || o.event === 'REPAYMENT') return pyRound(o.qty * o.price * kk, 2);
    if (o.event === 'TAX' || o.event === 'FEE') return pyRound(o.fee * kk, 2);
    if (o.event === 'AMORTIZATION') return pyRound(o.amount * kk, 2);
    if (o.event === 'FX_BUY' || o.event === 'FX_SELL') return pyRound(o.qty * o.price * kk, 2);
    return pyRound(o.qty * kk, 2);
  };
  const moveOp = (o) => {
    const c = opCost.get(o) ?? o.costRub ?? 0, v = moveVal(o, c);
    return { date: o.date, event: o.event, ticker: o.symbol, name: nameOf(o.symbol), qty: o.qty, price: pyRound(o.qty ? v / o.qty : 0, 4),
      currency: 'RUB', fee: 0, amountRub: pyRound(v, 2), cost: pyRound(c, 2), note: o.note };
  };
  const operations = [...ops].sort((a, b) => byTime(b, a)).map((o) => (o.event === 'MOVE_IN' || o.event === 'MOVE_OUT' ? moveOp(o) : {
    date: o.date, event: o.event, ticker: o.symbol, name: nameOf(o.symbol), qty: o.qty, price: o.price,
    currency: o.currency, fee: o.fee, amountRub: amountRub(o), note: o.note,
  }));

  // --- итоги
  const t = {};
  const T = (key, v) => { t[key] = (t[key] || 0) + v; };
  for (const o of ops) {
    const kk = k(o), q = o.qty, p = o.price, f = o.fee;
    if (o.event === 'BUY') { T('buys', q * p * kk); T('fees', f * kk); }
    else if (o.event === 'SELL' || o.event === 'REPAYMENT') { T('sells', q * p * kk); T('fees', o.event === 'SELL' ? f * kk : 0); }
    else if (o.event === 'AMORTIZATION') T('sells', o.amount * kk);
    else if (o.event === 'DIVIDEND') { T('divNet', (o.amount - f) * kk); T('divTax', f * kk); }
    else if (o.event === 'TAX' || o.event === 'FEE') T('otherTaxFees', f * kk);
    else if (o.event === 'MOVE_OUT') T('movedOut', opCost.get(o) ?? o.costRub ?? 0);
    else if (o.event === 'MOVE_IN') T('movedIn', opCost.get(o) ?? o.costRub ?? 0);
  }
  const totals = Object.fromEntries(Object.entries(t).map(([key, v]) => [key, pyRound(v, 2)]));
  // переводы между своими счетами (только в портфеле счёта или брокера): себестоимость ушла и пришла без прибыли
  totals.profit = pyRound(totalNow + (t.sells || 0) - (t.buys || 0) - (t.fees || 0) - (t.otherTaxFees || 0) + (t.divNet || 0)
    + (t.movedOut || 0) - (t.movedIn || 0), 2);

  const fmtQty = (q) => pyRound(q).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const warnings = [...holes.entries()].filter(([s]) => (qty.get(s) || 0) < -EPS).map(([s, q]) => ({
    ticker: s, name: nameOf(s), qty: q,
    text: `По операциям ${nameOf(s)}: ${fmtQty(q)} шт. — в выгрузке не хватает покупок; бумага не входит в стоимость.`,
  }));

  const flows = Object.fromEntries([...flowsSnow.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .filter(([, v]) => Math.abs(v) > 1).map(([d, v]) => [d, pyRound(v, 2)]));
  const idxOut = {};
  for (const [code, series] of Object.entries(indexes)) { const ff = ffill(series, days); idxOut[code] = days.map((d) => ff[d]); }
  const divByYear = Object.fromEntries([...payYear.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([y, m]) => [y, Object.fromEntries([...m.entries()].map(([s, v]) => [s, [pyRound(v[0]), pyRound(v[1])]]))]));

  return {
    days, value: valueSeries, invested: investedSeries, flows, indexes: idxOut, positions, xirr: xirrValue, totals,
    divByYear, payments, forecast, operations, warnings,
    // для отчёта
    extra: { qty, noPrice, usdNow: usd[asOf], totalNow, start, moveCost: Object.fromEntries(moveCost) },
  };
}
