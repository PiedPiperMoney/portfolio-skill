// Общее для разборщиков источников: числа и даты в русских отчётах, сборка операции в общем формате,
// таблицы соответствий «текст → событие», список нераспознанного.
//
// Общий формат операции (подробно — sources/snowball.mjs) и что добавлено для брокерских источников:
//   event (к событиям Snowball):
//     AMORTIZATION — частичное погашение / амортизация облигации: amount — сумма, бумаги остаются;
//     TRANSFER_IN / TRANSFER_OUT — бумаги пришли / ушли без сделки (перевод между счетами, из другого депозитария,
//       дробление и конвертация в виде «списали — зачислили»); build.mjs разбирает их в merge.mjs:
//       пара между своими счетами — не сделка, пара на одном счёте — дробление или конвертация;
//     CONVERT_IN / CONVERT_OUT — то же, но источник точно знает, что это конвертация / замещение (смена тикера, ISIN);
//     WRITE_OFF — бумаги списаны без денег (делистинг, ликвидация): продажа по нулевой цене с пометкой;
//     FX_BUY / FX_SELL — покупка / продажа валюты: symbol — валюта (USD, CNY…), qty — сколько валюты,
//       price — курс в валюте currency (обычно RUB); комиссия — отдельной операцией FEE;
//     VARMARGIN — вариационная маржа срочного рынка: qty = amount = сумма со знаком;
//   isin, figi — коды бумаги, если есть (тикер по ISIN находит build.mjs через Мосбиржу);
//   foreign: true — бумага не с Мосбиржи (цены — по собственным сделкам);
//   margin: true — сделка маржинальная / шорт; transfer: true — деньги между своими счетами;
//   market: 'срочный рынок' — для операций с фьючерсами и опционами;
//   src: { type, file, line | where, id } — откуда операция (для отчёта и защиты от дублей).
// Деньги без бумаги (пополнение, вывод, комиссия, налог…): symbol — валюта, qty = amount = сумма, price 1;
// у FEE и TAX сумма лежит ещё и в fee (так считает model.mjs).

// Число из отчёта: «1 234,56», «-1 234.56», «(123,4)», «12,5 %», неразрывные пробелы; пусто → 0
export function num(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  let s = String(v).replace(/[\s  ]/g, '').replace(/[₽%]|руб\.?/gi, '');
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[−–]/g, '-');
  // «1.234,56» → «1234.56»; «1,234.56» → «1234.56»; «1234,56» → «1234.56»
  if (s.includes(',') && s.includes('.')) {
    s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replaceAll('.', '').replace(',', '.') : s.replaceAll(',', '');
  } else s = s.replace(',', '.');
  const x = Number(s);
  if (!Number.isFinite(x)) return NaN;
  return neg ? -x : x;
}

// Дата → 'ГГГГ-ММ-ДД': «31.12.2024», «31.12.24», «2024-12-31», «2024-12-31T10:00:00Z», число Excel (дни с 1899-12-30)
export function isoDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    return new Date(Date.UTC(1899, 11, 30) + Math.round(v * 864e5)).toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/(\d{1,2})[./](\d{1,2})[./](\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

// Время из строки («10:15:03») — для порядка внутри дня
export function timeOf(v) {
  const m = String(v ?? '').match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}:${m[3] || '00'}` : '12:00:00';
}

export const ISIN_RE = /\b[A-Z]{2}[A-Z0-9]{9}\d\b/;
export const isIsin = (s) => /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(String(s || ''));

// Валюта: «RUR», «руб», «Рубль», «rub», «USD», «Доллар США», «юань» → ISO
const CUR = [
  [/^(rub|rur|sur|руб|рубль|рубли|российский рубль|₽)/i, 'RUB'], [/^(usd|доллар|\$)/i, 'USD'], [/^(eur|евро|€)/i, 'EUR'],
  [/^(cny|юан|китайский юань)/i, 'CNY'], [/^(hkd|гонконгский)/i, 'HKD'], [/^(gbp|фунт)/i, 'GBP'],
  [/^(chf|швейцарский)/i, 'CHF'], [/^(kzt|тенге)/i, 'KZT'], [/^(try|турецк)/i, 'TRY'], [/^(aed|дирхам)/i, 'AED'],
  [/^(byn|белорусск)/i, 'BYN'], [/^(jpy|иена|йена)/i, 'JPY'], [/^(inr|рупи)/i, 'INR'],
  [/^(xau|золото|gld)/i, 'XAU'], [/^(xag|серебро|slv)/i, 'XAG'],
];
export function currency(v, fallback = 'RUB') {
  const s = String(v ?? '').trim();
  if (!s) return fallback;
  for (const [re, c] of CUR) if (re.test(s)) return c;
  return /^[A-Za-z]{3}$/.test(s) ? s.toUpperCase() : fallback;
}

// Убрать суммы из текста подсказки (оставить слова, коды ISIN и тикеры)
export function redact(text) {
  // число — отдельное «слово» из цифр, точек и запятых (коды вроде RU0009024277 и даты 31.12.2024 тоже не нужны:
  // даты остаются в where); подряд идущие «#» (разряды «1 234,56») склеиваются
  return String(text ?? '')
    .split(/[\s  ]+/)
    .map((w) => (/^[-−+(]?[\d.,:]*\d[\d.,:]*[)%]?[,.;:]?$/.test(w) ? '#' : w))
    .join(' ')
    .replace(/#( #)+/g, '#')
    .trim()
    .slice(0, 200);
}

// Найти правило в таблице соответствий: правило — { re | test(row), ... }; первое подходящее
export function matchRule(rules, text, row) {
  for (const r of rules) {
    if (r.re ? r.re.test(text) : r.test?.(text, row)) return r;
  }
  return null;
}

// Операция в общем формате с умолчаниями
export function makeOp(o) {
  const date = o.date;
  const event = o.event;
  const qty = o.qty ?? 0, price = o.price ?? 0;
  const amount = o.amount ?? (['DIVIDEND', 'CASH_IN', 'CASH_OUT', 'CASH_GAIN', 'TAX_RETURN', 'VARMARGIN', 'AMORTIZATION'].includes(event) ? qty : qty * price);
  return {
    date, time: o.time || `${date} 12:00:00`, account: o.account || '', symbol: o.symbol || '', exchange: o.exchange || '',
    event, qty, price, amount, currency: o.currency || 'RUB', fee: o.fee ?? 0, nkd: o.nkd ?? 0,
    netRecorded: false, noCash: false, note: o.note || '',
    ...(o.isin ? { isin: o.isin } : {}), ...(o.figi ? { figi: o.figi } : {}), ...(o.foreign ? { foreign: true } : {}),
    ...(o.margin ? { margin: true } : {}), ...(o.transfer ? { transfer: true } : {}), ...(o.market ? { market: o.market } : {}),
    ...(o.name ? { name: o.name } : {}),
    src: o.src || {},
  };
}

// Деньги без бумаги: пополнение, вывод, комиссия, налог, прочий доход, вариационная маржа
export function cashOp({ event, amount, currency: cur = 'RUB', ...rest }) {
  const a = Math.abs(amount);
  const signed = event === 'VARMARGIN' ? amount : a;
  return makeOp({
    ...rest, event, currency: cur, symbol: rest.symbol || cur, qty: signed, price: 1, amount: signed,
    fee: event === 'FEE' || event === 'TAX' ? a : 0,
  });
}

// Сборщик результата разбора: операции, предупреждения, нераспознанные строки
export function collector(type, file) {
  const out = { ops: [], warnings: [], unknown: [], skipped: {}, info: {} };
  out.add = (op) => { out.ops.push(op); return op; };
  out.warn = (msg) => out.warnings.push(`${file ? `${file}: ` : ''}${msg}`);
  // where — где строка (лист, раздел, строка), text — описание операции (суммы вырезаются), hint — где править код
  out.unknownRow = (where, text, hint) => out.unknown.push({ source: type, file: file || '', where, text: redact(text), hint });
  // известная, но намеренно не учитываемая операция (например, размещение овернайта)
  out.skip = (why) => { out.skipped[why] = (out.skipped[why] || 0) + 1; };
  return out;
}

// Счёт-получатель: у источника несколько счетов → «<имя источника> — <счёт>», имя можно задать в settings
export function accountLabel(src, sub, multi) {
  if (src.accounts && sub != null && src.accounts[sub]) return src.accounts[sub];
  const base = src.account || '';
  if (!multi || sub == null || sub === '') return base || String(sub || '');
  return base ? `${base} — ${sub}` : String(sub);
}

// Таблица с заголовком: найти номера колонок по ключевым словам. spec — { поле: [слова…] | RegExp }
// Возвращает { поле: индекс } для найденных; слово ищется в нижнем регистре внутри текста ячейки.
export function headerIndex(row, spec) {
  const cells = row.map((c) => String(c ?? '').toLowerCase().replace(/\s+/g, ' ').trim());
  const idx = {};
  const used = new Set();
  for (const [key, words] of Object.entries(spec)) {
    const list = words instanceof RegExp ? [words] : words;
    const test = (c) => list.some((w) => (w instanceof RegExp ? w.test(c) : c.includes(w)));
    const i = cells.findIndex((c, j) => c && !used.has(j) && test(c));
    if (i >= 0) { idx[key] = i; used.add(i); }
  }
  return idx;
}
