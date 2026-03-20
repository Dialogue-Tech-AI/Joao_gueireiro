# SSL na VPS (Cloudflare Full/Full Strict)

Para usar **Full** ou **Full (Strict)** no Cloudflare (sem Flexible), o servidor precisa de HTTPS.

## 1. Obter credenciais Cloudflare

1. Cloudflare Dashboard → **Profile** (icone) → **API Tokens**
2. Em **API Keys**, copie a **Origin CA Key** (comeca com `v1.0-`)
3. Crie um **API Token** com permissoes:
   - `Zone:Read`
   - `Zone Settings:Edit`

## 2. Gerar Origin Certificate na VPS

```bash
cd ~/Guerreiros/V1
git pull origin master

# Exportar a chave (substitua pela sua)
export CLOUDFLARE_ORIGIN_CA_KEY="v1.0-SUA_CHAVE_AQUI"

# Rodar o script (cria /root/Guerreiros/ssl/origin.pem e origin.key)
chmod +x config/vps/scripts/create-origin-cert.sh
./config/vps/scripts/create-origin-cert.sh
```

Tambem funciona em comando unico:
```bash
cd ~/Guerreiros/V1 && CLOUDFLARE_ORIGIN_CA_KEY="v1.0-SUA_CHAVE_AQUI" ./config/vps/scripts/create-origin-cert.sh
```

## 3. Configurar Cloudflare para strict e HTTPS (opcional via CLI)

```bash
cd ~/Guerreiros/V1
chmod +x config/vps/scripts/configure-cloudflare-ssl.sh
CLOUDFLARE_API_TOKEN="SEU_TOKEN" CLOUDFLARE_ZONE_NAME="dialoguetech.com.br" ./config/vps/scripts/configure-cloudflare-ssl.sh
```

Comando unico:
```bash
cd ~/Guerreiros/V1 && CLOUDFLARE_API_TOKEN="SEU_TOKEN" CLOUDFLARE_ZONE_NAME="dialoguetech.com.br" ./config/vps/scripts/configure-cloudflare-ssl.sh
```

## 4. Subir os containers

```bash
cd ~/Guerreiros/V1
docker compose -f docker-compose.vps.yml down
docker compose -f docker-compose.vps.yml up -d --build
```

## 5. Cloudflare (manual)

- SSL/TLS → Overview → **Full** ou **Full (Strict)**
