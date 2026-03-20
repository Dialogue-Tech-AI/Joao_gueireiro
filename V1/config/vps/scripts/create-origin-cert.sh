#!/bin/bash
# Gera certificado Origin Cloudflare via API (sem usar nano)
# Uso: CLOUDFLARE_ORIGIN_CA_KEY="v1.0-xxx" ./create-origin-cert.sh
# Ou:  CLOUDFLARE_API_TOKEN="xxx" ./create-origin-cert.sh
#
# Obter Origin CA Key: Cloudflare Dashboard > Profile > API Tokens > Origin CA Key
# Obter API Token: Cloudflare Dashboard > Profile > API Tokens > Create Token
#   (precisa de permissão Zone > SSL and Certificates > Edit)

set -e
OUTPUT_DIR="${SSL_OUTPUT_DIR:-/root/Guerreiros/ssl}"
HOSTNAMES='["*.dialoguetech.com.br","dialoguetech.com.br"]'

mkdir -p "$OUTPUT_DIR"
cd "$OUTPUT_DIR"

# 1. Gerar chave privada
echo "[1/4] Gerando chave privada..."
openssl genrsa 2048 > origin.key
chmod 600 origin.key

# 2. Gerar CSR e salvar em arquivo (evita corrupção no pipe/shell)
echo "[2/4] Gerando CSR..."
openssl req -new -key origin.key -subj "/CN=*.dialoguetech.com.br" -out csr.pem 2>/dev/null

# 3. Chamar API Cloudflare
echo "[3/4] Solicitando certificado na Cloudflare..."

if [ -n "$CLOUDFLARE_ORIGIN_CA_KEY" ]; then
  AUTH_HEADER="X-Auth-User-Service-Key: $CLOUDFLARE_ORIGIN_CA_KEY"
elif [ -n "$CLOUDFLARE_API_TOKEN" ]; then
  AUTH_HEADER="Authorization: Bearer $CLOUDFLARE_API_TOKEN"
else
  echo "ERRO: Defina CLOUDFLARE_ORIGIN_CA_KEY ou CLOUDFLARE_API_TOKEN"
  echo "  export CLOUDFLARE_ORIGIN_CA_KEY=\"v1.0-xxx\""
  echo "  export CLOUDFLARE_API_TOKEN=\"xxx\""
  exit 1
fi

# Montar JSON com CSR via Python (preserva newlines corretamente)
TMP_JSON=$(mktemp)
python3 - "$TMP_JSON" << 'PYEOF'
import json, sys
with open("csr.pem") as f:
    csr = f.read()
payload = {
    "csr": csr,
    "hostnames": ["*.dialoguetech.com.br", "dialoguetech.com.br"],
    "request_type": "origin-rsa",
    "requested_validity": 5475
}
with open(sys.argv[1], "w") as out:
    json.dump(payload, out)
PYEOF

RESP=$(curl -s -X POST "https://api.cloudflare.com/client/v4/certificates" \
  -H "Content-Type: application/json" \
  -H "$AUTH_HEADER" \
  -d @"$TMP_JSON")
rm -f "$TMP_JSON" csr.pem

# 4. Extrair e salvar certificado
if echo "$RESP" | grep -q '"success":true'; then
  echo "[4/4] Salvando certificado..."
  echo "$RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
cert = d.get('result', {}).get('certificate', '')
if cert:
    print(cert)
else:
    sys.exit(1)
" > origin.pem
  if [ -s origin.pem ]; then
    chmod 644 origin.pem
    echo ""
    echo "OK! Certificados em $OUTPUT_DIR/"
    ls -la origin.pem origin.key
  else
    echo "ERRO: Nao foi possivel extrair certificado da resposta."
    echo "Resposta: $RESP" | head -5
    exit 1
  fi
else
  echo "ERRO na API Cloudflare:"
  echo "$RESP" | python3 -m json.tool 2>/dev/null || echo "$RESP"
  exit 1
fi
