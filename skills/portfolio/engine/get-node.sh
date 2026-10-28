#!/usr/bin/env bash
# Node.js для навыка без пароля администратора: если на компьютере нет Node 18+, качает официальный Node LTS
# с nodejs.org в ~/.portfolio-node (со сверкой контрольной суммы) и печатает путь к node. Есть свой — печатает его.
# Запускает агент:  NODE="$(bash <навык>/engine/get-node.sh)" && "$NODE" <репозиторий>/install.mjs
# Windows — get-node.ps1 рядом.
set -euo pipefail

DEST="$HOME/.portfolio-node"
LINE="latest-v24.x"

if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ]; then
  command -v node; exit 0
fi
if [ -x "$DEST/bin/node" ]; then echo "$DEST/bin/node"; exit 0; fi

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) PLATFORM=darwin-arm64 ;;
  Darwin-x86_64) PLATFORM=darwin-x64 ;;
  Linux-x86_64) PLATFORM=linux-x64 ;;
  Linux-aarch64) PLATFORM=linux-arm64 ;;
  *) echo "Для $(uname -s) $(uname -m) нет готовой сборки — поставьте Node.js LTS с nodejs.org." >&2; exit 1 ;;
esac

BASE="https://nodejs.org/dist/$LINE"
SUMS="$(curl -fsSL "$BASE/SHASUMS256.txt")"
FILE="$(printf '%s\n' "$SUMS" | grep -oE "node-v[0-9.]+-$PLATFORM\.tar\.gz$" | head -1)"
[ -n "$FILE" ] || { echo "На nodejs.org не нашёл сборку $PLATFORM." >&2; exit 1; }
WANT="$(printf '%s\n' "$SUMS" | awk -v f="$FILE" '$2 == f { print $1 }')"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "Качаю $FILE с nodejs.org…" >&2
curl -fsSL "$BASE/$FILE" -o "$TMP/$FILE"
GOT="$(shasum -a 256 "$TMP/$FILE" 2>/dev/null || sha256sum "$TMP/$FILE")"
[ "${GOT%% *}" = "$WANT" ] || { echo "Контрольная сумма не сошлась — файл повреждён, ничего не ставлю." >&2; exit 1; }
tar -xzf "$TMP/$FILE" -C "$TMP"
# переносим целиком в конце: оборвалось раньше — ~/.portfolio-node не появится полусобранной
rm -rf "$DEST"
mv "$TMP/${FILE%.tar.gz}" "$DEST"
echo "$DEST/bin/node"
