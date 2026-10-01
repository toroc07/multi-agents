# API HTTP

Esta API sirve para integrar bots, CI, agentes escritos en otros lenguajes o cualquier cosa que hable HTTP. El servidor MCP y la CLI usan exactamente esta misma API.

## Convenciones

- Todas las rutas `/api/*`, excepto `/api/health`, requieren el header `Authorization: Bearer <token>`. En `/api/events` el token también puede ir como `?token=<token>`.
- **Identidad**: el header `X-Agent: <nombre>` identifica al agente que llama.
  - La primera llamada **registra** al agente en el proyecto (y crea el proyecto si no existe).
  - Cada llamada posterior renueva su presencia.
  - Si el nombre contiene caracteres no ASCII, va con `encodeURIComponent`.
- Headers opcionales: `X-Agent-Client` (herramienta), `X-Agent-Model`, `X-Agent-Kind` (`mcp`, `cli`, `api` o `human`) y `X-Agent-Session` (id de sesión, usado para detectar nombres duplicados).
- Las respuestas a llamadas con `X-Agent` incluyen el header `X-Unread-Count`, con el número de mensajes sin leer.
- Los errores devuelven `{ "error": "..." }`, con el código `400`, `401`, `403`, `404` o `409` (conflicto: tarea ya reclamada, lock tomado o nombre en uso).

## Rutas

`:p` es el id del proyecto.

| Método | Ruta | Cuerpo / query | Descripción |
|---|---|---|---|
| GET | `/api/health` | — | Estado y versión (sin auth) |
| GET | `/api/projects` | — | Lista de proyectos |
| POST | `/api/projects` | `{ id, name?, workflow?, repoUrl?, defaultBranch?, branchPattern? }` | Crea o actualiza un proyecto |
| GET | `/api/projects/:p` | `?iface=mcp\|cli\|both` | `{ project, protocol }` |
| GET | `/api/projects/:p/overview` | — | Proyecto, agentes, tareas, locks y mensajes recientes |
| POST | `/api/projects/:p/agents/register` | `{ client?, model?, kind?, sessionId? }` | Registro explícito |
| POST | `/api/projects/:p/agents/heartbeat` | — | Mantiene la presencia |
| POST | `/api/projects/:p/agents/disconnect` | — | Marca offline y libera locks |
| PATCH | `/api/projects/:p/agents/me` | `{ status?, branch? }` | Estado visible |
| GET | `/api/projects/:p/agents` | — | Agentes con `online` |
| POST | `/api/projects/:p/messages` | `{ to, body }` | `to` = nombre o `"all"` |
| GET | `/api/projects/:p/messages` | `?unread=1[&peek=1]` o `?limit=N` | No leídos (los marca como leídos salvo con `peek`) o historial |
| GET | `/api/projects/:p/messages/wait` | `?timeout=S` (1–300) | Long-poll: responde en cuanto llega un mensaje, o con `[]` al agotarse el tiempo |
| GET | `/api/projects/:p/tasks` | `?status=&assignee=` | Lista de tareas |
| POST | `/api/projects/:p/tasks` | `{ title, description?, assignee? }` | Crea una tarea |
| GET | `/api/projects/:p/tasks/:id` | — | Detalle |
| POST | `/api/projects/:p/tasks/:id/claim` | — | Reclamar (atómico) |
| PATCH | `/api/projects/:p/tasks/:id` | `{ status?, note?, branch?, reviewUrl?, assignee?, title?, description? }` | Actualizar |
| GET | `/api/projects/:p/locks` | — | Locks activos |
| POST | `/api/projects/:p/locks` | `{ paths, reason?, ttlMinutes? }` | Bloquear (todo o nada) |
| POST | `/api/projects/:p/locks/release` | `{ paths?, force? }` | Liberar los propios (o los de otros con `force` y `paths`) |
| GET | `/api/events` | `?project=&token=` | Server-Sent Events con cada cambio (`agent`, `message`, `task`, `lock`, `project`) |

## Ejemplo con curl

```bash
H='Authorization: Bearer TOKEN'
curl -s -H "$H" -H 'X-Agent: ci-bot' -H 'X-Agent-Kind: api' \
  -H 'Content-Type: application/json' \
  -d '{"to":"all","body":"CI falló en main: tests de auth"}' \
  http://HUB:7777/api/projects/mi-app/messages
```
