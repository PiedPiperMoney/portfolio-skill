// Т-Инвестиции через официальный REST API (T-Invest API, контракт tinkoff.public.invest.api.contract.v1).
// Нужен токен ТОЛЬКО НА ЧТЕНИЕ (readonly): settings.json → sources[].token или переменная окружения TINVEST_TOKEN.
// Методы (POST, JSON, заголовок Authorization: Bearer <токен>):
//   UsersService/GetAccounts                  — счета (брокерский, ИИС, инвесткопилка…);
//   OperationsService/GetOperationsByCursor   — операции счёта по страницам (cursor / nextCursor / hasNext);
//   InstrumentsService/GetInstrumentBy        — бумага по UID / FIGI: тикер, ISIN, валюта, площадка;
//   InstrumentsService/BondBy                 — облигация: номинал.
// Поля ответа — camelCase, int64 — строкой, деньги — { currency, units, nano } (сверено с openapi.yaml и .proto
// репозитория RussianInvestments/investAPI, 17.10.2026). Перевод типов операций — таблица OPERATION_TYPES:
// все 63 значения OperationType из документации; новый тип — одна строка.
import { makeOp, cashOp, collector, accountLabel } from '../lib/common.mjs';

export const API_BASES = ['https://invest-public-api.tbank.ru/rest', 'https://invest-public-api.tinkoff.ru/rest'];
const PKG = 'tinkoff.public.invest.api.contract.v1';
const HINT = 'engine/sources/tinvest.mjs → OPERATION_TYPES';

// OperationType → что делать. event — событие общего формата; kind:
//   trade — сделка (quantity × price, комиссия из поля commission или из BROKER_FEE с parentOperationId);
//   pay — выплата по бумаге (налог DIVIDEND_TAX / BOND_TAX присоединяется в fee); cash — деньги без бумаги;
//   payTax — налог по выплате (присоединяется к выплате той же бумаги и даты, иначе отдельный TAX);
//   fee — комиссия (присоединяется к сделке-родителю, иначе отдельный FEE);
//   signTax — корректировка налога: + возврат (TAX_RETURN), − удержание (TAX);
//   move — бумаги без денег (переводы); skip — известная операция, в расчёт не идёт (why — почему).
// Флаги: margin — маржинальная сделка; market — срочный рынок; transfer — деньги между своими счетами.
export const OPERATION_TYPES = {
  OPERATION_TYPE_UNSPECIFIED: { kind: 'unknown' },
  OPERATION_TYPE_INPUT: { kind: 'cash', event: 'CASH_IN' },                     // пополнение брокерского счёта
  OPERATION_TYPE_BOND_TAX: { kind: 'payTax' },                                  // НДФЛ по купонам
  OPERATION_TYPE_OUTPUT_SECURITIES: { kind: 'move', event: 'TRANSFER_OUT' },    // вывод ЦБ
  OPERATION_TYPE_OVERNIGHT: { kind: 'cash', event: 'CASH_GAIN', note: 'доход по РЕПО овернайт' },
  OPERATION_TYPE_TAX: { kind: 'cash', event: 'TAX' },                           // удержание налога (в т. ч. НДФЛ при продаже)
  OPERATION_TYPE_BOND_REPAYMENT_FULL: { kind: 'repay', event: 'REPAYMENT' },    // полное погашение облигаций
  OPERATION_TYPE_SELL_CARD: { kind: 'trade', event: 'SELL', note: 'продажа с карты' },
  OPERATION_TYPE_DIVIDEND_TAX: { kind: 'payTax' },                              // налог по дивидендам
  OPERATION_TYPE_OUTPUT: { kind: 'cash', event: 'CASH_OUT' },                   // вывод денег
  OPERATION_TYPE_BOND_REPAYMENT: { kind: 'pay', event: 'AMORTIZATION' },        // частичное погашение (амортизация)
  OPERATION_TYPE_TAX_CORRECTION: { kind: 'signTax' },                           // корректировка налога
  OPERATION_TYPE_SERVICE_FEE: { kind: 'fee', note: 'обслуживание счёта' },
  OPERATION_TYPE_BENEFIT_TAX: { kind: 'cash', event: 'TAX', note: 'налог за материальную выгоду' },
  OPERATION_TYPE_MARGIN_FEE: { kind: 'fee', note: 'комиссия за непокрытую позицию', margin: true },
  OPERATION_TYPE_BUY: { kind: 'trade', event: 'BUY' },
  OPERATION_TYPE_BUY_CARD: { kind: 'trade', event: 'BUY', note: 'покупка с карты' },
  OPERATION_TYPE_INPUT_SECURITIES: { kind: 'move', event: 'TRANSFER_IN' },      // перевод бумаг из другого депозитария
  OPERATION_TYPE_SELL_MARGIN: { kind: 'trade', event: 'SELL', margin: true, note: 'продажа по margin-call' },
  OPERATION_TYPE_BROKER_FEE: { kind: 'fee', note: 'комиссия за операцию' },
  OPERATION_TYPE_BUY_MARGIN: { kind: 'trade', event: 'BUY', margin: true, note: 'покупка по margin-call' },
  OPERATION_TYPE_DIVIDEND: { kind: 'pay', event: 'DIVIDEND' },
  OPERATION_TYPE_SELL: { kind: 'trade', event: 'SELL' },
  OPERATION_TYPE_COUPON: { kind: 'pay', event: 'DIVIDEND', note: 'купон' },
  OPERATION_TYPE_SUCCESS_FEE: { kind: 'fee', note: 'комиссия SuccessFee' },
  // «Передача дивидендного дохода» — по документации без подробностей: + — выплата, − — удержание
  OPERATION_TYPE_DIVIDEND_TRANSFER: { kind: 'signPay', note: 'передача дивидендного дохода' },
  OPERATION_TYPE_ACCRUING_VARMARGIN: { kind: 'cash', event: 'VARMARGIN', market: 'срочный рынок' },
  OPERATION_TYPE_WRITING_OFF_VARMARGIN: { kind: 'cash', event: 'VARMARGIN', market: 'срочный рынок' },
  OPERATION_TYPE_DELIVERY_BUY: { kind: 'trade', event: 'BUY', note: 'покупка при экспирации фьючерса' },
  OPERATION_TYPE_DELIVERY_SELL: { kind: 'trade', event: 'SELL', note: 'продажа при экспирации фьючерса' },
  OPERATION_TYPE_TRACK_MFEE: { kind: 'fee', note: 'автоследование: за управление' },
  OPERATION_TYPE_TRACK_PFEE: { kind: 'fee', note: 'автоследование: за результат' },
  OPERATION_TYPE_TAX_PROGRESSIVE: { kind: 'cash', event: 'TAX', note: 'налог 15 %' },
  OPERATION_TYPE_BOND_TAX_PROGRESSIVE: { kind: 'payTax' },
  OPERATION_TYPE_DIVIDEND_TAX_PROGRESSIVE: { kind: 'payTax' },
  OPERATION_TYPE_BENEFIT_TAX_PROGRESSIVE: { kind: 'cash', event: 'TAX', note: 'налог за материальную выгоду 15 %' },
  OPERATION_TYPE_TAX_CORRECTION_PROGRESSIVE: { kind: 'signTax' },
  OPERATION_TYPE_TAX_REPO_PROGRESSIVE: { kind: 'cash', event: 'TAX', note: 'налог по РЕПО' },
  OPERATION_TYPE_TAX_REPO: { kind: 'cash', event: 'TAX', note: 'налог по РЕПО' },
  OPERATION_TYPE_TAX_REPO_HOLD: { kind: 'cash', event: 'TAX', note: 'налог по РЕПО' },
  OPERATION_TYPE_TAX_REPO_REFUND: { kind: 'cash', event: 'TAX_RETURN', note: 'возврат налога по РЕПО' },
  OPERATION_TYPE_TAX_REPO_HOLD_PROGRESSIVE: { kind: 'cash', event: 'TAX', note: 'налог по РЕПО' },
  OPERATION_TYPE_TAX_REPO_REFUND_PROGRESSIVE: { kind: 'cash', event: 'TAX_RETURN', note: 'возврат налога по РЕПО' },
  OPERATION_TYPE_DIV_EXT: { kind: 'pay', event: 'DIVIDEND', note: 'дивиденды на карту' },
  OPERATION_TYPE_TAX_CORRECTION_COUPON: { kind: 'signTax' },
  OPERATION_TYPE_CASH_FEE: { kind: 'fee', note: 'комиссия за валютный остаток' },
  OPERATION_TYPE_OUT_FEE: { kind: 'fee', note: 'комиссия за вывод валюты' },
  OPERATION_TYPE_OUT_STAMP_DUTY: { kind: 'fee', note: 'гербовый сбор' },
  OPERATION_TYPE_OUTPUT_SWIFT: { kind: 'cash', event: 'CASH_OUT', note: 'SWIFT' },
  OPERATION_TYPE_INPUT_SWIFT: { kind: 'cash', event: 'CASH_IN', note: 'SWIFT' },
  OPERATION_TYPE_OUTPUT_ACQUIRING: { kind: 'cash', event: 'CASH_OUT', note: 'на карту' },
  OPERATION_TYPE_INPUT_ACQUIRING: { kind: 'cash', event: 'CASH_IN', note: 'с карты' },
  OPERATION_TYPE_OUTPUT_PENALTY: { kind: 'fee', note: 'комиссия за вывод' },
  OPERATION_TYPE_ADVICE_FEE: { kind: 'fee', note: 'сервис советов' },
  // переводы бумаг между своими счетами: направление — по знаку количества, если его нет — по типу счёта
  OPERATION_TYPE_TRANS_IIS_BS: { kind: 'move', event: 'TRANSFER', note: 'с ИИС на брокерский' },
  OPERATION_TYPE_TRANS_BS_BS: { kind: 'move', event: 'TRANSFER', note: 'между брокерскими счетами' },
  OPERATION_TYPE_OUT_MULTI: { kind: 'cash', event: 'CASH_OUT', transfer: true, note: 'перевод на другой счёт' },
  OPERATION_TYPE_INP_MULTI: { kind: 'cash', event: 'CASH_IN', transfer: true, note: 'перевод с другого счёта' },
  OPERATION_TYPE_OVER_PLACEMENT: { kind: 'skip', why: 'размещение биржевого овернайта (деньги остаются на счёте)' },
  OPERATION_TYPE_OVER_COM: { kind: 'fee', note: 'овернайт' },
  OPERATION_TYPE_OVER_INCOME: { kind: 'cash', event: 'CASH_GAIN', note: 'доход от овернайта' },
  OPERATION_TYPE_OPTION_EXPIRATION: { kind: 'skip', why: 'экспирация опциона (срочный рынок: результат — в вариационной марже)' },
  OPERATION_TYPE_FUTURE_EXPIRATION: { kind: 'skip', why: 'экспирация фьючерса (срочный рынок: результат — в вариационной марже)' },
};

// Деньги API: { currency, units: '123', nano: 450000000 } → 123.45
export const money = (m) => (m ? Number(m.units || 0) + Number(m.nano || 0) / 1e9 : 0);
const qtyOf = (it) => Math.abs(Number(it.quantityDone) || Number(it.quantity) || 0);
const cur = (m, fallback = 'RUB') => (m?.currency ? m.currency.toUpperCase() : fallback);
// дата операции — по московскому времени (UTC+3)
const msk = (iso) => new Date(Date.parse(iso) + 3 * 3600e3).toISOString();

// Клиент API: f — fetch (в проверках подменяется), token — не печатается никогда
export function tinvestClient({ token, fetch: f = globalThis.fetch, bases = API_BASES }) {
  if (!token) throw new Error('Т-Инвестиции: нет токена — sources[].token в settings.json или переменная окружения TINVEST_TOKEN');
  let base = null;
  return async function call(service, method, body) {
    const tries = base ? [base] : bases;
    let lastErr;
    for (const b of tries) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await f(`${b}/${PKG}.${service}/${method}`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(body || {}),
          });
          const text = await res.text();
          if (!res.ok) {
            let msg = text.slice(0, 200);
            try { const j = JSON.parse(text); msg = `${j.code ?? ''} ${j.message ?? ''}`.trim(); } catch { /* не JSON */ }
            const e = new Error(`Т-Инвестиции ${service}/${method}: HTTP ${res.status} ${msg}`);
            e.status = res.status;
            if (res.status === 401 || res.status === 403) e.message += ' — токен неверный, просрочен или без доступа к счёту';
            throw e;
          }
          base = b;
          return JSON.parse(text);
        } catch (e) {
          lastErr = e;
          if (e.status && e.status !== 429 && e.status < 500) throw e;
          if (attempt < 2) await new Promise((r) => setTimeout(r, e.status === 429 ? 3000 : 500));
        }
      }
    }
    throw lastErr;
  };
}

// Все операции счёта по страницам
export async function fetchOperations(call, accountId, { from = '2000-01-01T00:00:00Z', to = new Date().toISOString() } = {}) {
  const items = [];
  let cursor = '';
  for (let page = 0; page < 10000; page++) {
    const r = await call('OperationsService', 'GetOperationsByCursor', {
      accountId, from, to, limit: 1000, state: 'OPERATION_STATE_EXECUTED', withoutCommissions: false, withoutTrades: true,
      withoutOvernights: false, ...(cursor ? { cursor } : {}),
    });
    items.push(...(r.items || []));
    if (!r.hasNext || !r.nextCursor) break;
    cursor = r.nextCursor;
  }
  return items;
}

// Разбор: accounts — ответ GetAccounts().accounts, opsByAccount — { id: [OperationItem] }, inst — { uid|figi: Instrument (+nominal) }
export function convertTinvest({ accounts, opsByAccount, inst = {}, src = {} }) {
  const out = collector('tinvest', 'Т-Инвестиции (API)');
  const multi = accounts.length > 1;
  const accName = Object.fromEntries(accounts.map((a) => [a.id, accountLabel(src, src.accounts?.[a.id] ? a.id : a.name || a.id, multi) || 'Т-Инвестиции']));
  out.info.accounts = accounts.map((a) => ({ name: accName[a.id], type: a.type, status: a.status }));
  const all = [];
  for (const a of accounts) for (const it of opsByAccount[a.id] || []) all.push({ it, a });
  const pays = new Map(), trades = new Map();

  const secOf = (it) => {
    const i = inst[it.instrumentUid] || inst[it.figi] || {};
    const ticker = it.ticker || i.ticker || '';
    const type = (it.instrumentType || i.instrumentType || '').toLowerCase();
    const foreign = i.realExchange ? i.realExchange !== 'REAL_EXCHANGE_MOEX' : false;
    return { ticker, isin: i.isin || '', type, foreign, name: i.name || it.name || '', nominal: i.nominal ? money(i.nominal) : 0,
      figi: it.figi || i.figi || '' };
  };
  const base = (it, a) => {
    const t = msk(it.date);
    return { date: t.slice(0, 10), time: `${t.slice(0, 10)} ${t.slice(11, 19)}`, account: accName[a.id],
      src: { type: 'tinvest', where: `${accName[a.id]}, ${it.id}`, id: it.id } };
  };

  // 1-й проход: сделки и выплаты (к ним присоединяются комиссии и налоги)
  for (const { it, a } of all) {
    if (it.state && it.state !== 'OPERATION_STATE_EXECUTED') { out.skip('неисполненные / отменённые'); continue; }
    const rule = OPERATION_TYPES[it.type];
    if (!rule || rule.kind === 'unknown') {
      out.unknownRow(`${accName[a.id]}, ${it.date?.slice(0, 10)}`, `${it.type || 'без типа'}: ${it.name || it.description || ''}`, HINT);
      continue;
    }
    const s = secOf(it);
    const pay = money(it.payment), qty = qtyOf(it);
    const c = cur(it.payment, cur(it.price));
    const common = { ...base(it, a), note: rule.note || '', ...(rule.margin ? { margin: true } : {}), ...(rule.market ? { market: rule.market } : {}) };
    const sym = { symbol: s.ticker || s.isin || s.figi, ...(s.isin ? { isin: s.isin } : {}), ...(s.figi ? { figi: s.figi } : {}),
      ...(s.foreign ? { foreign: true } : {}), ...(s.name ? { name: s.name } : {}) };
    if (rule.kind === 'trade') {
      if (s.type === 'futures' || s.type === 'option') { out.skip('сделки с фьючерсами и опционами (срочный рынок: результат — в вариационной марже)'); continue; }
      const nkd = Math.abs(money(it.accruedInt));
      const listed = Math.abs(money(it.price));
      const fromPay = qty ? Math.max(0, Math.abs(pay) - nkd) / qty : 0;
      // цена — из поля price, если она сходится с суммой; иначе — сумма без НКД ÷ количество
      const price = listed && (!fromPay || Math.abs(listed - fromPay) <= 0.02 * fromPay) ? listed : fromPay || listed;
      const fee = Math.abs(money(it.commission));
      if (s.type === 'currency') {
        const code = (s.ticker.match(/^([A-Z]{3})(RUB|_)/) || [])[1] || (s.name.match(/USD|EUR|CNY|HKD|GBP|CHF|KZT|TRY|AED|JPY/) || [])[0] || s.ticker;
        const op = out.add(makeOp({ ...common, event: rule.event === 'BUY' ? 'FX_BUY' : 'FX_SELL', symbol: code, qty, price, currency: c }));
        trades.set(it.id, { op, fx: true });
        if (fee) out.add(cashOp({ ...common, event: 'FEE', amount: fee, currency: cur(it.commission, c), note: `комиссия: валюта ${code}` }));
        continue;
      }
      const op = out.add(makeOp({ ...common, ...sym, event: rule.event, qty, price, currency: c, fee, nkd }));
      trades.set(it.id, { op, feeFromItem: fee > 0 });
    } else if (rule.kind === 'pay' || (rule.kind === 'signPay' && pay > 0)) {
      const ev = rule.event || 'DIVIDEND';
      const op = out.add(makeOp({ ...common, ...sym, event: ev, qty: ev === 'DIVIDEND' ? Math.abs(pay) : qty, amount: Math.abs(pay), currency: c }));
      if (ev === 'DIVIDEND') pays.set(it.id, op);
    } else if (rule.kind === 'repay') {
      const q = qty || 1;
      out.add(makeOp({ ...common, ...sym, event: 'REPAYMENT', qty: q, price: Math.abs(pay) / q || s.nominal, currency: c }));
    }
  }
  // 2-й проход: налоги, комиссии, деньги, переводы
  for (const { it, a } of all) {
    if (it.state && it.state !== 'OPERATION_STATE_EXECUTED') continue;
    const rule = OPERATION_TYPES[it.type];
    if (!rule || ['unknown', 'trade', 'pay', 'repay'].includes(rule.kind) || (rule.kind === 'signPay' && money(it.payment) > 0)) continue;
    const s = secOf(it);
    const pay = money(it.payment), c = cur(it.payment);
    const common = { ...base(it, a), note: rule.note || '', ...(rule.margin ? { margin: true } : {}), ...(rule.market ? { market: rule.market } : {}) };
    const symbol = s.ticker || s.isin || '';
    if (rule.kind === 'skip') { out.skip(rule.why); continue; }
    if (rule.kind === 'payTax' || rule.kind === 'signPay') {
      if (pay > 0) { out.add(cashOp({ ...common, event: 'TAX_RETURN', amount: pay, currency: c, note: 'возврат налога' })); continue; }
      // к выплате: по parentOperationId, иначе та же бумага, счёт и дата
      const parent = pays.get(it.parentOperationId)
        || [...pays.values()].find((p) => p.account === common.account && p.date === common.date && p.symbol === symbol && !p._tax);
      if (parent) { parent.fee += Math.abs(pay); parent._tax = true; continue; }
      out.add(cashOp({ ...common, event: 'TAX', amount: pay, currency: c, ...(symbol ? { symbol } : {}), note: common.note || 'налог по выплате' }));
      continue;
    }
    if (rule.kind === 'signTax') {
      out.add(cashOp({ ...common, event: pay > 0 ? 'TAX_RETURN' : 'TAX', amount: pay, currency: c, note: common.note || 'корректировка налога' }));
      continue;
    }
    if (rule.kind === 'fee') {
      const t = trades.get(it.parentOperationId);
      if (t && !t.fx) {
        if (!t.feeFromItem) t.op.fee += Math.abs(pay); // комиссия уже в поле commission сделки — второй раз не берём
        continue;
      }
      out.add(cashOp({ ...common, event: 'FEE', amount: pay, currency: c }));
      continue;
    }
    if (rule.kind === 'cash') {
      out.add(cashOp({ ...common, event: rule.event, amount: rule.event === 'VARMARGIN' ? pay : Math.abs(pay), currency: c, ...(rule.transfer ? { transfer: true } : {}) }));
      continue;
    }
    if (rule.kind === 'move') {
      const qty = qtyOf(it);
      const sym = { symbol: symbol || s.figi, ...(s.isin ? { isin: s.isin } : {}), ...(s.foreign ? { foreign: true } : {}) };
      let ev = rule.event;
      if (ev === 'TRANSFER') {
        const q = Number(it.quantity || 0);
        if (q < 0 || pay < 0) ev = 'TRANSFER_OUT';
        else if (it.type === 'OPERATION_TYPE_TRANS_IIS_BS') ev = a.type === 'ACCOUNT_TYPE_TINKOFF_IIS' ? 'TRANSFER_OUT' : 'TRANSFER_IN';
        else ev = /списан|вывод|out/i.test(`${it.name || ''} ${it.description || ''}`) ? 'TRANSFER_OUT' : 'TRANSFER_IN';
      }
      out.add(makeOp({ ...common, ...sym, event: ev, qty, price: Math.abs(money(it.price)), currency: cur(it.price, c) }));
    }
  }
  for (const p of pays.values()) delete p._tax;
  return out;
}

// Полное чтение: счета → операции → справочник инструментов (кэш — в объекте cache, его хранит build.mjs)
export async function readTinvest(src = {}, { fetch: f, cache = {}, log = () => {} } = {}) {
  const token = src.token || process.env.TINVEST_TOKEN || '';
  const call = tinvestClient({ token, fetch: f });
  const acc = await call('UsersService', 'GetAccounts', { status: 'ACCOUNT_STATUS_ALL' });
  let accounts = (acc.accounts || []).filter((a) => a.status !== 'ACCOUNT_STATUS_NEW');
  if (Array.isArray(src.accountIds) && src.accountIds.length) accounts = accounts.filter((a) => src.accountIds.includes(a.id));
  if (!accounts.length) throw new Error('Т-Инвестиции: нет счетов (или токен выпущен на другой счёт)');
  const opsByAccount = {};
  for (const a of accounts) {
    log(`  Т-Инвестиции: операции счёта «${a.name || a.type}»`);
    opsByAccount[a.id] = await fetchOperations(call, a.id, { from: src.from || '2000-01-01T00:00:00Z' });
  }
  const inst = { ...cache };
  const need = new Set();
  for (const list of Object.values(opsByAccount)) for (const it of list) if (it.instrumentUid && !inst[it.instrumentUid]) need.add(it.instrumentUid);
  for (const uid of need) {
    try {
      const r = await call('InstrumentsService', 'GetInstrumentBy', { idType: 'INSTRUMENT_ID_TYPE_UID', id: uid });
      const i = r.instrument || {};
      const rec = { ticker: i.ticker, isin: i.isin, figi: i.figi, currency: i.currency, name: i.name, instrumentType: i.instrumentType,
        classCode: i.classCode, realExchange: i.realExchange, exchange: i.exchange };
      if (i.instrumentType === 'bond') {
        try {
          const b = await call('InstrumentsService', 'BondBy', { idType: 'INSTRUMENT_ID_TYPE_UID', id: uid });
          if (b.instrument?.nominal) rec.nominal = b.instrument.nominal;
        } catch { /* номинал не обязателен */ }
      }
      inst[uid] = rec;
    } catch (e) {
      if (e.status === 401 || e.status === 403) throw e;
      log(`  Т-Инвестиции: не нашёл инструмент ${uid}: ${e.message}`);
    }
  }
  const out = convertTinvest({ accounts, opsByAccount, inst, src });
  out.cache = inst;
  return out;
}
