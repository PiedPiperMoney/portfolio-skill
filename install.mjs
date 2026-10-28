#!/usr/bin/env node
// Установка навыка «portfolio» в каталог навыков агента — без вопросов: её запускает сам агент или install.sh.
//   node install.mjs                      — DeepSeek Harness: ~/.agents/skills/portfolio
//   node install.mjs --agent claude       — Claude Code: ~/.claude/skills/portfolio
//   node install.mjs --target <каталог>   — в <каталог>/portfolio
// Ничего не удаляет: если навык уже стоит, старая копия откладывается в ~/.portfolio-skill-old/ДАТА
// (не рядом — иначе агент увидит два навыка с одним именем). После копирования запускает проверки навыка.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOTS = { deepseek: path.join(os.homedir(), '.agents', 'skills'), claude: path.join(os.homedir(), '.claude', 'skills') };
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const fail = (msg) => { console.error(`Не установлено: ${msg}`); process.exit(1); };

const major = Number(process.versions.node.split('.')[0]);
if (major < 18) fail(`Node.js ${process.versions.node} — нужна версия 18 или новее (LTS с nodejs.org).`);
const src = path.join(path.dirname(fileURLToPath(import.meta.url)), 'skills', 'portfolio');
if (!fs.existsSync(path.join(src, 'SKILL.md'))) fail(`нет ${src}/SKILL.md — запускайте install.mjs из скачанного репозитория.`);
const agent = opt('--agent') || 'deepseek';
if (!opt('--target') && !ROOTS[agent]) fail(`неизвестный агент «${agent}» (есть: ${Object.keys(ROOTS).join(', ')}) — или укажите --target.`);
const root = path.resolve((opt('--target') || ROOTS[agent]).replace(/^~(?=$|[\\/])/, os.homedir()));
const dest = path.join(root, 'portfolio');

// Новая копия сначала проверяется в отдельной папке (вне каталога навыков — агент её не увидит) и только потом
// встаёт на место: не прошла — установленный навык остаётся как был.
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-skill-'));
const fresh = path.join(stage, 'portfolio');
fs.cpSync(src, fresh, { recursive: true, filter: (p) => !/[\\/](node_modules|\.cache|\.DS_Store)$/.test(p) });
const t = spawnSync(process.execPath, [path.join(fresh, 'tests', 'run.mjs')], { encoding: 'utf8' });
if (t.status !== 0) {
  fs.rmSync(stage, { recursive: true, force: true });
  fail(`проверки новой копии не прошли, ${fs.existsSync(dest) ? 'установленный навык не тронут' : 'навык не поставлен'}.\n${(t.stdout || '').split('\n').filter((l) => /FAIL|!!!/.test(l)).join('\n')}`);
}
console.log('Проверки навыка прошли.');

fs.mkdirSync(root, { recursive: true });
if (fs.existsSync(dest)) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const old = path.join(os.homedir(), '.portfolio-skill-old', stamp);
  fs.mkdirSync(old, { recursive: true });
  fs.cpSync(dest, path.join(old, 'portfolio'), { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  console.log(`Старая копия навыка отложена: ${path.join(old, 'portfolio')}`);
}
fs.cpSync(fresh, dest, { recursive: true });
fs.rmSync(stage, { recursive: true, force: true });
console.log(`Готово: навык в ${dest}`);
console.log('Дальше: попросите агента «настрой мой портфель» (или «покажи на тестовом портфеле»).');
