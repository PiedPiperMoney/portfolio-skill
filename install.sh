#!/usr/bin/env bash
# Установка навыка «portfolio» в каталог навыков агента — меню для человека в терминале.
# Запуск: ./install.sh            — спросит, куда ставить
#         ./install.sh <каталог>  — поставить в <каталог>/portfolio
# Копирует и проверяет install.mjs (его же запускает агент сам); старую копию он не удаляет, а откладывает
# в ~/.portfolio-skill-old/ДАТА.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
command -v node >/dev/null 2>&1 || { echo "Не найден Node.js — поставьте версию LTS с nodejs.org и запустите ещё раз." >&2; exit 1; }

if [ $# -ge 1 ]; then
  DEST_ROOT="$1"
else
  echo "Куда поставить навык?"
  echo "  1) DeepSeek Harness — ~/.agents/skills (общий каталог навыков)"
  echo "  2) DeepSeek Harness — ~/.dsh/skills"
  echo "  3) Claude Code      — ~/.claude/skills"
  echo "  4) другой каталог"
  read -r -p "Номер [1]: " CHOICE
  case "${CHOICE:-1}" in
    1) DEST_ROOT="$HOME/.agents/skills" ;;
    2) DEST_ROOT="$HOME/.dsh/skills" ;;
    3) DEST_ROOT="$HOME/.claude/skills" ;;
    4) read -r -p "Каталог: " DEST_ROOT; DEST_ROOT="${DEST_ROOT/#\~/$HOME}" ;;
    *) echo "Нет такого варианта." >&2; exit 1 ;;
  esac
fi

if [ -e "$DEST_ROOT/portfolio" ]; then
  read -r -p "В $DEST_ROOT/portfolio уже есть навык. Заменить новым (старый будет отложен в ~/.portfolio-skill-old, не удалён)? [y/N]: " OK
  case "$OK" in y|Y|д|Д|yes|да) ;; *) echo "Оставил как есть."; exit 0 ;; esac
fi
exec node "$HERE/install.mjs" --target "$DEST_ROOT"
