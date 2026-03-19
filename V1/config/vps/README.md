# Deploy VPS Ubuntu

Compose unificado para subir a Plataforma Guerreiros na VPS com todas as dependências.

## Pré-requisitos

- Ubuntu 22.04+ com Docker e Docker Compose instalados
- Use `setup-vps.sh` para instalar: `bash setup-vps.sh`

## Configuração

1. **Crie a pasta credentials e copie os exemplos:**
   ```bash
   mkdir -p config/vps/credentials
   cp config/vps/credentials-examples/*.env-example config/vps/credentials/
   cd config/vps/credentials
   mv backend.vps.env-example backend.vps.env
   mv ai-worker.vps.env-example ai-worker.vps.env
   mv whatsapp-service.vps.env-example whatsapp-service.vps.env
   ```

2. **Edite os arquivos e preencha as chaves:**
   - `backend.vps.env` - OPENAI_API_KEY_DEV, JWT_SECRET_DEV, CORS_ORIGIN_DEV, WHATSAPP tokens
   - `ai-worker.vps.env` - OPENAI_API_KEY

## Deploy

```bash
# Na raiz do projeto (Guerreros/V1)
docker compose -f config/vps/docker-compose.vps.yml up -d --build

# Primeira vez - migrations e seed
docker compose -f config/vps/docker-compose.vps.yml exec app npm run migration:run
docker compose -f config/vps/docker-compose.vps.yml exec app npm run seed:run
```

## Cloudflare

Configure o DNS A record apontando para o IP da VPS (porta 80) e ative o proxy (nuvem laranja) para SSL automático.
