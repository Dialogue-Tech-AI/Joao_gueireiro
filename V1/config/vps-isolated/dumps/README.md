# Dump PostgreSQL (desenvolvimento local)

Ficheiro gerado a partir do contentor `joao_guerreiro-postgres` (base `joao_guerreiro`) para restaurar na VPS — **mesmos nomes** que `docker-compose.vps.yml`.

**Atenção:** pode conter dados sensíveis de desenvolvimento. A restauração **substitui** o conteúdo atual da base `joao_guerreiro` na VPS.

Base na VPS (compose isolado): utilizador **`joao_guerreiro`**, base **`joao_guerreiro`**, contentor **`joao_guerreiro-postgres`**, porta no host **`15432`**.

## 1. Enviar o dump do PC para a VPS

No **PowerShell** (Windows), a partir da pasta do projeto ou com caminho completo para o `.sql`:

```powershell
scp "C:\Users\bield\Desktop\Plataforma guerreiros\Joao guerreiro\V1\config\vps-isolated\dumps\joao_guerreiro_dev_dump.sql" root@SEU_IP:/root/joao_guerreiro_dev_dump.sql
```

Substitui `SEU_IP` pelo IP da VPS (ex.: `187.77.244.149`).

## 2. Restaurar na VPS (SSH como root)

A senha tem de ser a mesma que em `config/vps-isolated/.env` → **`POSTGRES_PASSWORD`** (e o que o `backend.vps.env` usa em `DB_PASSWORD_*`).

Recomenda-se parar a app para libertar ligações à base durante o restore:

```bash
cd /root/Joao_gueireiro/V1
docker compose -f config/vps-isolated/docker-compose.vps.yml --env-file config/vps-isolated/.env stop app ai-worker frontend 2>/dev/null || true

export PGPASSWORD='COLOCA_AQUI_POSTGRES_PASSWORD_DO_.env'
docker cp /root/joao_guerreiro_dev_dump.sql joao_guerreiro-postgres:/tmp/dump.sql
docker exec -e PGPASSWORD="$PGPASSWORD" joao_guerreiro-postgres psql -U joao_guerreiro -d joao_guerreiro -v ON_ERROR_STOP=1 -f /tmp/dump.sql
docker exec joao_guerreiro-postgres rm -f /tmp/dump.sql

docker compose -f config/vps-isolated/docker-compose.vps.yml --env-file config/vps-isolated/.env up -d
```

Se o ficheiro já estiver **dentro** do clone do repo na VPS (`config/vps-isolated/dumps/joao_guerreiro_dev_dump.sql`), podes usar esse caminho no `docker cp` em vez de `/root/joao_guerreiro_dev_dump.sql`.

## Restaurar (recomendado: script na VPS)

Evita `source .env` (ficheiros **CRLF** do Windows causam `: command not found`).

```bash
cd /root/Joao_gueireiro/V1
git pull
chmod +x config/vps-isolated/dumps/restore-dump-on-vps.sh
./config/vps-isolated/dumps/restore-dump-on-vps.sh
```

## Restaurar (manual, ficheiro já no repo na VPS)

```bash
export PGPASSWORD="$(grep '^POSTGRES_PASSWORD=' config/vps-isolated/.env | cut -d= -f2- | tr -d '\r' | sed 's/^"//;s/"$//')"
cd ~/Joao_gueireiro/V1
docker cp config/vps-isolated/dumps/joao_guerreiro_dev_dump.sql joao_guerreiro-postgres:/tmp/dump.sql
docker exec -e PGPASSWORD="$PGPASSWORD" joao_guerreiro-postgres psql -U joao_guerreiro -d joao_guerreiro -v ON_ERROR_STOP=1 -f /tmp/dump.sql
```

Regenerar o dump no PC de desenvolvimento:

```powershell
docker exec joao_guerreiro-postgres pg_dump -U joao_guerreiro --clean --if-exists --no-owner --no-acl joao_guerreiro -f /tmp/dump.sql
docker cp joao_guerreiro-postgres:/tmp/dump.sql .\V1\config\vps-isolated\dumps\joao_guerreiro_dev_dump.sql
```
