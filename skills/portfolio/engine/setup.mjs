// Первая настройка папки портфеля одной командой: навык сам узнаёт отчёты в папке человека, копирует их в
// <папка>/reports, пишет settings.json и кладёт страницу дашборда. Сборку делает build.mjs, ярлык — shortcut.mjs.
//
//   node engine/setup.mjs --workdir "<папка портфеля>" --reports "<папка с отчётами>"
//   node engine/setup.mjs --workdir "<папка портфеля>" --sample          # выдуманный тестовый портфель
//   node engine/setup.mjs --workdir "<папка портфеля>" --tinvest         # Т-Инвестиции по API, файлов нет
//
// Вид отчёта узнаётся не по имени, а по содержимому: файл пробуют читатели из sources/ (SOURCE_TYPES в build.mjs),
// побеждает тот, кто прочитал больше операций. settings.json пишется последним: оборвалось посередине — запустить
// ещё раз; есть settings.json — портфель уже настроен, команда ничего не трогает.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE_TYPES } from './build.mjs';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE_TYPES = Object.keys(SOURCE_TYPES).filter((t) => !SOURCE_TYPES[t].network);
// счёт на странице по умолчанию; человек переименует потом
const ACCOUNT = { snowball: 'Snowball', csv: 'Ручные', bcs: 'БКС', sber: 'Сбербанк', intelinvest: 'Интеллектуальный инвестор' };
// у этих брокеров отчёты обычно помесячные — все файлы в одну папку-источник
const FOLDER_TYPES = new Set(['bcs', 'sber']);
const MAX_DEPTH = 2;
// сюда человек кладёт свежие выгрузки и отчёты; на «обнови» агент разбирает их по references/обновление.md
export const NEW_DIR = 'Новые отчёты';
const NOT_REPORT = 'не похоже на отчёт брокера или выгрузку Snowball';

function walk(dir, depth = 0, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'ru'))) {
    if (e.name.startsWith('.') || e.name.startsWith('~$')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < MAX_DEPTH) walk(p, depth + 1, out); } else if (e.isFile()) out.push(p);
  }
  return out;
}

const isCandidate = (file) => FILE_TYPES.some((t) => SOURCE_TYPES[t].ext.test(file));

// Один файл: { type, operations } или { reason }.
function recognize(file) {
  const kinds = FILE_TYPES.filter((t) => SOURCE_TYPES[t].ext.test(file));
  let best = null, reason = NOT_REPORT;
  for (const type of kinds) {
    try {
      const n = SOURCE_TYPES[type].read(file, {}).ops.length;
      if (n > 0 && (!best || n > best.operations)) best = { type, operations: n };
    } catch (e) {
      if (/\.xls$/i.test(file)) reason = `если это отчёт брокера — ${e.message}`; // читатель БКС объясняет, как пересохранить
    }
  }
  return best || { reason };
}

// Повторные скачивания одного файла («отчёт (1).xlsx»): одинаковое содержимое → берём файл с самым коротким именем,
// остальные — в пропущенные. Иначе одни и те же сделки попадут в портфель дважды.
function dropRepeats(files, skipped) {
  const keep = new Map();
  for (const file of files) {
    const h = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
    const k = keep.get(h);
    const shorter = !k || path.basename(file).length < path.basename(k).length;
    const [kept, repeat] = shorter ? [file, k] : [k, file];
    keep.set(h, kept);
    if (repeat) skipped.push({ file: repeat, name: path.basename(repeat), reason: `повтор файла «${path.basename(kept)}» — то же содержимое` });
  }
  return [...keep.values()];
}

// Что в папке: found — отчёты по порядку видов, skipped — похожие по расширению, но не прочитанные или повторы
// (с причиной), ignored — сколько остальных файлов (картинки, документы) не трогали. overlap — есть и выгрузка
// Snowball, и отчёты брокера: если Snowball собран из того же счёта, сделки задвоятся — спросить человека.
export function detectReports(dir) {
  const all = walk(dir), skipped = [], found = [];
  const ignored = all.filter((f) => !isCandidate(f)).length;
  for (const file of dropRepeats(all.filter(isCandidate), skipped)) {
    const r = recognize(file);
    const name = path.basename(file);
    if (r.type) found.push({ file, name, ...r });
    else skipped.push({ file, name, reason: r.reason });
  }
  found.sort((a, b) => FILE_TYPES.indexOf(a.type) - FILE_TYPES.indexOf(b.type) || a.name.localeCompare(b.name, 'ru'));
  skipped.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const has = (t) => found.some((f) => f.type === t);
  return { found, skipped, ignored, overlap: has('snowball') && ['bcs', 'sber', 'intelinvest'].some(has) };
}

// Куда копировать каждый отчёт и какие строки sources получатся
function planReports(found) {
  const count = (t) => found.filter((f) => f.type === t).length;
  const used = new Set(), copies = [], sources = [];
  const free = (rel) => {
    let r = rel, i = 2;
    const ext = path.extname(rel);
    while (used.has(r)) r = `${rel.slice(0, rel.length - ext.length)} (${i++})${ext}`;
    used.add(r);
    return r;
  };
  for (const f of found) {
    if (FOLDER_TYPES.has(f.type)) {
      copies.push([f.file, free(`reports/${f.type}/${f.name}`)]);
      if (!sources.some((s) => s.type === f.type)) sources.push({ type: f.type, file: `reports/${f.type}`, account: ACCOUNT[f.type] });
    } else {
      const rel = free(`reports/${f.name}`);
      copies.push([f.file, rel]);
      const account = count(f.type) > 1 ? path.basename(f.name, path.extname(f.name)) : ACCOUNT[f.type];
      sources.push({ type: f.type, file: rel, account });
    }
  }
  return { copies, sources };
}

function copyTemplate(workdir) {
  const dash = path.join(SKILL_DIR, 'dashboard');
  for (const f of ['index.html', 'styles.css']) fs.copyFileSync(path.join(dash, f), path.join(workdir, f));
  fs.cpSync(path.join(dash, 'js'), path.join(workdir, 'js'), { recursive: true });
  // в custom.* живут доработки человека — только если их ещё нет
  for (const f of ['custom.js', 'custom.css']) if (!fs.existsSync(path.join(workdir, f))) fs.copyFileSync(path.join(dash, f), path.join(workdir, f));
}

export function setupWorkdir({ workdir, reports, sample = false, tinvest = false }) {
  if (fs.existsSync(path.join(workdir, 'settings.json'))) {
    throw new Error(`портфель в ${workdir} уже настроен (есть settings.json) — это обновление, а не настройка`);
  }
  let found = [], skipped = [], ignored = 0, overlap = false, copies = [], settings;
  const example = () => JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'sample', 'settings.example.json'), 'utf8'));
  if (sample) {
    copies = [[path.join(SKILL_DIR, 'sample', 'snowball-sample.csv'), 'reports/snowball-sample.csv']];
    settings = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'sample', 'settings.sample.json'), 'utf8'));
  } else if (tinvest) {
    // файлов нет: операции придут по API, токен человек даст отдельно (references/настройка.md)
    settings = Object.assign(example(), { title: 'Мой портфель', sources: [{ type: 'tinvest', account: 'Т-Инвестиции' }], cash: [] });
  } else {
    if (!reports || !fs.existsSync(reports) || !fs.statSync(reports).isDirectory()) throw new Error(`нет папки ${reports}`);
    ({ found, skipped, ignored, overlap } = detectReports(reports));
    if (!found.length) {
      const why = skipped.map((s) => `\n  ${s.name}: ${s.reason}`).join('');
      throw new Error(`в ${reports} не нашёл ни одного отчёта брокера или выгрузки${why}`);
    }
    const plan = planReports(found);
    copies = plan.copies;
    settings = Object.assign(example(), { title: 'Мой портфель', sources: plan.sources, cash: [] });
  }
  fs.mkdirSync(path.join(workdir, 'reports'), { recursive: true });
  fs.mkdirSync(path.join(workdir, NEW_DIR), { recursive: true });
  for (const [from, rel] of copies) {
    const to = path.join(workdir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (path.resolve(from) !== path.resolve(to)) fs.copyFileSync(from, to);
  }
  copyTemplate(workdir);
  fs.writeFileSync(path.join(workdir, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`);
  return { workdir, sources: settings.sources, found, skipped, ignored, overlap };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const home = (p) => p && path.resolve(p.replace(/^~(?=$|[\\/])/, os.homedir()));
  const workdir = home(opt('--workdir')), reports = home(opt('--reports')), detect = home(opt('--detect'));
  const sample = argv.includes('--sample'), tinvest = argv.includes('--tinvest');
  const printFound = (dir, r) => {
    for (const f of r.found) console.log(`  нашёл: ${path.relative(dir, f.file)} — ${SOURCE_TYPES[f.type].name}, операций ${f.operations}`);
    for (const s of r.skipped) console.log(`  пропустил: ${path.relative(dir, s.file)} — ${s.reason}`);
    if (r.ignored) console.log(`  других файлов не трогал: ${r.ignored}`);
    if (r.overlap) console.log('Внимание: есть и выгрузка Snowball, и отчёты брокера. Если Snowball собран из того же счёта, '
      + 'сделки посчитаются дважды — спросите человека (references/настройка.md, 1а).');
  };
  // --detect <папка>: только сказать, что в ней лежит (новые отчёты при обновлении), ничего не копируя
  if (detect) {
    if (!fs.existsSync(detect)) { process.stderr.write(`Нет папки ${detect}\n`); process.exit(1); }
    const r = detectReports(detect);
    if (!r.found.length && !r.skipped.length) console.log('Отчётов не нашёл.');
    printFound(detect, r);
    process.exit(0);
  }
  if (!workdir || [reports, sample, tinvest].filter(Boolean).length !== 1) {
    process.stderr.write('Использование: node <навык>/engine/setup.mjs --workdir <папка портфеля> (--reports <папка с отчётами> | --sample | --tinvest)\n'
      + '               node <навык>/engine/setup.mjs --detect <папка>   — что за отчёты лежат в папке\n');
    process.exit(2);
  }
  try {
    const r = setupWorkdir({ workdir, reports, sample, tinvest });
    console.log(`Папка портфеля готова: ${r.workdir}`);
    if (sample) console.log('Портфель тестовый, выдуманный.');
    printFound(reports, r);
    console.log(`Новые выгрузки и отчёты потом — в папку «${NEW_DIR}» внутри неё.`);
    console.log(`Источники в settings.json: ${r.sources.map((s) => `${SOURCE_TYPES[s.type].name} → счёт «${s.account || ACCOUNT[s.type]}»`).join(', ')}`);
    console.log(`Дальше: node "${path.join(SKILL_DIR, 'engine', 'build.mjs')}" --workdir "${r.workdir}"`);
  } catch (err) {
    process.stderr.write(`Настройка не сделана: ${err.message}\n`);
    process.exit(1);
  }
}
