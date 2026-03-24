# Nginx no host (subdomínio → stack João Guerreiro)

O `docker-compose.vps.yml` (stack isolada na mesma VPS que Guerreiros) publica o frontend em **8081** (HTTP) e **8444** (HTTPS no contentor). A Cloudflare (proxy laranja) fala com a origem em **443** por defeito. Este Nginx na VPS:

- escuta **80** e **443** no host;
- termina SSL;
- envia tudo para **`http://127.0.0.1:8081`** (frontend Docker), que já faz proxy de `/api` e `/socket.io` para o backend.

## Pré-requisitos

- Stack em execução: `docker compose ... up -d` (contentor `joao_guerreiro-frontend` a ouvir em **8081** no host).
- Certificado **válido para o FQDN** do subdomínio (ex.: Let’s Encrypt ou o mesmo par `origin.pem` / `origin.key` se o cert cobrir esse nome).
- **443 livre** no host. Se outro site já usa Nginx na 443, **não** instales um segundo Nginx: acrescenta apenas um novo `server { }` ao ficheiro existente.

## Passos na VPS (Debian/Ubuntu)

1. Instalar Nginx (se ainda não existir):

   ```bash
   sudo apt update && sudo apt install -y nginx
   ```

2. Copiar certificados para um sítio legível pelo Nginx:

   ```bash
   sudo mkdir -p /etc/nginx/ssl/joao-guerreiro
   sudo cp /root/Joao_gueireiro/V1/config/vps-isolated/ssl/origin.pem /etc/nginx/ssl/joao-guerreiro/
   sudo cp /root/Joao_gueireiro/V1/config/vps-isolated/ssl/origin.key /etc/nginx/ssl/joao-guerreiro/
   sudo chmod 640 /etc/nginx/ssl/joao-guerreiro/origin.key
   sudo chown root:www-data /etc/nginx/ssl/joao-guerreiro/origin.key
   ```

   Se o certificado **não** incluir o subdomínio novo, emite um cert (ex. Certbot) para esse FQDN e aponta `ssl_certificate` / `ssl_certificate_key` para `fullchain.pem` e `privkey.pem`.

3. Criar o site a partir do exemplo:

   ```bash
   sudo nano /etc/nginx/sites-available/joao-guerreiro.conf
   ```

   Cola o conteúdo de `reverse-proxy.joao-guerreiro.conf.example` (já com `server_name atendimento-joaoguerreiro.dialoguetech.com.br`).

4. Ativar e testar:

   ```bash
   sudo ln -sf /etc/nginx/sites-available/joao-guerreiro.conf /etc/nginx/sites-enabled/
   sudo nginx -t
   sudo systemctl reload nginx
   ```

5. Cloudflare: modo SSL **Full** ou **Full (strict)**. Firewall da VPS: **80** e **443** TCP abertos para o mundo (a Cloudflare liga-se à origem).

## Teste

- `curl -I https://atendimento-joaoguerreiro.dialoguetech.com.br` deve devolver HTTP 200 ou 301 vindo do teu stack.

## Nota

Se preferires não ter Nginx no host, alternativa é **DNS só** (nuvem cinzenta) e usar `https://subdomínio:8444`, ou regras da Cloudflare para origem na porta 8444 (conforme plano).
