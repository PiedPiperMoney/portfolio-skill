#!/usr/bin/env node
// Проверки источников операций без сети: выдуманные образцы каждого формата → ожидаемые операции.
//   Т-Инвестиции — tests/fixtures/tinvest/*.json (ответы API подставляются вместо fetch; все 63 типа операций);
//   БКС и «Интеллектуальный инвестор» — .xlsx собираются здесь мини-писателем (engine/lib/xlsx.mjs);
//   Сбербанк — tests/fixtures/sber-report.html; шаблон CSV — tests/fixtures/шаблон-все-типы.csv и sample/шаблон-операций.csv;
//   объединение источников, дубли и переводы — engine/merge.mjs; сборка целиком — build.mjs с --offline.
// Запуск: node tests/sources.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readXlsx, writeXlsx } from '../engine/lib/xlsx.mjs';
import { num, isoDate, redact } from '../engine/lib/common.mjs';
import { htmlTables } from '../engine/lib/html.mjs';
import { OPERATION_TYPES, readTinvest, money } from '../engine/sources/tinvest.mjs';
import { readBcs } from '../engine/sources/bcs.mjs';
import { readSber, SBER_NOTE } from '../engine/sources/sber.mjs';
import { readIntelinvest } from '../engine/sources/intelinvest.mjs';
import { readCsvTemplate } from '../engine/sources/csv.mjs';
import { dedupe, resolveMoves } from '../engine/merge.mjs';
import { compute } from '../engine/model.mjs';
import { build } from '../engine/build.mjs';

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(SKILL, 'tests', 'fixtures');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-sources-'));

let failed = 0, passed = 0;
function eq(name, got, want, tol = 0.005) {
  const near = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol;
  const same = (a, b) => (typeof b === 'number' ? near(a, b)
    : Array.isArray(b) ? Array.isArray(a) && a.length === b.length && b.every((x, i) => same(a[i], x))
      : b && typeof b === 'object' ? a && typeof a === 'object' && Object.keys(b).every((k) => same(a[k], b[k])) && Object.keys(a).length === Object.keys(b).length
        : a === b);
  if (same(got, want)) passed++; else { failed++; console.log(`FAIL ${name}:\n  получилось ${JSON.stringify(got)}\n  должно быть ${JSON.stringify(want)}`); }
}
const section = (t) => console.log(`— ${t}`);
// операция кратко: [событие, бумага, количество, цена, сумма, валюта, комиссия/налог]
const brief = (o) => [o.event, o.symbol, o.qty, o.price, o.amount, o.currency, o.fee];

// ---------------------------------------------------------------------------------------------
section('общие помощники: числа, даты, текст без сумм, xlsx, html');
eq('число с пробелами и запятой', num('1 234,56'), 1234.56);
eq('число в скобках — минус', num('(12,5)'), -12.5);
eq('число с точкой тысяч', num('1.234,5'), 1234.5);
eq('дата ДД.ММ.ГГ', isoDate('5.3.24'), '2024-03-05');
eq('дата числом Excel', isoDate(45356), '2024-03-05');
eq('из подсказки вырезаны суммы', redact('Дивиденды RU0009029540 сумма 1 234,56 налог 160 руб.'), 'Дивиденды RU0009029540 сумма # налог # руб.');
const book = readXlsx(writeXlsx([{ name: 'Лист', rows: [['текст', 1.5, { date: '2024-03-05' }], [], ['', 'a & <b>', true]] }]));
eq('xlsx: общие строки, число, дата, пустая строка, логическое', book.sheets[0].rows, [['текст', 1.5, '2024-03-05'], [], ['', 'a & <b>', true]]);
eq('xlsx: строки в ячейке (inlineStr)', readXlsx(writeXlsx([{ name: 'S', rows: [['x', 2]] }], { sharedStrings: false })).sheets[0].rows, [['x', 2]]);
let xlsErr = '';
try { readXlsx(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0])); } catch (e) { xlsErr = e.code; }
eq('старый .xls распознан', xlsErr, 'XLS_OLD');
const tabs = htmlTables('<p>Раздел А</p><table><tr><th>Дата</th><th colspan="2">Сумма</th></tr><tr><td>01.01.2024</td><td>1&nbsp;000</td><td>x</td></tr></table>');
eq('html: таблица, colspan, &nbsp;, заголовок раздела', [tabs[0].title, tabs[0].rows], ['Раздел А', [['Дата', 'Сумма', ''], ['01.01.2024', '1 000', 'x']]]);

// ---------------------------------------------------------------------------------------------
section('Т-Инвестиции (API): ответы из tests/fixtures/tinvest, все типы операций');
// все значения OperationType из документации (operations.proto / openapi.yaml RussianInvestments/investAPI)
const DOC_TYPES = ['UNSPECIFIED', 'INPUT', 'BOND_TAX', 'OUTPUT_SECURITIES', 'OVERNIGHT', 'TAX', 'BOND_REPAYMENT_FULL', 'SELL_CARD',
  'DIVIDEND_TAX', 'OUTPUT', 'BOND_REPAYMENT', 'TAX_CORRECTION', 'SERVICE_FEE', 'BENEFIT_TAX', 'MARGIN_FEE', 'BUY', 'BUY_CARD',
  'INPUT_SECURITIES', 'SELL_MARGIN', 'BROKER_FEE', 'BUY_MARGIN', 'DIVIDEND', 'SELL', 'COUPON', 'SUCCESS_FEE', 'DIVIDEND_TRANSFER',
  'ACCRUING_VARMARGIN', 'WRITING_OFF_VARMARGIN', 'DELIVERY_BUY', 'DELIVERY_SELL', 'TRACK_MFEE', 'TRACK_PFEE', 'TAX_PROGRESSIVE',
  'BOND_TAX_PROGRESSIVE', 'DIVIDEND_TAX_PROGRESSIVE', 'BENEFIT_TAX_PROGRESSIVE', 'TAX_CORRECTION_PROGRESSIVE', 'TAX_REPO_PROGRESSIVE',
  'TAX_REPO', 'TAX_REPO_HOLD', 'TAX_REPO_REFUND', 'TAX_REPO_HOLD_PROGRESSIVE', 'TAX_REPO_REFUND_PROGRESSIVE', 'DIV_EXT',
  'TAX_CORRECTION_COUPON', 'CASH_FEE', 'OUT_FEE', 'OUT_STAMP_DUTY', 'OUTPUT_SWIFT', 'INPUT_SWIFT', 'OUTPUT_ACQUIRING',
  'INPUT_ACQUIRING', 'OUTPUT_PENALTY', 'ADVICE_FEE', 'TRANS_IIS_BS', 'TRANS_BS_BS', 'OUT_MULTI', 'INP_MULTI', 'OVER_PLACEMENT',
  'OVER_COM', 'OVER_INCOME', 'OPTION_EXPIRATION', 'FUTURE_EXPIRATION'].map((t) => `OPERATION_TYPE_${t}`);
eq('таблица соответствий: все 63 типа документации, ничего лишнего', Object.keys(OPERATION_TYPES).sort(), [...DOC_TYPES].sort());
const fixturesTypes = new Set();
for (const f of fs.readdirSync(path.join(FIX, 'tinvest')).filter((x) => x.startsWith('operations-'))) {
  for (const it of JSON.parse(fs.readFileSync(path.join(FIX, 'tinvest', f), 'utf8')).items) fixturesTypes.add(it.type);
}
eq('в образце есть операция каждого типа', DOC_TYPES.filter((t) => !fixturesTypes.has(t)), []);
eq('деньги API: units + nano', [money({ units: '12', nano: 500000000 }), money({ units: '-1', nano: -410000000 })], [12.5, -1.41]);

// подмена fetch: отвечает файлами образца, проверяет токен и тело запроса
const calls = [];
const J = (f) => JSON.parse(fs.readFileSync(path.join(FIX, 'tinvest', f), 'utf8'));
const fakeFetch = async (url, init) => {
  const method = url.split('/').pop();
  const body = JSON.parse(init.body);
  calls.push({ url, method, body, auth: init.headers.Authorization });
  const ok = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });
  if (init.headers.Authorization !== 'Bearer t.test-readonly') return { ok: false, status: 401, text: async () => '{"code":40003,"message":"authentication token is missing or invalid"}' };
  if (method.endsWith('UsersService.GetAccounts') || method === 'tinkoff.public.invest.api.contract.v1.UsersService/GetAccounts') return ok(J('accounts.json'));
  if (url.endsWith('UsersService/GetAccounts')) return ok(J('accounts.json'));
  if (url.endsWith('OperationsService/GetOperationsByCursor')) return ok(J(`operations-${body.accountId}-${body.cursor === 'page2' ? 2 : 1}.json`));
  if (url.endsWith('InstrumentsService/GetInstrumentBy')) return ok(J('instruments.json')[body.id] || {});
  if (url.endsWith('InstrumentsService/BondBy')) return ok(J('bond.json'));
  return { ok: false, status: 404, text: async () => '{}' };
};
const tv = await readTinvest({ type: 'tinvest', token: 't.test-readonly', account: 'Т' }, { fetch: fakeFetch });
eq('адрес REST и метод', calls[0].url, 'https://invest-public-api.tbank.ru/rest/tinkoff.public.invest.api.contract.v1.UsersService/GetAccounts');
const opsCalls = calls.filter((c) => c.url.endsWith('GetOperationsByCursor'));
eq('пагинация: брокерский — две страницы (cursor), ИИС — одна', opsCalls.map((c) => [c.body.accountId, c.body.cursor || '']), [['acc-bs', ''], ['acc-bs', 'page2'], ['acc-iis', '']]);
eq('запрос операций: исполненные, с комиссиями', [opsCalls[0].body.state, opsCalls[0].body.withoutCommissions, opsCalls[0].body.limit], ['OPERATION_STATE_EXECUTED', false, 1000]);
eq('справочник: инструмент по UID, облигация — номинал', calls.filter((c) => /GetInstrumentBy|BondBy/.test(c.url)).map((c) => [c.url.split('/').pop(), c.body.idType, c.body.id]).sort(),
  [['BondBy', 'INSTRUMENT_ID_TYPE_UID', 'u-bond'], ['GetInstrumentBy', 'INSTRUMENT_ID_TYPE_UID', 'u-aapl'], ['GetInstrumentBy', 'INSTRUMENT_ID_TYPE_UID', 'u-bond'],
    ['GetInstrumentBy', 'INSTRUMENT_ID_TYPE_UID', 'u-cny'], ['GetInstrumentBy', 'INSTRUMENT_ID_TYPE_UID', 'u-fut'], ['GetInstrumentBy', 'INSTRUMENT_ID_TYPE_UID', 'u-sber']]);
eq('кэш инструментов отдан для следующей сборки', Object.keys(tv.cache).sort(), ['u-aapl', 'u-bond', 'u-cny', 'u-fut', 'u-sber']);
const byId = (id) => tv.ops.filter((o) => o.src.id === id).map(brief);
const BS = 'Т — Брокерский', IIS = 'Т — ИИС';
// по каждому типу: id операции в образце → что получилось
const TV_EXPECT = {
  input: [['CASH_IN', 'RUB', 100000, 1, 100000, 'RUB', 0]],
  buy: [['BUY', 'SBER', 100, 280, 28000, 'RUB', 14]],                      // комиссия из поля commission; BROKER_FEE с родителем не задвоен
  buy_card: [['BUY', 'SBER', 10, 281, 2810, 'RUB', 1.41]],                 // commission пуст → BROKER_FEE с parentOperationId
  'buy-bond': [['BUY', 'RU000A0ZZZZ1', 10, 990, 9900, 'RUB', 0]],          // НКД отдельно (250)
  sell: [['SELL', 'SBER', 20, 300, 6000, 'RUB', 3]],
  sell_card: [['SELL', 'SBER', 5, 301, 1505, 'RUB', 0]],
  buy_margin: [['BUY', 'SBER', 1, 300, 300, 'RUB', 0]],
  sell_margin: [['SELL', 'SBER', 1, 299, 299, 'RUB', 0]],
  div: [['DIVIDEND', 'SBER', 3300, 0, 3300, 'RUB', 429]],                  // налог DIVIDEND_TAX — в fee выплаты (по parentOperationId)
  cpn: [['DIVIDEND', 'RU000A0ZZZZ1', 400, 0, 400, 'RUB', 52]],            // BOND_TAX без родителя — по бумаге и дате
  div_ext: [['DIVIDEND', 'SBER', 100, 0, 100, 'RUB', 15]],                 // DIVIDEND_TAX_PROGRESSIVE
  cpn2: [['DIVIDEND', 'RU000A0ZZZZ1', 200, 0, 200, 'RUB', 30]],           // BOND_TAX_PROGRESSIVE
  bond_repayment: [['AMORTIZATION', 'RU000A0ZZZZ1', 10, 0, 2500, 'RUB', 0]],
  bond_repayment_full: [['REPAYMENT', 'RU000A0ZZZZ1', 10, 750, 7500, 'RUB', 0]],
  'buy-cny': [['FX_BUY', 'CNY', 1000, 12.5, 12500, 'RUB', 0], ['FEE', 'RUB', 6.25, 1, 6.25, 'RUB', 6.25]],
  'sell-cny': [['FX_SELL', 'CNY', 100, 12.6, 1260, 'RUB', 0]],
  'div-usd': [['DIVIDEND', 'AAPL', 24, 0, 24, 'USD', 2.4]],
  tax: [['TAX', 'RUB', 260, 1, 260, 'RUB', 260]],
  tax_progressive: [['TAX', 'RUB', 30, 1, 30, 'RUB', 30]],
  'taxcorr-plus': [['TAX_RETURN', 'RUB', 100, 1, 100, 'RUB', 0]],
  'taxcorr-minus': [['TAX', 'RUB', 40, 1, 40, 'RUB', 40]],
  tax_correction_progressive: [['TAX_RETURN', 'RUB', 10, 1, 10, 'RUB', 0]],
  tax_correction_coupon: [['TAX', 'RUB', 5, 1, 5, 'RUB', 5]],
  benefit_tax: [['TAX', 'RUB', 7, 1, 7, 'RUB', 7]],
  benefit_tax_progressive: [['TAX', 'RUB', 8, 1, 8, 'RUB', 8]],
  tax_repo: [['TAX', 'RUB', 1, 1, 1, 'RUB', 1]],
  tax_repo_progressive: [['TAX', 'RUB', 2, 1, 2, 'RUB', 2]],
  tax_repo_hold: [['TAX', 'RUB', 3, 1, 3, 'RUB', 3]],
  tax_repo_hold_progressive: [['TAX', 'RUB', 4, 1, 4, 'RUB', 4]],
  tax_repo_refund: [['TAX_RETURN', 'RUB', 5, 1, 5, 'RUB', 0]],
  tax_repo_refund_progressive: [['TAX_RETURN', 'RUB', 6, 1, 6, 'RUB', 0]],
  service_fee: [['FEE', 'RUB', 290, 1, 290, 'RUB', 290]],
  margin_fee: [['FEE', 'RUB', 11, 1, 11, 'RUB', 11]],
  success_fee: [['FEE', 'RUB', 12, 1, 12, 'RUB', 12]],
  track_mfee: [['FEE', 'RUB', 13, 1, 13, 'RUB', 13]],
  track_pfee: [['FEE', 'RUB', 14, 1, 14, 'RUB', 14]],
  cash_fee: [['FEE', 'RUB', 15, 1, 15, 'RUB', 15]],
  out_fee: [['FEE', 'RUB', 16, 1, 16, 'RUB', 16]],
  out_stamp_duty: [['FEE', 'RUB', 17, 1, 17, 'RUB', 17]],
  output_penalty: [['FEE', 'RUB', 18, 1, 18, 'RUB', 18]],
  advice_fee: [['FEE', 'RUB', 19, 1, 19, 'RUB', 19]],
  over_com: [['FEE', 'RUB', 20, 1, 20, 'RUB', 20]],
  output: [['CASH_OUT', 'RUB', 5000, 1, 5000, 'RUB', 0]],
  output_swift: [['CASH_OUT', 'USD', 100, 1, 100, 'USD', 0]],
  input_swift: [['CASH_IN', 'USD', 200, 1, 200, 'USD', 0]],
  output_acquiring: [['CASH_OUT', 'RUB', 300, 1, 300, 'RUB', 0]],
  input_acquiring: [['CASH_IN', 'RUB', 400, 1, 400, 'RUB', 0]],
  out_multi: [['CASH_OUT', 'RUB', 1000, 1, 1000, 'RUB', 0]],
  'inp-multi': [['CASH_IN', 'RUB', 1000, 1, 1000, 'RUB', 0]],
  overnight: [['CASH_GAIN', 'RUB', 21, 1, 21, 'RUB', 0]],
  over_income: [['CASH_GAIN', 'RUB', 22, 1, 22, 'RUB', 0]],
  over_placement: [],
  'divtr-plus': [['DIVIDEND', 'SBER', 50, 0, 50, 'RUB', 6]],              // «передача дивидендного дохода»: + выплата, − удержание к ней
  'divtr-minus': [],
  accruing_varmargin: [['VARMARGIN', 'RUB', 350, 1, 350, 'RUB', 0]],
  writing_off_varmargin: [['VARMARGIN', 'RUB', -120, 1, -120, 'RUB', 0]],
  'buy-fut': [],                                                            // сделка с фьючерсом — не позиция
  delivery_buy: [['BUY', 'SBER', 100, 290, 29000, 'RUB', 0]],
  delivery_sell: [['SELL', 'SBER', 100, 291, 29100, 'RUB', 0]],
  option_expiration: [], future_expiration: [], unspecified: [], canceled: [], broker_fee: [], 'fee-card': [],
  dividend_tax: [], bond_tax: [], dividend_tax_progressive: [], bond_tax_progressive: [],
  input_securities: [['TRANSFER_IN', 'AAPL', 3, 0, 0, 'RUB', 0]],
  output_securities: [['TRANSFER_OUT', 'SBER', 7, 0, 0, 'RUB', 0]],
  'bsbs-out': [['TRANSFER_OUT', 'SBER', 10, 0, 0, 'RUB', 0]],
  'bsbs-in': [['TRANSFER_IN', 'SBER', 10, 0, 0, 'RUB', 0]],
  iisbs: [['TRANSFER_OUT', 'SBER', 2, 0, 0, 'RUB', 0]],                     // с ИИС на брокерский: на ИИС — расход
};
const allIds = new Set();
for (const f of fs.readdirSync(path.join(FIX, 'tinvest')).filter((x) => x.startsWith('operations-'))) {
  for (const it of J(f).items) allIds.add(it.id);
}
eq('ожидание записано для каждой операции образца', [...allIds].filter((id) => !(id in TV_EXPECT)), []);
for (const [id, want] of Object.entries(TV_EXPECT)) eq(`Т-Инвестиции: ${id}`, byId(id), want);
eq('счета по названиям', [...new Set(tv.ops.map((o) => o.account))].sort(), [BS, IIS].sort());
eq('дата по Москве и время', [tv.ops.find((x) => x.src.id === 'input').date, tv.ops.find((x) => x.src.id === 'input').time], ['2024-03-01', '2024-03-01 10:00:00']);
eq('облигация: НКД отдельно, ISIN', [tv.ops.find((o) => o.src.id === 'buy-bond').nkd, tv.ops.find((o) => o.src.id === 'buy-bond').isin], [250, 'RU000A0ZZZZ1']);
eq('маржинальные сделки помечены', tv.ops.filter((o) => o.margin).map((o) => o.src.id).sort(), ['buy_margin', 'margin_fee', 'sell_margin']);
eq('вариационная маржа — срочный рынок', tv.ops.filter((o) => o.event === 'VARMARGIN').every((o) => o.market === 'срочный рынок'), true);
eq('бумага не с Мосбиржи помечена', tv.ops.filter((o) => o.foreign).map((o) => o.src.id).sort(), ['div-usd', 'input_securities']);
eq('переводы денег между своими счетами помечены', tv.ops.filter((o) => o.transfer).map((o) => o.src.id).sort(), ['inp-multi', 'out_multi']);
eq('нераспознано: только UNSPECIFIED', tv.unknown.map((u) => [u.text, u.hint]), [['OPERATION_TYPE_UNSPECIFIED: OPERATION_TYPE_UNSPECIFIED', 'engine/sources/tinvest.mjs → OPERATION_TYPES']]);
eq('пропущено и почему', tv.skipped, {
  'неисполненные / отменённые': 1, 'сделки с фьючерсами и опционами (срочный рынок: результат — в вариационной марже)': 1,
  'размещение биржевого овернайта (деньги остаются на счёте)': 1,
  'экспирация опциона (срочный рынок: результат — в вариационной марже)': 1, 'экспирация фьючерса (срочный рынок: результат — в вариационной марже)': 1,
});
let tokenErr = '';
try { await readTinvest({ token: 'wrong' }, { fetch: fakeFetch }); } catch (e) { tokenErr = e.message; }
eq('неверный токен — понятная ошибка, сам токен не печатается', [/токен неверный/.test(tokenErr), tokenErr.includes('wrong')], [true, false]);
let noToken = '';
const envTok = process.env.TINVEST_TOKEN; delete process.env.TINVEST_TOKEN;
try { await readTinvest({}, { fetch: fakeFetch }); } catch (e) { noToken = e.message; }
if (envTok) process.env.TINVEST_TOKEN = envTok;
eq('нет токена — подсказка про settings.json и TINVEST_TOKEN', /TINVEST_TOKEN/.test(noToken), true);
process.env.TINVEST_TOKEN = 't.test-readonly';
const tvEnv = await readTinvest({ account: 'Т' }, { fetch: fakeFetch });
if (envTok) process.env.TINVEST_TOKEN = envTok; else delete process.env.TINVEST_TOKEN;
eq('токен из переменной окружения TINVEST_TOKEN', tvEnv.ops.length, tv.ops.length);
// переводы на своих счетах: пара BS→ИИС убирается; вывод в другой депозитарий и приход без пары — продажа / покупка
const tvMoves = resolveMoves(tv.ops);
eq('Т-Инвестиции: переводы между своими счетами', tvMoves.stats, { internal: 1, splits: 0, conversions: 0, inUnpaired: 1, outUnpaired: 2, writeOff: 0 });

// ---------------------------------------------------------------------------------------------
section('БКС (.xlsx): собранный здесь отчёт с разделами');
const E = '';
const bcsHead = [E, 'Дата', 'Номер', 'Время', 'Куплено, шт', 'Цена', 'Сумма платежа', 'Продано, шт', 'Цена', 'Сумма выручки', 'Валюта цены',
  'Валюта платежа', 'Дата соверш.', 'Время соверш.', 'Тип сделки', 'Дата расчетов', 'Комиссия Банка за расчет по сделке',
  'Комиссия Банка за заключение сделки', 'Комиссия ТС', 'НКД'];
const cashHead = [E, 'Дата', 'Операция', E, E, E, 'Сумма зачисления', 'Сумма списания', E, E, E, E, E, E, 'Примечание'];
const cashRow = (d, op, cr, db, note = '') => [E, d, op, E, E, E, cr, db, E, E, E, E, E, E, note];
const mvRow = (code, d, inQ, outQ, rest, note) => [E, code, E, E, d, E, E, inQ, outQ, rest, E, E, note];
const bcsBook = writeXlsx([
  { name: 'Брокерский', rows: [
    [E, 'Отчет брокера за период с 01.03.2024 по 31.03.2024'],
    [E, 'Субсчет: Брокерский'],
    [E, '1. Движение денежных средств'],
    [E, 'Рубль'],
    cashHead,
    cashRow('01.03.2024', 'Приход ДС', 100000, ''),
    cashRow('05.03.2024', 'Дивиденды', 870, '', 'Дивиденды по RU0009029540, налог 130,00'),
    cashRow('06.03.2024', 'Погашение купона', 348, '', 'купон RU000A0ZZZZ1 налог 52,00'),
    cashRow('07.03.2024', 'Частичное погашение облигации', 2500, '', 'RU000A0ZZZZ1'),
    cashRow('08.03.2024', 'Вознаграждение компании', '', 50),
    cashRow('09.03.2024', 'НДФЛ', '', 260),
    cashRow('10.03.2024', 'Возврат НДФЛ', 40, ''),
    cashRow('11.03.2024', 'Вывод ДС', '', 5000),
    cashRow('12.03.2024', 'Перевод ДС', '', 1000, 'на ИИС'),
    cashRow('13.03.2024', 'Вариационная маржа', 300, ''),
    cashRow('13.03.2024', 'Вариационная маржа', '', 100),
    cashRow('14.03.2024', 'Расчеты по сделке', '', 28000),
    cashRow('15.03.2024', 'Погашение облигации', 7500, '', 'RU000A0ZZZZ2'),
    cashRow('16.03.2024', 'Оферта', 980, '', 'RU000A0ZZZZ5'),
    cashRow('17.03.2024', 'Странная операция', 1, ''),
    cashRow('17.03.2024', 'Проценты на остаток', 15, ''),
    [E, 'Итого по валюте Рубль:', E, E, E, E, 100000, 30000],
    [E, 'USD'],
    cashRow('20.03.2024', 'Дивиденды', 9, '', 'US0378331005 налог 1,00'),
    [E, '2.1. Сделки:'],
    bcsHead,
    [E, 'Сбербанк ао', 'SBER', 'ISIN: RU0009029540'],
    [E, '14.03.2024', '1', '10:00', 100, 280, 28000, E, E, E, 'RUB', 'RUB', '14.03.2024', '10:00', 'Биржевая', '15.03.2024', 10, 4, 2, E],
    [E, '18.03.2024', '2', '11:00', E, E, E, 50, 300, 15000, 'RUB', 'RUB', '18.03.2024', '11:00', 'Биржевая', '19.03.2024', 5, 2, 1, E],
    [E, '19.03.2024', '5', '11:30', E, E, E, 10, 305, 3050, 'RUB', 'RUB', '19.03.2024', '11:30', 'Маржинальная', '20.03.2024', E, E, E, E],
    [E, 'Итого по SBER:'],
    [E, 'Облигация выдуманная', 'RU000A0ZZZZ1'],
    [E, { date: '2024-03-14' }, '3', '12:00', 10, 99.5, 9950, E, E, E, 'RUB', 'RUB', '14.03.2024', '12:00', 'Биржевая', '15.03.2024', 3, 1, 1, 120],
    [E, '2.3. Заключенные в отчетном периоде сделки с иностранной валютой'],
    [E, 'Дата', 'Номер', 'Время', 'Куплено', 'Курс', 'Сумма в рублях', 'Продано', 'Курс', 'Сумма в рублях', 'Комиссия'],
    [E, 'CNYRUB_TOM'],
    [E, '21.03.2024', '4', '10:00', 1000, 12.5, 12500, E, E, E, 6.25],
    [E, '3. Активы:'],
    [E, 'SBER', E, E, E, E, E, 280, E, E, E, 300],
    [E, '4. Движение ценных бумаг'],
    [E, 'Наименование', E, E, 'Дата', E, E, 'Приход', 'Расход', 'Остаток', E, E, 'Примечание'],
    mvRow('SBER', '15.03.2024', 100, E, 100, 'Сделка'),
    mvRow('SBER', '19.03.2024', E, 50, 50, 'Сделка'),
    mvRow('GAZP2', '22.03.2024', 200, E, 200, 'Перевод из другого депозитария'),
    mvRow('MOEX', '25.03.2024', E, 30, 0, 'Списание (делистинг)'),
    mvRow('LKOH', '26.03.2024', E, 10, 0, 'Дробление'),
    mvRow('LKOH', '26.03.2024', 100, E, 100, 'Дробление'),
    mvRow('OLDX', '27.03.2024', E, 5, 0, 'Конвертация'),
    mvRow('NEWX', '27.03.2024', 10, E, 10, 'Конвертация'),
    mvRow('RU000A0ZZZZ2', '15.03.2024', E, 10, 0, 'Погашение'),
    mvRow('RU000A0ZZZZ5', '16.03.2024', E, 1, 0, 'Выкуп по оферте'),
    mvRow('VTBR', '28.03.2024', 5, E, 5, 'Непонятное основание'),
  ] },
  { name: 'ИИС', rows: [
    [E, 'Субсчет: ИИС'],
    [E, '1. Движение денежных средств'],
    cashHead,
    cashRow('12.03.2024', 'Перевод ДС', 1000, '', 'с брокерского'),
  ] },
]);
const bcsFile = path.join(TMP, 'bcs-report.xlsx');
fs.writeFileSync(bcsFile, bcsBook);
const bcs = readBcs(bcsFile, { account: 'БКС' });
const bOps = (pred) => bcs.ops.filter(pred).map((o) => [o.date, ...brief(o)]);
const BB = 'БКС — Брокерский';
eq('БКС: два субсчёта в одном файле', [...new Set(bcs.ops.map((o) => o.account))].sort(), [BB, 'БКС — ИИС'].sort());
eq('БКС: сделки с бумагами (цена облигации = сумма ÷ количество, комиссии сложены)', bOps((o) => o.event === 'BUY' || o.event === 'SELL'), [
  ['2024-03-14', 'BUY', 'SBER', 100, 280, 28000, 'RUB', 16],
  ['2024-03-18', 'SELL', 'SBER', 50, 300, 15000, 'RUB', 8],
  ['2024-03-19', 'SELL', 'SBER', 10, 305, 3050, 'RUB', 0],
  ['2024-03-14', 'BUY', 'RU000A0ZZZZ1', 10, 995, 9950, 'RUB', 5],
  ['2024-03-16', 'SELL', 'RU000A0ZZZZ5', 1, 980, 980, 'RUB', 0],
]);
eq('БКС: маржинальная сделка помечена', bcs.ops.filter((x) => x.margin).map((x) => [x.date, x.event]), [['2024-03-19', 'SELL']]);
eq('БКС: НКД облигации', bcs.ops.find((o) => o.symbol === 'RU000A0ZZZZ1' && o.event === 'BUY').nkd, 120);
eq('БКС: сделка с валютой + комиссия', bOps((o) => o.event.startsWith('FX_') || (o.event === 'FEE' && /валюта/.test(o.note))), [
  ['2024-03-21', 'FX_BUY', 'CNY', 1000, 12.5, 12500, 'RUB', 0], ['2024-03-21', 'FEE', 'RUB', 6.25, 1, 6.25, 'RUB', 6.25]]);
eq('БКС: деньги', bOps((o) => !['BUY', 'SELL', 'FX_BUY', 'TRANSFER_IN', 'TRANSFER_OUT', 'CONVERT_IN', 'CONVERT_OUT', 'WRITE_OFF'].includes(o.event) && !/валюта/.test(o.note)), [
  ['2024-03-01', 'CASH_IN', 'RUB', 100000, 1, 100000, 'RUB', 0],
  ['2024-03-05', 'DIVIDEND', 'SBER', 1000, 0, 1000, 'RUB', 130],          // ISIN → тикер из строки бумаги в сделках
  ['2024-03-06', 'DIVIDEND', 'RU000A0ZZZZ1', 400, 0, 400, 'RUB', 52],
  ['2024-03-07', 'AMORTIZATION', 'RU000A0ZZZZ1', 0, 0, 2500, 'RUB', 0],
  ['2024-03-08', 'FEE', 'RUB', 50, 1, 50, 'RUB', 50],
  ['2024-03-09', 'TAX', 'RUB', 260, 1, 260, 'RUB', 260],
  ['2024-03-10', 'TAX_RETURN', 'RUB', 40, 1, 40, 'RUB', 0],
  ['2024-03-11', 'CASH_OUT', 'RUB', 5000, 1, 5000, 'RUB', 0],
  ['2024-03-12', 'CASH_OUT', 'RUB', 1000, 1, 1000, 'RUB', 0],
  ['2024-03-13', 'VARMARGIN', 'RUB', 300, 1, 300, 'RUB', 0],
  ['2024-03-13', 'VARMARGIN', 'RUB', -100, 1, -100, 'RUB', 0],
  ['2024-03-15', 'REPAYMENT', 'RU000A0ZZZZ2', 10, 750, 7500, 'RUB', 0],   // количество — из движения бумаг
  ['2024-03-17', 'CASH_GAIN', 'RUB', 15, 1, 15, 'RUB', 0],
  ['2024-03-20', 'DIVIDEND', 'US0378331005', 10, 0, 10, 'USD', 1],
  ['2024-03-12', 'CASH_IN', 'RUB', 1000, 1, 1000, 'RUB', 0],
]);
eq('БКС: перевод денег между субсчетами помечен', bcs.ops.filter((o) => o.transfer).map((o) => [o.account, o.event]), [[BB, 'CASH_OUT'], ['БКС — ИИС', 'CASH_IN']]);
eq('БКС: движение бумаг без сделки (сделки не задвоены)', bOps((o) => /TRANSFER|CONVERT|WRITE_OFF/.test(o.event)), [
  ['2024-03-22', 'TRANSFER_IN', 'GAZP', 200, 0, 0, 'RUB', 0],             // внутренний код БКС GAZP2 → GAZP
  ['2024-03-25', 'WRITE_OFF', 'MOEX', 30, 0, 0, 'RUB', 0],
  ['2024-03-26', 'TRANSFER_OUT', 'LKOH', 10, 0, 0, 'RUB', 0],
  ['2024-03-26', 'TRANSFER_IN', 'LKOH', 100, 0, 0, 'RUB', 0],
  ['2024-03-27', 'CONVERT_OUT', 'OLDX', 5, 0, 0, 'RUB', 0],
  ['2024-03-27', 'CONVERT_IN', 'NEWX', 10, 0, 0, 'RUB', 0],
]);
eq('БКС: нераспознанное — с подсказкой, где править, без сумм', bcs.unknown.map((u) => [u.text, u.hint]), [
  ['движение бумаг: Непонятное основание (VTBR)', 'engine/sources/bcs.mjs → MOVE_RULES'],
  ['Странная операция', 'engine/sources/bcs.mjs → CASH_RULES'],
]);
eq('БКС: расчёты по сделкам и итоги пропущены осознанно', bcs.skipped, { 'расчёты по сделкам (сделки — из раздела сделок)': 1 });
let xlsMsg = '';
const xlsFile = path.join(TMP, 'старый.xls');
fs.writeFileSync(xlsFile, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
try { readBcs(xlsFile, {}); } catch (e) { xlsMsg = e.message; }
eq('БКС: старый .xls — «пересохраните в .xlsx»', /пересохран|сохраните как «Книга Excel \(\.xlsx\)»/.test(xlsMsg), true);
// без раздела сделок — как в старом проекте: приход/расход бумаг по цене закрытия месяца
const bcsOld = path.join(TMP, 'bcs-no-deals.xlsx');
fs.writeFileSync(bcsOld, writeXlsx([{ name: 'Отчет', rows: [
  [E, 'Отчет брокера за период с 01.03.2024 по 31.03.2024'],
  [E, '3. Активы:'], [E, 'SBER', E, E, E, E, E, 280, E, E, E, 300],
  [E, '4. Движение ценных бумаг'], mvRow('SBER', '15.03.2024', 100, E, 100, ''),
] }]));
const bcs2 = readBcs(bcsOld, { account: 'БКС' });
eq('БКС без раздела сделок: покупка по цене закрытия месяца + предупреждение', [bcs2.ops.map(brief), bcs2.warnings.length],
  [[['BUY', 'SBER', 100, 300, 30000, 'RUB', 0]], 1]);

// ---------------------------------------------------------------------------------------------
section('Сбербанк (HTML): tests/fixtures/sber-report.html');
const sber = readSber(path.join(FIX, 'sber-report.html'), { account: 'Сбер' });
eq('Сбер: пометка «проверено только на образце»', [sber.info.note === SBER_NOTE, /только на образце/.test(SBER_NOTE)], [true, true]);
eq('Сбер: операции', sber.ops.map((o) => [o.date, ...brief(o)]), [
  ['2024-03-02', 'BUY', 'SBER', 100, 280, 28000, 'RUB', 11.2],
  ['2024-03-03', 'BUY', 'RU000A0ZZZZ3', 5, 1012, 5060, 'RUB', 2.03],     // цена 101,2 % → сумма ÷ количество
  ['2024-03-18', 'SELL', 'SBER', 30, 300, 9000, 'RUB', 3.6],
  ['2024-03-19', 'SELL', 'GAZP', 10, 160, 1600, 'RUB', 0.64],
  ['2024-03-21', 'FX_BUY', 'CNY', 500, 12.4, 6200, 'RUB', 0],
  ['2024-03-21', 'FEE', 'RUB', 3.1, 1, 3.1, 'RUB', 3.1],
  ['2024-03-22', 'TRANSFER_IN', 'RU000A0DQZE3', 50, 0, 0, 'RUB', 0],
  ['2024-03-24', 'CONVERT_OUT', 'RU000A0ZZZZ6', 4, 0, 0, 'RUB', 0],
  ['2024-03-24', 'CONVERT_IN', 'RU000A0ZZZZ7', 2, 0, 0, 'RUB', 0],
  ['2024-03-25', 'TRANSFER_OUT', 'SBER', 70, 0, 0, 'RUB', 0],          // дробление: списали 70, зачислили 700 (→ SPLIT в merge.mjs)
  ['2024-03-25', 'TRANSFER_IN', 'SBER', 700, 0, 0, 'RUB', 0],
  ['2024-03-26', 'WRITE_OFF', 'RU000A0ZZZZ8', 3, 0, 0, 'RUB', 0],
  ['2024-03-01', 'CASH_IN', 'RUB', 100000, 1, 100000, 'RUB', 0],
  ['2024-03-05', 'DIVIDEND', 'SBER', 1000, 0, 1000, 'RUB', 130],          // НДФЛ отдельной строкой присоединён к выплате
  ['2024-03-06', 'DIVIDEND', 'RU000A0ZZZZ3', 339, 0, 339, 'RUB', 39],     // налог из текста описания
  ['2024-03-07', 'AMORTIZATION', 'RU000A0ZZZZ3', 0, 0, 1000, 'RUB', 0],
  ['2024-03-08', 'REPAYMENT', 'RU000A0ZZZZ4', 5, 1000, 5000, 'RUB', 0],
  ['2024-03-09', 'FEE', 'RUB', 150, 1, 150, 'RUB', 150],
  ['2024-03-10', 'CASH_OUT', 'RUB', 2000, 1, 2000, 'RUB', 0],
  ['2024-03-11', 'CASH_OUT', 'RUB', 500, 1, 500, 'RUB', 0],
  ['2024-03-12', 'TAX_RETURN', 'RUB', 20, 1, 20, 'RUB', 0],
  ['2024-03-13', 'VARMARGIN', 'RUB', 100, 1, 100, 'RUB', 0],
  ['2024-03-16', 'DIVIDEND', 'AAPL', 10, 0, 10, 'USD', 1],
  ['2024-03-17', 'SELL', 'RU000A0ZZZZ3', 2, 1010, 2020, 'RUB', 0],       // оферта: количество — из движения бумаг
  ['2024-03-18', 'TAX', 'RUB', 65, 1, 65, 'RUB', 65],                   // НДФЛ при продаже — отдельной строкой
  ['2024-03-19', 'CASH_GAIN', 'RUB', 12, 1, 12, 'RUB', 0],
  ['2024-03-01', 'CASH_IN', 'RUB', 400000, 1, 400000, 'RUB', 0],        // ИИС
]);
eq('Сбер: ИИС отдельным счётом', [...new Set(sber.ops.map((x) => x.account))], ['Сбер', 'Сбер — ИИС']);
eq('Сбер: оферта помечена', sber.ops.find((x) => x.date === '2024-03-17').note, 'оферта');
eq('Сбер: маржинальная сделка помечена', sber.ops.filter((o) => o.margin).map((o) => o.symbol), ['GAZP']);
eq('Сбер: нераспознанное', sber.unknown.map((u) => [u.where, u.text, u.hint]), [['«Движение денежных средств за период», строка 13, 2024-03-15', 'Непонятная операция #', 'engine/sources/sber.mjs → CASH_RULES']]);
eq('Сбер: отменённая сделка и таблицы без операций пропущены', Object.keys(sber.skipped).length, 6);

// ---------------------------------------------------------------------------------------------
section('«Интеллектуальный инвестор» (.xlsx, лист «Сделки»)');
const iiHead = ['Тикер', 'Название', 'Операция', 'Дата', 'Кол-во', 'Цена', 'Номинал', 'НКД', 'Комиссия', 'Сумма', 'Сумма без комиссии', 'Валюта', 'Заметка'];
const ii = (t, n, op, d, q, p, face, nkd, fee, sum, nc, cur = 'RUB', note = '') => [t, n, op, d, q, p, face, nkd, fee, sum, nc, cur, note];
const iiFile = path.join(TMP, 'complex_portfolio_report_1.xlsx');
fs.writeFileSync(iiFile, writeXlsx([{ name: 'Сводка', rows: [['пусто']] }, { name: 'Сделки', rows: [
  iiHead,
  ii('Деньги (RUB)', '', 'Внесение', '01.03.2024', '', '', '', '', '', 100000, 100000),
  ii('SBER', 'Сбербанк', 'Покупка', '02.03.2024', 100, 280, '', '', 11.2, -28011.2, -28000),
  ii('RU000A0ZZZZ1', 'Облигация', 'Покупка', '03.03.2024', 10, 99.5, 1000, 120, 5, -10075, -10070),
  ii('SBER', 'Сбербанк', 'Продажа', '04.03.2024', 30, 300, '', '', 3.6, 8996.4, 9000),
  ii('SBER', 'Сбербанк', 'Дивиденд', '05.03.2024', '', '', '', '', '', 870, 870),
  ii('RU000A0ZZZZ1', 'Облигация', 'Купон', '06.03.2024', '', '', '', '', '', 348, 348),
  ii('RU000A0ZZZZ1', 'Облигация', 'Амортизация', '07.03.2024', 10, '', '', '', '', 2500, 2500),
  ii('RU000A0ZZZZ1', 'Облигация', 'Погашение', '08.03.2024', 10, '', '', '', '', 7500, 7500),
  ii('GAZP', 'Газпром', 'Корректировка', '09.03.2024', 50, 160, '', '', '', 8000, 8000),
  ii('LKOH', 'Лукойл', 'Корректировка', '10.03.2024', 5, 7000, '', '', '', -35000, -35000),
  ii('USD', 'Доллар', 'Покупка', '11.03.2024', 100, 90, '', '', 4.5, -9004.5, -9000),
  ii('Деньги (RUB)', '', 'Списание', '12.03.2024', '', '', '', '', '', -5000, -5000),
  ii('Деньги (RUB)', '', 'Расход', '13.03.2024', '', '', '', '', '', -199, -199),
  ii('Деньги (RUB)', '', 'Корректировка', '14.03.2024', '', '', '', '', '', -260, -260),
  ii('Деньги (RUB)', '', 'Доход', '15.03.2024', '', '', '', '', '', 15, 15),
  ii('Деньги (USD)', '', 'Внесение', '16.03.2024', '', '', '', '', '', 50, 50, 'USD'),
  ii('PLZL', 'Полюс', 'Сплит', '17.03.2024', 10, '', '', '', '', 0, 0),
  ii('OLDY', 'Старая', 'Конвертация', '19.03.2024', 4, 50, '', '', '', -200, -200),
  ii('NEWY', 'Новая', 'Конвертация', '19.03.2024', 2, 100, '', '', '', 200, 200),
  ii('RU000A0ZZZZ1', 'Облигация', 'Оферта', '20.03.2024', 2, '', '', '', '', 2000, 2000),
  ii('Деньги (RUB)', '', 'Вариационная маржа', '21.03.2024', '', '', '', '', '', -75, -75),
  ii('Деньги (RUB)', '', 'Возврат налога', '22.03.2024', '', '', '', '', '', 40, 40),
  ii('DELZ', 'Делист', 'Делистинг', '23.03.2024', 3, '', '', '', '', 0, 0),
  ii('SBER', 'Сбербанк', 'Что-то новое', '18.03.2024', 1, 1, '', '', '', 1, 1),
] }]));
const intel = readIntelinvest(iiFile, { account: 'ИИ' });
eq('Интеллектуальный инвестор: операции', intel.ops.map((o) => [o.date, ...brief(o)]), [
  ['2024-03-01', 'CASH_IN', 'RUB', 100000, 1, 100000, 'RUB', 0],
  ['2024-03-02', 'BUY', 'SBER', 100, 280, 28000, 'RUB', 11.2],
  ['2024-03-03', 'BUY', 'RU000A0ZZZZ1', 10, 995, 9950, 'RUB', 5],         // цена 99,5 % × номинал 1000
  ['2024-03-04', 'SELL', 'SBER', 30, 300, 9000, 'RUB', 3.6],
  ['2024-03-05', 'DIVIDEND', 'SBER', 870, 0, 870, 'RUB', 0],
  ['2024-03-06', 'DIVIDEND', 'RU000A0ZZZZ1', 348, 0, 348, 'RUB', 0],
  ['2024-03-07', 'AMORTIZATION', 'RU000A0ZZZZ1', 10, 0, 2500, 'RUB', 0],
  ['2024-03-08', 'REPAYMENT', 'RU000A0ZZZZ1', 10, 750, 7500, 'RUB', 0],
  ['2024-03-09', 'TRANSFER_IN', 'GAZP', 50, 160, 8000, 'RUB', 0],          // «Корректировка» + : бумаги пришли по своей цене
  ['2024-03-10', 'TRANSFER_OUT', 'LKOH', 5, 7000, 35000, 'RUB', 0],        // «Корректировка» − : ушли
  ['2024-03-11', 'FX_BUY', 'USD', 100, 90, 9000, 'RUB', 0],
  ['2024-03-11', 'FEE', 'RUB', 4.5, 1, 4.5, 'RUB', 4.5],
  ['2024-03-12', 'CASH_OUT', 'RUB', 5000, 1, 5000, 'RUB', 0],
  ['2024-03-13', 'FEE', 'RUB', 199, 1, 199, 'RUB', 199],
  ['2024-03-14', 'TAX', 'RUB', 260, 1, 260, 'RUB', 260],
  ['2024-03-15', 'CASH_GAIN', 'RUB', 15, 1, 15, 'RUB', 0],
  ['2024-03-16', 'CASH_IN', 'USD', 50, 1, 50, 'USD', 0],
  ['2024-03-17', 'SPLIT', 'PLZL', 0, 10, 0, 'RUB', 0],
  ['2024-03-19', 'CONVERT_OUT', 'OLDY', 4, 50, 200, 'RUB', 0],
  ['2024-03-19', 'CONVERT_IN', 'NEWY', 2, 100, 200, 'RUB', 0],
  ['2024-03-20', 'SELL', 'RU000A0ZZZZ1', 2, 1000, 2000, 'RUB', 0],
  ['2024-03-21', 'VARMARGIN', 'RUB', -75, 1, -75, 'RUB', 0],
  ['2024-03-22', 'TAX_RETURN', 'RUB', 40, 1, 40, 'RUB', 0],
  ['2024-03-23', 'WRITE_OFF', 'DELZ', 3, 0, 0, 'RUB', 0],
]);
eq('Интеллектуальный инвестор: нераспознанное', intel.unknown.map((u) => [u.text, u.hint]), [['Что-то новое SBER', 'engine/sources/intelinvest.mjs → SECURITY_OPS / MONEY_OPS']]);

// ---------------------------------------------------------------------------------------------
section('шаблон операций (CSV)');
const sampleCsv = readCsvTemplate(path.join(SKILL, 'sample', 'шаблон-операций.csv'), { account: 'Счёт' });
eq('sample/шаблон-операций.csv: строки-образцы с # не считаются', [sampleCsv.ops.length, sampleCsv.unknown.length, sampleCsv.warnings.length], [0, 0, 0]);
// те же образцы без # — все типы разбираются
const allTypes = path.join(TMP, 'шаблон-все.csv');
fs.writeFileSync(allTypes, fs.readFileSync(path.join(SKILL, 'sample', 'шаблон-операций.csv'), 'utf8').replace(/^#/gm, ''));
const csvSample = readCsvTemplate(allTypes, {});
eq('образцы шаблона без # — все распознаны', [csvSample.ops.length > 10, csvSample.unknown], [true, []]);
const csv = readCsvTemplate(path.join(FIX, 'шаблон-все-типы.csv'), { account: 'Ручной' });
eq('CSV: каждый тип', csv.ops.map((o) => [o.date, ...brief(o), o.account]), [
  ['2024-01-15', 'CASH_IN', 'RUB', 100000, 1, 100000, 'RUB', 0, 'Брокерский'],
  ['2024-01-16', 'BUY', 'SBER', 100, 270.5, 27050, 'RUB', 13.53, 'Брокерский'],
  ['2024-01-16', 'BUY', 'RU000A1038V6', 10, 987, 9870, 'RUB', 4.94, 'Брокерский'],
  ['2024-02-01', 'SELL', 'SBER', 10, 280, 2800, 'RUB', 1.4, 'Брокерский'],
  ['2024-02-01', 'TAX', 'RUB', 120, 1, 120, 'RUB', 120, 'Брокерский'],
  ['2024-02-02', 'SELL', 'GAZP', 5, 150, 750, 'RUB', 0, 'Брокерский'],
  ['2024-02-03', 'SELL', 'RU000A1038V6', 2, 1000, 2000, 'RUB', 0, 'Брокерский'],
  ['2024-02-04', 'DIVIDEND', 'SBER', 3369, 0, 3369, 'RUB', 438, 'Брокерский'],
  ['2024-02-05', 'DIVIDEND', 'RU000A1038V6', 387.9, 0, 387.9, 'RUB', 50, 'Брокерский'],
  ['2024-02-06', 'DIVIDEND', 'AAPL', 24, 0, 24, 'USD', 2.4, 'Брокерский'],
  ['2024-02-07', 'AMORTIZATION', 'RU000A1038V6', 8, 0, 2000, 'RUB', 0, 'Брокерский'],
  ['2024-02-08', 'REPAYMENT', 'RU000A1038V6', 8, 750, 6000, 'RUB', 0, 'Брокерский'],
  ['2024-02-09', 'FEE', 'RUB', 199, 1, 199, 'RUB', 199, 'Брокерский'],
  ['2024-02-10', 'TAX', 'RUB', 260, 1, 260, 'RUB', 260, 'Брокерский'],
  ['2024-02-11', 'TAX_RETURN', 'RUB', 40, 1, 40, 'RUB', 0, 'Брокерский'],
  ['2024-02-12', 'CASH_OUT', 'RUB', 5000, 1, 5000, 'RUB', 0, 'Брокерский'],
  ['2024-02-13', 'CASH_OUT', 'RUB', 1000, 1, 1000, 'RUB', 0, 'Брокерский'],
  ['2024-02-13', 'CASH_IN', 'RUB', 1000, 1, 1000, 'RUB', 0, 'ИИС'],
  ['2024-02-14', 'TRANSFER_OUT', 'LKOH', 3, 0, 0, 'RUB', 0, 'Брокерский'],
  ['2024-02-14', 'TRANSFER_IN', 'LKOH', 3, 0, 0, 'RUB', 0, 'ИИС'],
  ['2024-02-15', 'CONVERT_OUT', 'OLDX', 4, 0, 0, 'RUB', 0, 'Брокерский'],
  ['2024-02-15', 'CONVERT_IN', 'NEWX', 2, 0, 0, 'RUB', 0, 'Брокерский'],
  ['2024-02-16', 'WRITE_OFF', 'DELX', 7, 0, 0, 'RUB', 0, 'Брокерский'],
  ['2024-02-17', 'SPLIT', 'PLZL', 0, 10, 0, 'RUB', 0, 'Брокерский'],
  ['2024-02-18', 'FX_BUY', 'CNY', 1000, 12.8, 12800, 'RUB', 0, 'Брокерский'],
  ['2024-02-18', 'FEE', 'RUB', 6.4, 1, 6.4, 'RUB', 6.4, 'Брокерский'],
  ['2024-02-19', 'FX_SELL', 'USD', 10, 92, 920, 'RUB', 0, 'Брокерский'],
  ['2024-02-20', 'VARMARGIN', 'RUB', -150, 1, -150, 'RUB', 0, 'Брокерский'],
  ['2024-02-21', 'CASH_GAIN', 'RUB', 33, 1, 33, 'RUB', 0, 'Ручной'],
]);
eq('CSV: шорт и перевод денег помечены', [csv.ops.filter((o) => o.margin).map((o) => o.symbol), csv.ops.filter((o) => o.transfer).length], [['GAZP'], 2]);
eq('CSV: ISIN записан как ISIN', csv.ops.find((o) => o.symbol === 'RU000A1038V6').isin, 'RU000A1038V6');
eq('CSV: нераспознанное — строка и подсказка', csv.unknown.map((u) => [u.where, u.text]), [['строка 31, 2024-02-22', 'Опцион колл']]);
eq('CSV: не число — предупреждение', csv.warnings.length, 1);

// ---------------------------------------------------------------------------------------------
section('объединение источников: дубли и переводы (engine/merge.mjs)');
const o = (src, account, date, event, symbol, qty, price = 0, extra = {}) => ({ date, time: `${date} 12:00:00`, account, symbol, exchange: '', event, qty, price,
  amount: extra.amount ?? qty * price, currency: 'RUB', fee: extra.fee ?? 0, nkd: 0, netRecorded: false, noCash: false, note: '', src: { source: src }, ...extra });
const A = [o('a', 'Счёт', '2024-01-10', 'BUY', 'SBER', 10, 250), o('a', 'Счёт', '2024-01-10', 'BUY', 'SBER', 10, 250),
  o('a', 'Счёт', '2024-01-20', 'DIVIDEND', 'SBER', 100, 0, { amount: 100, fee: 13 })];
const B = [o('b', 'Счёт', '2024-01-10', 'BUY', 'SBER', 10, 250), o('b', 'Счёт', '2024-01-10', 'BUY', 'SBER', 10, 250),
  o('b', 'Счёт', '2024-01-10', 'BUY', 'SBER', 10, 250), o('b', 'Счёт', '2024-01-20', 'DIVIDEND', 'SBER', 100, 0, { amount: 100, fee: 13 }),
  o('b', 'Другой', '2024-01-10', 'BUY', 'SBER', 10, 250), o('b', 'Счёт', '2024-01-11', 'BUY', 'SBER', 10, 250)];
const dd = dedupe([{ id: 'a', ops: A }, { id: 'b', ops: B }]);
// у «a» две одинаковые покупки (настоящие) — обе остаются; «b» прислал три такие же — две из них дубли, третья новая
eq('дубли: две из трёх покупок и выплата из второго источника', dd.dropped, { a: 0, b: 3 });
eq('дубли: остались', dd.ops.length, 6);
const moves = resolveMoves([
  o('x', 'Брокерский', '2024-01-01', 'BUY', 'SBER', 10, 200, { fee: 10 }),
  o('x', 'Брокерский', '2024-02-01', 'TRANSFER_OUT', 'SBER', 10),
  o('x', 'ИИС', '2024-02-03', 'TRANSFER_IN', 'SBER', 10),
  o('x', 'ИИС', '2024-03-01', 'TRANSFER_OUT', 'SBER', 10),
  o('x', 'ИИС', '2024-03-01', 'TRANSFER_IN', 'SBER', 100),
  o('x', 'ИИС', '2024-04-01', 'BUY', 'OLDX', 4, 50),
  o('x', 'ИИС', '2024-04-10', 'CONVERT_IN', 'NEWX', 2),
  o('x', 'ИИС', '2024-04-10', 'CONVERT_OUT', 'OLDX', 4),
  o('x', 'ИИС', '2024-05-01', 'TRANSFER_IN', 'GAZP', 5, 150),
  o('x', 'ИИС', '2024-05-02', 'TRANSFER_OUT', 'SBER', 20),
  o('x', 'ИИС', '2024-05-03', 'BUY', 'DELX', 3, 10),
  o('x', 'ИИС', '2024-05-04', 'WRITE_OFF', 'DELX', 3),
]);
eq('переводы: события после разбора', moves.ops.map((x) => [x.date, x.event, x.symbol, x.qty, Math.round(x.price * 100) / 100]), [
  ['2024-01-01', 'BUY', 'SBER', 10, 200],
  ['2024-03-01', 'SPLIT', 'SBER', 0, 10],                 // на одном счёте 10 → 100 в один день — дробление
  ['2024-04-01', 'BUY', 'OLDX', 4, 50],
  ['2024-04-10', 'BUY', 'NEWX', 2, 100],                  // конвертация: себестоимость 200 перешла на 2 новые бумаги
  ['2024-04-10', 'SELL', 'OLDX', 4, 50],                  // старая — продана по себестоимости, прибыли нет
  ['2024-05-01', 'BUY', 'GAZP', 5, 150],                  // пришли без пары — по цене из отчёта
  ['2024-05-02', 'SELL', 'SBER', 20, 20.1],               // ушли без пары — по средней (2 010 ÷ 100 бумаг после дробления)
  ['2024-05-03', 'BUY', 'DELX', 3, 10],
  ['2024-05-04', 'SELL', 'DELX', 3, 0],                   // делистинг — по нулю
]);
eq('переводы: счётчики', moves.stats, { internal: 1, splits: 1, conversions: 1, inUnpaired: 1, outUnpaired: 1, writeOff: 1 });
// расчёт после разбора: перевод между счетами не продажа, дробление учтено, конвертация без прибыли
const px = (m) => ({ days: Object.fromEntries(Object.entries(m).map(([d, p]) => [d, [p, 0, null, null]])) });
const rm = compute({ ops: moves.ops.filter((x) => x.symbol === 'SBER').slice(0, 2), asOf: '2024-03-02', rates: {},
  prices: { SBER: px({ '2024-01-01': 200, '2024-03-01': 21 }) }, meta: {}, indexes: {} });
eq('расчёт: 10 SBER → дробление ×10 → 100 шт., себестоимость 2 010', [rm.positions[0].qty, rm.positions[0].cost], [100, 2010]);

// амортизация и сделки с валютой в расчёте (model.mjs)
section('расчёт: амортизация, валюта, вариационная маржа');
const ra = compute({
  ops: [o('x', 'С', '2024-01-01', 'BUY', 'BND', 10, 1000), o('x', 'С', '2024-06-01', 'AMORTIZATION', 'BND', 10, 0, { amount: 2500 }),
    o('x', 'С', '2024-06-02', 'FX_BUY', 'CNY', 100, 12.5), o('x', 'С', '2024-06-03', 'VARMARGIN', 'RUB', -50, 1, { amount: -50 })],
  asOf: '2024-06-03', rates: {}, prices: { BND: px({ '2024-01-01': 1000, '2024-06-01': 750 }) }, meta: {}, indexes: {},
});
// себестоимость 10 000 − 2 500 = 7 500; бумаг по-прежнему 10; продажи (возврат номинала) 2 500
eq('амортизация: количество, себестоимость, итоги', [ra.positions[0].qty, ra.positions[0].cost, ra.totals.sells, ra.totals.buys], [10, 7500, 2500, 10000]);
eq('амортизация: в притоках индекса −2 500', ra.flows['2024-06-01'], -2500);
eq('валюта и вар. маржа — в ленте с суммой в рублях', ra.operations.slice(0, 2).map((x) => [x.event, x.amountRub]), [['VARMARGIN', -50], ['FX_BUY', 1250]]);

// ---------------------------------------------------------------------------------------------
section('сборка целиком без сети: несколько источников, отчёт');
const WD = path.join(TMP, 'портфель');
fs.mkdirSync(path.join(WD, 'reports'), { recursive: true });
fs.copyFileSync(path.join(FIX, 'sber-report.html'), path.join(WD, 'reports', 'sber.html'));
fs.mkdirSync(path.join(WD, 'reports', 'bcs'));
fs.copyFileSync(bcsFile, path.join(WD, 'reports', 'bcs', '2024-03.xlsx')); // источник — папка с месячными отчётами
// тот же отчёт Сбера во второй раз — все операции дубли
fs.copyFileSync(path.join(FIX, 'sber-report.html'), path.join(WD, 'reports', 'sber-копия.html'));
fs.writeFileSync(path.join(WD, 'settings.json'), JSON.stringify({
  title: 'Проверка', asOf: '2024-03-31', cash: [], watchlist: [],
  sources: [
    { type: 'sber', file: 'reports/sber.html', account: 'Сбер' },
    { type: 'bcs', file: 'reports/bcs', account: 'БКС' },
    { type: 'sber', file: 'reports/sber-копия.html', account: 'Сбер' },
    { type: 'csv', file: 'reports/нет-такого.csv', account: 'Ручной' },
  ],
}));
const { report } = await build({ workdir: WD, offline: true, quiet: true });
eq('отчёт: операции по источникам и дубли', report.sources.map((s) => [s.type, s.operations, s.duplicates, s.unknown]),
  [['sber', sber.ops.length, 0, 1], ['bcs', bcs.ops.length, 0, 2], ['sber', sber.ops.length, sber.ops.length, 1]]);
eq('отчёт: всего дублей', report.duplicates, sber.ops.length);
eq('отчёт: источник-папка — файлов', report.sources[1].files, 1);
eq('отчёт: у Сбера пометка про образец', [report.sources[0].note === SBER_NOTE, report.warnings.includes(SBER_NOTE)], [true, true]);
eq('отчёт: нераспознанное со ссылкой на код', report.unknown.map((u) => u.hint).sort(), [
  'engine/sources/bcs.mjs → CASH_RULES', 'engine/sources/bcs.mjs → MOVE_RULES', 'engine/sources/sber.mjs → CASH_RULES', 'engine/sources/sber.mjs → CASH_RULES']);
eq('отчёт: в подсказках нет сумм', report.unknown.every((u) => !/\d{2,}/.test(u.text.replace(/[A-Z]{2}[A-Z0-9]{9}\d/g, ''))), true);
eq('отчёт: непрочитанный источник не роняет сборку', [report.sourceErrors?.length, /нет файла/.test(report.sourceErrors?.[0]?.error || '')], [1, true]);
eq('отчёт: переводы и корпоративные действия', report.moves, { internal: 0, splits: 2, conversions: 2, inUnpaired: 2, outUnpaired: 0, writeOff: 2 });
eq('отчёт: события амортизации и валюты есть', [report.events.AMORTIZATION, report.events.FX_BUY], [2, 2]);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`${failed ? 'FAIL' : 'OK  '} sources.test: проверок ${passed + failed}, не прошло ${failed}`);
process.exit(failed ? 1 : 0);
