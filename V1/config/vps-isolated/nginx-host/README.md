# Nginx no host (subdomínio → stack João Guerreiro)

O `docker-compose.vps.yml` publica o frontend em **8081** (HTTP) e **8444** (HTTPS no contentor). Com **Cloudflare** (proxy laranja), a origem costuma ser contactada em **443**. Este Nginx no **host**:

- escuta **80** e **443**;
- termina SSL;
- envia tudo para **`http://127.0.0.1:8081`** (contentor `joao_guerreiro-frontend`), que já faz proxy de `/api` e `/socket.io`.

Ficheiros:

- **`joao-guerreiro.conf`** — Nginx no **host** (443 livre): `server_name` = `atendimento-joaoguerreiro.dialoguetech.com.br` → `127.0.0.1:8081`.
- **`joao-guerreiro-vhost-shared-443.conf`** — mesmo subdomínio quando a **443 já está** noutro contentor (ex.: `guerreiros-frontend`): proxy para `172.17.0.1:8081` (ajustar paths SSL).
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

---

## Quando a 443 já está noutro contentor (ex.: `guerreiros-frontend`)

Neste cenário **não** podes instalar Nginx no host na mesma porta 443. O tráfego HTTPS entra no Nginx **dentro** do contentor que já publica `80` e `443`. Esse Nginx escolhe o site pelo header `Host`; sem um `server_name` para `atendimento-joaoguerreiro.dialoguetech.com.br`, o pedido cai no *default* (ex.: login do Fabio).

1. Garante que o João está a ouvir no host em **8081** (`docker ps` → `0.0.0.0:8081->80` no `joao_guerreiro-frontend`).

2. No contentor que serve a 443, descobre onde estão os certificados SSL de um vhost que já funcione:

   ```bash
   docker exec guerreiros-frontend sh -c "grep -R ssl_certificate /etc/nginx/ 2>/dev/null | head -20"
   ```

3. Copia o ficheiro **`joao-guerreiro-vhost-shared-443.conf`** para esse contentor e edita **só** as linhas `ssl_certificate` / `ssl_certificate_key` para coincidirem com um vhost HTTPS válido (wildcard `*.dialoguetech.com.br` ou certificado desse subdomínio).

   ```bash
   cd /root/Joao_gueireiro/V1
   docker cp config/vps-isolated/nginx-host/joao-guerreiro-vhost-shared-443.conf guerreiros-frontend:/etc/nginx/conf.d/99-joao-guerreiro.conf
   docker exec -it guerreiros-frontend sh -c "vi /etc/nginx/conf.d/99-joao-guerreiro.conf"
   ```

4. Testar e recarregar:

   ```bash
   docker exec guerreiros-frontend nginx -t && docker exec guerreiros-frontend nginx -s reload
   ```

5. O `proxy_pass` usa **`http://172.17.0.1:8081`** (gateway Docker → host). Se der *502* ou *connection refused*, a partir do contentor confirma o IP do host:

   ```bash
   docker exec guerreiros-frontend getent hosts host.docker.internal 2>/dev/null || true
   ip -4 addr show docker0 | grep inet
   ```

   Substitui no ficheiro `172.17.0.1` pelo IP do `docker0` se for diferente, ou no `docker-compose` do Guerreiros adiciona `extra_hosts: - "host.docker.internal:host-gateway"` e usa `proxy_pass http://host.docker.internal:8081;`.

6. **Cloudflare**: registo DNS **A** ou **CNAME** para o subdomínio apontando para esta VPS; SSL na origem **Full** ou **Full (strict)** conforme o certificado na VPS.
