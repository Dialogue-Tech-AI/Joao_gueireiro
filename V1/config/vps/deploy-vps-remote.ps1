# ============================================================
# Deploy VPS Remoto - Plataforma Guerreiros
# ============================================================
# Execute localmente (PowerShell): .\deploy-vps-remote.ps1
# Faz SSH na VPS, atualiza codigo, sobe Docker, roda migrations.
# Preserva dados do banco (volumes).
# ============================================================

$VPS_HOST = "root@187.77.244.149"
$PROJECT_DIR = "/root/Guerreiros"

Write-Host "=== Deploy na VPS 187.77.244.149 ===" -ForegroundColor Cyan
Write-Host ""

$remoteScript = @"
set -e
cd $PROJECT_DIR/V1 || { echo 'Erro: pasta nao encontrada. Ajuste PROJECT_DIR no script.'; exit 1; }

echo '=== 1. Atualizando codigo ==='
git fetch origin
git pull origin master

echo ''
echo '=== 2. Parando containers ==='
docker compose -f docker-compose.vps.yml down

echo ''
echo '=== 3. Subindo aplicacao (build + migrations via db-init) ==='
docker compose -f docker-compose.vps.yml up -d --build

echo ''
echo '=== Deploy concluido! ==='
docker compose -f docker-compose.vps.yml ps
"@

$remoteScript | ssh -o StrictHostKeyChecking=no $VPS_HOST "bash -s"
