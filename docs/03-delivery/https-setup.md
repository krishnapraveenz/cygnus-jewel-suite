# HTTPS / TLS on the Shop LAN

By default, Cygnus runs plain HTTP on the shop's internal LAN. This is acceptable for
trusted networks behind a router/firewall (no internet exposure). If you want TLS
(encrypted traffic), the simplest approach is a **reverse proxy**.

---

## Option A: Caddy (recommended — auto-TLS, zero config)

Install Caddy on the server PC and point it at the backend:

```
# /etc/caddy/Caddyfile (or wherever Caddy reads its config)
https://192.168.1.10 {
    reverse_proxy 127.0.0.1:8787
    tls internal              # auto-generates a self-signed cert for the LAN IP
}
```

Then set `BIND_ADDR=127.0.0.1:8787` (backend only listens on localhost; Caddy fronts it).
Clients connect to `https://192.168.1.10` instead of `http://…:8787`.

Counter PCs will see a browser "self-signed cert" warning once — accept it (or install the
Caddy root CA on each machine for a clean experience).

---

## Option B: nginx

```nginx
# /etc/nginx/conf.d/cygnus.conf
server {
    listen 443 ssl;
    server_name 192.168.1.10;

    ssl_certificate     /etc/nginx/certs/cygnus.crt;
    ssl_certificate_key /etc/nginx/certs/cygnus.key;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

Generate a self-signed cert:
```bash
openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
  -keyout /etc/nginx/certs/cygnus.key \
  -out /etc/nginx/certs/cygnus.crt \
  -subj "/CN=192.168.1.10"
```

---

## Option C: Built-in TLS (future)

A `--tls` flag with rustls + auto-generated self-signed cert is planned but not yet
implemented. For now, use a reverse proxy — it's production-standard and separates
concerns (the app handles business logic; the proxy handles TLS termination).

---

## When is HTTPS needed?

- **Not needed** for a shop LAN behind a firewall where only trusted staff PCs are
  connected. Auth tokens are session-based and short-lived (12h).
- **Recommended** if the server is on a shared office network, or if you're tunnelling
  over the internet (e.g., remote management).
- **Required** if you ever expose the backend to the public internet (but that's
  explicitly not the current deployment model).
