// Окно выбора папки — чтобы человек показал, где лежат отчёты, мышкой, а не печатал путь.
//
//   node engine/pick-folder.mjs [--prompt "Где лежат отчёты брокера?"]
//
// Печатает полный путь выбранной папки. Код выхода: 0 — выбрал, 2 — закрыл окно, 3 — окна выбора здесь нет
// (Linux без zenity и kdialog, сервер без экрана) — тогда спросить путь словами.
// Окно ждёт человека сколько угодно: запускать без короткого таймаута.
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const i = argv.indexOf('--prompt');
const prompt = (i >= 0 && argv[i + 1]) || 'Где лежат отчёты брокера или выгрузка Snowball?';
const home = os.homedir();

function mac() {
  // activate — окно поверх остальных, без запроса на управление другими программами
  const q = prompt.replace(/["\\]/g, ' ');
  const r = spawnSync('osascript', ['-e', 'activate', '-e',
    `POSIX path of (choose folder with prompt "${q}" default location (path to downloads folder))`], { encoding: 'utf8' });
  if (r.status === 0) return { path: r.stdout.trim() };
  return /-128/.test(r.stderr) ? { cancel: true } : { none: r.stderr.trim() };
}

function windows() {
  const q = prompt.replace(/'/g, "''");
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    `$d.Description = '${q}'`,
    "$d.SelectedPath = Join-Path $env:USERPROFILE 'Downloads'",
    '$top = New-Object System.Windows.Forms.Form -Property @{TopMost = $true}',
    "if ($d.ShowDialog($top) -eq 'OK') { [Console]::OutputEncoding = [Text.Encoding]::UTF8; $d.SelectedPath } else { exit 2 }",
  ].join('; ');
  // -EncodedCommand: русский текст подсказки доходит до PowerShell без поломки кодировки
  const enc = Buffer.from(ps, 'utf16le').toString('base64');
  const r = spawnSync('powershell', ['-NoProfile', '-STA', '-EncodedCommand', enc], { encoding: 'utf8' });
  if (r.error) return { none: r.error.message };
  if (r.status === 0 && r.stdout.trim()) return { path: r.stdout.trim() };
  return r.status === 2 ? { cancel: true } : { none: r.stderr.trim() };
}

function linux() {
  // без экрана zenity выходит с тем же кодом, что при «Отмене», — проверяем экран заранее
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return { none: 'нет экрана' };
  for (const [cmd, args] of [
    ['zenity', ['--file-selection', '--directory', `--title=${prompt}`, `--filename=${home}/`]],
    ['kdialog', ['--getexistingdirectory', home, '--title', prompt]],
  ]) {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    if (r.error) continue; // такой программы нет — следующая
    if (r.status === 0 && r.stdout.trim()) return { path: r.stdout.trim() };
    if (r.status === 1) return { cancel: true };
  }
  return { none: 'нет zenity и kdialog' };
}

const r = process.platform === 'darwin' ? mac() : process.platform === 'win32' ? windows() : linux();
if (r.path) {
  // косую черту в конце срезаем, кроме корня диска: «E:\» без неё — это «текущая папка на E:»
  console.log(/^([A-Za-z]:)?[\\/]$/.test(r.path) ? r.path : r.path.replace(/[\\/]$/, ''));
  process.exit(0);
}
if (r.cancel) {
  console.error('Окно закрыли, папку не выбрали.');
  process.exit(2);
}
console.error(`Окна выбора папки здесь нет (${r.none}). Спросите путь к папке словами.`);
process.exit(3);
