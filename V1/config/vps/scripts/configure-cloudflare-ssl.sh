#!/bin/bash
# Configura SSL/TLS da zona Cloudflare para strict e always_use_https=on.
#
# Uso:
#   CLOUDFLARE_API_TOKEN="token" CLOUDFLARE_ZONE_NAME="dialoguetech.com.br" ./configure-cloudflare-ssl.sh

set -euo pipefail

CF_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}"
CF_ZONE_NAME="${CLOUDFLARE_ZONE_NAME:-}"
CF_SSL_MODE="${CLOUDFLARE_SSL_MODE:-strict}"
CF_ALWAYS_HTTPS="${CLOUDFLARE_ALWAYS_HTTPS:-on}"

if [ -z "$CF_API_TOKEN" ]; then
  echo "ERRO: Defina CLOUDFLARE_API_TOKEN"
  exit 1
fi

if [ -z "$CF_ZONE_NAME" ]; then
  echo "ERRO: Defina CLOUDFLARE_ZONE_NAME (ex: dialoguetech.com.br)"
  exit 1
fi

echo "[1/3] Buscando zone id para ${CF_ZONE_NAME}..."
ZONE_RESP=$(curl -sS "https://api.cloudflare.com/client/v4/zones?name=${CF_ZONE_NAME}" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: application/json")

CF_ZONE_ID=$(
  echo "$ZONE_RESP" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(1)
result = data.get('result') or []
if result and result[0].get('id'):
    print(result[0]['id'])
"
)

if [ -z "$CF_ZONE_ID" ]; then
  echo "ERRO: Nao foi possivel obter zone id."
  echo "$ZONE_RESP" | python3 -m json.tool 2>/dev/null || echo "$ZONE_RESP"
  exit 1
fi

echo "[2/3] Aplicando SSL/TLS mode: ${CF_SSL_MODE}..."
SSL_RESP=$(curl -sS -X PATCH "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/settings/ssl" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "{\"value\":\"${CF_SSL_MODE}\"}")

echo "$SSL_RESP" | python3 -m json.tool 2>/dev/null || echo "$SSL_RESP"

echo "[3/3] Aplicando Always Use HTTPS: ${CF_ALWAYS_HTTPS}..."
HTTPS_RESP=$(curl -sS -X PATCH "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/settings/always_use_https" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "{\"value\":\"${CF_ALWAYS_HTTPS}\"}")

echo "$HTTPS_RESP" | python3 -m json.tool 2>/dev/null || echo "$HTTPS_RESP"

echo ""
echo "OK! Cloudflare atualizado para a zona ${CF_ZONE_NAME}."
