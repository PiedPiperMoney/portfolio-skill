#!/usr/bin/env node
// Все проверки навыка: node <навык>/tests/run.mjs [--dashboard <папка человека>]
// Запускает tests/*.test.mjs (без сети).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const runs = fs.readdirSync(HERE).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => [f, path.join(HERE, f), args]);

let bad = 0;
for (const [name, file, a] of runs) {
  console.log(`\n=== ${name}`);
  const r = spawnSync(process.execPath, [file, ...a], { stdio: 'inherit' });
  if (r.status !== 0) { bad++; console.log(`!!! ${name}: не прошло (код ${r.status})`); }
}
console.log(`\n${bad ? `НЕ ПРОШЛО: ${bad} из ${runs.length}` : `ВСЁ ПРОШЛО: ${runs.length} из ${runs.length}`}`);
process.exit(bad ? 1 : 0);
