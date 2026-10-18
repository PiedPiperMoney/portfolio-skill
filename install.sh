#!/usr/bin/env bash
# Установка навыка «portfolio» в каталог навыков агента.
# Запуск: ./install.sh            — спросит, куда ставить
#         ./install.sh <каталог>  — поставить в <каталог>/portfolio
# Ничего не удаляет: если навык уже стоит, спросит и отложит старую копию в ~/.portfolio-skill-old/ДАТА
# (не рядом — иначе агент увидит два навыка с одним именем).
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)/skills/portfolio"
[ -f "$SRC/SKILL.md" ] || { echo "Не нашёл $SRC/SKILL.md — запускайте install.sh из скачанного репозитория." >&2; exit 1; }

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

DEST="$DEST_ROOT/portfolio"
mkdir -p "$DEST_ROOT"
if [ -e "$DEST" ]; then
  read -r -p "В $DEST уже есть навык. Заменить новым (старый будет отложен в ~/.portfolio-skill-old, не удалён)? [y/N]: " OK
  case "$OK" in y|Y|д|Д|yes|да) ;; *) echo "Оставил как есть."; exit 0 ;; esac
  OLD="$HOME/.portfolio-skill-old/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$OLD"
  mv "$DEST" "$OLD/"
  echo "Старая копия: $OLD"
fi
cp -R "$SRC" "$DEST"
echo "Готово: навык в $DEST"

if command -v node >/dev/null 2>&1; then
  V="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$V" -lt 18 ]; then echo "Внимание: Node.js $V — нужна версия 18 или новее (nodejs.org)."; fi
  node "$DEST/tests/run.mjs" >/dev/null 2>&1 && echo "Проверки навыка прошли." || echo "Внимание: проверки навыка не прошли — запустите: node \"$DEST/tests/run.mjs\""
else
  echo "Внимание: не найден Node.js — поставьте версию LTS с nodejs.org."
fi
echo "Дальше: откройте агента и напишите «настрой мой портфель» (или «покажи на тестовом портфеле»)."
