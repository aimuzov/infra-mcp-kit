#!/bin/bash
# Спайк страниц на Astro: собрать кит, поставить его тарболом в коннектор-фикстуру, как поставил бы
# настоящий сервер, собрать страницы, поднять сервер и прогнать OAuth и браузерный e2e.
#   bash spike/run.sh [каталог-для-скриншотов]
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
shots=${1:-$root/spike/shots}

cd "$root"
npm run build >/dev/null
npm pack --silent --pack-destination spike >/dev/null
mv spike/aimuzov-infra-mcp-kit-*.tgz spike/kit.tgz

cd spike/connector
lsof -ti :8790 | xargs kill 2>/dev/null || true
rm -rf node_modules/@aimuzov/infra-mcp-kit package-lock.json
npm install --silent
npx astro build >/dev/null
node src/server.ts >server.log 2>&1 &
server=$!
trap 'kill $server' EXIT
sleep 2

node oauth-e2e.mjs
node browser-e2e.mjs "$shots"
