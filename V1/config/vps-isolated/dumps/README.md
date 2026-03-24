# Dump PostgreSQL (desenvolvimento local)

Ficheiro gerado a partir do contentor `joao_guerreiro-postgres` (base `joao_guerreiro`) para restaurar na VPS na base `joaog_v2`.

**Atenção:** pode conter dados de desenvolvimento sensíveis. Não uses em produção sem rever o conteúdo; para ambientes públicos, prefere um dump anonimizado.

## Restaurar na VPS

Com `joaog-v2-postgres` em execução e `PGPASSWORD` definido:

```bash
docker cp joao_guerreiro_dev_dump.sql joaog-v2-postgres:/tmp/dump.sql
docker exec -e PGPASSWORD="$PGPASSWORD" -i joaog-v2-postgres psql -U joaog_v2 -d joaog_v2 -f /tmp/dump.sql
```

Ou a partir do repositório clonado:

```bash
cd ~/Joao_gueireiro/V1
export PGPASSWORD='sua_senha_joaog_v2'
docker cp config/vps-isolated/dumps/joao_guerreiro_dev_dump.sql joaog-v2-postgres:/tmp/dump.sql
docker exec -e PGPASSWORD="$PGPASSWORD" -i joaog-v2-postgres psql -U joaog_v2 -d joaog_v2 -f /tmp/dump.sql
```

Para regenerar o dump no PC de desenvolvimento:

```powershell
docker exec joao_guerreiro-postgres pg_dump -U joao_guerreiro --clean --if-exists --no-owner --no-acl joao_guerreiro -f /tmp/dump.sql
docker cp joao_guerreiro-postgres:/tmp/dump.sql .\V1\config\vps-isolated\dumps\joao_guerreiro_dev_dump.sql
```
