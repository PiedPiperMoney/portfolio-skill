#!/usr/bin/env node
// Сборка данных дашборда: node <навык>/engine/build.mjs --workdir <папка> [--offline] [--quiet]
// Читает <папка>/settings.json и источники операций, качает рыночные данные (кэш — <папка>/.cache/),
// пишет <папка>/dashboard-data.js (window.DATA = {...}) и <папка>/report.json (кратко: даты, операции, предупреждения).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSnowball } from './sources/snowball.mjs';
import { readTinvest } from './sources/tinvest.mjs';
import { readBcs } from './sources/bcs.mjs';
import { readSber, SBER_NOTE } from './sources/sber.mjs';
import { readIntelinvest } from './sources/intelinvest.mjs';
import { readCsvTemplate } from './sources/csv.mjs';
import { dedupe, resolveMoves } from './merge.mjs';
import { createMarket } from './market.mjs';
import { compute, holdingsOn, addDays, makeFx } from './model.mjs';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEXES = ['MCFTR', 'IMOEX', 'RGBITR', 'RUCBTRNS'];
const INDEX_NAMES = {
  MCFTR: 'Мосбиржа полной доходности', IMOEX: 'Индекс Мосбиржи (без дивидендов)',
  RGBITR: 'Гособлигации полной доходности', RUCBTRNS: 'Корпоративные облигации полной доходности',
};
// биржи, где у Мосбиржи нет цен: оцениваем по ценам собственных сделок
const FOREIGN_EXCHANGES = new Set(['NYSE', 'NASDAQ', 'AMEX', 'ARCA', 'BATS', 'LSE', 'HKEX', 'XETRA', 'OTC']);

// Отрасли эмитентов (перенесено из эталона и дополнено); чего нет — «Прочее»,
// облигации и фонды без записи — «Облигации» и «Фонды»
export const SECTOR = {
  LSNGP: 'Электроэнергетика', LSNG: 'Электроэнергетика', TGKA: 'Электроэнергетика', IRAO: 'Электроэнергетика',
  HYDR: 'Электроэнергетика', FEES: 'Электроэнергетика', MSNG: 'Электроэнергетика', UPRO: 'Электроэнергетика',
  MSRS: 'Электроэнергетика', MRKC: 'Электроэнергетика', MRKP: 'Электроэнергетика', ELFV: 'Электроэнергетика',
  ENPG: 'Металлы', ENPL: 'Металлы', ALRS: 'Металлы', GMKN: 'Металлы', RUAL: 'Металлы', POGR: 'Металлы',
  PLZL: 'Металлы', UGLD: 'Металлы', SELG: 'Металлы', CHMF: 'Металлы', NLMK: 'Металлы', MAGN: 'Металлы',
  MTLR: 'Металлы', MTLRP: 'Металлы', TRMK: 'Металлы', RASP: 'Металлы', VSMO: 'Металлы',
  SBER: 'Финансы', SBERP: 'Финансы', VTBR: 'Финансы', MOEX: 'Финансы', T: 'Финансы', TCSG: 'Финансы',
  BSPB: 'Финансы', CBOM: 'Финансы', SVCB: 'Финансы', RENI: 'Финансы', SFIN: 'Финансы', LEAS: 'Финансы', SPBE: 'Финансы',
  ROSN: 'Нефть и газ', LKOH: 'Нефть и газ', SNGSP: 'Нефть и газ', SNGS: 'Нефть и газ', NVTK: 'Нефть и газ',
  GAZP: 'Нефть и газ', TATN: 'Нефть и газ', TATNP: 'Нефть и газ', SIBN: 'Нефть и газ', BANE: 'Нефть и газ',
  BANEP: 'Нефть и газ',
  TRNFP: 'Транспорт', AFLT: 'Транспорт', FLOT: 'Транспорт', NMTP: 'Транспорт', FESH: 'Транспорт',
  AGRO: 'Потребительский', RAGR: 'Потребительский', MGNT: 'Потребительский', X5: 'Потребительский',
  LENT: 'Потребительский', BELU: 'Потребительский', SGZH: 'Потребительский', MVID: 'Потребительский',
  DIAS: 'ИТ', YDEX: 'ИТ', OZON: 'ИТ', HEAD: 'ИТ', POSI: 'ИТ', ASTR: 'ИТ', VKCO: 'ИТ', IVAT: 'ИТ', SOFL: 'ИТ',
  MTSS: 'Телеком', RTKM: 'Телеком', RTKMP: 'Телеком',
  PHOR: 'Химия', AKRN: 'Химия', NKNC: 'Химия', NKNCP: 'Химия',
  PIKK: 'Строительство', SMLT: 'Строительство', LSRG: 'Строительство', ETLN: 'Строительство',
  MDMG: 'Здравоохранение', GEMC: 'Здравоохранение',
  MO: 'Потребительский (США)', TMOS: 'Фонды', SBMM: 'Денежный рынок', LQDT: 'Денежный рынок', AKMM: 'Денежный рынок',
  TMON: 'Денежный рынок',
};

const DEFAULT_WATCHLIST = [
  { ticker: 'IMOEXF', name: 'Индекс Мосбиржи (вечный фьючерс)', engine: 'futures', market: 'forts', board: 'RFUD' },
  { ticker: 'CNYRUB_TOM', name: 'Юань', engine: 'currency', market: 'selt', board: 'CETS' },
  { ticker: 'USDRUBF', name: 'Доллар (вечный фьючерс)', engine: 'futures', market: 'forts', board: 'RFUD' },
];

function kindOf(info) {
  if (!info) return 'Акция';
  if (info.boards?.some((b) => b.engine === 'stock' && b.market === 'bonds') && !info.boards.some((b) => b.market === 'shares')) return 'Облигация';
  const t = `${info.type || ''} ${info.group || ''}`;
  if (/bond/.test(t)) return 'Облигация';
  if (/ppif|etf/.test(t)) return 'Фонд';
  return 'Акция';
}

function readSettings(workdir) {
  const p = path.join(workdir, 'settings.json');
  if (!fs.existsSync(p)) throw new Error(`нет ${p} — образец: ${path.join(SKILL_DIR, 'sample', 'settings.example.json')}`);
  const s = JSON.parse(fs.readFileSync(p, 'utf8'));
  return {
    sources: [], asOf: 'auto', cash: [], watchlist: DEFAULT_WATCHLIST, names: {}, sectors: {}, title: 'Мой портфель',
    forecast: 'history12m', forecastTax: 0.15, snowballRef: null, ...s,
  };
}

// Источники операций: тип → чтение. Файловые — синхронно, Т-Инвестиции — по сети (async).
// Каждый возвращает { ops, warnings, unknown, skipped, info } (см. lib/common.mjs → collector).
// broker — брокер счетов этого источника для переключателя портфелей, если в settings.json у источника нет поля broker;
// у выгрузок сервисов учёта и ручного шаблона брокера нет — брокером считается сам счёт (account).
export const SOURCE_TYPES = {
  snowball: { name: 'выгрузка Snowball', ext: /\.csv$/i, read: (file, src) => ({ ...readSnowball(file, { account: src.account || 'Snowball' }), unknown: [], skipped: {}, info: {} }) },
  csv: { name: 'шаблон операций', ext: /\.csv$/i, read: readCsvTemplate },
  bcs: { name: 'отчёт БКС', broker: 'БКС', ext: /\.xlsx?$/i, read: readBcs },
  sber: { name: 'отчёт Сбербанка', broker: 'Сбербанк', ext: /\.html?$/i, read: readSber },
  intelinvest: { name: 'выгрузка «Интеллектуального инвестора»', ext: /\.xlsx$/i, read: readIntelinvest },
  tinvest: { name: 'Т-Инвестиции (API)', broker: 'Т-Инвестиции', network: true },
};

// id портфеля для адреса страницы (#p-<id>): латиница, цифры и дефис
const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n',
  о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
const slug = (t) => [...String(t).toLowerCase()].map((c) => TRANSLIT[c] ?? c).join('').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';

// Счета и брокеры для переключателя. accounts — счета по порядку появления; sourcesOf — счёт → [источник из settings].
// Брокер счёта: sources[].broker, иначе брокер типа источника, иначе сам счёт. Группа брокера — только если у него
// больше одного счёта и это не все счета сразу (тогда он совпал бы с «Все счета»).
export function planPortfolios(accounts, sourcesOf) {
  const brokerOf = (acc) => {
    const srcs = sourcesOf(acc);
    return srcs.find((s) => s.broker)?.broker || srcs.map((s) => SOURCE_TYPES[s.type]?.broker).find(Boolean) || acc;
  };
  const brokers = new Map();
  for (const a of accounts) { const b = brokerOf(a); if (!brokers.has(b)) brokers.set(b, []); brokers.get(b).push(a); }
  const used = new Set();
  const uid = (base) => { let id = base, n = 2; while (used.has(id)) id = `${base}-${n++}`; used.add(id); return id; };
  const list = [];
  for (const [b, accs] of brokers) {
    const group = accs.length > 1 && accs.length < accounts.length;
    const parent = group ? uid(`b-${slug(b)}`) : null;
    if (group) list.push({ id: parent, label: b, kind: 'broker', accounts: accs });
    for (const a of accs) {
      const label = group || b === a || a.toLowerCase().includes(b.toLowerCase()) ? a : `${a} (${b})`;
      list.push({ id: uid(`a-${slug(a)}`), label, kind: 'account', ...(parent ? { parent } : {}), accounts: [a] });
    }
  }
  return list;
}

// Расчёт портфелей из planPortfolios тем же compute, что и общий. Себестоимость перевода считается в портфеле счёта,
// откуда ушли бумаги (средняя), и с ней же бумаги приходят на другой счёт; переводы по цепочке (A → Б → В) уточняются
// за несколько проходов — каждый делает точным ещё один перевод по времени. Брокер — с теми же суммами переводов.
// Возвращает { plan, results: { id: { r, ops } }, cost }.
export function computePortfolios({ ops, internal, plan, market }) {
  let cost = {};
  const accPlan = plan.filter((p) => p.kind === 'account');
  let accRes = [];
  for (let pass = 0; pass <= internal.length; pass++) {
    accRes = accPlan.map((p) => { const pops = portfolioOps(ops, internal, new Set(p.accounts), cost); return { r: compute({ ops: pops, ...market }), ops: pops }; });
    const next = Object.assign({}, ...accRes.map((x) => x.r.extra.moveCost));
    const same = internal.every((_, i) => next[i] === cost[i]);
    cost = next;
    if (same || !internal.length) break;
  }
  const results = {};
  accPlan.forEach((p, i) => { results[p.id] = accRes[i]; });
  for (const p of plan.filter((x) => x.kind !== 'account')) {
    const pops = portfolioOps(ops, internal, new Set(p.accounts), cost, { fixedOut: true });
    results[p.id] = { r: compute({ ops: pops, ...market }), ops: pops };
  }
  return { plan, results, cost };
}

// Операции портфеля из набора счетов: свои операции плюс переводы бумаг с другими счетами (merge.mjs → internal).
// Перевод внутри набора не виден (как в общем портфеле); ушедшие наружу — MOVE_OUT, пришедшие снаружи — MOVE_IN.
// cost — себестоимость каждого перевода (номер → ₽); fixedOut — и у ушедших брать её, а не среднюю по портфелю.
export function portfolioOps(ops, internal, set, cost, { fixedOut = false } = {}) {
  const out = ops.filter((o) => set.has(o.account));
  internal.forEach(([o, p], i) => {
    const a = set.has(o.account), b = set.has(p.account);
    if (a && !b) out.push({ ...o, event: 'MOVE_OUT', moveId: i, price: 0, amount: 0, fee: 0, ...(fixedOut && cost[i] != null ? { costRub: cost[i] } : {}), note: o.note || `перевод бумаг на счёт «${p.account}»` });
    if (b && !a) out.push({ ...p, event: 'MOVE_IN', moveId: i, price: 0, amount: 0, fee: 0, ...(cost[i] != null ? { costRub: cost[i] } : {}), note: p.note || `перевод бумаг со счёта «${o.account}»` });
  });
  return out;
}

async function loadOps(workdir, settings, { log, offline }) {
  const lists = [], warnings = [], files = [], unknown = [], errors = [];
  const cacheFile = path.join(workdir, '.cache', 'tinvest-instruments.json');
  for (const [n, src] of settings.sources.entries()) {
    const kind = SOURCE_TYPES[src.type];
    if (!kind) throw new Error(`источник «${src.type}» не поддерживается (есть: ${Object.keys(SOURCE_TYPES).join(', ')})`);
    const id = `${n + 1}:${src.type}`;
    let r, file = null;
    try {
      if (src.type === 'tinvest') {
        if (offline) throw new Error('Т-Инвестиции: без сети (--offline) операции не скачать');
        let cache = {};
        try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { /* нет кэша */ }
        r = await readTinvest(src, { cache, log });
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify(r.cache));
      } else {
        if (!src.file) throw new Error(`источник ${n + 1} (${src.type}): нет поля file`);
        file = path.resolve(workdir, src.file);
        if (!fs.existsSync(file)) throw new Error(`нет файла ${file}`);
        if (fs.statSync(file).isDirectory()) {
          // папка: все файлы нужного вида по порядку имён (например, месячные отчёты БКС)
          const list = fs.readdirSync(file).filter((f) => kind.ext.test(f) && !f.startsWith('~$')).sort().map((f) => path.join(file, f));
          if (!list.length) throw new Error(`в папке ${file} нет файлов ${kind.ext.source}`);
          r = { ops: [], warnings: [], unknown: [], skipped: {}, info: {} };
          for (const f of list) {
            const one = kind.read(f, src);
            r.ops.push(...one.ops); r.warnings.push(...one.warnings); r.unknown.push(...(one.unknown || []));
            for (const [k, v] of Object.entries(one.skipped || {})) r.skipped[k] = (r.skipped[k] || 0) + v;
            if (one.info?.accounts) r.info.accounts = [...new Set([...(r.info.accounts || []), ...one.info.accounts])];
          }
          r.info.files = list.length;
        } else r = kind.read(file, src);
      }
    } catch (err) {
      if (settings.sources.length === 1) throw err;
      errors.push({ source: id, error: err.message });
      warnings.push(`Источник ${n + 1} (${kind.name}) не прочитан: ${err.message}`);
      continue;
    }
    for (const o of r.ops) { if (!o.account) o.account = src.account || kind.name; o.src = { ...(o.src || {}), source: id }; }
    lists.push({ id, ops: r.ops });
    warnings.push(...r.warnings);
    if (src.type === 'sber') warnings.push(SBER_NOTE);
    unknown.push(...(r.unknown || []).map((u) => ({ ...u, source: id })));
    files.push({
      id, type: src.type, account: src.account || '', file: file ? path.basename(file) : null, operations: r.ops.length,
      modified: file ? fs.statSync(file).mtime.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
      unknown: (r.unknown || []).length, skipped: r.skipped || {}, ...(r.info?.files ? { files: r.info.files } : {}),
      ...(r.info?.accounts?.length ? { accounts: r.info.accounts } : {}),
      ...(src.type === 'sber' ? { note: SBER_NOTE } : {}),
    });
  }
  return { lists, warnings, files, unknown, errors };
}

// Тикер по ISIN (Мосбиржа) для операций, где из отчёта известен только ISIN
async function resolveIsins(ops, market, notes) {
  const isins = [...new Set(ops.filter((o) => o.isin && (!o.symbol || o.symbol === o.isin)).map((o) => o.isin))];
  const found = {};
  for (const i of isins) found[i] = await market.safe(`тикер по ISIN ${i} (Мосбиржа)`, () => market.isinToSecid(i), null);
  const miss = isins.filter((i) => !found[i]);
  for (const o of ops) if (o.isin && found[o.isin] && (!o.symbol || o.symbol === o.isin)) o.symbol = found[o.isin];
  if (miss.length) notes.push(`Не нашёл на Мосбирже тикер по ISIN: ${miss.join(', ')} — бумаги показаны под ISIN.`);
}

export async function build({ workdir, offline = false, quiet = false }) {
  const log = quiet ? () => {} : (m) => process.stderr.write(`${m}\n`);
  const settings = readSettings(workdir);
  const market = createMarket({ cacheDir: path.join(workdir, '.cache'), log, offline });
  const { lists, warnings: srcWarnings, files, unknown, errors: sourceErrors } = await loadOps(workdir, settings, { log, offline });
  const notes = [...srcWarnings];
  // несколько источников: тикер по ISIN, дубли между источниками, переводы и конвертации
  const all = lists.flatMap((l) => l.ops);
  if (all.some((o) => o.isin)) await resolveIsins(all, market, notes);
  const { ops: merged, dropped } = dedupe(lists);
  const { ops, notes: moveNotes, stats: moves, internal } = resolveMoves(merged);
  notes.push(...moveNotes);
  for (const f of files) f.duplicates = dropped[f.id] || 0;
  const dupTotal = Object.values(dropped).reduce((a, b) => a + b, 0);
  if (dupTotal) notes.push(`Отброшено дублей (та же операция из двух источников): ${dupTotal}.`);
  if (unknown.length) notes.push(`Не распознано строк в источниках: ${unknown.length} — список в report.json → unknown.`);
  if (!ops.length) throw new Error('в источниках нет операций');

  const asOf = !settings.asOf || settings.asOf === 'auto' ? await market.lastTradingDay() : settings.asOf;
  const start = ops.reduce((m, o) => (o.date < m ? o.date : m), ops[0].date);
  const lastOp = ops.reduce((m, o) => (o.date > m ? o.date : m), ops[0].date);
  log(`операций ${ops.length}, с ${start} по ${lastOp}; день оценки ${asOf}`);
  if (lastOp > asOf) notes.push(`Операции после дня оценки ${asOf} (до ${lastOp}) не входят в позиции и стоимость по дням, но входят в итоги и XIRR.`);

  // --- бумаги: цены, названия, вид, отрасль
  const syms = [...new Set(ops.filter((o) => o.event === 'BUY' || o.event === 'SELL').map((o) => o.symbol))].sort();
  const prices = {}, meta = {};
  for (const s of syms) {
    const exch = ops.find((o) => o.symbol === s && o.exchange)?.exchange || '';
    let info = null, hist = null;
    if (!FOREIGN_EXCHANGES.has(exch.toUpperCase()) && !ops.some((o) => o.symbol === s && o.foreign)) {
      info = await market.safe(`описание ${s} (Мосбиржа)`, () => market.secInfo(s), null);
      if (info?.boards?.length) {
        log(`  цены ${s}`);
        hist = await market.safe(`история цен ${s} (Мосбиржа)`, () => market.secHistory(s, start, asOf), null);
      }
    }
    if (hist && Object.keys(hist.days).length) {
      prices[s] = { days: hist.days };
    } else if (!info?.boards?.length) {
      // открытых цен нет — оценка по ценам собственных сделок (последняя сделка дня)
      const trades = ops.filter((o) => o.symbol === s && (o.event === 'BUY' || o.event === 'SELL'));
      const days = {};
      for (const o of trades) days[o.date] = [o.price, 0, null, null];
      prices[s] = { own: trades[0].currency, days };
      notes.push(`${settings.names[s] || s}${exch ? ` (${exch})` : ''}: цен Мосбиржи нет — стоимость по ценам собственных сделок × курс ЦБ.`);
    } else {
      prices[s] = { days: {} };
    }
    const kind = kindOf(info);
    meta[s] = {
      name: settings.names[s] || info?.shortname || s, kind,
      sector: settings.sectors[s] || SECTOR[s] || (kind === 'Облигация' ? 'Облигации' : kind === 'Фонд' ? 'Фонды' : 'Прочее'),
      quote: hist?.board ? { engine: 'stock', market: hist.market, board: hist.board } : null,
    };
  }
  // названия бумаг, по которым были только выплаты
  for (const o of ops) if (o.symbol && !meta[o.symbol] && settings.names[o.symbol]) meta[o.symbol] = { name: settings.names[o.symbol] };

  // --- курсы ЦБ: валюты операций, валютных номиналов и собственных цен; доллар — всегда
  const curs = new Set(['USD']);
  for (const o of ops) if (o.currency && o.currency !== 'RUB') curs.add(o.currency);
  for (const p of Object.values(prices)) {
    if (p.own && p.own !== 'RUB') curs.add(p.own);
    for (const v of Object.values(p.days)) if (v[3] && v[3] !== 'RUB' && v[3] !== 'SUR') curs.add(v[3]);
  }
  const rateTill = lastOp > asOf ? lastOp : asOf;
  log(`курсы ЦБ: ${[...curs].join(', ')}`);
  const rates = await market.safe('курсы ЦБ', () => market.cbrRates([...curs], addDays(start, -30), rateTill), {});
  for (const c of curs) if (!rates[c]) notes.push(`Нет курса ${c} — суммы в ${c} посчитаны как в рублях.`);

  // --- индексы
  const indexes = {};
  for (const code of settings.indexes || INDEXES) {
    log(`  индекс ${code}`);
    indexes[code] = await market.safe(`индекс ${code}`, () => market.indexHistory(code, start, asOf), {});
  }

  // --- прогноз выплат на 12 месяцев
  const held = [...holdingsOn(ops, asOf).entries()].filter(([, q]) => q > 1e-9).map(([s]) => s).sort();
  const fx = makeFx(rates);
  const fwd = {}, forecastItems = [];
  const horizon = addDays(asOf, 365);
  for (const s of held) {
    if (meta[s]?.kind === 'Облигация') {
      // купоны — по расписанию Мосбиржи
      // на 12 месяцев — столько ближайших купонов, сколько их в году (частота с Мосбиржи), но не позже чем через год;
      // частоты нет — купоны с датой реестра до той же даты следующего года (не включая её)
      const cps = await market.safe(`купоны ${s}`, () => market.bondCoupons(s, asOf), []);
      const freq = (await market.safe(`описание ${s}`, () => market.secInfo(s), null))?.couponFrequency;
      const ahead = cps.filter((c) => c.recordDate > asOf && (freq ? c.recordDate <= horizon : c.recordDate < horizon))
        .sort((a, b) => (a.recordDate < b.recordDate ? -1 : 1)).slice(0, freq || undefined);
      let sum = 0;
      for (const c of ahead) {
        const rub = c.amount * fx(c.currency, asOf);
        sum += rub;
        forecastItems.push({ recordDate: c.recordDate, ticker: s, perShare: rub, status: 'купон по расписанию' });
      }
      fwd[s] = { grossPerUnit: sum };
    } else {
      // по своим выплатам за прошлые 12 месяцев: на бумагу = выплата ÷ бумаг на дату выплаты
      let sum = 0;
      const byDate = new Map();
      for (const o of ops) {
        if (o.symbol !== s || o.event !== 'DIVIDEND' || !(o.date > addDays(asOf, -365) && o.date <= asOf)) continue;
        const q = holdingsOn(ops, o.date).get(s) || 0;
        if (q <= 1e-9) continue;
        const k = fx(o.currency, o.date);
        const gross = (o.netRecorded ? o.amount / (1 - 0.13) : o.amount) * k;
        sum += gross / q;
        const next = addDays(o.date, 365);
        byDate.set(next, (byDate.get(next) || 0) + gross / q);
      }
      fwd[s] = { grossPerUnit: sum };
      for (const [d, v] of byDate) forecastItems.push({ recordDate: d, ticker: s, perShare: v, status: 'оценка по прошлому году' });
    }
  }

  // --- расчёт
  const market0 = { asOf, rates, prices, meta, indexes, fwd, forecastItems, tax: settings.forecastTax, xirrEnd: settings.xirrEnd };
  const r = compute({ ops, ...market0 });
  for (const s of r.extra.noPrice) notes.push(`${meta[s]?.name || s}: нет цены на ${asOf} — бумага не вошла в позиции.`);
  if (ops.some((o) => o.event === 'SPLIT')) notes.push('Дробления (SPLIT) учтены один раз на бумагу и дату; на бумаги с нулевым остатком не влияют.');
  const ignored = [...new Set(ops.filter((o) => ['CASH_GAIN', 'TAX_RETURN'].includes(o.event)).map((o) => o.event))];
  if (ignored.length) notes.push(`События ${ignored.join(', ')} показаны в ленте, в доходность и итоги не входят.`);
  if (ops.some((o) => o.event === 'VARMARGIN')) notes.push('Вариационная маржа (срочный рынок) показана в ленте операций, в стоимость и доходность бумаг не входит.');
  if (ops.some((o) => o.event === 'FX_BUY' || o.event === 'FX_SELL')) notes.push('Покупки и продажи валюты показаны в ленте; валюта на счёте в стоимость входит, только если указана в настройках (cash).');
  for (const w of r.warnings) {
    if (ops.some((o) => o.symbol === w.ticker && o.margin)) notes.push(`${w.name}: минусовой остаток похож на шорт (маржинальную позицию) — в стоимость не входит.`);
  }

  // данные страницы для одного портфеля; общий («Все счета») — ровно в формате эталона
  const loadedOn = new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
  const pack = (r, { fileList, cash, ownSyms, snowballRef, last }) => {
    const srcNames = fileList.map((f) => `${SOURCE_TYPES[f.type].name} (${f.file ? `${f.file}, ` : ''}${f.modified.split('-').reverse().join('.')})`).join(', ');
    return {
      asOf,
      source: [
        srcNames[0].toUpperCase() + srcNames.slice(1), 'цены и индексы — Мосбиржа', 'курс — ЦБ',
        ...(ownSyms.length ? [`${ownSyms.join(', ')} — по ценам собственных сделок`] : []),
        'прогноз выплат — по выплатам за прошлые 12 месяцев',
      ].join('; '),
      days: r.days, value: r.value, invested: r.invested, flows: r.flows, indexes: r.indexes,
      indexNames: Object.fromEntries(Object.keys(r.indexes).map((c) => [c, INDEX_NAMES[c] || c])),
      positions: r.positions, xirr: r.xirr, totals: r.totals, divByYear: r.divByYear, payments: r.payments,
      forecast: r.forecast, operations: r.operations, warnings: r.warnings,
      ...(snowballRef ? { snowballRef } : {}),
      cash,
      quoteSources: Object.fromEntries(r.positions.filter((p) => meta[p.ticker]?.quote).map((p) => [p.ticker, meta[p.ticker].quote])),
      watchlist: settings.watchlist,
      // добавлено к формату эталона
      title: settings.title,
      forecastMode: settings.forecast,
      loadedOn, lastOperation: last,
    };
  };
  const ownOf = (list) => { const s = new Set(list.filter((o) => o.event === 'BUY' || o.event === 'SELL' || o.event === 'MOVE_IN').map((o) => o.symbol)); return Object.entries(prices).filter(([k, p]) => p.own && s.has(k)).map(([k]) => meta[k]?.name || k); };
  const data = pack(r, { fileList: files, cash: settings.cash, ownSyms: Object.entries(prices).filter(([, p]) => p.own).map(([s]) => meta[s]?.name || s), snowballRef: settings.snowballRef, last: lastOp });

  // --- портфели отдельных счетов и брокеров (тот же compute; если счёт один — их нет)
  const accounts = [...new Set([...ops.map((o) => o.account), ...internal.flatMap(([o, p]) => [o.account, p.account])])];
  const portfolioReport = [];
  if (accounts.length > 1) {
    const srcIds = new Map();
    for (const o of [...ops, ...internal.flat()]) { if (!srcIds.has(o.account)) srcIds.set(o.account, new Set()); if (o.src?.source) srcIds.get(o.account).add(o.src.source); }
    const sourcesOf = (acc) => [...(srcIds.get(acc) || [])].map((id) => settings.sources[+id.split(':')[0] - 1]).filter(Boolean);
    const { plan, results } = computePortfolios({ ops, internal, plan: planPortfolios(accounts, sourcesOf), market: market0 });
    const known = new Set(accounts);
    for (const c of settings.cash) if (c.account && !known.has(c.account)) notes.push(`Деньги на счёте (cash): счёта «${c.account}» нет в операциях — ${c.currency} учтена только в «Все счета».`);
    data.portfolios = plan.map(({ id, label, kind, parent }) => ({ id, label, kind, ...(parent ? { parent } : {}) }));
    data.byPortfolio = {};
    for (const p of plan) {
      const set = new Set(p.accounts);
      const { r: pr, ops: pops } = results[p.id];
      const ids = new Set(pops.map((o) => o.src?.source).filter(Boolean));
      const fileList = files.filter((f) => ids.has(f.id));
      data.byPortfolio[p.id] = pack(pr, {
        fileList: fileList.length ? fileList : files, cash: settings.cash.filter((c) => c.account && set.has(c.account)),
        ownSyms: ownOf(pops), last: pops.reduce((m, o) => (o.date > m ? o.date : m), pops[0]?.date || lastOp),
      });
      portfolioReport.push({ id: p.id, label: p.label, kind: p.kind, ...(p.parent ? { parent: p.parent } : {}), accounts: p.accounts,
        operations: pops.length, value: pr.extra.totalNow, xirr: pr.xirr, profit: pr.totals.profit });
    }
    if (internal.length) notes.push(`В портфелях отдельных счетов переводы бумаг между своими счетами (${internal.length}) — вывод и ввод бумаг по рыночной стоимости дня, себестоимость переходит на новый счёт; в «Все счета» их не видно.`);
  }
  fs.writeFileSync(path.join(workdir, 'dashboard-data.js'), `window.DATA = ${JSON.stringify(data)};\n`);

  const report = {
    builtAt: new Date().toISOString(), asOf, start, lastOperation: lastOp, days: r.days.length,
    sources: files, operations: ops.length, duplicates: dupTotal, moves, unknown,
    ...(sourceErrors.length ? { sourceErrors } : {}),
    events: ops.reduce((m, o) => ((m[o.event] = (m[o.event] || 0) + 1), m), {}),
    positions: r.positions.length, value: r.extra.totalNow, xirr: r.xirr,
    ...(portfolioReport.length ? { portfolios: portfolioReport } : {}),
    warnings: [...r.warnings.map((w) => w.text), ...notes],
    failed: market.failed,
  };
  fs.writeFileSync(path.join(workdir, 'report.json'), `${JSON.stringify(report, null, 1)}\n`);
  log(`готово: ${r.days.length} дней, стоимость ${r.extra.totalNow}, XIRR ${(r.xirr * 100).toFixed(2)} %; `
    + `предупреждений ${report.warnings.length}, не скачано ${market.failed.length}`);
  return { data, report };
}

// --- запуск из командной строки
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--workdir');
  if (i < 0 || !args[i + 1]) {
    process.stderr.write('Использование: node <навык>/engine/build.mjs --workdir <папка> [--offline] [--quiet]\n');
    process.exit(2);
  }
  build({ workdir: path.resolve(args[i + 1]), offline: args.includes('--offline'), quiet: args.includes('--quiet') })
    .catch((err) => { process.stderr.write(`Ошибка: ${err.message}\n`); process.exit(1); });
}
