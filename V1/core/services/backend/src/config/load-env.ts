import dotenv from 'dotenv';
import path from 'path';
import { existsSync } from 'fs';

function getProjectRoot(): string {
  // From core/services/backend/src/config/load-env.ts → project root
  const backendConfigDir = __dirname;
  return path.resolve(backendConfigDir, '../../../../../');
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'sim', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'nao', 'off'].includes(normalized)) return false;
  return undefined;
}

/**
 * Aplica a lógica de seleção de ambiente (development/production)
 * em cima de um único arquivo `.env`, usando o padrão:
 *
 *   VAR_DEV=...
 *   VAR_PROD=...
 *   IS_PRODUCTION=true|false
 *
 * O valor efetivo de `VAR` é escolhido com base em `IS_PRODUCTION`
 * e exposto em `process.env.VAR` para o resto da aplicação.
 */
export function applyEnvMode(env: NodeJS.ProcessEnv = process.env): void {
  const explicitFlag = parseBoolean(env.IS_PRODUCTION);
  const isProduction = explicitFlag !== undefined ? explicitFlag : env.NODE_ENV === 'production';

  // Garante NODE_ENV coerente com o flag booleano
  env.NODE_ENV = isProduction ? 'production' : (env.NODE_ENV || 'development');

  type Pair = { dev?: string; prod?: string };
  const pairs: Record<string, Pair> = {};

  // Descobre todos os pares XXX_DEV / XXX_PROD existentes
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === '') continue;

    if (key.endsWith('_DEV')) {
      const base = key.slice(0, -4);
      if (!pairs[base]) pairs[base] = {};
      pairs[base].dev = value;
    } else if (key.endsWith('_PROD')) {
      const base = key.slice(0, -5);
      if (!pairs[base]) pairs[base] = {};
      pairs[base].prod = value;
    }
  }

  // Para cada base, escolhe o valor adequado e o expõe em env[base]
  for (const [base, pair] of Object.entries(pairs)) {
    const current = env[base];
    let selected: string | undefined;

    if (isProduction) {
      if (pair.prod !== undefined) {
        selected = pair.prod;
      } else if (pair.dev !== undefined) {
        // VPS/Docker: um único ficheiro com só *_DEV (ex. backend.vps.env)
        selected = pair.dev;
      } else if (current !== undefined) {
        selected = current;
      }
    } else {
      if (pair.dev !== undefined) {
        selected = pair.dev;
      } else if (pair.prod !== undefined) {
        selected = pair.prod;
      } else if (current !== undefined) {
        selected = current;
      }
    }

    if (selected !== undefined) {
      env[base] = selected;
    }
  }
}

/**
 * Compose VPS (`JOAO_VPS_DOCKER_NETWORK=1`): muitos copiam `backend.local.env` com
 * DB_HOST_DEV=localhost — dentro do contentor isso é inválido. Corrige para os nomes
 * dos serviços na rede Docker.
 */
function applyDockerComposeServiceHosts(env: NodeJS.ProcessEnv): void {
  if (env.JOAO_VPS_DOCKER_NETWORK !== '1') return;

  const isLocalHost = (v: string | undefined): boolean =>
    v === 'localhost' || v === '127.0.0.1' || v === '::1';

  if (isLocalHost(env.DB_HOST)) env.DB_HOST = 'postgres';
  if (isLocalHost(env.REDIS_HOST)) env.REDIS_HOST = 'redis';
  if (isLocalHost(env.RABBITMQ_HOST)) env.RABBITMQ_HOST = 'rabbitmq';
  if (isLocalHost(env.MINIO_ENDPOINT)) env.MINIO_ENDPOINT = 'minio';
}

/**
 * Carrega o arquivo `.env` e aplica a seleção de ambiente (DEV/PROD) usando `applyEnvMode`.
 * Ordem de busca:
 *   1) DOTENV_PATH
 *   2) config/local/credentials/.env/backend.local.env
 *   3) config/server/credentials/.env/backend.prod.env
 *   4) cwd/.env
 */
export function loadEnv(fromPath?: string): void {
  if (fromPath) {
    const result = dotenv.config({ path: fromPath });
    if (result.error) {
      console.warn(`Não foi possível carregar o arquivo de ambiente em ${fromPath}:`, result.error.message);
    }
    applyEnvMode(process.env);
    applyDockerComposeServiceHosts(process.env);
    return;
  }

  const projectRoot = getProjectRoot();
  const localBackend = path.join(projectRoot, 'config', 'local', 'credentials', '.env', 'backend.local.env');
  const serverBackend = path.join(projectRoot, 'config', 'server', 'credentials', '.env', 'backend.prod.env');
  const cwdEnvPath = path.resolve(process.cwd(), '.env');

  let envFile = process.env.DOTENV_PATH;
  if (!envFile && existsSync(localBackend)) envFile = localBackend;
  if (!envFile && existsSync(serverBackend)) envFile = serverBackend;
  if (!envFile && existsSync(cwdEnvPath)) envFile = cwdEnvPath;

  if (envFile) {
    const result = dotenv.config({ path: envFile });
    if (result.error) {
      console.warn(`Não foi possível carregar o arquivo de ambiente em ${envFile}:`, result.error.message);
    }
  }
  // Docker: variáveis vêm do env_file do Compose (já em process.env); não há ficheiro no disco.

  applyEnvMode(process.env);
  applyDockerComposeServiceHosts(process.env);
}

