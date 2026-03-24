"""Configuration settings for AI Worker"""
import os
from urllib.parse import urlparse, urlunparse

from dotenv import load_dotenv
from pydantic_settings import BaseSettings
from typing import Optional


def _swap_url_host_if_localhost(url: str, new_host: str) -> str:
    """Compose VPS: env copiado do PC com localhost → nome do serviço Docker."""
    if not url:
        return url
    try:
        p = urlparse(url)
    except ValueError:
        return url
    if p.hostname not in ("localhost", "127.0.0.1", "::1"):
        return url
    user = p.username or ""
    password = p.password or ""
    port = p.port
    if password:
        auth = f"{user}:{password}"
    elif user:
        auth = user
    else:
        auth = ""
    if auth:
        netloc = f"{auth}@{new_host}:{port}" if port else f"{auth}@{new_host}"
    else:
        netloc = f"{new_host}:{port}" if port else new_host
    return urlunparse((p.scheme, netloc, p.path, p.params, p.query, p.fragment))


def _apply_vps_docker_network_overrides() -> None:
    if os.getenv("JOAO_VPS_DOCKER_NETWORK") != "1":
        return
    pg = os.getenv("POSTGRES_URL", "")
    if pg:
        os.environ["POSTGRES_URL"] = _swap_url_host_if_localhost(pg, "postgres")
    amqp = os.getenv("RABBITMQ_URL", "")
    if amqp:
        os.environ["RABBITMQ_URL"] = _swap_url_host_if_localhost(amqp, "rabbitmq")
    rh = os.getenv("REDIS_HOST", "")
    if rh in ("localhost", "127.0.0.1", "::1"):
        os.environ["REDIS_HOST"] = "redis"
    qh = os.getenv("QDRANT_HOST", "")
    if qh in ("localhost", "127.0.0.1", "::1"):
        os.environ["QDRANT_HOST"] = "qdrant"

# Procurar ai-worker.local.env / ai-worker.prod.env em config/local ou config/server (relativo a core/services/ai-worker)
_current_dir = os.path.dirname(os.path.abspath(__file__))       # ai-worker/config
_ai_worker_root = os.path.dirname(_current_dir)                 # ai-worker/
_project_root = os.path.dirname(os.path.dirname(os.path.dirname(_ai_worker_root)))  # services->core->project
_local_env = os.path.join(_project_root, 'config', 'local', 'credentials', '.env', 'ai-worker.local.env')
_server_env = os.path.join(_project_root, 'config', 'server', 'credentials', '.env', 'ai-worker.prod.env')
_fallback_env = os.path.join(_ai_worker_root, '.env')

_env_file_path = _local_env
if os.getenv('IS_PRODUCTION', '').lower() in ('true', '1', 'yes'):
    _env_file_path = _server_env
if not os.path.exists(_env_file_path) and os.path.exists(_server_env):
    _env_file_path = _server_env
if not os.path.exists(_env_file_path) and os.path.exists(_fallback_env):
    _env_file_path = _fallback_env
if not os.path.exists(_env_file_path):
    _env_file_path = _local_env

# No Docker (Compose env_file), o path do monorepo não existe em /app — só usar variáveis injectadas.
_in_docker = os.path.exists("/.dockerenv") or os.getenv("JOAO_VPS_DOCKER_NETWORK") == "1"
_env_file_for_pydantic = (
    _env_file_path if (not _in_docker and os.path.isfile(_env_file_path)) else None
)
if _env_file_for_pydantic:
    load_dotenv(_env_file_for_pydantic)

_apply_vps_docker_network_overrides()


class Settings(BaseSettings):
    """Application settings"""
    
    # RabbitMQ
    rabbitmq_url: str = os.getenv('RABBITMQ_URL', 'amqp://altese:altese123@127.0.0.1:5672/')

    # AWS SQS (when USE_SQS=true)
    use_sqs: bool = os.getenv('USE_SQS', 'false').lower() == 'true'
    sqs_queue_ai_messages_url: Optional[str] = os.getenv('SQS_QUEUE_AI_MESSAGES_URL')
    sqs_queue_ai_responses_url: Optional[str] = os.getenv('SQS_QUEUE_AI_RESPONSES_URL')
    sqs_queue_function_call_process_url: Optional[str] = os.getenv('SQS_QUEUE_FUNCTION_CALL_PROCESS_URL')
    sqs_queue_function_call_response_url: Optional[str] = os.getenv('SQS_QUEUE_FUNCTION_CALL_RESPONSE_URL')
    aws_region: str = os.getenv('AWS_REGION', 'us-east-1')
    
    # PostgreSQL
    postgres_url: str = os.getenv('POSTGRES_URL', 'postgresql://altese:altese123@localhost:5432/altese_autopecas')
    
    # Redis
    redis_host: str = os.getenv('REDIS_HOST', 'localhost')
    redis_port: int = int(os.getenv('REDIS_PORT', '6379'))
    redis_password: Optional[str] = os.getenv('REDIS_PASSWORD')
    redis_db: int = int(os.getenv('REDIS_DB', '0'))
    
    # Qdrant
    qdrant_host: str = os.getenv('QDRANT_HOST', 'localhost')
    qdrant_port: int = int(os.getenv('QDRANT_PORT', '6333'))
    
    # OpenAI
    openai_api_key: str = os.getenv('OPENAI_API_KEY', '')
    openai_model: str = os.getenv('OPENAI_MODEL', 'gpt-4o-mini')
    
    # Node.js API
    node_api_url: str = os.getenv('NODE_API_URL', 'http://localhost:3000')
    internal_api_key: str = os.getenv('INTERNAL_API_KEY', '')

    # Cost reporting (USD -> BRL)
    usd_brl_rate: float = float(os.getenv('USD_BRL_RATE', '5.5'))
    
    # LangChain
    langchain_tracing_v2: bool = os.getenv('LANGCHAIN_TRACING_V2', 'false').lower() == 'true'
    langchain_api_key: Optional[str] = os.getenv('LANGCHAIN_API_KEY')
    langchain_project: str = os.getenv('LANGCHAIN_PROJECT', 'altese-ai')
    
    # Logging
    log_level: str = os.getenv('LOG_LEVEL', 'INFO')
    
    class Config:
        env_file = _env_file_for_pydantic
        case_sensitive = False
        extra = "ignore"  # Ignorar campos extras do .env (que são do Node.js)


# Global settings instance
settings = Settings()
