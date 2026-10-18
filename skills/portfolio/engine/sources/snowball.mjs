// Выгрузка операций Snowball (CSV) → общий формат операций.
// Колонки: Event,Date,Symbol,Price,Quantity,Currency,FeeTax,Exchange,NKD,FeeCurrency,DoNotAdjustCash,Note; дробные — с запятой.
//
// Общий формат операции:
//   date 'ГГГГ-ММ-ДД', time (полная строка даты — для порядка внутри дня), account, symbol, exchange,
//   event: BUY | SELL | DIVIDEND (дивиденд или купон) | REPAYMENT (погашение) | FEE | TAX | SPLIT |
//          CASH_IN | CASH_OUT | CASH_CONVERT | CASH_GAIN | TAX_RETURN,
//   qty, price, amount (сумма в валюте: сделка — qty×price, выплата — сумма до налога), currency,
//   fee (комиссия; у выплаты — удержанный налог), nkd, netRecorded (выплата записана уже после налога, налог 0),
//   noCash (флаг «не трогать кэш»), note, src {file, line}.
import fs from 'node:fs';
import path from 'node:path';

// CSV по RFC 4180: кавычки, запятые и переводы строк внутри кавычек
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

const EVENTS = new Set(['BUY', 'SELL', 'DIVIDEND', 'REPAYMENT', 'FEE', 'TAX', 'SPLIT', 'CASH_IN', 'CASH_OUT',
  'CASH_CONVERT', 'CASH_GAIN', 'TAX_RETURN']);

// число Snowball: пробелы убрать, запятая → точка, пусто → 0
function num(s, warn) {
  const t = (s || '').replace(/\s/g, '').replaceAll(',', '.');
  if (!t) return 0;
  const v = Number(t);
  if (!Number.isFinite(v)) { warn(`не число «${s}»`); return 0; }
  return v;
}

export function readSnowball(file, { account = 'Snowball' } = {}) {
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  const head = rows[0].map((h) => h.trim());
  const need = ['Event', 'Date', 'Symbol', 'Price', 'Quantity', 'Currency', 'FeeTax'];
  const miss = need.filter((h) => !head.includes(h));
  if (miss.length) throw new Error(`${path.basename(file)}: нет колонок ${miss.join(', ')} — это не выгрузка Snowball?`);
  const ops = [], warnings = [];
  rows.slice(1).forEach((cells, i) => {
    const line = i + 2;
    const r = Object.fromEntries(head.map((h, j) => [h, cells[j] ?? '']));
    const warn = (msg) => warnings.push(`${path.basename(file)}, строка ${line}: ${msg}`);
    const event = r.Event.trim().toUpperCase();
    if (!EVENTS.has(event)) warn(`неизвестное событие «${r.Event}» — пропущено в расчётах`);
    const qty = num(r.Quantity, warn), price = num(r.Price, warn), fee = num(r.FeeTax, warn);
    const noCash = r.DoNotAdjustCash === 'True';
    ops.push({
      date: r.Date.slice(0, 10), time: r.Date, account, symbol: r.Symbol, exchange: r.Exchange || '',
      event, qty, price,
      // у DIVIDEND сумма выплаты в Snowball лежит в колонке Quantity
      amount: event === 'DIVIDEND' ? qty : qty * price,
      currency: r.Currency || 'RUB', fee, nkd: num(r.NKD, warn),
      netRecorded: event === 'DIVIDEND' && noCash && fee === 0,
      noCash, note: r.Note || '', src: { file: path.basename(file), line },
    });
  });
  return { ops, warnings };
}
