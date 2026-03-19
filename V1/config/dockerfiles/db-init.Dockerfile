# DB Init - Roda migrations e seed antes do app subir
# Contexto do build = ./core (preserva services/ e shared/ para imports cruzados)
FROM node:20-alpine

WORKDIR /app

# Copiar estrutura core/ inteira (services + shared)
COPY . .

# Instalar deps do backend (inclui devDeps: ts-node, cross-env, typescript)
WORKDIR /app/services/backend
RUN npm ci

ENV NODE_ENV=development
ENV NODE_PATH=/app/services/backend/node_modules
ENV DOTENV_PATH=/dev/null

CMD ["sh", "-c", "node -r ts-node/register scripts/db/run-migrations.ts && TS_NODE_PROJECT=tsconfig.seed.json node -r ts-node/register scripts/seed/index.ts"]
