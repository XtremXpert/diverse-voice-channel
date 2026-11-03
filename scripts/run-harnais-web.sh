#!/bin/sh
# Fait tourner le serveur web du harnais au premier plan (supervisé par launchd).
set -eu
export KUBECONFIG=${KUBECONFIG:-$HOME/.kube/vezina-local.yaml}
export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
PNPM_BIN=${PNPM_BIN:-$(command -v pnpm || echo "$HOME/.local/bin/pnpm")}
cd "${HARNAIS_REPO:-$HOME/code/deepseek-harness}"
exec env -u ELECTRON_RUN_AS_NODE "$PNPM_BIN" run dsh web --no-open \
  --host "${HARNAIS_HOST:-192.168.235.231}" --port "${HARNAIS_PORT:-3080}" \
  --public-url "${HARNAIS_PUBLIC_URL:-https://harnais.636.vezina.biz}" \
  --trusted-host "${HARNAIS_TRUSTED_HOST:-harnais.636.vezina.biz}"
