// Ярлык на рабочем столе: открывает дашборд человека в браузере. Сервер и Node для открытия не нужны —
// страница работает с диска, живые цены берёт сама. Данные обновляет агент (`build.mjs`).
//
//   node engine/shortcut.mjs --workdir "<папка>" [--name "Портфель"] [--force]
//
// Мак — маленькое приложение `<имя>.app` (AppleScript, без окна терминала);
// Windows — интернет-ярлык `<имя>.url`; Linux — `<имя>.desktop`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MARK = 'portfolio-skill-shortcut';

function args(argv) {
  const a = { name: 'Портфель', force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workdir') a.workdir = argv[++i];
    else if (argv[i] === '--name') a.name = argv[++i];
    else if (argv[i] === '--force') a.force = true;
  }
  return a;
}

function fail(msg) { console.error(`Ярлык не создан: ${msg}`); process.exit(1); }

function desktopDir() {
  if (process.platform === 'win32') {
    // рабочий стол бывает перенесён в OneDrive — спрашиваем у Windows
    try {
      const d = execFileSync('powershell', ['-NoProfile', '-Command', "[Environment]::GetFolderPath('Desktop')"], { encoding: 'utf8' }).trim();
      if (d && fs.existsSync(d)) return d;
    } catch { /* ниже — обычный путь */ }
    return path.join(process.env.USERPROFILE || os.homedir(), 'Desktop');
  }
  if (process.platform === 'linux') {
    try {
      const d = execFileSync('xdg-user-dir', ['DESKTOP'], { encoding: 'utf8' }).trim();
      if (d && fs.existsSync(d)) return d;
    } catch { /* ниже — обычный путь */ }
  }
  return path.join(os.homedir(), 'Desktop');
}

// наш ли это ярлык — чужой файл с тем же именем не трогаем без --force
function isOurs(p) {
  try {
    const f = fs.statSync(p).isDirectory() ? path.join(p, 'Contents', 'Resources', 'portfolio-target.txt') : p;
    return fs.readFileSync(f, 'utf8').includes(MARK);
  } catch { return false; }
}

const a = args(process.argv.slice(2));
if (!a.workdir) fail('укажите --workdir — папку с портфелем.');
const workdir = path.resolve(a.workdir.replace(/^~(?=$|[\\/])/, os.homedir()));
const page = path.join(workdir, 'index.html');
if (!fs.existsSync(page)) fail(`в ${workdir} нет index.html — сначала соберите дашборд.`);
if (!fs.existsSync(path.join(workdir, 'dashboard-data.js'))) fail(`в ${workdir} нет dashboard-data.js — сначала соберите дашборд (build.mjs).`);
const name = a.name.replace(/[\\/:*?"<>|]/g, ' ').trim() || 'Портфель';

const desk = desktopDir();
if (!fs.existsSync(desk)) fail(`не нашёл рабочий стол (${desk}).`);
const url = pathToFileURL(page).href;
let target;

if (process.platform === 'darwin') {
  target = path.join(desk, `${name}.app`);
  if (fs.existsSync(target) && !isOurs(target) && !a.force) fail(`на рабочем столе уже есть «${name}.app», и это не ярлык портфеля. Выберите другое имя (--name).`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-shortcut-'));
  const script = path.join(tmp, 'open.applescript');
  // путь к странице читается из файла внутри приложения: папку можно переложить и обновить ярлык командой ещё раз
  fs.writeFileSync(script, [
    'set here to POSIX path of (path to me)',
    'set target to do shell script "head -n 1 " & quoted form of (here & "Contents/Resources/portfolio-target.txt")',
    'try',
    '  do shell script "test -f " & quoted form of target',
    'on error',
    '  display dialog "Не нашёл дашборд: " & target & return & return & "Папку с портфелем переместили или удалили. Попросите агента пересоздать ярлык." buttons {"OK"} default button 1 with icon caution',
    '  return',
    'end try',
    'do shell script "open " & quoted form of target',
    '',
  ].join('\n'));
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  try { execFileSync('osacompile', ['-o', target, script], { stdio: 'pipe' }); } catch (e) { fail(`osacompile: ${String(e.stderr || e.message).trim()}`); }
  fs.writeFileSync(path.join(target, 'Contents', 'Resources', 'portfolio-target.txt'), `${page}\n${MARK}\n`);
  fs.rmSync(tmp, { recursive: true, force: true });
  try { execFileSync('touch', [target]); } catch { /* значок обновится сам */ }
} else if (process.platform === 'win32') {
  target = path.join(desk, `${name}.url`);
  if (fs.existsSync(target) && !isOurs(target) && !a.force) fail(`на рабочем столе уже есть «${name}.url», и это не ярлык портфеля. Выберите другое имя (--name).`);
  // ; — комментарий в формате .url, Windows его пропускает
  fs.writeFileSync(target, `[InternetShortcut]\r\nURL=${url}\r\nIconIndex=0\r\n; ${MARK}\r\n`, 'utf8');
} else {
  target = path.join(desk, `${name}.desktop`);
  if (fs.existsSync(target) && !isOurs(target) && !a.force) fail(`на рабочем столе уже есть «${name}.desktop», и это не ярлык портфеля. Выберите другое имя (--name).`);
  fs.writeFileSync(target, `[Desktop Entry]\nType=Link\nName=${name}\nURL=${url}\nIcon=x-office-spreadsheet\nComment=${MARK}\n`);
  fs.chmodSync(target, 0o755);
}

console.log(`Ярлык готов: ${target}`);
console.log(`Открывает: ${page}`);
