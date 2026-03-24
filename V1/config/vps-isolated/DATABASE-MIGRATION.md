# Copiar base de dados local → VPS (PostgreSQL)

Desenvolvimento local: utilizador `joao_guerreiro`, base `joao_guerreiro`, contentor `joao_guerreiro-postgres`.

VPS (`docker-compose.vps.yml`): **os mesmos nomes** — utilizador `joao_guerreiro`, base `joao_guerreiro`, contentor `joao_guerreiro-postgres` (senhas no `.env` e em `credentials/backend.vps.env` devem coincidir).

---

## 1) Na tua máquina (Windows PowerShell)

```powershell
cd "C:\caminho\para\Joao guerreiro\V1"

docker exec joao_guerreiro-postgres pg_dump -U joao_guerreiro `
  --clean --if-exists --no-owner --no-acl `
  joao_guerreiro -f /tmp/joao_dump.sql

docker cp joao_guerreiro-postgres:/tmp/joao_dump.sql .\joao_guerreiro_dump.sql
```

Envio para a VPS:

```powershell
scp .\joao_guerreiro_dump.sql usuario@IP_DA_VPS:~/
```

---

## 2) Na VPS

Com Postgres da stack em execução:

```bash
cd ~/Joao_gueireiro/V1
docker compose -f config/vps-isolated/docker-compose.vps.yml --env-file config/vps-isolated/.env up -d postgres
```

Restaurar (usa a mesma senha que em `POSTGRES_PASSWORD` / `DB_PASSWORD_DEV`):

```bash
export PGPASSWORD='joao_guerreiro123'
docker exec -i joao_guerreiro-postgres psql -U joao_guerreiro -d joao_guerreiro < ~/joao_guerreiro_dump.sql
```

---

## 3) Dump incluído no repositório

Ver `dumps/joao_guerreiro_dev_dump.sql` e `dumps/README.md`.

---

## Dump formato custom (opcional)

**Local:**

```powershell
docker exec joao_guerreiro-postgres pg_dump -U joao_guerreiro -Fc -f /tmp/joao.dump joao_guerreiro
docker cp joao_guerreiro-postgres:/tmp/joao.dump .\joao.dump
```

**VPS:**

```bash
docker cp ~/joao.dump joao_guerreiro-postgres:/tmp/joa.dump
docker exec -e PGPASSWORD="$PGPASSWORD" joao_guerreiro-postgres pg_restore -U joao_guerreiro -d joao_guerreiro --clean --if-exists --no-owner --no-acl /tmp/joa.dump
```
