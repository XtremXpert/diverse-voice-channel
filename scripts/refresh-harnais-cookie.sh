#!/bin/sh
# Démarre le serveur web du harnais et publie son cookie de session dans Traefik,
# afin que l'URL https://harnais.636.vezina.biz n'exige jamais le ?token=.
set -eu

HOST=${HARNAIS_HOST:-192.168.235.231}
PORT=${HARNAIS_PORT:-3080}
PUBLIC_URL=${HARNAIS_PUBLIC_URL:-https://harnais.636.vezina.biz}
NS=${HARNAIS_NAMESPACE:-lan}
MIDDLEWARE=${HARNAIS_MIDDLEWARE:-harnais-cookie}
LOG=/tmp/dsh-web.log

# Un seul serveur à la fois : le port doit être libre avant de démarrer.
[ -n "$(lsof -tiTCP:"$PORT" -sTCP:LISTEN || true)" ] && kill "$(lsof -tiTCP:"$PORT" -sTCP:LISTEN)" && sleep 2
: > "$LOG"

cd "${HARNAIS_REPO:-$HOME/code/deepseek-harness}"
env -u ELECTRON_RUN_AS_NODE pnpm run dsh web --no-open \
  --host "$HOST" --port "$PORT" --public-url "$PUBLIC_URL" --trusted-host "${PUBLIC_URL#https://}" >> "$LOG" 2>&1 &

# 1. Attendre que le jeton soit imprimé.
TOKEN=''
for _ in $(seq 1 90); do
  TOKEN=$(grep -oE 'token=[A-Za-z0-9_-]+' "$LOG" | head -1 | cut -d= -f2 || true)
  [ -n "$TOKEN" ] && break
  sleep 1
done
[ -n "$TOKEN" ] || { echo "jeton introuvable dans $LOG" >&2; exit 1; }

# 2. Échanger le jeton contre le cookie de session.
COOKIE=$(curl -s -D - -o /dev/null "http://$HOST:$PORT/?token=$TOKEN" \
  | grep -i '^set-cookie:' | head -1 | cut -d' ' -f2- | tr -d '\r' | cut -d';' -f1)
[ -n "$COOKIE" ] || { echo "cookie introuvable" >&2; exit 1; }

# 3. Publier le cookie : les navigateurs ne transmettent plus de jeton.
kubectl -n "$NS" patch middleware "$MIDDLEWARE" --type merge \
  -p "{\"spec\":{\"headers\":{\"customRequestHeaders\":{\"Cookie\":\"$COOKIE\"}}}}"
echo "cookie publié dans $NS/$MIDDLEWARE"
