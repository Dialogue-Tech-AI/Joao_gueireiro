# Certificados SSL - Cloudflare Full (Strict)

Para usar Cloudflare em modo **Full** ou **Full (Strict)**, coloque aqui o **Cloudflare Origin Certificate**.

## Como obter

1. Cloudflare Dashboard → seu domínio → **SSL/TLS** → **Origin Server**
2. Clique em **Create Certificate**
3. Deixe os valores padrão (RSA, 15 anos)
4. Salve:
   - **Origin Certificate** → salve como `origin.pem`
   - **Private Key** → salve como `origin.key`
5. Copie os arquivos para esta pasta:
   ```bash
   # Na VPS:
   mkdir -p ~/Guerreiros/V1/config/vps/ssl
   # Cole o conteúdo do certificado em origin.pem
   # Cole o conteúdo da chave privada em origin.key
   ```
6. Reinicie o frontend:
   ```bash
   docker compose -f docker-compose.vps.yml up -d --build frontend
   ```
