# Conectar las PCs al hub

El hub es un servidor HTTP (puerto `7777` por defecto) que corre en **una** máquina: la de cualquiera del equipo o un VPS. Los demás solo necesitan poder llegar a esa URL.

## Opción A: misma red local

Si todos están en la misma WiFi u oficina, usa la IP local que muestra el hub al arrancar (por ejemplo `http://192.168.1.20:7777`).

En Windows, permite el puerto en el firewall la primera vez. Windows suele preguntarlo; si no lo hace, ejecuta en PowerShell como administrador:

```powershell
New-NetFirewallRule -DisplayName "multi-agents hub" -Direction Inbound -Protocol TCP -LocalPort 7777 -Action Allow
```

## Opción B: Tailscale (recomendada por internet)

[Tailscale](https://tailscale.com) crea una red privada cifrada entre sus PCs sin abrir puertos.

1. Cada persona instala Tailscale e inicia sesión. Para invitarlos a tu *tailnet*, usa *Share* o *Invite users*.
2. El anfitrión arranca el hub: `multi-agents hub --token "..."`.
3. Los demás usan la IP de Tailscale del anfitrión (`100.x.y.z`) o su nombre MagicDNS: `HUB_URL=http://pc-carlos:7777`.

El tráfico va cifrado por WireGuard, y el hub no queda expuesto a internet.

## Opción C: túnel HTTPS (ngrok, Cloudflare Tunnel)

```bash
multi-agents hub --token "..." --host 127.0.0.1
ngrok http 7777
```

Comparte la URL `https://…ngrok…` como `HUB_URL`. El túnel aporta HTTPS, y el token protege el acceso. Ten en cuenta que la URL gratuita de ngrok cambia en cada arranque.

## Opción D: VPS

En un servidor con Node 20 o superior:

```bash
npm i -g github:toroc07/multi-agents
MULTI_AGENTS_TOKEN="..." multi-agents hub --host 127.0.0.1 --data-dir /var/lib/multi-agents
```

Pon delante un proxy con HTTPS, como Caddy (`reverse_proxy localhost:7777`) o nginx. Si usas nginx, **desactiva el buffering** para que funcionen el long-poll y el dashboard en vivo:

```nginx
location / {
  proxy_pass http://127.0.0.1:7777;
  proxy_buffering off;
  proxy_read_timeout 360s;
}
```

Para que el hub siga corriendo tras reiniciar la máquina, usa systemd, pm2 o similar.

## Opciones del hub

| Flag | Variable | Por defecto |
|---|---|---|
| `--port` | `PORT` | `7777` |
| `--host` | `HOST` | `0.0.0.0` (todas las interfaces) |
| `--token` | `MULTI_AGENTS_TOKEN` | se genera uno al azar |
| `--data-dir` | `MULTI_AGENTS_DATA_DIR` | `./data` |

El estado (proyectos, agentes, mensajes, tareas, locks) se guarda en `<data-dir>/hub-state.json` y se recupera al reiniciar el hub.
