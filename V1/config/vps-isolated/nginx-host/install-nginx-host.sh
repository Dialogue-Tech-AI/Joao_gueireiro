#!/usr/bin/env bash
# Instala Nginx no host e ativa reverse proxy para o frontend Docker (127.0.0.1:8081).
# Uso (root na VPS):  bash /root/Joao_gueireiro/V1/config/vps-isolated/nginx-host/install-nginx-host.sh
# Opcional:            bash install-nginx-host.sh /caminho/para/Joao_gueireiro/V1

set -euo pipefail

REPO="${1:-/root/Joao_gueireiro/V1}"
CONF_SRC="${REPO}/config/vps-isolated/nginx-host/joao-guerreiro.conf"
SSL_DIR="${REPO}/config/vps-isolated/ssl"

if [[ ! -f "${CONF_SRC}" ]]; then
  echo "Erro: não encontrei ${CONF_SRC}"
  exit 1
fi
if [[ ! -f "${SSL_DIR}/origin.pem" ]] || [[ ! -f "${SSL_DIR}/origin.key" ]]; then
  echo "Erro: coloque origin.pem e origin.key em ${SSL_DIR}"
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y nginx

install -d -m 0755 /etc/nginx/ssl/joao-guerreiro
install -m 0644 "${SSL_DIR}/origin.pem" /etc/nginx/ssl/joao-guerreiro/origin.pem
install -m 0640 -o root -g www-data "${SSL_DIR}/origin.key" /etc/nginx/ssl/joao-guerreiro/origin.key

install -m 0644 "${CONF_SRC}" /etc/nginx/sites-available/joao-guerreiro.conf
ln -sf /etc/nginx/sites-available/joao-guerreiro.conf /etc/nginx/sites-enabled/joao-guerreiro.conf

nginx -t
systemctl reload nginx

echo "Nginx configurado. Teste: curl -sI https://atendimento-joaoguerreiro.dialoguetech.com.br"
