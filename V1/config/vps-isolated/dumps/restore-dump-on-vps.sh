#!/usr/bin/env bash
# Executar NA VPS, na pasta V1 do repositório (ex.: /root/Joao_gueireiro/V1).
#   chmod +x config/vps-isolated/dumps/restore-dump-on-vps.sh
#   ./config/vps-isolated/dumps/restore-dump-on-vps.sh
#
# Não usa "source .env" (evita erro ": command not found" com .env em CRLF).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

ENV_FILE="config/vps-isolated/.env"
DUMP="config/vps-isolated/dumps/joao_guerreiro_dev_dump.sql"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Falta $ENV_FILE"
  exit 1
fi
if [[ ! -f "$DUMP" ]]; then
  echo "Falta $DUMP — faz git pull ou coloca o ficheiro."
  exit 1
fi

# Senha sem depender de CRLF no .env
export PGPASSWORD="$(grep '^POSTGRES_PASSWORD=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '\r\n' | sed 's/^"//;s/"$//')"
if [[ -z "${PGPASSWORD:-}" ]]; then
  echo "POSTGRES_PASSWORD vazio em $ENV_FILE"
  exit 1
fi

COMPOSE=(docker compose -f config/vps-isolated/docker-compose.vps.yml --env-file "$ENV_FILE")

"${COMPOSE[@]}" stop app ai-worker frontend 2>/dev/null || true

docker cp "$DUMP" joao_guerreiro-postgres:/tmp/dump.sql
docker exec -e PGPASSWORD="$PGPASSWORD" joao_guerreiro-postgres \
  psql -U joao_guerreiro -d joao_guerreiro -v ON_ERROR_STOP=1 -f /tmp/dump.sql
docker exec joao_guerreiro-postgres rm -f /tmp/dump.sql

"${COMPOSE[@]}" up -d

echo "Restore concluído."
