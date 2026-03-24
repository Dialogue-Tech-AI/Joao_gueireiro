# Dump PostgreSQL (desenvolvimento local)

Ficheiro gerado a partir do contentor `joao_guerreiro-postgres` (base `joao_guerreiro`) para restaurar na VPS — **mesmos nomes** que `docker-compose.vps.yml`.

**Atenção:** pode conter dados sensíveis de desenvolvimento.

## Restaurar na VPS

```bash
export PGPASSWORD='a_mesma_senha_do_postgres'
cd ~/Joao_gueireiro/V1
docker cp config/vps-isolated/dumps/joao_guerreiro_dev_dump.sql joao_guerreiro-postgres:/tmp/dump.sql
docker exec -e PGPASSWORD="$PGPASSWORD" -i joao_guerreiro-postgres psql -U joao_guerreiro -d joao_guerreiro -f /tmp/dump.sql
```

Regenerar o dump no PC de desenvolvimento:

```powershell
docker exec joao_guerreiro-postgres pg_dump -U joao_guerreiro --clean --if-exists --no-owner --no-acl joao_guerreiro -f /tmp/dump.sql
docker cp joao_guerreiro-postgres:/tmp/dump.sql .\V1\config\vps-isolated\dumps\joao_guerreiro_dev_dump.sql
```
