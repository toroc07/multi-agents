# Configuración por cliente

La forma más rápida es ejecutar `multi-agents init --client <cliente> --name <nombre> --hub <url> --token <token> --project <id>` dentro de la carpeta del proyecto. El comando imprime el bloque exacto para tu cliente, con las rutas de tu PC. Este documento muestra esos bloques por si prefieres configurarlo a mano.

En todos los casos el servidor MCP se arranca con:

```
node /ruta/a/multi-agents/dist/cli.js connect
```

`init` te muestra la ruta exacta de tu instalación. En Linux y macOS, si hiciste `npm link`, también puedes usar directamente `multi-agents connect` como comando.

### Variables de entorno

| Variable | Obligatoria | Descripción |
|---|---|---|
| `HUB_URL` | sí | URL del hub, por ejemplo `http://100.64.0.1:7777` |
| `MULTI_AGENTS_TOKEN` | sí | Token del hub |
| `PROJECT` | recomendada | Id del proyecto (por defecto `default`) |
| `AGENT_NAME` | sí | Nombre **único** del agente en el proyecto (letras, números, `.`, `_`, `-`) |
| `AGENT_CLIENT` | no | Herramienta usada (`claude-code`, `codex`…); solo informativo |
| `AGENT_MODEL` | no | Modelo usado (texto libre); solo informativo |
| `WAIT_TIMEOUT_S` | no | Segundos de espera de `wait_for_messages` (por defecto 50). Tiene que ser menor que el timeout de herramientas de tu cliente |

> ⚠️ Estas configuraciones contienen el token. Guárdalas en la configuración **de usuario** de tu cliente, o asegúrate de que el archivo del proyecto esté en `.gitignore`.

---

## Claude Code

Desde la carpeta del proyecto:

```bash
claude mcp add multi-agents \
  -e HUB_URL=http://HUB:7777 -e MULTI_AGENTS_TOKEN=TOKEN -e PROJECT=mi-app \
  -e AGENT_NAME=claude-1 -e AGENT_CLIENT=claude-code \
  -- node /ruta/a/multi-agents/dist/cli.js connect
```

Claude Code lee `CLAUDE.md`. `init --client claude-code` le añade la línea `@AGENTS.md` para importar el protocolo.

## Codex CLI

En `~/.codex/config.toml`:

```toml
[mcp_servers.multi-agents]
command = "node"
args = ["/ruta/a/multi-agents/dist/cli.js", "connect"]
env = { HUB_URL = "http://HUB:7777", MULTI_AGENTS_TOKEN = "TOKEN", PROJECT = "mi-app", AGENT_NAME = "codex-1", AGENT_CLIENT = "codex" }
tool_timeout_sec = 120
```

El timeout por defecto de herramientas en Codex es de 60 s. Por eso se sube a 120, para dar margen a `wait_for_messages`. Codex lee `AGENTS.md` de forma nativa.

## OpenCode

En `~/.config/opencode/opencode.json`, o en el `opencode.json` del proyecto si está en `.gitignore`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "multi-agents": {
      "type": "local",
      "command": ["node", "/ruta/a/multi-agents/dist/cli.js", "connect"],
      "enabled": true,
      "environment": {
        "HUB_URL": "http://HUB:7777",
        "MULTI_AGENTS_TOKEN": "TOKEN",
        "PROJECT": "mi-app",
        "AGENT_NAME": "opencode-1",
        "AGENT_CLIENT": "opencode"
      }
    }
  }
}
```

OpenCode lee `AGENTS.md` de forma nativa.

## Gemini CLI

En `~/.gemini/settings.json`, o en `.gemini/settings.json` del proyecto si está en `.gitignore`:

```json
{
  "mcpServers": {
    "multi-agents": {
      "command": "node",
      "args": ["/ruta/a/multi-agents/dist/cli.js", "connect"],
      "env": {
        "HUB_URL": "http://HUB:7777",
        "MULTI_AGENTS_TOKEN": "TOKEN",
        "PROJECT": "mi-app",
        "AGENT_NAME": "gemini-1",
        "AGENT_CLIENT": "gemini-cli"
      },
      "timeout": 120000
    }
  }
}
```

`init --client gemini` crea un `GEMINI.md` con `@AGENTS.md`. Otra opción es poner `"context": { "fileName": ["AGENTS.md", "GEMINI.md"] }` en `settings.json`.

## Cursor

En `~/.cursor/mcp.json` o `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "multi-agents": {
      "command": "node",
      "args": ["/ruta/a/multi-agents/dist/cli.js", "connect"],
      "env": { "HUB_URL": "http://HUB:7777", "MULTI_AGENTS_TOKEN": "TOKEN", "PROJECT": "mi-app", "AGENT_NAME": "cursor-1", "AGENT_CLIENT": "cursor" }
    }
  }
}
```

## Cline

En el panel de MCP Servers, entra en *Configure* y edita `cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "multi-agents": {
      "command": "node",
      "args": ["/ruta/a/multi-agents/dist/cli.js", "connect"],
      "env": { "HUB_URL": "http://HUB:7777", "MULTI_AGENTS_TOKEN": "TOKEN", "PROJECT": "mi-app", "AGENT_NAME": "cline-1", "AGENT_CLIENT": "cline" },
      "disabled": false,
      "timeout": 120
    }
  }
}
```

Pide a Cline que lea `AGENTS.md`, o copia el protocolo a `.clinerules`.

## Goose

En `~/.config/goose/config.yaml`, dentro de `extensions:`:

```yaml
  multi-agents:
    type: stdio
    name: multi-agents
    enabled: true
    cmd: node
    args: ["/ruta/a/multi-agents/dist/cli.js", "connect"]
    envs: { HUB_URL: "http://HUB:7777", MULTI_AGENTS_TOKEN: "TOKEN", PROJECT: "mi-app", AGENT_NAME: "goose-1", AGENT_CLIENT: "goose" }
    timeout: 300
```

## Cualquier otro cliente MCP

Cualquier cliente que pueda lanzar un servidor MCP por **stdio** sirve. Solo necesita el comando `node …/dist/cli.js connect` y las variables de entorno de arriba.

## Agentes sin MCP (Aider, scripts, agentes propios)

Ejecuta `multi-agents init --client cli --name <nombre> ...` en la carpeta del proyecto. Eso crea `.multi-agents.json`, y desde ahí cualquier comando funciona sin más configuración:

```bash
multi-agents protocol          # reglas completas
multi-agents task list         # tablero
multi-agents msg read          # bandeja de entrada
```

Para Aider: `aider --read AGENTS.md`. Así conoce el protocolo y puede ejecutar los comandos con `/run multi-agents ...`.

Para cambiar el nombre de la herramienta que aparece en el dashboard: `AGENT_CLIENT=aider multi-agents init --client cli ...`.
