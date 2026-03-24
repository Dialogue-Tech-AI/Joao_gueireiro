# Deploy VPS — stack `joao_guerreiro`

O ficheiro `docker-compose.vps.yml` replica os **nomes** do compose local (`config/local/dependencies/docker-compose.yml`):

- Rede: `joao_guerreiro-network`
- Contentores: `joao_guerreiro-postgres`, `joao_guerreiro-redis`, `joao_guerreiro-rabbitmq`, `joao_guerreiro-minio`, `joao_guerreiro-qdrant`, …
- Volumes nomeados: `joao_guerreiro-postgres-data`, `joao_guerreiro-redis-data`, etc.
- Utilizadores/serviços: `joao_guerreiro` (Postgres, RabbitMQ, MinIO), base `joao_guerreiro`

**Isolamento:** na mesma VPS, não podes ter dois contentores com o mesmo `container_name`. Esta stack usa `joao_guerreiro-*`; outra aplicação deve usar **outros** nomes (ex.: `guerreiros-*`). Não há sufixo extra tipo `joaog-v2` — apenas o mesmo padrão do ambiente local.

Projeto Compose: `joao-guerreiro-vps` (nome do projeto; não altera os `container_name` explícitos).

## Portas no host

| Porta | Serviço |
|--------|---------|
| 5432 | Postgres |
| 6379 | Redis |
| 5672 / 15672 | RabbitMQ (AMQP / Management) |
| 9000 / 9001 | MinIO API / Console |
| 6333 / 6334 | Qdrant |
| **8080** | Frontend HTTP |
| **8443** | Frontend HTTPS (com certificados em `ssl/`) |

Se outra stack já usar alguma destas portas, altera o mapeamento no compose.

## Passos na VPS

```bash
cd /opt/Joao_gueireiro/V1/config/vps-isolated
mkdir -p credentials ssl
cp compose.vps.env-example .env
cp credentials-examples/backend.vps.env-example credentials/backend.vps.env
cp credentials-examples/ai-worker.vps.env-example credentials/ai-worker.vps.env
nano .env
nano credentials/backend.vps.env
nano credentials/ai-worker.vps.env
```

SSL: coloca `origin.pem` e `origin.key` em `ssl/` (ver `ssl/README.md`).

```bash
cd /opt/Joao_gueireiro/V1
docker compose -f config/vps-isolated/docker-compose.vps.yml --env-file config/vps-isolated/.env up -d --build
```

Repositório: [Dialogue-Tech-AI/Joao_gueireiro](https://github.com/Dialogue-Tech-AI/Joao_gueireiro)
