// Выгрузка «Интеллектуального инвестора» (intelinvest.ru, complex_portfolio_report_*.xlsx), лист «Сделки».
// Колонки: Тикер, Название, Операция, Дата, Кол-во, Цена, Номинал, НКД, Комиссия, Сумма, Сумма без комиссии,
// Валюта, Заметка (ищутся по заголовку; нет заголовка — по этому порядку).
// Деньги — строки с тикером «Деньги (RUB)», «Деньги (USD)»…
// Логика — как в старом проекте (portfolio-dashboard/src/intelinvest.py), дополнена остальными операциями.
import path from 'node:path';
import { readXlsx } from '../lib/xlsx.mjs';
import { num, isoDate, timeOf, currency, isIsin, makeOp, cashOp, collector } from '../lib/common.mjs';

const HINT = 'engine/sources/intelinvest.mjs → SECURITY_OPS / MONEY_OPS';

// Операция по бумаге → событие. sign: событие зависит от знака суммы (+ / −)
export const SECURITY_OPS = [
  { re: /^покупка$/i, event: 'BUY' },
  { re: /^продажа$/i, event: 'SELL' },
  { re: /^(дивиденд|дивиденды)$/i, event: 'DIVIDEND' },
  { re: /^купон$/i, event: 'DIVIDEND', note: 'купон' },
  { re: /^амортизация$/i, event: 'AMORTIZATION' },
  { re: /^(погашение|полное погашение)$/i, event: 'REPAYMENT' },
  { re: /^оферта$/i, event: 'SELL', note: 'оферта' },
  { re: /^(сплит|дробление)$/i, event: 'SPLIT' },
  { re: /^конвертация$/i, sign: { '+': 'CONVERT_IN', '-': 'CONVERT_OUT' } },
  // «Корректировка» по бумаге: + — бумаги пришли (открытие позиции по реальной цене), − — ушли (перевод)
  { re: /^корректировка$/i, sign: { '+': 'TRANSFER_IN', '-': 'TRANSFER_OUT' } },
  { re: /^(делистинг|списание без выплаты)$/i, event: 'WRITE_OFF' },
  { re: /^(зачисление|ввод бумаг)$/i, event: 'TRANSFER_IN' },
  { re: /^(списание|вывод бумаг)$/i, event: 'TRANSFER_OUT' },
];
// Операция с деньгами (тикер «Деньги (…)») → событие
export const MONEY_OPS = [
  { re: /^внесение$/i, event: 'CASH_IN' },
  { re: /^(списание|вывод)$/i, event: 'CASH_OUT' },
  { re: /^(расход|комиссия)$/i, event: 'FEE' },
  { re: /^налог$/i, event: 'TAX' },
  { re: /^возврат налога$/i, event: 'TAX_RETURN' },
  { re: /^(доход|начисление)$/i, event: 'CASH_GAIN' },
  { re: /^вариационная маржа$/i, event: 'VARMARGIN', market: 'срочный рынок' },
  // «Корректировка» денег: − — налог или удержание, + — прочее зачисление
  { re: /^корректировка$/i, sign: { '+': 'CASH_GAIN', '-': 'TAX' }, note: 'корректировка' },
];
const FX_TICKER = /^(USD|EUR|CNY|HKD|GBP|CHF|KZT|TRY|AED|JPY|GLD|XAU|SLV|XAG)(RUB)?(_TOM|_TOD)?$/;

const COLS = {
  ticker: ['тикер'], name: ['название'], op: ['операция'], date: ['дата'], qty: ['кол-во', 'количество'],
  price: ['цена'], face: ['номинал'], nkd: ['нкд'], fee: ['комиссия'], sumNoFee: ['сумма без комиссии'], sum: ['сумма'],
  cur: ['валюта'], note: ['заметка', 'примечание'],
};
const DEFAULT_COLS = { ticker: 0, name: 1, op: 2, date: 3, qty: 4, price: 5, face: 6, nkd: 7, fee: 8, sum: 9, sumNoFee: 10, cur: 11, note: 12 };

function findCols(row) {
  const cells = row.map((c) => String(c ?? '').toLowerCase().trim());
  const idx = {};
  // «сумма без комиссии» раньше «суммы», чтобы «сумма» не забрала её
  for (const key of ['ticker', 'name', 'op', 'date', 'qty', 'price', 'face', 'nkd', 'fee', 'sumNoFee', 'sum', 'cur', 'note']) {
    const i = cells.findIndex((c, j) => !Object.values(idx).includes(j) && COLS[key].some((w) => (key === 'sum' ? c === w : c.startsWith(w))));
    if (i >= 0) idx[key] = i;
  }
  return idx;
}

export function readIntelinvest(file, src = {}) {
  const base = path.basename(file);
  const out = collector('intelinvest', base);
  const book = readXlsx(file);
  const sheet = book.sheets.find((s) => /сделки/i.test(s.name)) || book.sheets[0];
  if (!sheet) throw new Error(`${base}: в книге нет листов`);
  const account = src.account || 'Интеллектуальный инвестор';
  let col = null;
  sheet.rows.forEach((row, r) => {
    const line = r + 1;
    if (!row || !row.length) return;
    const lower = row.map((c) => String(c ?? '').toLowerCase().trim());
    if (lower.includes('операция') && lower.some((c) => c.startsWith('тикер'))) { col = findCols(row); return; }
    const c = col || DEFAULT_COLS;
    const g = (k) => (c[k] != null ? row[c[k]] : '');
    const ticker = String(g('ticker') ?? '').trim();
    const opText = String(g('op') ?? '').trim();
    if (!ticker || !opText) return;
    const date = isoDate(g('date'));
    const where = `${sheet.name}, строка ${line}`;
    if (!date) { out.unknownRow(where, `${opText} ${ticker}: нет даты`, HINT); return; }
    const qty = Math.abs(num(g('qty'))), price = num(g('price')), face = num(g('face'));
    const nkd = Math.abs(num(g('nkd'))), fee = Math.abs(num(g('fee')));
    const sum = num(g('sum')), noFee = num(g('sumNoFee'));
    const cur = currency(g('cur'));
    const common = {
      date, time: `${date} ${timeOf(g('date'))}`, account, src: { type: 'intelinvest', file: base, line },
      note: String(g('note') ?? '').trim(),
    };
    const sign = sum < 0 || (sum === 0 && num(g('qty')) < 0) ? '-' : '+';
    const money = ticker.match(/^деньги\s*\(([^)]+)\)/i);
    if (money) {
      const rule = MONEY_OPS.find((x) => x.re.test(opText));
      if (!rule) { out.unknownRow(where, `${opText} (деньги)`, HINT); return; }
      const event = rule.sign ? rule.sign[sign] : rule.event;
      out.add(cashOp({ ...common, event, amount: event === 'VARMARGIN' ? sum : Math.abs(sum), currency: currency(money[1], cur),
        note: [rule.note, common.note].filter(Boolean).join('; '), ...(rule.market ? { market: rule.market } : {}) }));
      return;
    }
    const rule = SECURITY_OPS.find((x) => x.re.test(opText));
    if (!rule) { out.unknownRow(where, `${opText} ${ticker}`, HINT); return; }
    const event = rule.sign ? rule.sign[sign] : rule.event;
    const note = [rule.note, common.note].filter(Boolean).join('; ');
    const sym = isIsin(ticker) ? { symbol: ticker, isin: ticker } : { symbol: ticker.toUpperCase() };
    // цена одной бумаги в деньгах: облигация — «Цена» в % от номинала; иначе — из суммы без комиссии
    const isBondPct = face > 0 && price > 0 && price <= 300;
    const total = Math.abs(noFee) > 0.0005 ? Math.abs(noFee) : Math.abs(sum) - fee;
    const unit = isBondPct ? (price / 100) * face : qty ? (total > 0 ? total / qty : Math.abs(price)) : Math.abs(price);
    const fx = FX_TICKER.exec(ticker.toUpperCase());
    if (fx && (event === 'BUY' || event === 'SELL')) {
      out.add(makeOp({ ...common, event: event === 'BUY' ? 'FX_BUY' : 'FX_SELL', symbol: fx[1], qty, price: unit, currency: 'RUB', note }));
      if (fee) out.add(cashOp({ ...common, event: 'FEE', amount: fee, currency: 'RUB', note: `комиссия: ${opText} ${fx[1]}` }));
      return;
    }
    switch (event) {
      case 'BUY': case 'SELL':
        out.add(makeOp({ ...common, ...sym, event, qty, price: unit, currency: cur, fee, nkd, note, name: g('name') || undefined }));
        break;
      case 'DIVIDEND':
        out.add(makeOp({ ...common, ...sym, event, qty: Math.abs(sum), amount: Math.abs(sum), currency: cur, note }));
        break;
      case 'AMORTIZATION':
        out.add(makeOp({ ...common, ...sym, event, qty, amount: Math.abs(sum), currency: cur, note }));
        break;
      case 'REPAYMENT':
        out.add(makeOp({ ...common, ...sym, event, qty, price: qty ? Math.abs(sum) / qty : unit, currency: cur, note }));
        break;
      case 'SPLIT':
        // в выгрузке «Кол-во» у сплита — коэффициент (если это не так — поправьте здесь)
        out.add(makeOp({ ...common, ...sym, event, qty: 0, price: qty || price, amount: 0, currency: cur, note }));
        break;
      default: // TRANSFER_* / CONVERT_*
        out.add(makeOp({ ...common, ...sym, event, qty, price: unit, currency: cur, note: note || `${opText.toLowerCase()} в выгрузке` }));
    }
  });
  return out;
}
