# multi-agents

[![CI](https://github.com/toroc07/multi-agents/actions/workflows/ci.yml/badge.svg)](https://github.com/toroc07/multi-agents/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)
[![MCP](https://img.shields.io/badge/MCP-compatible-6E56CF)](https://modelcontextprotocol.io)

**Haz que varios agentes de IA trabajen juntos, en paralelo, sobre el mismo proyecto, en una sola PC o en varias.**

![Dashboard de multi-agents con varios agentes coordinándose](docs/images/dashboard.png)

Claude Code, Codex, OpenCode, Gemini CLI, Aider o un script propio: da igual qué agente use cada puesto, ni si están en la misma PC o en máquinas distintas. Con `multi-agents` todos se conectan a un **hub** común donde pueden:

- 💬 **Enviarse mensajes** directos o a todos (`all`).
- ❓ **Preguntar y decidir a través del hub**: cuando un agente necesita una decisión, la pregunta (con opciones) llega a quien hizo el pedido, aunque esté en otra PC o en el dashboard, en vez de quedarse esperando en una consola que nadie mira.
- 📋 **Repartirse el trabajo** en un tablero de tareas (crear, reclamar de forma atómica, pasar a revisión, revisar y cerrar).
- 🔒 **Bloquear archivos o carpetas** antes de editarlos para no pisarse.
- 👀 **Verse entre ellos**: quién está conectado, con qué herramienta y modelo, en qué rama y qué está haciendo. El estado se actualiza solo según lo que hace cada agente.
- 📢 **Enterarse de todo**: el hub anuncia a todos los cambios de las tareas y guarda un historial de actividad (tareas, bloqueos, conflictos, conexiones).
- 🖥️ **Seguir todo en un dashboard web** en vivo, desde donde los humanos también pueden mandar mensajes, responder preguntas, crear tareas y cambiar su estado.

> **Novedades de la v0.2:** preguntas por el hub, estado automático, anuncios, historial, revisión entre agentes, rama por tarea y `init --write`. Ver el [CHANGELOG](CHANGELOG.md).

Es **agnóstico de agente y de modelo**: cualquier cliente con soporte [MCP](https://modelcontextprotocol.io) funciona sin cambios. Los que no tienen MCP pueden usar la CLI desde la terminal, y también hay una API HTTP. Funciona con **GitHub**, con **cualquier remoto git** (GitLab, Bitbucket, Gitea…) o **sin control de versiones**.

```
 PC 1: Claude Code ──MCP──┐
 PC 2: Codex       ──MCP──┤
 PC 3: OpenCode    ──MCP──┼──► HUB (HTTP) ──► Dashboard web
 PC 4: Gemini CLI  ──MCP──┤     mensajes · tareas · locks · presencia
 PC 5: Aider/otro  ──CLI──┘
```

---

## Clientes compatibles

| Cliente | Cómo se conecta | Lee `AGENTS.md` |
|---|---|---|
| Claude Code | MCP | sí, vía `CLAUDE.md` → `@AGENTS.md` (lo crea `init`) |
| Codex CLI | MCP | sí |
| OpenCode | MCP | sí |
| Gemini CLI | MCP | sí, vía `GEMINI.md` → `@AGENTS.md` (lo crea `init`) |
| Cursor | MCP | sí |
| Cline | MCP | hay que indicárselo |
| Goose | MCP | hay que indicárselo |
| Cualquier cliente MCP | MCP (stdio) | depende del cliente |
| Aider, scripts, agentes propios | CLI `multi-agents …` | `aider --read AGENTS.md` |
| Bots, CI u otros lenguajes | [API HTTP](docs/api.md) | — |

La configuración exacta de cada uno está en **[docs/clients.md](docs/clients.md)**.

---

## Requisitos

- **Node.js 20 o superior** y **git** en cada máquina que ejecute un agente.
- Si los agentes están en máquinas distintas, estas tienen que poder llegar al hub por red: la misma LAN, [Tailscale](https://tailscale.com) (recomendado), un túnel HTTPS o un VPS. Ver **[docs/setup-network.md](docs/setup-network.md)**. Si todo corre en una sola PC, basta con `localhost`.

## Instalación

```bash
git clone https://github.com/toroc07/multi-agents.git
cd multi-agents
npm install
npm link
multi-agents --version
```

`npm link` deja disponible el comando `multi-agents` en toda la máquina. Para actualizar más adelante: `git pull && npm install`.

> En PowerShell, si aparece *"la ejecución de scripts está deshabilitada"*, ejecuta una vez `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, o usa `multi-agents.cmd` en su lugar.

---

## Inicio rápido

### 1. Levantar el hub

En la máquina que hará de hub:

```bash
multi-agents hub --token "un-secreto-largo"
```

Verás las URLs del hub y el enlace al dashboard (`http://<ip>:7777/#token=...`). Si hay agentes en otras máquinas, necesitan **la URL y el token**; compártelos solo por un canal privado. Si no pasas `--token`, se genera uno al azar.

Opcionalmente, crea el proyecto con su flujo de trabajo. Si no lo haces, se crea solo con el flujo `github` cuando entra el primer agente.

```bash
multi-agents project create mi-app --workflow github \
  --repo https://github.com/yo/mi-app --hub http://localhost:7777 --token "un-secreto-largo"
```

### 2. Conectar cada agente

Cada agente trabaja en su propia copia del proyecto (por ejemplo, un `git clone` del repo). Dentro de esa carpeta:

```bash
multi-agents init --client claude-code --name agente-1 \
  --hub http://localhost:7777 --token "un-secreto-largo" --project mi-app --write
```

El nombre (`--name`) tiene que ser único para cada agente. Si el hub está en otra máquina, usa su IP en `--hub`.

`--client` puede ser `claude-code`, `codex`, `opencode`, `gemini`, `cursor`, `cline`, `goose`, `generic-mcp` o `cli`. El comando:

1. Crea `.multi-agents.json` con tu configuración local y lo añade a `.gitignore`. Es **el único archivo que contiene el token**.
2. Escribe o actualiza `AGENTS.md` con el **protocolo de colaboración**. Haz commit de este archivo para que todos los agentes lo lean.
3. Con `--write`, **configura el cliente directamente**:
   - Claude Code: `claude mcp add`;
   - Codex: `~/.codex/config.toml`;
   - OpenCode, Gemini y Cursor: su archivo JSON del proyecto, respetando lo que ya tuviera y guardando una copia `.bak`.

   Sin `--write` (o para Cline y Goose), te muestra el bloque para pegarlo a mano.

La configuración del cliente solo apunta a `.multi-agents.json` (`multi-agents connect --config …`), así que no contiene secretos.

### 3. A trabajar

Abre tu agente en la carpeta del proyecto y dale una instrucción como:

> "Revisa el tablero de multi-agents, reclama una tarea y empieza. Coordínate con los demás agentes."

Cada agente:

- reclama **una tarea a la vez**;
- bloquea los archivos que va a tocar;
- trabaja en **una rama por tarea** (`agent/<nombre>/task-<id>`);
- al terminar, la pasa a revisión y abre un PR;
- otro agente la revisa y la cierra, o la devuelve con cambios.

El hub anuncia cada paso a los demás. Si un agente necesita una decisión, **te pregunta por el hub** y tú respondes desde el dashboard con un clic. Cuando no tiene nada que hacer, espera mensajes nuevos con `wait_for_messages`.

---

## Herramientas que recibe cada agente (MCP)

| Herramienta | Para qué sirve |
|---|---|
| `whoami`, `get_project` | Identidad, proyecto, flujo de trabajo y protocolo completo |
| `list_agents`, `set_status` | Quién está conectado y en qué anda cada uno (el estado se actualiza solo; `set_status` añade detalle) |
| `send_message`, `read_messages`, `wait_for_messages` | Mensajería (directa o a `all`) con espera activa; `reply_to` responde a una pregunta |
| `ask` | Pregunta o pide una decisión **por el hub**, con opciones, y espera la respuesta |
| `list_tasks`, `get_task`, `create_task`, `claim_task`, `update_task` | Tablero de tareas: `open → claimed → in_progress → review → done` / `blocked` |
| `lock_files`, `unlock_files`, `list_locks` | Reservas de archivos o carpetas (todo o nada, con caducidad) |

Cada respuesta incluye un aviso **"📬 You have N unread messages"**, así los agentes se enteran de los mensajes aunque estén ocupados en otra cosa.

Los agentes sin MCP tienen los mismos comandos en la CLI:

```bash
multi-agents status "Implementando #3"       multi-agents agents
multi-agents msg send all "Terminé el login"  multi-agents msg read        multi-agents msg wait
multi-agents ask "¿Qué validación añado?" --options "Lanzar error|Devolver null"
multi-agents msg send --reply-to 12 "Lanzar error"
multi-agents task list --status open          multi-agents task claim 3    multi-agents task update 3 --status review --review-url <url>
multi-agents lock src/auth --reason "#3"      multi-agents unlock          multi-agents locks
multi-agents protocol
```

Ejecuta `multi-agents help` para ver la lista completa.

---

## Flujos de trabajo por proyecto

| `--workflow` | Para qué | Qué les indica a los agentes |
|---|---|---|
| `github` *(por defecto)* | Repos en GitHub | Una rama por tarea (`agent/<nombre>/task-<id>`), PR a `main` con `gh pr create`, enlace del PR en la tarea |
| `git` | GitLab, Bitbucket, Gitea, servidor propio… | Igual, pero con merge request o el flujo de revisión que use el equipo |
| `none` | Sin control de versiones (carpeta compartida, Syncthing, unidad de red) | Bloqueo **obligatorio** antes de editar y avisar al cambiar archivos compartidos |

Otras opciones de `project create` / `project update`:
- `--default-branch`: la rama base (por defecto `main`).
- `--branch-pattern`: el nombre de las ramas; admite `{agent}` y `{task}`. Por ejemplo `"agent/{agent}"`, si prefieres una rama por agente.
- `--max-active-tasks`: cuántas tareas puede tener a la vez cada agente (por defecto 1; 0 = sin límite).

El hub **no** llama a la API de GitHub ni de ningún proveedor: la integración es solo de protocolo y enlaces. Detalles en **[docs/protocol.md](docs/protocol.md)**.

---

## Seguridad

- Todo el acceso a la API requiere el **token del hub**. Trátalo como una contraseña.
- Todos los agentes comparten el mismo token, así que cualquiera que lo tenga puede actuar con cualquier nombre de agente. Compártelo solo con quien sea de confianza.
- El tráfico va por **HTTP**. Para conectar PCs por internet usa **Tailscale** o un túnel HTTPS (ngrok, Cloudflare Tunnel) en lugar de abrir el puerto directamente. Ver [docs/setup-network.md](docs/setup-network.md).
- El token solo se guarda en `.multi-agents.json`, que `init` añade a `.gitignore`. **No lo subas a git.** Las configuraciones MCP generadas por `init` no contienen secretos.
- Los mensajes, tareas y locks se guardan en texto plano en `data/hub-state.json`, en la máquina del hub.

---

## Desarrollo

```bash
npm install
npm run build        # compila a dist/
npm test             # compila y ejecuta los tests unitarios y e2e (hub + agentes MCP y CLI reales)
npm run hub          # hub local con token generado
```

Estructura:

```
src/
  cli.ts             entrada de la CLI (hub, connect, init y comandos de agente)
  config.ts          configuración (variables de entorno / .multi-agents.json / --config)
  init.ts            asistente de configuración por cliente (--write)
  fileEdit.ts        edición segura de JSON, TOML, .gitignore y AGENTS.md (respeta CRLF/LF)
  hub/               servidor HTTP, estado, historial, persistencia y dashboard
  bridge/            cliente del hub, servidor MCP y comandos CLI
  shared/            tipos, rutas, actividad y protocolo de colaboración
test/                tests unitarios, de init y e2e (vitest)
docs/                documentación
```

## Licencia

[MIT](LICENSE)
