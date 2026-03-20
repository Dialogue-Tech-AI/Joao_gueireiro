#!/bin/bash
# Gera certificado Origin Cloudflare via API.
# Uso recomendado:
#   CLOUDFLARE_ORIGIN_CA_KEY="v1.0-xxx" ./create-origin-cert.sh
#
# Uso alternativo:
#   CLOUDFLARE_API_TOKEN="xxx" ./create-origin-cert.sh
# (apenas se o token tiver permissao para Origin CA)

set -euo pipefail
OUTPUT_DIR="${SSL_OUTPUT_DIR:-/root/Guerreiros/ssl}"
CF_HOSTNAMES_JSON="${CLOUDFLARE_HOSTNAMES_JSON:-[\"*.dialoguetech.com.br\",\"dialoguetech.com.br\"]}"
CF_REQUEST_TYPE="${CLOUDFLARE_REQUEST_TYPE:-origin-rsa}"
CF_VALIDITY_DAYS="${CLOUDFLARE_VALIDITY_DAYS:-5475}"
CF_CSR_SUBJECT="${CLOUDFLARE_CSR_SUBJECT:-/CN=*.dialoguetech.com.br}"

mkdir -p "$OUTPUT_DIR"
cd "$OUTPUT_DIR"

# 1. Gerar chave privada
echo "[1/4] Gerando chave privada..."
openssl genrsa -out origin.key 2048
chmod 600 origin.key

# 2. Gerar CSR e salvar em arquivo
echo "[2/4] Gerando CSR..."
CSR_FILE="$OUTPUT_DIR/csr.pem"
openssl req -new -key origin.key -subj "$CF_CSR_SUBJECT" -out "$CSR_FILE" 2>/dev/null

if [ ! -s "$CSR_FILE" ]; then
  echo "ERRO: CSR vazio ou nao gerado. Verifique openssl."
  exit 1
fi

# 3. Chamar API Cloudflare
echo "[3/4] Solicitando certificado na Cloudflare..."

if [ -n "${CLOUDFLARE_ORIGIN_CA_KEY:-}" ]; then
  AUTH_HEADER="X-Auth-User-Service-Key: $CLOUDFLARE_ORIGIN_CA_KEY"
elif [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
  AUTH_HEADER="Authorization: Bearer $CLOUDFLARE_API_TOKEN"
else
  echo "ERRO: Defina CLOUDFLARE_ORIGIN_CA_KEY ou CLOUDFLARE_API_TOKEN"
  exit 1
fi

TMP_JSON=$(mktemp)
python3 - "$CSR_FILE" "$TMP_JSON" "$CF_HOSTNAMES_JSON" "$CF_REQUEST_TYPE" "$CF_VALIDITY_DAYS" << 'PYEOF'
import json, sys
csr_path, json_path, hostnames_json, request_type, validity_days = sys.argv[1:6]
with open(csr_path, "rb") as f:
    csr = f.read().decode("ascii").strip()
csr = csr.replace("\r\n", "\n").replace("\r", "")
hostnames = json.loads(hostnames_json)
payload = {
    "csr": csr,
    "hostnames": hostnames,
    "request_type": request_type,
    "requested_validity": int(validity_days)
}
with open(json_path, "w", encoding="utf-8") as out:
    json.dump(payload, out, ensure_ascii=True)
PYEOF

RESP=$(curl -sS -X POST "https://api.cloudflare.com/client/v4/certificates" \
  -H "Content-Type: application/json" \
  -H "$AUTH_HEADER" \
  -d @"$TMP_JSON")
CERTIFICATE=$(
  echo "$RESP" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(2)
if data.get('success') is True:
    cert = data.get('result', {}).get('certificate', '')
    if cert:
        print(cert)
        sys.exit(0)
sys.exit(1)
" || true
)

if [ -n "$CERTIFICATE" ]; then
  echo "[4/4] Salvando certificado..."
  printf "%s\n" "$CERTIFICATE" > origin.pem
  chmod 644 origin.pem
  echo ""
  echo "OK! Certificados em $OUTPUT_DIR/"
  ls -la origin.pem origin.key
else
  echo "ERRO na API Cloudflare:"
  echo "$RESP" | python3 -m json.tool 2>/dev/null || echo "$RESP"
  if [ "${CF_DEBUG_KEEP_FILES:-0}" = "1" ]; then
    echo ""
    echo "DEBUG: mantendo arquivos temporarios:"
    echo " - CSR:  $CSR_FILE"
    echo " - JSON: $TMP_JSON"
  fi
  rm -f origin.pem
  rm -f "$TMP_JSON" "$CSR_FILE"
  exit 1
fi

rm -f "$TMP_JSON" "$CSR_FILE"
