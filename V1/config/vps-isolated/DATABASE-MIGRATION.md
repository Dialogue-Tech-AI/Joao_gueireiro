# Copiar base de dados local → VPS (PostgreSQL)

Desenvolvimento local (Docker): utilizador `joao_guerreiro`, base `joao_guerreiro`, contentor `joao_guerreiro-postgres`.

VPS (stack `joaog-v2`): utilizador `joaog_v2`, base `joaog_v2`, contentor `joaog-v2-postgres` (senha igual à definida no `.env` do compose).

---

## 1) Na tua máquina (Windows PowerShell)

Com o Postgres local a correr (`docker compose -f config/local/dependencies/docker-compose.yml up -d`):

```powershell
cd "C:\caminho\para\Joao guerreiro\V1"

docker exec joao_guerreiro-postgres pg_dump -U joao_guerreiro `
  --clean --if-exists --no-owner --no-acl `
  joao_guerreiro -f /tmp/joao_dump.sql

docker cp joao_guerreiro-postgres:/tmp/joao_dump.sql .\joao_guerreiro_dump.sql
```

Alternativa (redirecionamento direto, pode ser mais lento em bases grandes):

```powershell
docker exec joao_guerreiro-postgres pg_dump -U joao_guerreiro --clean --if-exists --no-owner --no-acl joao_guerreiro > joao_guerreiro_dump.sql
```

Copia o ficheiro para a VPS (exemplo com `scp`):

```powershell
scp .\joao_guerreiro_dump.sql usuario@IP_DA_VPS:/home/usuario/
```

---

## 2) Na VPS (Linux)

Garante que a stack está no ar (Postgres a correr):

```bash
cd ~/Joao_gueireiro/V1
docker compose -f config/vps-isolated/docker-compose.joaog-v2.yml --env-file config/vps-isolated/.env up -d postgres
```

Define a mesma senha que usaste no `.env` (`JOAOG_V2_POSTGRES_PASSWORD`):

```bash
export PGPASSWORD='a_tua_senha_do_compose'
```

Restaura (apaga dados atuais da base `joaog_v2` e substitui pelo dump):

```bash
docker exec -i joaog-v2-postgres psql -U joaog_v2 -d joaog_v2 < ~/joao_guerreiro_dump.sql
```

Se o dump falhar por extensões ou ordem de objetos, tenta só dados após migrações já aplicadas pelo `db-init`:

```bash
# opção: dump só dados (sem schema) — só se o schema na VPS já for idêntico
# docker exec joao_guerreiro-postgres pg_dump -U joao_guerreiro --data-only --no-owner --no-acl joao_guerreiro > dados.sql
```

---

## 3) Depois do restore

- Confirma que `credentials/backend.joaog-v2.env` na VPS tem o mesmo utilizador/senha/base que o Compose.
- Sobe o resto da stack se ainda não estiver:  
  `docker compose -f config/vps-isolated/docker-compose.joaog-v2.yml --env-file config/vps-isolated/.env up -d --build`

---

## Notas

- `--no-owner --no-acl` evita conflitos de roles entre `joao_guerreiro` (local) e `joaog_v2` (VPS).
- `--clean --if-exists` gera `DROP` antes dos `CREATE`; útil para substituir tudo.
- Bases muito grandes: usa formato customizado (`-Fc`) e `pg_restore` em vez de SQL plano.

### Dump formato custom (opcional)

**Local:**

```powershell
docker exec joao_guerreiro-postgres pg_dump -U joao_guerreiro -Fc -f /tmp/joao.dump joao_guerreiro
docker cp joao_guerreiro-postgres:/tmp/joao.dump .\joao.dump
```

**VPS:**

```bash
docker cp ~/joao.dump joaog-v2-postgres:/tmp/joa.dump
docker exec -e PGPASSWORD="$PGPASSWORD" joaog-v2-postgres pg_restore -U joaog_v2 -d joaog_v2 --clean --if-exists --no-owner --no-acl /tmp/joa.dump
```
