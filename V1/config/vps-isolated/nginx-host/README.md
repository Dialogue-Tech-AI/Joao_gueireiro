# Nginx no host (subdomínio → stack João Guerreiro)

O `docker-compose.vps.yml` publica o frontend em **8081** (HTTP) e **8444** (HTTPS no contentor). Com **Cloudflare** (proxy laranja), a origem costuma ser contactada em **443**. Este Nginx no **host**:

- escuta **80** e **443**;
- termina SSL;
- envia tudo para **`http://127.0.0.1:8081`** (contentor `joao_guerreiro-frontend`), que já faz proxy de `/api` e `/socket.io`.

Ficheiros:

- **`joao-guerreiro.conf`** — configuração pronta (`server_name` = `atendimento-joaoguerreiro.dialoguetech.com.br`).
- **`install-nginx-host.sh`** — instala o pacote `nginx`, copia certs e ativa o site.

## Pré-requisitos

- Stack Docker em execução com o frontend à escuta em **8081** no host.
- `origin.pem` e `origin.key` em `config/vps-isolated/ssl/` (válidos para o FQDN ou wildcard).
- **443 livre** no host. Se já existe Nginx com outro site, não corras o script cegamente: incorpora os `server { }` de `joao-guerreiro.conf` no ficheiro principal.

## Instalação rápida (VPS, como root)

Depois de `git pull` e com o compose de pé:

```bash
chmod +x /root/Joao_gueireiro/V1/config/vps-isolated/nginx-host/install-nginx-host.sh
bash /root/Joao_gueireiro/V1/config/vps-isolated/nginx-host/install-nginx-host.sh
```

Caminho alternativo do repo:

```bash
bash /caminho/Joao_gueireiro/V1/config/vps-isolated/nginx-host/install-nginx-host.sh /caminho/Joao_gueireiro/V1
```

## Manual (sem script)

```bash
sudo apt update && sudo apt install -y nginx
sudo mkdir -p /etc/nginx/ssl/joao-guerreiro
sudo cp /root/Joao_gueireiro/V1/config/vps-isolated/ssl/origin.pem /etc/nginx/ssl/joao-guerreiro/
sudo cp /root/Joao_gueireiro/V1/config/vps-isolated/ssl/origin.key /etc/nginx/ssl/joao-guerreiro/
sudo chmod 640 /etc/nginx/ssl/joao-guerreiro/origin.key
sudo chown root:www-data /etc/nginx/ssl/joao-guerreiro/origin.key
sudo cp /root/Joao_gueireiro/V1/config/vps-isolated/nginx-host/joao-guerreiro.conf /etc/nginx/sites-available/
sudo ln -sf /etc/nginx/sites-available/joao-guerreiro.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

## Cloudflare e firewall

- SSL/TLS: **Full** ou **Full (strict)**.
- Abrir **80** e **443** TCP na VPS (origem).

## Teste

```bash
curl -sI https://atendimento-joaoguerreiro.dialoguetech.com.br
```
