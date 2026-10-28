// Запущен ли модуль командой `node <файл>`, а не подключён через import (тогда он только отдаёт функции).
// Пути сравниваются настоящие: Node даёт import.meta.url уже без ссылок, а argv[1] — как набрали. У человека каталог
// навыков бывает ссылкой на другой диск (~/.dsh → внешний диск) — простое сравнение там молча ничего не запускало.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function isMain(metaUrl) {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return fs.realpathSync(path.resolve(arg)) === fs.realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false; // argv[1] указывает не на существующий файл (node -e, REPL) — значит, это не запуск этого модуля
  }
}
