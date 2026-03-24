#!/bin/bash
# ============================================================
# Setup SSL - Cloudflare Origin Certificate
# ============================================================
# Cria origin.pem e origin.key a partir de arquivos ou interativo.
# NUNCA commite certificados no git - rode este script na VPS.
#
# Uso:
#   Opção 1 - Já tem os arquivos (ex: copiou via SCP):
#     ./setup-ssl.sh /caminho/para/certificado.pem /caminho/para/chave.key
#
#   Opção 2 - Interativo (script abre editor para colar):
#     ./setup-ssl.sh
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSL_DIR="$SCRIPT_DIR"
CERT_FILE="$SSL_DIR/origin.pem"
KEY_FILE="$SSL_DIR/origin.key"

echo "=== Setup SSL Cloudflare ==="
echo "Destino: $SSL_DIR"
echo ""

if [ -n "$1" ] && [ -n "$2" ]; then
    # Modo: copiar de arquivos existentes
    SRC_CERT="$1"
    SRC_KEY="$2"
    if [ ! -f "$SRC_CERT" ]; then
        echo "Erro: arquivo não encontrado: $SRC_CERT"
        exit 1
    fi
    if [ ! -f "$SRC_KEY" ]; then
        echo "Erro: arquivo não encontrado: $SRC_KEY"
        exit 1
    fi
    cp "$SRC_CERT" "$CERT_FILE"
    cp "$SRC_KEY" "$KEY_FILE"
    echo "Arquivos copiados com sucesso."
else
    # Modo interativo: abrir editor para colar
    echo "Modo interativo. O editor será aberto para você colar o conteúdo."
    echo ""
    echo "1. Abra o Cloudflare Dashboard → SSL/TLS → Origin Server"
    echo "2. Crie ou visualize o certificado"
    echo "3. Você irá colar o Origin Certificate e a Private Key"
    echo ""
    read -p "Pressione Enter para começar..."

    echo ""
    echo ">>> Colando ORIGIN CERTIFICATE (origin.pem)"
    echo "    Cole o conteúdo completo incluindo -----BEGIN CERTIFICATE----- e -----END CERTIFICATE-----"
    echo ""
    read -p "Pressione Enter para abrir o editor..."
    "${EDITOR:-nano}" "$CERT_FILE" 2>/dev/null || nano "$CERT_FILE"

    echo ""
    echo ">>> Colando PRIVATE KEY (origin.key)"
    echo "    Cole o conteúdo completo incluindo -----BEGIN PRIVATE KEY----- e -----END PRIVATE KEY-----"
    echo ""
    read -p "Pressione Enter para abrir o editor..."
    "${EDITOR:-nano}" "$KEY_FILE" 2>/dev/null || nano "$KEY_FILE"
fi

# Validar
echo ""
echo "Validando arquivos..."
if ! grep -q "BEGIN CERTIFICATE" "$CERT_FILE" 2>/dev/null; then
    echo "Erro: origin.pem não parece um certificado válido (falta BEGIN CERTIFICATE)"
    exit 1
fi
if ! grep -q "BEGIN PRIVATE KEY" "$KEY_FILE" 2>/dev/null && ! grep -q "BEGIN RSA PRIVATE KEY" "$KEY_FILE" 2>/dev/null; then
    echo "Erro: origin.key não parece uma chave privada válida"
    exit 1
fi

echo ""
echo "OK! Certificados configurados:"
ls -la "$CERT_FILE" "$KEY_FILE"
echo ""
echo "Próximo passo - reinicie o frontend:"
echo "  cd ~/Guerreiros/V1"
echo "  docker compose -f docker-compose.vps.yml up -d --force-recreate frontend"
echo ""
