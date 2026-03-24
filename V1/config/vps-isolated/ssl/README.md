# SSL (certificados do frontend Nginx)

Coloque aqui os ficheiros esperados pelo `docker-entrypoint` do frontend:

- `origin.pem` — certificado (cadeia completa, se aplicável)
- `origin.key` — chave privada

Com estes ficheiros presentes, o contentor ativa `nginx-ssl.conf` e escuta HTTPS na porta **8444** no host (mapeamento `8444:443`).

Sem certificados, apenas HTTP na porta **8081** no host fica disponível (útil para testes atrás de um reverse proxy que termina SSL).

**Permissões:** `chmod 600 origin.key` recomendado.
