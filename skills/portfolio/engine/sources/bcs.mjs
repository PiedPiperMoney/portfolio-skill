// Брокерский отчёт БКС (.xlsx; старый .xls — пересохранить, см. xlsHelp). Разделы ищутся по названию,
// колонки — по заголовку (нет заголовка — по номерам колонок, как в старом проекте portfolio-dashboard/src/broker_bcs.py):
//   «1. Движение денежных средств»  — пополнения, выводы, дивиденды, купоны, погашения, налоги, комиссии,
//                                      вариационная маржа (таблица CASH_RULES);
//   «2.x Сделки … с ценными бумагами» — покупки и продажи с ценой, НКД и комиссиями;
//   «… сделки с валютой»              — покупка и продажа валюты;
//   «3. Активы»                      — цены закрытия месяца (нужны, только если раздела сделок нет);
//   «4. Движение ценных бумаг»       — бумаги без сделки: переводы, конвертации, дробления, делистинг (MOVE_RULES);
//   справочник ценных бумаг (любая таблица с колонкой ISIN) — код ↔ ISIN.
// В одном файле может быть несколько счетов (строки «Субсчет …», «ИИС …») — счёт берётся из последней такой строки.
import fs from 'node:fs';
import path from 'node:path';
import { readXlsx } from '../lib/xlsx.mjs';
import { num, isoDate, currency, ISIN_RE, makeOp, cashOp, collector, accountLabel, headerIndex } from '../lib/common.mjs';

// внутренние коды БКС → биржевой тикер (дополняется settings: sources[].tickerMap)
export const BCS_CODES = { GAZP2: 'GAZP', SGMLP: 'MTLRP', ENGRU_001: 'ENRU', TGK1_01: 'TGKA', AFKS_02: 'AFKS' };

// Движение денег: описание операции (+ примечание) → событие. Порядок важен: первое совпадение.
//   event — событие; dir — 'in' зачисление / 'out' списание / 'signed' со знаком; skip — известная строка, не операция
export const CASH_RULES = [
  { re: /итого|^остаток|сальдо|входящ|исходящ/i, skip: 'итоги и остатки' }, // «Проценты на остаток» — не итог
  { re: /возврат.*(ндфл|налог)|(ндфл|налог).*возврат/i, event: 'TAX_RETURN' },
  { re: /^(ндфл|налог|удержан\S* (ндфл|налог))/i, event: 'TAX' }, // «Налог…» в начале; «Дивиденды…, налог …» — это выплата
  { re: /вариационн|вар\.?\s?марж/i, event: 'VARMARGIN', dir: 'signed', market: 'срочный рынок' },
  { re: /дивиденд/i, event: 'DIVIDEND' },
  { re: /купон/i, event: 'DIVIDEND', note: 'купон' },
  { re: /частичн.*погашен|амортизац/i, event: 'AMORTIZATION' },
  { re: /оферт/i, event: 'OFFER' },
  { re: /погашени.*(облигац|ценн|номинал)|погашение$/i, event: 'REPAYMENT' },
  { re: /перевод.*(дс|денеж|средств)|внутренн.*перевод|перевод между/i, event: 'CASH_TRANSFER' },
  { re: /^приход дс|зачислен.*(дс|денеж|средств)|пополнен/i, event: 'CASH_IN' },
  { re: /^вывод дс|списан.*(дс|денеж|средств)|вывод|возврат.*средств/i, event: 'CASH_OUT' },
  { re: /вознагражд|комисс|урегулир|плата за|депозитар|абонент|обслуживан/i, event: 'FEE' },
  { re: /кэшб[еэ]к|процент.*остат|начислен.*доход|компенсац|доход по/i, event: 'CASH_GAIN' },
  { re: /расч[её]ты? по сделк|покупка|продажа|сделк|нкд|конвертац.*валют|обмен валют/i, skip: 'расчёты по сделкам (сделки — из раздела сделок)' },
];

// Движение бумаг без сделки: основание / примечание → событие (направление — по колонкам приход / расход)
export const MOVE_RULES = [
  { re: /сделк|покупк|продаж|торг/i, kind: 'trade' },
  { re: /погашен|оферт/i, kind: 'repay' }, // деньги пришли в движении денежных средств
  { re: /конвертац|замещен|обмен/i, in: 'CONVERT_IN', out: 'CONVERT_OUT' },
  { re: /дроблен|сплит|консолидац|объединен/i, in: 'TRANSFER_IN', out: 'TRANSFER_OUT', note: 'дробление' },
  { re: /делистинг|ликвидац|аннулир|исключен/i, in: 'TRANSFER_IN', out: 'WRITE_OFF' },
  { re: /перевод|списан|зачислен|ввод|вывод|депозитар|приход|расход|внутренн/i, in: 'TRANSFER_IN', out: 'TRANSFER_OUT' },
];

// «Тип сделки» маржинальной / непокрытой позиции (шорт)
export const MARGIN_RE = /маржин|необеспеч|непокрыт|шорт|short/i;
const HINT_CASH = 'engine/sources/bcs.mjs → CASH_RULES';
const HINT_MOVE = 'engine/sources/bcs.mjs → MOVE_RULES';

// подсказка для старого .xls: пересохранить; если есть LibreOffice — команда для агента
export function xlsHelp(file) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  const candidates = [...dirs.map((d) => path.join(d, 'soffice')), '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe'];
  const soffice = candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  const msg = `${path.basename(file)} — старый формат Excel (.xls), навык читает только .xlsx. Откройте файл в Excel, `
    + 'Numbers или LibreOffice и сохраните как «Книга Excel (.xlsx)», затем укажите новый файл в settings.json.';
  return soffice
    ? `${msg} LibreOffice найден — можно конвертировать командой: "${soffice}" --headless --convert-to xlsx --outdir "${path.dirname(file)}" "${file}"`
    : msg;
}

const SECTION = [
  [/движение денежных средств/i, 'cash'],
  [/сделки.*валют|валютн.*сделк|иностранн.*валют.*сделк|сделки с иностранной валютой/i, 'fx'],
  [/сделк.*(ценн|бумаг)|заключенн.*сделк|^\s*2\.\d*\.?\s*сделки/i, 'deals'],
  [/движение ценных бумаг/i, 'moves'],
  [/^\s*3\.?\s*активы|^активы:?$/i, 'assets'],
  [/справочник/i, 'ref'],
  [/срочн.*рын|фьючерс|опцион|пфи/i, 'derivatives'],
];

const normCode = (s) => String(s ?? '').replace(/\s+/g, '').toUpperCase();
const CODE_RE = /^[A-Z0-9_.-]{3,16}$/;

export function readBcs(file, src = {}) {
  const base = path.basename(file);
  let book;
  try { book = readXlsx(file); } catch (e) {
    if (e.code === 'XLS_OLD' || /\.xls$/i.test(file)) throw new Error(xlsHelp(file));
    throw new Error(`${base}: не читается как .xlsx (${e.message})`);
  }
  const out = collector('bcs', base);
  const codes = { ...BCS_CODES, ...(src.tickerMap || {}) };
  const isinOf = {};       // код или название → ISIN (справочник)
  const deals = [], moves = [], cash = [], fx = [], closes = {}; // сырые строки разделов
  const subs = new Set();

  for (const sheet of book.sheets) {
    let section = null, col = null, inst = null, cur = 'RUB', sub = null, month = null;
    sheet.rows.forEach((row, r) => {
      if (!row || !row.length) return;
      const cells = row.map((c) => (c == null ? '' : c));
      const text = cells.slice(0, 6).map(String).join(' ').trim();
      const where = `${sheet.name}, строка ${r + 1}`;
      // период отчёта (для цен закрытия месяца)
      const per = text.match(/период[^\d]*(\d{2}\.\d{2}\.\d{2,4})\s*(?:-|по|—)\s*(\d{2}\.\d{2}\.\d{2,4})/i);
      if (per) month = isoDate(per[2]).slice(0, 7);
      // (\b в JS не видит границу русских слов — поэтому (?=…))
      const subM = text.match(/^(?:субсч[её]т|сч[её]т|договор)(?=[\s:№])[^:№]*[:№]?\s*(.+)$/i) || text.match(/(?:^|\s)(ИИС(?:\s.*)?)$/);
      if (subM && cells.filter((c) => c !== '').length <= 3 && !/итого/i.test(text)) { sub = subM[1].trim().slice(0, 40); subs.add(sub); }
      const sec = SECTION.find(([re]) => re.test(text) && cells.filter((c) => c !== '').length <= 3);
      if (sec) { section = sec[1]; col = null; inst = null; return; }
      if (!section) return;
      const lower = cells.map((c) => String(c).toLowerCase());
      // заголовки таблиц
      if (section === 'cash' && lower.some((c) => c.includes('операция')) && lower.some((c) => c.includes('дата'))) {
        col = headerIndex(cells, { date: ['дата'], op: ['операция'], credit: ['зачисл', 'приход'], debit: ['списан', 'расход'], note: ['примечан', 'комментар'] });
        return;
      }
      if ((section === 'deals' || section === 'fx') && lower.some((c) => c.includes('куплено')) && lower.some((c) => c.includes('продано'))) {
        const h = headerIndex(cells, { date: /^дата$|^дата сделки|^дата заключ/, bought: ['куплено'], sold: ['продано'], payCur: ['валюта платежа'],
          priceCur: ['валюта цены'], settle: ['дата расч'], type: ['тип сделки'], nkd: ['нкд'], num: [/^номер/] });
        const priceIdx = lower.map((c, i) => (c.startsWith('цена') || c.startsWith('курс') ? i : -1)).filter((i) => i >= 0);
        const sumIdx = lower.map((c, i) => (c.startsWith('сумма') && !c.includes('нкд') ? i : -1)).filter((i) => i >= 0);
        h.buyPrice = priceIdx.find((i) => i > h.bought); h.sellPrice = priceIdx.find((i) => i > h.sold);
        h.buySum = sumIdx.find((i) => i > h.bought && (h.sold == null || i < h.sold)); h.sellSum = sumIdx.find((i) => i > h.sold);
        h.fees = lower.map((c, i) => (c.includes('комисс') ? i : -1)).filter((i) => i >= 0);
        col = h;
        return;
      }
      if (section === 'moves' && lower.some((c) => c.includes('дата')) && lower.some((c) => /приход|зачисл/.test(c))) {
        col = headerIndex(cells, { code: ['наименование', 'ценная бумага', 'код', 'выпуск'], date: ['дата'], inQ: ['приход', 'зачисл'],
          outQ: ['расход', 'списан'], rest: ['остаток'], note: ['примечан', 'основан', 'операция', 'комментар'] });
        return;
      }
      // заголовок справочника: ячейка «ISIN» (без цифр — «ISIN: RU…» в строке бумаги не заголовок)
      if (section !== 'deals' && section !== 'fx' && lower.some((c) => /^isin[^0-9]{0,25}$/.test(c.trim()))) {
        col = { ...(col || {}), refIsin: lower.findIndex((c) => /^isin[^0-9]{0,25}$/.test(c.trim())),
          refCode: lower.findIndex((c) => /^код|тикер/.test(c)), refName: lower.findIndex((c) => /наименован|бумага/.test(c)) };
        if (section !== 'ref' && section !== 'assets') section = section === 'cash' ? section : 'ref';
        return;
      }
      if (section === 'ref' && col?.refIsin >= 0) {
        const isin = String(cells[col.refIsin] || '').trim();
        if (ISIN_RE.test(isin)) {
          if (col.refCode >= 0 && cells[col.refCode]) isinOf[normCode(cells[col.refCode])] = isin;
          if (col.refName >= 0 && cells[col.refName]) isinOf[String(cells[col.refName]).trim().toLowerCase()] = isin;
        }
        return;
      }
      if (section === 'cash') {
        const c = col || { date: 1, op: 2, credit: 6, debit: 7, note: 14 };
        const date = isoDate(cells[c.date]);
        const op = String(cells[c.op] ?? '').trim();
        if (!date) { // строка-заголовок валюты: «Рубль», «USD», «Доллар США»
          const t = String(cells.find((x) => x !== '') ?? '').trim();
          if (t && t.length < 25 && currency(t, '') && !/итого/i.test(t)) cur = currency(t);
          return;
        }
        if (!op) return;
        cash.push({ date, op, credit: num(cells[c.credit]) || 0, debit: num(cells[c.debit]) || 0, note: String(cells[c.note] ?? '').trim(),
          cur, sub, where, row: cells });
        return;
      }
      if (section === 'deals' || section === 'fx') {
        if (!col) return;
        const date = isoDate(cells[col.date]);
        const b = Math.abs(num(cells[col.bought]) || 0), s = Math.abs(num(cells[col.sold]) || 0);
        if (date && (b || s)) {
          const fees = (col.fees || []).reduce((a, i) => a + Math.abs(num(cells[i]) || 0), 0);
          const qty = b || s;
          const sum = Math.abs(num(cells[b ? col.buySum : col.sellSum]) || 0);
          const px = Math.abs(num(cells[b ? col.buyPrice : col.sellPrice]) || 0);
          (section === 'fx' ? fx : deals).push({ date, side: b ? 'BUY' : 'SELL', qty, price: px, sum, fees,
            nkd: Math.abs(num(cells[col.nkd]) || 0), cur: currency(cells[col.payCur] || cells[col.priceCur], cur),
            type: String(cells[col.type] ?? ''), inst, sub, where, settle: isoDate(cells[col.settle]) });
          return;
        }
        if (/итого/i.test(text)) return;
        // строка бумаги / валютной пары: название, код, ISIN
        const nonEmpty = cells.filter((x) => x !== '').map(String);
        if (nonEmpty.length && nonEmpty.length <= 4) {
          const isin = (nonEmpty.join(' ').match(ISIN_RE) || [])[0];
          const code = nonEmpty.map(normCode).find((x) => CODE_RE.test(x) && !ISIN_RE.test(x) && /[A-Z]/.test(x));
          inst = { name: nonEmpty[0].replace(/ISIN.*$/i, '').trim(), isin, code };
        }
        return;
      }
      if (section === 'moves') {
        const c = col || { code: 1, date: 4, inQ: 7, outQ: 8, rest: 9, note: 12 };
        const date = isoDate(cells[c.date]);
        const inQ = Math.abs(num(cells[c.inQ]) || 0), outQ = Math.abs(num(cells[c.outQ]) || 0);
        const name = String(cells[c.code] ?? '').trim();
        if (!date || !name || (!inQ && !outQ)) return;
        const isin = (String(cells.join(' ')).match(ISIN_RE) || [])[0];
        moves.push({ date, name, code: normCode(name), isin, inQ, outQ, note: String(cells[c.note] ?? '').trim(), sub, where });
        return;
      }
      if (section === 'assets') {
        const code = normCode(cells[1]);
        if (CODE_RE.test(code)) {
          const p = num(cells[11]) || num(cells[7]) || 0;
          if (p && month) (closes[code] ||= {})[month] = p;
        }
      }
    });
  }

  const multi = subs.size > 1;
  const acc = (sub) => accountLabel(src, sub, multi) || 'БКС';
  // бумага: код БКС → тикер, или ISIN (тикер по ISIN найдёт build.mjs)
  // ISIN → код из справочника и из строк бумаг в сделках (чтобы дивиденд по ISIN лёг на тот же тикер, что и сделки)
  const codeOf = {};
  for (const [k, v] of Object.entries(isinOf)) if (CODE_RE.test(k) && !ISIN_RE.test(k)) codeOf[v] = k;
  for (const d of [...deals]) if (d.inst?.isin && d.inst?.code) codeOf[d.inst.isin] = d.inst.code;
  const security = ({ code, isin, name }) => {
    const i = isin || isinOf[code] || isinOf[String(name || '').toLowerCase()] || (ISIN_RE.test(code || '') ? code : null);
    const raw = code && CODE_RE.test(code) && !ISIN_RE.test(code) ? code : (i && codeOf[i]) || null;
    const c = raw ? codes[raw] || raw : null;
    if (c) return { symbol: c, ...(i ? { isin: i } : {}), name };
    if (i) return { symbol: i, isin: i, name };
    return { symbol: c || String(name || '').slice(0, 30), name };
  };

  // --- сделки с бумагами
  for (const d of deals) {
    const sec = security(d.inst || {});
    const unit = d.sum && d.qty ? d.sum / d.qty : d.price; // облигации: «Цена» в % — берём сумму ÷ количество
    out.add(makeOp({ ...sec, date: d.date, time: `${d.date} 12:00:00`, account: acc(d.sub), event: d.side, qty: d.qty, price: unit,
      currency: d.cur, fee: d.fees, nkd: d.nkd, note: [MARGIN_RE.test(d.type) ? 'маржинальная сделка' : '', /репо/i.test(d.type) ? 'РЕПО' : ''].filter(Boolean).join('; '),
      ...(MARGIN_RE.test(d.type) ? { margin: true } : {}), src: { type: 'bcs', file: base, where: d.where } }));
  }
  // --- сделки с валютой
  for (const d of fx) {
    const pair = `${d.inst?.code || ''} ${d.inst?.name || ''}`.toUpperCase();
    const sym = (pair.match(/USD|EUR|CNY|HKD|GBP|CHF|KZT|TRY|AED|JPY|GLD|SLV/) || [])[0] || currency(d.inst?.name, 'USD');
    const rate = d.price || (d.sum && d.qty ? d.sum / d.qty : 0);
    out.add(makeOp({ date: d.date, account: acc(d.sub), event: d.side === 'BUY' ? 'FX_BUY' : 'FX_SELL', symbol: sym, qty: d.qty, price: rate,
      currency: 'RUB', src: { type: 'bcs', file: base, where: d.where } }));
    if (d.fees) out.add(cashOp({ date: d.date, account: acc(d.sub), event: 'FEE', amount: d.fees, currency: 'RUB', note: `комиссия: валюта ${sym}`,
      src: { type: 'bcs', file: base, where: d.where } }));
  }

  // --- движение бумаг: что не сделка
  const haveDeals = deals.length > 0;
  const freeDeals = deals.map((d) => ({ ...d, sec: security(d.inst || {}) }));
  const near = (a, b, n) => Math.abs(Date.parse(a) - Date.parse(b)) <= n * 864e5;
  const priceAt = (code, date) => {
    const m = closes[code];
    if (!m) return 0;
    const k = Object.keys(m).sort();
    return m[date.slice(0, 7)] || m[k.filter((x) => x <= date.slice(0, 7)).pop()] || m[k[0]] || 0;
  };
  const repayMoves = [];
  for (const m of moves) {
    const sec = security(m);
    const rule = MOVE_RULES.find((x) => x.re.test(m.note)) || (haveDeals ? null : { kind: 'trade' });
    const dir = m.inQ ? 'in' : 'out';
    const qty = m.inQ || m.outQ;
    // сделка из раздела сделок с тем же количеством рядом по дате — уже учтена
    const dealIdx = freeDeals.findIndex((d) => !d.used && d.sec.symbol === sec.symbol && Math.abs(d.qty - qty) < 1e-9
      && (d.side === 'BUY') === (dir === 'in') && near(d.settle || d.date, m.date, 5));
    if (dealIdx >= 0 && (!rule || rule.kind === 'trade')) { freeDeals[dealIdx].used = true; continue; }
    if (!rule) { out.unknownRow(`${m.where}, ${m.date}`, `движение бумаг: ${m.note || 'без основания'} (${sec.symbol})`, HINT_MOVE); continue; }
    const common = { ...sec, date: m.date, account: acc(m.sub), src: { type: 'bcs', file: base, where: m.where } };
    if (rule.kind === 'trade') {
      if (haveDeals) { out.unknownRow(`${m.where}, ${m.date}`, `движение бумаг по сделке без строки в разделе сделок (${sec.symbol})`, HINT_MOVE); continue; }
      // раздела сделок нет — как в старом проекте: приход = покупка, расход = продажа по цене закрытия месяца
      const p = priceAt(m.code, m.date);
      out.add(makeOp({ ...common, event: dir === 'in' ? 'BUY' : 'SELL', qty, price: p, note: 'цена — закрытие месяца (раздела сделок нет)' }));
      out.info.closePrices = (out.info.closePrices || 0) + 1;
      continue;
    }
    if (rule.kind === 'repay') { repayMoves.push({ ...m, sec, qty, used: false }); continue; }
    out.add(makeOp({ ...common, event: rule[dir], qty, price: 0, note: rule.note || m.note }));
  }
  if (out.info.closePrices) out.warn(`в отчёте нет раздела сделок — покупки и продажи (${out.info.closePrices}) взяты из движения бумаг по цене закрытия месяца; комиссии сделок не учтены`);

  // --- движение денег
  for (const c of cash) {
    const text = `${c.op} ${c.note}`;
    const rule = CASH_RULES.find((x) => x.re.test(c.op)) || CASH_RULES.find((x) => x.re.test(text) && !x.skip);
    const where = `${c.where}, ${c.date}`;
    if (!rule) { out.unknownRow(where, c.op, HINT_CASH); continue; }
    if (rule.skip) { out.skip(rule.skip); continue; }
    const amount = c.credit - c.debit;
    const isin = (text.match(ISIN_RE) || [])[0];
    const common = { date: c.date, account: acc(c.sub), currency: c.cur, src: { type: 'bcs', file: base, where: c.where } };
    const secFromText = () => {
      if (isin) return security({ isin, code: Object.keys(isinOf).find((k) => isinOf[k] === isin) });
      const known = [...deals.map((d) => d.inst), ...moves].filter(Boolean).find((x) => x.name && text.toLowerCase().includes(String(x.name).toLowerCase()));
      return known ? security(known) : null;
    };
    switch (rule.event) {
      case 'DIVIDEND': {
        const sec = secFromText();
        const tax = Math.abs(num((text.toLowerCase().match(/(?:налог|ндфл)[^\d-]*-?\s*([\d\s]+[.,]?\d*)/) || [])[1]) || 0);
        if (!sec) out.unknownRow(where, `${c.op}: не нашёл бумагу (нет ISIN в примечании)`, HINT_CASH);
        out.add(makeOp({ ...common, ...(sec || { symbol: '?' }), event: 'DIVIDEND', qty: c.credit + tax, amount: c.credit + tax, fee: tax, note: rule.note || '' }));
        break;
      }
      case 'AMORTIZATION': {
        const sec = secFromText();
        if (!sec) out.unknownRow(where, `${c.op}: не нашёл бумагу`, HINT_CASH);
        out.add(makeOp({ ...common, ...(sec || { symbol: '?' }), event: 'AMORTIZATION', qty: 0, amount: c.credit }));
        break;
      }
      case 'REPAYMENT': case 'OFFER': {
        const sec = secFromText();
        const mv = repayMoves.find((m) => !m.used && m.outQ && near(m.date, c.date, 5) && (!sec || m.sec.symbol === sec.symbol));
        if (mv) mv.used = true;
        const s = sec || mv?.sec;
        if (!s) { out.unknownRow(where, `${c.op}: не нашёл бумагу`, HINT_CASH); break; }
        const qty = mv?.qty || 1;
        out.add(makeOp({ ...common, ...s, event: rule.event === 'OFFER' ? 'SELL' : 'REPAYMENT', qty, price: c.credit / qty,
          note: rule.event === 'OFFER' ? 'оферта' : mv ? '' : 'погашение: количество не найдено в движении бумаг' }));
        break;
      }
      case 'CASH_TRANSFER':
        out.add(cashOp({ ...common, event: amount >= 0 ? 'CASH_IN' : 'CASH_OUT', amount, transfer: true, note: 'перевод между счетами' }));
        break;
      case 'VARMARGIN':
        out.add(cashOp({ ...common, event: 'VARMARGIN', amount, market: rule.market, note: 'срочный рынок' }));
        break;
      case 'TAX': case 'FEE':
        // возврат комиссии / налога зачислением — с обратным знаком
        if (amount > 0 && rule.event === 'TAX') out.add(cashOp({ ...common, event: 'TAX_RETURN', amount }));
        else if (amount > 0) out.add(cashOp({ ...common, event: 'CASH_GAIN', amount, note: 'возврат комиссии' }));
        else out.add(cashOp({ ...common, event: rule.event, amount }));
        break;
      default:
        out.add(cashOp({ ...common, event: rule.event, amount }));
    }
  }
  for (const m of repayMoves.filter((x) => !x.used)) {
    out.unknownRow(`${m.where}, ${m.date}`, `погашение / оферта ${m.sec.symbol}: в движении денег нет выплаты`, HINT_CASH);
  }
  out.info.accounts = [...subs];
  return out;
}
