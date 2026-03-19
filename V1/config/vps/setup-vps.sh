#!/bin/bash
# ============================================================
# Setup VPS Ubuntu - Plataforma Guerreiros
# ============================================================
# Execute na VPS: bash setup-vps.sh
# Ou copie e cole os comandos no terminal SSH
# ============================================================

set -e

echo "=== 1. Atualizando Ubuntu ==="
apt update && apt upgrade -y

echo "=== 2. Instalando dependencias ==="
apt install -y ca-certificates curl gnupg git

echo "=== 3. Instalando Docker ==="
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null

apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

echo "=== 4. Verificando Docker ==="
docker --version
docker compose version

echo "=== 5. Setup concluido! ==="
echo ""
echo "Proximos passos:"
echo "  1. Clonar o repositorio: git clone https://github.com/Dialogue-Tech-AI/Guerreiros.git"
echo "  2. cd Guerreiros/V1"
echo "  3. Editar os .env em config/vps/credentials/"
echo "  4. docker compose -f config/vps/docker-compose.vps.yml up -d --build"
echo "  5. docker compose -f config/vps/docker-compose.vps.yml exec app npm run migration:run"
echo "  6. docker compose -f config/vps/docker-compose.vps.yml exec app npm run seed:run"
