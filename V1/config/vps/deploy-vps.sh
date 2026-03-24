#!/bin/bash
# ============================================================
# Deploy VPS - Plataforma Guerreiros
# ============================================================
# Preserva dados do banco (volumes). Roda migrations via db-init.
# Uso: bash deploy-vps.sh  (execute na VPS, ou via SSH)
# ============================================================

set -e

# Diretório do projeto (ajuste se necessário)
PROJECT_DIR="${GUERREIROS_DIR:-/root/Guerreiros}"
cd "$PROJECT_DIR/V1" || { echo "Erro: pasta $PROJECT_DIR/V1 não encontrada"; exit 1; }

echo "=== Deploy Plataforma Guerreiros ==="
echo "Diretório: $(pwd)"

# Atualizar código
echo ""
echo "=== 1. Atualizando código (git pull) ==="
git fetch origin
git pull origin master

# Parar e remover containers (mantém volumes - dados do banco preservados)
echo ""
echo "=== 2. Parando e removendo containers ==="
docker compose -f docker-compose.vps.yml down --remove-orphans
# Remove containers órfãos que podem ter ficado de runs anteriores (ex: minio-init)
docker rm -f guerreiros-minio-init 2>/dev/null || true

# Subir tudo com rebuild - db-init roda migrations automaticamente antes do app
echo ""
echo "=== 3. Subindo aplicação (build + up) ==="
docker compose -f docker-compose.vps.yml up -d --build

echo ""
echo "=== 4. Deploy concluído! ==="
docker compose -f docker-compose.vps.yml ps
