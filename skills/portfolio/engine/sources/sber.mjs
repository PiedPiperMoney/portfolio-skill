// Отчёт брокера Сбербанка в HTML (личный кабинет «СберИнвестиции» → отчёты брокера).
// ВНИМАНИЕ: формат проверен только на образце (tests/fixtures/sber-report.html), собранном по разделам
// PDF-отчёта; настоящий HTML может отличаться. Таблицы находятся по заголовкам столбцов, а не по номерам.
// Разделы:
//   «Сделки купли/продажи ценных бумаг» — покупки и продажи (цена, сумма, НКД, комиссии брокера и биржи);
//   «Движение денежных средств за период» — пополнения, выводы, дивиденды, купоны, погашения, налоги,
//      комиссии, переводы, вариационная маржа (таблица CASH_RULES, по «Описанию операции»);
//   «Движение ценных бумаг» (если есть) — переводы, конвертации, дробления (MOVE_RULES);
//   справочник ценных бумаг — название / код ↔ ISIN; тикер по ISIN находит build.mjs через Мосбиржу;
//   «Оценка активов», «Портфель Ценных Бумаг», «Сводная информация…» — операций нет, пропускаются.
import fs from 'node:fs';
import path from 'node:path';
import { htmlTables } from '../lib/html.mjs';
import { num, isoDate, timeOf, currency, ISIN_RE, isIsin, makeOp, cashOp, collector, accountLabel, headerIndex } from '../lib/common.mjs';

export const SBER_NOTE = 'Формат отчёта Сбербанка проверен только на образце. Если что-то не распозналось — пришлите разработчику '
  + 'строку из раздела unknown отчёта сборки (там нет сумм) или такую же строку из отчёта брокера, заменив суммы.';

// Описание операции в движении денег → событие (первое совпадение; skip — известная строка, не операция)
export const CASH_RULES = [
  { re: /итого|остаток на (начало|конец)|входящий|исходящий/i, skip: 'итоги и остатки' },
  { re: /возврат.*(ндфл|налог)|(ндфл|налог).*возврат/i, event: 'TAX_RETURN' },
  { re: /^(ндфл|налог|удержан\S* (ндфл|налог))/i, event: 'TAX' }, // «Налог…» в начале; «Дивиденды…, налог …» — это выплата
  { re: /вариационн|вар\.?\s?марж/i, event: 'VARMARGIN', market: 'срочный рынок' },
  { re: /дивиденд/i, event: 'DIVIDEND' },
  { re: /купон/i, event: 'DIVIDEND', note: 'купон' },
  { re: /частичн.*погашен|амортизац/i, event: 'AMORTIZATION' },
  { re: /оферт/i, event: 'OFFER' },
  { re: /погашени/i, event: 'REPAYMENT' },
  { re: /перевод.*(между|площадк|субсч|счет|счёт)|внутренн.*перевод/i, event: 'CASH_TRANSFER' },
  { re: /ввод д\/?с|зачислени.*(д\/?с|денеж|средств)|пополнен/i, event: 'CASH_IN' },
  { re: /вывод д\/?с|списани.*(д\/?с|денеж|средств)|вывод/i, event: 'CASH_OUT' },
  { re: /комисси|вознагражд|плата за|депозитарн|обслуживан/i, event: 'FEE' },
  { re: /кэшб[еэ]к|процент.*остат|начислен.*доход|компенсац|доход по/i, event: 'CASH_GAIN' },
  { re: /сделк|покупк|продаж|нкд|расч[её]т/i, skip: 'расчёты по сделкам (сделки — из таблицы сделок)' },
];
export const MOVE_RULES = [
  { re: /сделк|покупк|продаж/i, skip: 'движение бумаг по сделке (сделки — из таблицы сделок)' },
  { re: /погашен|оферт/i, skip: 'погашение (деньги — из движения денежных средств)' },
  { re: /конвертац|замещен|обмен/i, in: 'CONVERT_IN', out: 'CONVERT_OUT' },
  { re: /дроблен|сплит|консолидац/i, in: 'TRANSFER_IN', out: 'TRANSFER_OUT', note: 'дробление' },
  { re: /делистинг|ликвидац|аннулир/i, in: 'TRANSFER_IN', out: 'WRITE_OFF' },
  { re: /перевод|зачислен|списан|ввод|вывод|депозитар/i, in: 'TRANSFER_IN', out: 'TRANSFER_OUT' },
];
const HINT_CASH = 'engine/sources/sber.mjs → CASH_RULES';
const HINT_MOVE = 'engine/sources/sber.mjs → MOVE_RULES';
const HINT_TABLE = 'engine/sources/sber.mjs → TABLES';

// Таблица → вид: по названию раздела и словам в заголовке
export const TABLES = [
  { kind: 'skip', title: /оценка активов|портфель ценных бумаг|сводная информация|итог/i },
  { kind: 'fxdeals', title: /сделки.*валют/i, head: ['дата', 'количество'] },
  { kind: 'deals', title: /сделки купли|сделки с ценными|сделки/i, head: ['дата', 'количество', 'цена'] },
  { kind: 'cash', title: /движение денежных средств/i, head: ['дата', 'описание'] },
  { kind: 'moves', title: /движение ценных бумаг/i, head: ['дата'] },
  { kind: 'ref', title: /справочник/i, head: ['isin'] },
];

const lc = (s) => String(s ?? '').toLowerCase();

export function readSber(file, src = {}) {
  const base = path.basename(file);
  const html = fs.readFileSync(file, 'utf8');
  const out = collector('sber', base);
  out.info.note = SBER_NOTE;
  const tables = htmlTables(html);
  if (!tables.length) throw new Error(`${base}: в файле нет таблиц — это не HTML-отчёт брокера?`);
  const subs = new Set([...html.matchAll(/(?:субсч[её]т|торговый код|договор)[^<]{0,6}(?:№|:)?\s*([A-ZА-Я0-9-]{3,20}(?:\s*\(ИИС\))?)/gi)].map((m) => m[1].trim()));
  const multi = subs.size > 1;
  const isinOf = {}, nameOf = {}, codeOf = {};
  const deals = [], fxdeals = [], cash = [], moves = [];

  for (const t of tables) {
    const hi = t.rows.findIndex((r) => r.some((c) => /дата|isin/i.test(c)) && r.filter(Boolean).length >= 3);
    if (hi < 0) continue;
    const head = t.rows[hi].map(lc);
    const kindRule = TABLES.find((k) => k.title.test(t.title) && (!k.head || k.head.every((w) => head.some((h) => h.includes(w)))))
      || TABLES.find((k) => k.head && k.head.every((w) => head.some((h) => h.includes(w))) && k.kind !== 'deals' && k.kind !== 'fxdeals')
      || (head.some((h) => h.includes('количество')) && head.some((h) => h.startsWith('цена')) && head.some((h) => /вид|операция/.test(h)) ? { kind: 'deals' } : null);
    if (!kindRule) { out.unknownRow(`таблица «${t.title || t.index + 1}»`, `таблица не распознана: ${head.filter(Boolean).slice(0, 6).join(', ')}`, HINT_TABLE); continue; }
    if (kindRule.kind === 'skip') { out.skip(`таблица «${t.title}» (без операций)`); continue; }
    const sub = (t.title.match(/(ИИС|субсч[её]т\s*\S+)/i) || [])[1] || null;
    const rows = t.rows.slice(hi + 1);
    const where = (i) => `«${t.title || 'таблица'}», строка ${i + 1}`;
    if (kindRule.kind === 'ref') {
      const c = headerIndex(t.rows[hi], { name: ['наименование'], code: ['код', 'тикер'], isin: ['isin'] });
      for (const r of rows) {
        const isin = String(r[c.isin] || '').trim();
        if (!isIsin(isin)) continue;
        if (r[c.name]) { isinOf[lc(r[c.name]).trim()] = isin; nameOf[isin] = r[c.name]; }
        if (r[c.code]) { isinOf[lc(r[c.code]).trim()] = isin; if (!isIsin(String(r[c.code]).trim())) codeOf[isin] = String(r[c.code]).trim().toUpperCase(); }
      }
      continue;
    }
    if (kindRule.kind === 'deals' || kindRule.kind === 'fxdeals') {
      const c = headerIndex(t.rows[hi], {
        date: /^дата (заключ|сделки)|^дата$/, settle: ['дата расч'], time: ['время'], name: ['наименование', 'валютная пара', 'инструмент'],
        code: ['код', 'тикер'], isin: ['isin'], cur: ['валюта'], side: [/^вид|^операция|покупка\/продажа|направление/], qty: ['количество', 'объем', 'объём'],
        price: [/^цена|^курс/], nkd: ['нкд'], sum: [/^сумма|^объем в валюте|^объём в валюте/], feeBroker: ['комиссия брокера', 'комиссия банка'],
        feeEx: ['комиссия биржи', 'комиссия тс'], fee: ['комисси'], status: ['статус'], comment: ['комментар', 'примечан'],
      });
      rows.forEach((r, i) => {
        const date = isoDate(r[c.date]);
        if (!date) return;
        const side = lc(r[c.side]);
        const ev = /покуп|buy|^к$/.test(side) ? 'BUY' : /прода|sell|^п$/.test(side) ? 'SELL' : null;
        if (/отмен|не исполн/i.test(r[c.status] || '')) { out.skip('отменённые сделки'); return; }
        if (!ev) { out.unknownRow(where(i), `сделка: вид «${r[c.side] || ''}»`, HINT_TABLE); return; }
        const qty = Math.abs(num(r[c.qty]) || 0), sum = Math.abs(num(r[c.sum]) || 0), price = Math.abs(num(r[c.price]) || 0);
        const fee = [c.feeBroker, c.feeEx, c.fee].filter((x) => x != null).reduce((a, x) => a + Math.abs(num(r[x]) || 0), 0);
        (kindRule.kind === 'fxdeals' ? fxdeals : deals).push({ date, time: timeOf(r[c.time]), ev, qty, sum, price, fee, nkd: Math.abs(num(r[c.nkd]) || 0),
          name: r[c.name] || '', code: r[c.code] || '', isin: (String(r[c.isin] || r[c.code] || '').match(ISIN_RE) || [])[0], cur: currency(r[c.cur]),
          sub, where: where(i), margin: /маржин|шорт|необеспеч/i.test(r[c.comment] || ''), repo: /репо/i.test(r[c.comment] || '') });
      });
      continue;
    }
    if (kindRule.kind === 'cash') {
      const c = headerIndex(t.rows[hi], { date: ['дата'], desc: ['описание', 'операция', 'содержание'], cur: ['валюта'],
        credit: ['зачислен', 'поступлен', 'приход'], debit: ['списан', 'расход'], sum: [/^сумма$/], place: ['площадка'] });
      rows.forEach((r, i) => {
        const date = isoDate(r[c.date]);
        if (!date) return;
        const credit = Math.abs(num(r[c.credit]) || 0), debit = Math.abs(num(r[c.debit]) || 0);
        const signed = c.credit != null || c.debit != null ? credit - debit : num(r[c.sum]) || 0;
        cash.push({ date, desc: String(r[c.desc] || '').trim(), cur: currency(r[c.cur]), amount: signed, sub, where: where(i) });
      });
      continue;
    }
    if (kindRule.kind === 'moves') {
      const c = headerIndex(t.rows[hi], { date: ['дата'], name: ['наименование'], isin: ['isin'], op: ['операция', 'вид', 'основание', 'описание'],
        inQ: ['зачислен', 'приход'], outQ: ['списан', 'расход'], qty: ['количество'] });
      rows.forEach((r, i) => {
        const date = isoDate(r[c.date]);
        if (!date) return;
        let inQ = Math.abs(num(r[c.inQ]) || 0), outQ = Math.abs(num(r[c.outQ]) || 0);
        if (!inQ && !outQ && c.qty != null) {
          const q = num(r[c.qty]) || 0;
          if (/списан|расход|вывод/i.test(r[c.op] || '') || q < 0) outQ = Math.abs(q); else inQ = Math.abs(q);
        }
        moves.push({ date, name: r[c.name] || '', isin: (String(r[c.isin] || '').match(ISIN_RE) || [])[0], op: String(r[c.op] || ''), inQ, outQ, sub, where: where(i) });
      });
    }
  }

  const acc = (sub) => accountLabel(src, sub, multi || !!sub) || 'Сбербанк';
  const security = ({ name, code, isin }) => {
    let c = String(code || '').trim().toUpperCase();
    const i = isin || (isIsin(c) ? c : null) || isinOf[lc(code).trim()] || isinOf[lc(name).trim()];
    if ((!c || isIsin(c)) && i && codeOf[i]) c = codeOf[i]; // ISIN → код из справочника: дивиденд ляжет на тикер сделок
    if (c && !isIsin(c) && /^[A-Z0-9.-]{2,12}$/.test(c)) return { symbol: c, ...(i ? { isin: i } : {}), name };
    if (i) return { symbol: i, isin: i, name: name || nameOf[i] };
    return null;
  };
  const srcOf = (w) => ({ type: 'sber', file: base, where: w });

  for (const d of deals) {
    const sec = security(d);
    if (!sec) { out.unknownRow(d.where, `сделка: не нашёл код или ISIN бумаги «${d.name}»`, HINT_TABLE); continue; }
    const unit = d.sum && d.qty ? d.sum / d.qty : d.price; // облигации: цена в % — берём сумму ÷ количество
    out.add(makeOp({ ...sec, date: d.date, time: `${d.date} ${d.time}`, account: acc(d.sub), event: d.ev, qty: d.qty, price: unit,
      currency: d.cur, fee: d.fee, nkd: d.nkd, note: [d.margin ? 'маржинальная сделка' : '', d.repo ? 'РЕПО' : ''].filter(Boolean).join('; '),
      ...(d.margin ? { margin: true } : {}), src: srcOf(d.where) }));
  }
  for (const d of fxdeals) {
    const sym = (`${d.name} ${d.code}`.toUpperCase().match(/USD|EUR|CNY|HKD|GBP|CHF|KZT|TRY|AED|JPY|GLD|SLV/) || [])[0] || currency(d.name, 'USD');
    const rate = d.price || (d.sum && d.qty ? d.sum / d.qty : 0);
    out.add(makeOp({ date: d.date, time: `${d.date} ${d.time}`, account: acc(d.sub), event: d.ev === 'BUY' ? 'FX_BUY' : 'FX_SELL', symbol: sym, qty: d.qty,
      price: rate, currency: 'RUB', src: srcOf(d.where) }));
    if (d.fee) out.add(cashOp({ date: d.date, account: acc(d.sub), event: 'FEE', amount: d.fee, currency: 'RUB', note: `комиссия: валюта ${sym}`, src: srcOf(d.where) }));
  }
  const near = (a, b, n) => Math.abs(Date.parse(a) - Date.parse(b)) <= n * 864e5;
  const repayMoves = [];
  for (const m of moves) {
    const sec = security(m) || { symbol: m.name.slice(0, 30), name: m.name };
    const rule = MOVE_RULES.find((x) => x.re.test(m.op));
    if (!rule) { out.unknownRow(m.where, `движение бумаг: ${m.op || 'без описания'}`, HINT_MOVE); continue; }
    if (rule.skip) { if (/погашен|оферт/i.test(m.op)) repayMoves.push({ ...m, sec }); out.skip(rule.skip); continue; }
    const dir = m.inQ ? 'in' : 'out';
    out.add(makeOp({ ...sec, date: m.date, account: acc(m.sub), event: rule[dir], qty: m.inQ || m.outQ, price: 0, note: rule.note || m.op, src: srcOf(m.where) }));
  }
  // бумага из описания операции: ISIN, код или название из справочника и сделок
  const known = [...deals, ...moves].map((d) => security(d) && { ...security(d), name: d.name }).filter(Boolean);
  const secFromText = (text) => {
    const isin = (text.match(ISIN_RE) || [])[0];
    if (isin) return security({ isin, name: nameOf[isin] });
    const t = lc(text);
    for (const [k, v] of Object.entries(isinOf)) if (k.length >= 4 && t.includes(k)) return security({ isin: v, name: nameOf[v] });
    return known.find((x) => x.name && t.includes(lc(x.name))) || null;
  };
  const divs = [];
  for (const c of cash) {
    const rule = CASH_RULES.find((x) => x.re.test(c.desc));
    const where = `${c.where}, ${c.date}`;
    if (!rule) { out.unknownRow(where, c.desc, HINT_CASH); continue; }
    if (rule.skip) { out.skip(rule.skip); continue; }
    const common = { date: c.date, account: acc(c.sub), currency: c.cur, src: srcOf(c.where) };
    switch (rule.event) {
      case 'DIVIDEND': {
        const sec = secFromText(c.desc);
        if (!sec) out.unknownRow(where, `${c.desc}: не нашёл бумагу`, HINT_CASH);
        const tax = Math.abs(num((lc(c.desc).match(/(?:налог|ндфл)[^\d]*([\d\s]+[.,]?\d*)/) || [])[1]) || 0);
        divs.push(out.add(makeOp({ ...common, ...(sec || { symbol: '?' }), event: 'DIVIDEND', qty: c.amount + tax, amount: c.amount + tax, fee: tax, note: rule.note || '' })));
        break;
      }
      case 'AMORTIZATION': {
        const sec = secFromText(c.desc);
        if (!sec) out.unknownRow(where, `${c.desc}: не нашёл бумагу`, HINT_CASH);
        out.add(makeOp({ ...common, ...(sec || { symbol: '?' }), event: 'AMORTIZATION', qty: 0, amount: c.amount }));
        break;
      }
      case 'REPAYMENT': case 'OFFER': {
        const sec = secFromText(c.desc);
        const mv = repayMoves.find((m) => !m.used && near(m.date, c.date, 5) && (!sec || m.sec.symbol === sec.symbol));
        if (mv) mv.used = true;
        const s = sec || mv?.sec;
        if (!s) { out.unknownRow(where, `${c.desc}: не нашёл бумагу`, HINT_CASH); break; }
        const qty = mv ? mv.outQ || mv.inQ : 1;
        out.add(makeOp({ ...common, ...s, event: rule.event === 'OFFER' ? 'SELL' : 'REPAYMENT', qty, price: c.amount / qty,
          note: rule.event === 'OFFER' ? 'оферта' : '' }));
        break;
      }
      case 'TAX': {
        if (c.amount > 0) { out.add(cashOp({ ...common, event: 'TAX_RETURN', amount: c.amount })); break; }
        // налог по выплате — в fee выплаты (та же дата и бумага); иначе отдельной строкой
        const sec = secFromText(c.desc);
        const d = divs.find((x) => x.date === c.date && x.account === common.account && (!sec || x.symbol === sec.symbol) && !x._taxed);
        if (d && sec) { d.fee += Math.abs(c.amount); d.amount += Math.abs(c.amount); d.qty = d.amount; d._taxed = true; break; }
        out.add(cashOp({ ...common, event: 'TAX', amount: c.amount, ...(sec ? { symbol: sec.symbol } : {}) }));
        break;
      }
      case 'FEE':
        if (c.amount > 0) out.add(cashOp({ ...common, event: 'CASH_GAIN', amount: c.amount, note: 'возврат комиссии' }));
        else out.add(cashOp({ ...common, event: 'FEE', amount: c.amount }));
        break;
      case 'CASH_TRANSFER':
        out.add(cashOp({ ...common, event: c.amount >= 0 ? 'CASH_IN' : 'CASH_OUT', amount: c.amount, transfer: true, note: 'перевод между счетами' }));
        break;
      case 'VARMARGIN':
        out.add(cashOp({ ...common, event: 'VARMARGIN', amount: c.amount, market: rule.market, note: 'срочный рынок' }));
        break;
      default:
        out.add(cashOp({ ...common, event: rule.event, amount: c.amount }));
    }
  }
  for (const d of divs) delete d._taxed;
  return out;
}
