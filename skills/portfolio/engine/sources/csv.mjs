// Ручной шаблон операций (CSV) — sample/шаблон-операций.csv. Для брокеров, которых навык не читает,
// и для поправок: покупки до начала отчётов, цена бумаг, пришедших переводом, и т. п.
// Разделитель — «;» (так сохраняет Excel в России) или «,»; дробные — с запятой или точкой; кодировка UTF-8.
// Колонки (порядок любой, лишние не мешают):
//   Дата | Счёт | Тип | Тикер или ISIN | Количество | Цена | Сумма | Валюта | Комиссия | Налог | НКД | Примечание
// Тип — слово из TYPES ниже (регистр не важен). Новый тип — одна строка в TYPES.
import fs from 'node:fs';
import path from 'node:path';
import { num, isoDate, timeOf, currency, isIsin, makeOp, cashOp, collector } from '../lib/common.mjs';

// Тип в шаблоне → событие общего формата. kind: trade — сделка (количество × цена), pay — выплата по бумаге,
// cash — деньги без бумаги, move — бумаги без денег, fx — сделка с валютой, split — дробление (Количество = коэффициент)
export const TYPES = [
  { re: /^(покупка|купля|buy)$/i, event: 'BUY', kind: 'trade' },
  { re: /^(продажа|sell)$/i, event: 'SELL', kind: 'trade' },
  { re: /^(шорт|продажа в шорт|короткая продажа)$/i, event: 'SELL', kind: 'trade', margin: true, note: 'шорт' },
  { re: /^(оферта|выкуп по оферте|погашение по оферте)$/i, event: 'SELL', kind: 'trade', note: 'оферта' },
  { re: /^(дивиденд|дивиденды|dividend)$/i, event: 'DIVIDEND', kind: 'pay' },
  { re: /^(купон|купоны|coupon)$/i, event: 'DIVIDEND', kind: 'pay', note: 'купон' },
  { re: /^(погашение|полное погашение)$/i, event: 'REPAYMENT', kind: 'trade' },
  { re: /^(частичное погашение|амортизация)$/i, event: 'AMORTIZATION', kind: 'pay' },
  { re: /^(комиссия|комиссия брокера|комиссия биржи|fee)$/i, event: 'FEE', kind: 'cash' },
  { re: /^(налог|ндфл|tax)$/i, event: 'TAX', kind: 'cash' },
  { re: /^(возврат налога|возврат ндфл)$/i, event: 'TAX_RETURN', kind: 'cash' },
  { re: /^(пополнение|внесение|зачисление денег|cash_in)$/i, event: 'CASH_IN', kind: 'cash' },
  { re: /^(вывод|списание денег|cash_out)$/i, event: 'CASH_OUT', kind: 'cash' },
  { re: /^(перевод денег \(приход\)|перевод денег на счёт|перевод денег на счет)$/i, event: 'CASH_IN', kind: 'cash', transfer: true },
  { re: /^(перевод денег \(расход\)|перевод денег со счёта|перевод денег со счета)$/i, event: 'CASH_OUT', kind: 'cash', transfer: true },
  { re: /^(перевод бумаг \(приход\)|зачисление бумаг|перевод бумаг на счёт|перевод бумаг на счет)$/i, event: 'TRANSFER_IN', kind: 'move' },
  { re: /^(перевод бумаг \(расход\)|списание бумаг|перевод бумаг со счёта|перевод бумаг со счета)$/i, event: 'TRANSFER_OUT', kind: 'move' },
  { re: /^(конвертация \(приход\)|замещение \(приход\))$/i, event: 'CONVERT_IN', kind: 'move' },
  { re: /^(конвертация \(расход\)|замещение \(расход\))$/i, event: 'CONVERT_OUT', kind: 'move' },
  { re: /^(делистинг|списание без выплаты)$/i, event: 'WRITE_OFF', kind: 'move' },
  { re: /^(сплит|дробление|обратный сплит|консолидация)$/i, event: 'SPLIT', kind: 'split' },
  { re: /^(покупка валюты)$/i, event: 'FX_BUY', kind: 'fx' },
  { re: /^(продажа валюты)$/i, event: 'FX_SELL', kind: 'fx' },
  { re: /^(вариационная маржа|вар\.? ?маржа)$/i, event: 'VARMARGIN', kind: 'cash', signed: true, market: 'срочный рынок' },
  { re: /^(кэшбэк|кешбэк|прочий доход|начисление|доход)$/i, event: 'CASH_GAIN', kind: 'cash' },
];

export const COLUMNS = {
  date: /^дата/i, account: /^сч[её]т/i, type: /^(тип|операция)/i, symbol: /^(тикер|isin|бумага|код)/i,
  qty: /^(количество|кол-во)/i, price: /^цена/i, amount: /^сумма/i, currency: /^валюта/i, fee: /^комисси/i,
  tax: /^налог/i, nkd: /^нкд/i, note: /^(примечание|комментарий)/i,
};

export function parseDelimited(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const first = text.split(/\r?\n/, 1)[0];
  const delim = (first.match(/;/g) || []).length >= (first.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

export function readCsvTemplate(file, src = {}) {
  const base = path.basename(file);
  const out = collector('csv', base);
  const rows = parseDelimited(fs.readFileSync(file, 'utf8'));
  if (!rows.length) return out;
  const head = rows[0].map((h) => h.trim());
  const col = {};
  for (const [k, re] of Object.entries(COLUMNS)) { const i = head.findIndex((h) => re.test(h)); if (i >= 0) col[k] = i; }
  const miss = ['date', 'type'].filter((k) => col[k] == null);
  if (miss.length) throw new Error(`${base}: нет колонок «Дата» и «Тип» — это не шаблон операций (образец: sample/шаблон-операций.csv)`);
  rows.slice(1).forEach((cells, i) => {
    const line = i + 2;
    const g = (k) => (col[k] != null ? String(cells[col[k]] ?? '').trim() : '');
    if (g('date').startsWith('#')) return; // строка-комментарий
    const date = isoDate(g('date'));
    const typeText = g('type');
    const rule = TYPES.find((t) => t.re.test(typeText));
    const where = `строка ${line}`;
    if (!date) { out.unknownRow(where, `нет даты: ${typeText}`, 'engine/sources/csv.mjs → дата в формате ДД.ММ.ГГГГ'); return; }
    if (!rule) { out.unknownRow(`${where}, ${date}`, typeText, 'engine/sources/csv.mjs → TYPES (новый тип — одна строка)'); return; }
    const nums = {};
    for (const k of ['qty', 'price', 'amount', 'fee', 'tax', 'nkd']) {
      nums[k] = num(g(k));
      if (Number.isNaN(nums[k])) { out.warn(`строка ${line}: не число «${g(k)}» в колонке ${head[col[k]]} — взят 0`); nums[k] = 0; }
    }
    const raw = g('symbol').toUpperCase();
    const cur = currency(g('currency'));
    const account = g('account') || src.account || 'Счёт';
    const common = {
      date, time: `${date} ${timeOf(g('date'))}`, account, note: [rule.note, g('note')].filter(Boolean).join('; '),
      src: { type: 'csv', file: base, line }, ...(rule.margin ? { margin: true } : {}), ...(rule.transfer ? { transfer: true } : {}),
      ...(rule.market ? { market: rule.market } : {}),
    };
    const sym = isIsin(raw) ? { symbol: raw, isin: raw } : { symbol: raw };
    const qty = Math.abs(nums.qty), price = Math.abs(nums.price);
    switch (rule.kind) {
      case 'trade': {
        const p = price || (qty ? Math.abs(nums.amount) / qty : 0);
        out.add(makeOp({ ...common, ...sym, event: rule.event, qty, price: p, currency: cur, fee: Math.abs(nums.fee), nkd: Math.abs(nums.nkd) }));
        if (nums.tax) out.add(cashOp({ ...common, event: 'TAX', amount: nums.tax, currency: cur, note: `налог: ${typeText}` }));
        break;
      }
      case 'pay': {
        const amount = Math.abs(nums.amount) || qty * price;
        const div = rule.event === 'DIVIDEND';
        // у дивиденда и купона налог — в fee самой выплаты; у амортизации — отдельной операцией
        out.add(makeOp({ ...common, ...sym, event: rule.event, qty: div ? amount : qty, price: 0, amount, currency: cur, fee: div ? Math.abs(nums.tax) : 0 }));
        if (!div && nums.tax) out.add(cashOp({ ...common, event: 'TAX', amount: nums.tax, currency: cur, note: `налог: ${typeText}` }));
        if (nums.fee) out.add(cashOp({ ...common, event: 'FEE', amount: nums.fee, currency: cur }));
        break;
      }
      case 'cash': {
        const amount = nums.amount || nums.qty * (nums.price || 1);
        out.add(cashOp({ ...common, event: rule.event, amount: rule.signed ? amount : Math.abs(amount), currency: cur, ...(raw && !/^[A-Z]{3}$/.test(raw) ? { symbol: raw } : {}) }));
        if (nums.fee && rule.event !== 'FEE') out.add(cashOp({ ...common, event: 'FEE', amount: nums.fee, currency: cur }));
        break;
      }
      case 'move':
        out.add(makeOp({ ...common, ...sym, event: rule.event, qty, price, currency: cur }));
        break;
      case 'split':
        // Количество — коэффициент: 10 — одна бумага стала десятью; 0,1 — десять стали одной
        out.add(makeOp({ ...common, ...sym, event: 'SPLIT', qty: 0, price: qty || price, amount: 0, currency: cur }));
        break;
      case 'fx': {
        const p = price || (qty ? Math.abs(nums.amount) / qty : 0);
        out.add(makeOp({ ...common, event: rule.event, symbol: raw || 'USD', qty, price: p, currency: cur === raw ? 'RUB' : cur }));
        if (nums.fee) out.add(cashOp({ ...common, event: 'FEE', amount: nums.fee, currency: cur === raw ? 'RUB' : cur, note: `комиссия: ${typeText}` }));
        break;
      }
      default: break;
    }
  });
  return out;
}
