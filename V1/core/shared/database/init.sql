-- Plataforma Guerreiros - PostgreSQL Initialization Script
-- Este script é executado automaticamente quando o banco é criado pela primeira vez

-- Create extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Create schema if needed
CREATE SCHEMA IF NOT EXISTS public;

-- Grant permissions
GRANT ALL PRIVILEGES ON DATABASE guerreiros TO guerreiros;
GRANT ALL PRIVILEGES ON SCHEMA public TO guerreiros;

-- Log successful initialization
DO $$
BEGIN
  RAISE NOTICE 'Plataforma Guerreiros database initialized successfully!';
END $$;
