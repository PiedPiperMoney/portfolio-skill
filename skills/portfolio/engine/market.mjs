// Рыночные данные: Мосбиржа ISS (цены бумаг с НКД и номиналом, индексы, купоны), ЦБ (курсы валют).
// Всё складывается в кэш <папка>/.cache/. Кэш годен, если скачан после окончания нужного дня (fetchedAt > till);
// иначе докачиваем только недостающий хвост. Обрывы сети — до 6 попыток с паузой.
import fs from 'node:fs';
import path from 'node:path';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const ISS = 'https://iss.moex.com/iss';

// коды валют ЦБ (XML_dynamic)
export const CBR_CODES = {
  USD: 'R01235', EUR: 'R01239', CNY: 'R01375', GBP: 'R01035', HKD: 'R01200', CHF: 'R01775', JPY: 'R01820',
  KZT: 'R01335', TRY: 'R01700', AED: 'R01230', BYN: 'R01090', INR: 'R01270',
};

// режимы торгов, с которых берём историю цен (после основного)
const MAIN_BOARDS = ['TQBR', 'TQCB', 'TQOB', 'TQTF', 'EQBR', 'TQDE', 'TQIF'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const todayIso = () => new Date().toISOString().slice(0, 10);

export class HttpError extends Error {
  constructor(status, url) { super(`HTTP ${status}: ${url}`); this.status = status; }
}

export function createMarket({ cacheDir, log = () => {}, offline = false }) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const failed = []; // что не удалось скачать: {what, error}

  async function fetchText(url, { retries = 6, timeoutMs = 60000, encoding = 'utf-8' } = {}) {
    if (offline) throw new Error(`нет сети (offline): ${url}`);
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) {
          const err = new HttpError(res.status, url);
          // 4xx (кроме 429) повторять бесполезно
          if (res.status < 500 && res.status !== 429) { err.final = true; }
          throw err;
        }
        const buf = await res.arrayBuffer();
        return new TextDecoder(encoding).decode(buf);
      } catch (err) {
        if (err.final || attempt >= retries - 1) throw err;
        log(`  повтор ${attempt + 1}: ${url} (${err.message})`);
        await sleep(3000 * (attempt + 1));
      }
    }
  }
  const fetchJson = async (url) => JSON.parse(await fetchText(url));

  function readCache(name) {
    const p = path.join(cacheDir, name);
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
  }
  function writeCache(name, data) {
    fs.writeFileSync(path.join(cacheDir, name), JSON.stringify(data));
  }
  // кэш годен для дня till, если скачан позже этого дня
  const fresh = (c, till) => c && c.till >= till && c.fetchedAt > till;

  // постраничная история ISS (страница — 100 строк)
  async function issPaged(url, block = 'history') {
    const rows = [];
    let cols = null;
    for (let start = 0; ; ) {
      const js = (await fetchJson(`${url}&start=${start}`))[block];
      cols = js.columns;
      for (const r of js.data) rows.push(Object.fromEntries(cols.map((c, i) => [c, r[i]])));
      if (js.data.length < 100) break;
      start += js.data.length;
    }
    return rows;
  }

  // Описание бумаги и её режимы торгов
  async function secInfo(secid) {
    const name = `sec-info-${secid}.json`;
    const c = readCache(name);
    if (c && 'couponFrequency' in c) return c;
    const js = await fetchJson(`${ISS}/securities/${encodeURIComponent(secid)}.json?iss.meta=off&iss.only=description,boards`
      + '&description.columns=name,value&boards.columns=boardid,market,engine,is_primary,history_from,history_till');
    const desc = Object.fromEntries(js.description.data.map(([k, v]) => [k, v]));
    const boards = js.boards.data.map(([boardid, market, engine, isPrimary]) => ({ boardid, market, engine, isPrimary }));
    const info = {
      secid, found: boards.length > 0 || js.description.data.length > 0,
      shortname: desc.SHORTNAME || null, name: desc.NAME || null, isin: desc.ISIN || null,
      type: desc.TYPE || null, group: desc.GROUP || null, faceunit: desc.FACEUNIT || null,
      couponFrequency: desc.COUPONFREQUENCY ? Number(desc.COUPONFREQUENCY) : null, matDate: desc.MATDATE || null, boards,
    };
    writeCache(name, info);
    return info;
  }

  // Режимы, по которым собираем историю: основной, потом главные (первая найденная цена дня побеждает)
  function historyBoards(info) {
    const stock = info.boards.filter((b) => b.engine === 'stock' && (b.market === 'shares' || b.market === 'bonds'));
    const primary = stock.filter((b) => b.isPrimary === 1);
    const first = primary.length ? primary : stock.slice(0, 1);
    const main = stock.filter((b) => MAIN_BOARDS.includes(b.boardid) && !first.includes(b));
    return [...first, ...main];
  }

  async function loadSecDays(info, from, till) {
    const days = {};
    for (const b of historyBoards(info)) {
      const rows = await issPaged(`${ISS}/history/engines/stock/markets/${b.market}/boards/${b.boardid}/securities/`
        + `${encodeURIComponent(info.secid)}.json?from=${from}&till=${till}&iss.meta=off`
        + '&history.columns=TRADEDATE,CLOSE,LEGALCLOSEPRICE,ACCINT,FACEVALUE,FACEUNIT');
      for (const r of rows) {
        const px = r.CLOSE || r.LEGALCLOSEPRICE;
        if (px && !(r.TRADEDATE in days)) {
          days[r.TRADEDATE] = [px, r.ACCINT || 0, r.FACEVALUE ?? null, r.FACEUNIT ?? null];
        }
      }
    }
    return days;
  }

  // История цены бумаги: {market, board, days: {дата: [цена закрытия, НКД ₽, номинал, валюта номинала]}}
  // Цена облигации — в % от номинала, акции и фонда — в рублях.
  async function secHistory(secid, from, till) {
    const name = `sec-${secid}.json`;
    let c = readCache(name);
    if (c && c.from <= from && fresh(c, till)) return c;
    const info = await secInfo(secid);
    const boards = historyBoards(info);
    const base = { secid, market: boards[0]?.market || null, board: boards[0]?.boardid || null };
    if (c && c.from <= from && c.till >= from) {
      // докачиваем хвост: с последнего дня кэша (он мог быть неполным)
      const tail = await loadSecDays(info, c.till, till);
      const days = Object.fromEntries(Object.entries(c.days).filter(([d]) => d < c.till));
      Object.assign(days, tail);
      c = { ...base, from: c.from, till, fetchedAt: todayIso(), days };
    } else {
      c = { ...base, from, till, fetchedAt: todayIso(), days: await loadSecDays(info, from, till) };
    }
    writeCache(name, c);
    return c;
  }

  // История индекса: {дата: закрытие}
  async function indexHistory(code, from, till) {
    const name = `idx-${code}.json`;
    let c = readCache(name);
    if (c && c.from <= from && fresh(c, till)) return c.days;
    const load = async (f) => {
      const rows = await issPaged(`${ISS}/history/engines/stock/markets/index/securities/${code}.json`
        + `?from=${f}&till=${till}&iss.meta=off&history.columns=TRADEDATE,CLOSE`);
      return Object.fromEntries(rows.filter((r) => r.CLOSE).map((r) => [r.TRADEDATE, r.CLOSE]));
    };
    if (c && c.from <= from && c.till >= from) {
      const days = Object.fromEntries(Object.entries(c.days).filter(([d]) => d < c.till));
      Object.assign(days, await load(c.till));
      c = { from: c.from, till, fetchedAt: todayIso(), days };
    } else {
      c = { from, till, fetchedAt: todayIso(), days: await load(from) };
    }
    writeCache(name, c);
    return c.days;
  }

  // Последний торговый день с закрытием (по индексу MCFTR за две недели до сегодня)
  async function lastTradingDay() {
    const t = todayIso();
    const f = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
    const rows = await issPaged(`${ISS}/history/engines/stock/markets/index/securities/MCFTR.json`
      + `?from=${f}&till=${t}&iss.meta=off&history.columns=TRADEDATE,CLOSE`);
    const ok = rows.filter((r) => r.CLOSE).map((r) => r.TRADEDATE).sort();
    if (!ok.length) throw new Error('Мосбиржа не отдала закрытия MCFTR за две недели');
    return ok[ok.length - 1];
  }

  // Курсы ЦБ: {валюта: {дата: ₽ за 1 единицу}}; дата — день, с которого курс действует
  async function cbrRates(currencies, from, till) {
    const out = {};
    for (const cur of currencies) {
      const code = CBR_CODES[cur];
      if (!code) { failed.push({ what: `курс ${cur}`, error: 'нет кода валюты ЦБ' }); continue; }
      const name = `cbr-${cur}.json`;
      let c = readCache(name);
      if (!(c && c.from <= from && fresh(c, till))) {
        const dmy = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
        const xml = await fetchText(`https://www.cbr.ru/scripts/XML_dynamic.asp?date_req1=${dmy(from)}`
          + `&date_req2=${dmy(till)}&VAL_NM_RQ=${code}`, { encoding: 'windows-1251' });
        const rates = {};
        const re = /Date="(\d\d)\.(\d\d)\.(\d{4})"[\s\S]*?<Nominal>(\d+)<\/Nominal>[\s\S]*?<Value>([\d,]+)<\/Value>/g;
        for (const m of xml.matchAll(re)) rates[`${m[3]}-${m[2]}-${m[1]}`] = Number(m[5].replace(',', '.')) / Number(m[4]);
        if (!Object.keys(rates).length) throw new Error(`ЦБ не отдал курс ${cur}`);
        c = { from, till, fetchedAt: todayIso(), rates };
        writeCache(name, c);
      }
      out[cur] = c.rates;
    }
    return out;
  }

  // Купоны облигации (Мосбиржа): [{recordDate, payDate, amount, currency}]
  async function bondCoupons(secid, asOf) {
    const name = `coupons-${secid}.json`;
    let c = readCache(name);
    if (!(c && c.fetchedAt > asOf)) {
      const js = await fetchJson(`${ISS}/securities/${encodeURIComponent(secid)}/bondization.json?iss.meta=off&limit=unlimited`
        + '&iss.only=coupons&coupons.columns=coupondate,recorddate,value,faceunit');
      const list = js.coupons.data.filter((r) => r[2]).map(([coupondate, recorddate, value, faceunit]) => ({
        recordDate: recorddate || coupondate, payDate: coupondate, amount: value,
        currency: faceunit === 'SUR' ? 'RUB' : faceunit,
      }));
      c = { fetchedAt: todayIso(), coupons: list };
      writeCache(name, c);
    }
    return c.coupons;
  }


  // Тикер (код Мосбиржи) по ISIN: поиск ISS; торгуемая бумага фондового рынка в приоритете. Кэш — isin-map.json
  async function isinToSecid(isin) {
    const map = readCache('isin-map.json') || {};
    if (map[isin] !== undefined) return map[isin];
    const js = await fetchJson(`${ISS}/securities.json?q=${encodeURIComponent(isin)}&iss.meta=off`
      + '&securities.columns=secid,isin,is_traded,group,primary_boardid');
    const rows = js.securities.data.map(([secid, is, traded, group, board]) => ({ secid, isin: is, traded, group, board }))
      .filter((r) => r.isin === isin);
    const score = (r) => (r.traded ? 2 : 0) + (/^stock_/.test(r.group || '') ? 1 : 0);
    rows.sort((a, b) => score(b) - score(a));
    map[isin] = rows[0]?.secid || null;
    writeCache('isin-map.json', map);
    return map[isin];
  }

  // обёртка: ошибка скачивания не роняет сборку, а попадает в отчёт
  async function safe(what, fn, fallback) {
    try { return await fn(); } catch (err) {
      failed.push({ what, error: err.message });
      log(`  не скачано: ${what} — ${err.message}`);
      return fallback;
    }
  }

  return { secInfo, isinToSecid, secHistory, indexHistory, lastTradingDay, cbrRates, bondCoupons, safe, failed, readCache, writeCache };
}

