# Deploy VPS — instância isolada `joaog-v2`

Esta stack foi desenhada para correr **em paralelo** com outra instância na mesma VPS (ex.: `guerreiros-*`), sem partilhar containers, volumes, redes nem portas padrão.

## O que fica isolado

| Recurso | Prefixo / nome |
|--------|----------------|
| Projeto Compose | `joaog-v2` |
| Rede | `joaog-v2-internal` |
| Containers | `joaog-v2-postgres`, `joaog-v2-redis`, … |
| Volumes Docker | `joaog_v2_postgres_data`, … |
| Filas RabbitMQ (env app) | `joaog-v2-messages`, `joaog-v2-ai-requests`, … |
| Base de dados Postgres | `joaog_v2` |
| Portas no host | ver secção abaixo |

## Portas no host (ajuste se necessário)

| Host | Serviço |
|------|---------|
| **8080** | HTTP (Nginx → frontend) |
| **8443** | HTTPS (Nginx, se existir `ssl/origin.pem` e `ssl/origin.key`) |
| **19000** | MinIO API |
| **19001** | MinIO Console |
| **25672** | RabbitMQ Management UI |

Postgres, Redis e Qdrant **não** expõem portas no host (apenas rede interna Docker), o que reduz conflitos e superfície de ataque.

## Passos na VPS

### 1. Clonar / atualizar o repositório

```bash
cd /opt
git clone https://github.com/Dialogue-Tech-AI/Joao_gueireiro.git
cd Joao_gueireiro/V1
git pull
```

### 2. Credenciais

```bash
cd config/vps-isolated
mkdir -p credentials ssl
cp joaog-v2.compose.env-example .env
cp credentials-examples/backend.joaog-v2.env-example credentials/backend.joaog-v2.env
cp credentials-examples/ai-worker.joaog-v2.env-example credentials/ai-worker.joaog-v2.env
```

Edite `.env` (senhas do Compose) e `credentials/*.env` (alinhar `DB_PASSWORD`, `RABBITMQ_PASS`, `MINIO_SECRET_KEY`, URLs, `CORS_ORIGIN`, chaves OpenAI, JWT, etc.).

### 3. SSL (opcional mas recomendado)

Coloque `origin.pem` e `origin.key` em `config/vps-isolated/ssl/` (ver `ssl/README.md`).

### 4. Subir a stack

```bash
cd /opt/Joao_gueireiro/V1
docker compose -f config/vps-isolated/docker-compose.joaog-v2.yml --env-file config/vps-isolated/.env up -d --build
```

Ver logs:

```bash
docker compose -f config/vps-isolated/docker-compose.joaog-v2.yml --env-file config/vps-isolated/.env logs -f app
```

Parar:

```bash
docker compose -f config/vps-isolated/docker-compose.joaog-v2.yml --env-file config/vps-isolated/.env down
```

## Subdomínio novo

1. No DNS do domínio (Cloudflare, Registro.br, etc.), crie um registo **A** (ou **AAAA** se for IPv6):
   - **Nome:** `novo` (ou o subdomínio desejado, ex.: `app2`)
   - **Destino:** IP público da VPS

2. Escolha um destino **na VPS**:
   - **Opção A — Proxy na VPS (recomendado):** Nginx/Caddy no host a escutar `443` e fazer `proxy_pass` para `https://127.0.0.1:8443` (se usar SSL no container) ou `http://127.0.0.1:8080`.
   - **Opção B — Só container:** apontar DNS para a VPS e, se a outra app já usa 80/443, manter apenas **8080/8443** e configurar o proxy reverso na porta 443 do host para o upstream correto.

3. Atualize `CORS_ORIGIN_DEV` no `backend.joaog-v2.env` para `https://novo.seudominio.com`.

## SSL com credenciais já existentes

- Se usa **Let's Encrypt** no host: configure o site Nginx/Caddy no host com o certificado gerido pelo ACME; o proxy encaminha para `127.0.0.1:8080` (HTTP interno).
- Se usa **certificados próprios** no container: copie PEM + KEY para `config/vps-isolated/ssl/` com os nomes `origin.pem` e `origin.key` e exponha **8443**; ou termine SSL no host e use apenas HTTP interno.

## Duas aplicações na mesma VPS

- A **outra** versão deve continuar com o seu próprio `docker-compose` e nomes de projeto/containers.
- **Não** reutilize volumes nem rede entre stacks.
- Garanta que **portas no host** são distintas (esta stack usa 8080, 8443, 19000, 19001, 25672 por defeito).

Repositório: [Dialogue-Tech-AI/Joao_gueireiro](https://github.com/Dialogue-Tech-AI/Joao_gueireiro)
