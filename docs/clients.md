# Configuración por cliente

## La forma rápida: `init --write`

Dentro de la carpeta del proyecto del agente:

```bash
multi-agents init --client <cliente> --name <nombre> --hub <url> --token <token> --project <id> --write
```

- Crea **`.multi-agents.json`** con el hub, el token, el proyecto y el nombre del agente. Es el **único archivo con el token**, y `init` lo añade a `.gitignore`.
- Escribe la configuración MCP del cliente. Esa configuración no contiene secretos: solo apunta a `.multi-agents.json`.
- Respeta lo que ya tuvieran los archivos del cliente y guarda una copia `.bak` de cualquier archivo existente que modifique.
- Conserva los saltos de línea (CRLF/LF) de los archivos que toca, y se puede ejecutar varias veces sin generar cambios.

| `--client` | Qué hace `--write` |
|---|---|
| `claude-code` | Ejecuta `claude mcp add multi-agents --scope local …` (solo para esa carpeta) |
| `codex` | Escribe `[mcp_servers.multi-agents]` en `~/.codex/config.toml` (o `$CODEX_HOME/config.toml`) |
| `opencode` | Añade `mcp.multi-agents` a `opencode.json` del proyecto |
| `gemini` | Añade `mcpServers.multi-agents` a `.gemini/settings.json` del proyecto |
| `cursor` | Añade `mcpServers.multi-agents` a `.cursor/mcp.json` del proyecto |
| `cline`, `goose`, `generic-mcp` | No escribe nada: muestra el bloque para pegarlo a mano (sus rutas dependen de cada instalación) |
| `cli` | No hace falta MCP: los comandos `multi-agents …` leen `.multi-agents.json` |

Si los archivos JSON del proyecto (`opencode.json`, `.gemini/settings.json`, `.cursor/mcp.json`) los crea `init`, también los añade a `.gitignore`, porque contienen rutas de tu máquina. Si ya existían y están en git, decide tú si subirlos.

Sin `--write`, `init` imprime el bloque exacto para tu cliente, con las rutas de tu PC, y lo pegas tú.

## Cómo se arranca el servidor MCP

En todos los clientes el comando es el mismo:

```
node /ruta/a/multi-agents/dist/cli.js connect --config /ruta/al/proyecto/.multi-agents.json
```

`init` rellena las rutas de tu máquina. Sin `--config`, `connect` busca el `.multi-agents.json` más cercano subiendo desde la carpeta donde lo arranca el cliente.

### Configurar con variables de entorno (alternativa)

También puedes no usar `.multi-agents.json` y pasar todo por variables de entorno en la configuración del cliente. Si existen ambos, las variables tienen prioridad.

| Variable | Descripción |
|---|---|
| `HUB_URL` | URL del hub, por ejemplo `http://100.64.0.1:7777` |
| `MULTI_AGENTS_TOKEN` | Token del hub |
| `PROJECT` | Id del proyecto (por defecto `default`) |
| `AGENT_NAME` | Nombre **único** del agente en el proyecto (letras, números, `.`, `_`, `-`) |
| `AGENT_CLIENT` | Herramienta usada (`claude-code`, `codex`…); solo informativo |
| `AGENT_MODEL` | Modelo usado (texto libre); solo informativo |
| `WAIT_TIMEOUT_S` | Segundos de espera de `wait_for_messages` y `ask` (por defecto 50). Tiene que ser menor que el timeout de herramientas de tu cliente |
| `MULTI_AGENTS_CONFIG` | Ruta a un `.multi-agents.json` (equivale a `--config`) |

> ⚠️ Con variables de entorno, la configuración del cliente **sí contiene el token**: guárdala en la configuración de usuario o asegúrate de que esté en `.gitignore`.

---

## Bloques para configurar a mano

En los ejemplos, `NODE` es la ruta de `node` (por ejemplo `C:\Program Files\nodejs\node.exe` o `/usr/bin/node`), `CLI` es `…/multi-agents/dist/cli.js` y `CONFIG` es `…/tu-proyecto/.multi-agents.json`. `init` imprime estos bloques ya rellenados.

### Claude Code

Desde la carpeta del proyecto:

```bash
claude mcp add multi-agents --scope local -- NODE CLI connect --config CONFIG
```

Claude Code lee `CLAUDE.md`. `init --client claude-code` le añade la línea `@AGENTS.md` para importar el protocolo.

### Codex CLI

En `~/.codex/config.toml`:

```toml
[mcp_servers.multi-agents]
command = "NODE"
args = ["CLI", "connect", "--config", "CONFIG"]
tool_timeout_sec = 120
```

El timeout por defecto de herramientas en Codex es de 60 s; se sube a 120 para dar margen a `wait_for_messages` y `ask`. La configuración de Codex es **global**: si ejecutas `init` en otro proyecto, Codex pasará a apuntar a ese. Codex lee `AGENTS.md` de forma nativa.

### OpenCode

En el `opencode.json` del proyecto (o en `~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "multi-agents": {
      "type": "local",
      "command": ["NODE", "CLI", "connect", "--config", "CONFIG"],
      "enabled": true
    }
  }
}
```

OpenCode lee `AGENTS.md` de forma nativa.

### Gemini CLI

En `.gemini/settings.json` del proyecto:

```json
{
  "mcpServers": {
    "multi-agents": {
      "command": "NODE",
      "args": ["CLI", "connect", "--config", "CONFIG"],
      "timeout": 120000,
      "trust": true
    }
  }
}
```

- `"trust": true` evita que Gemini pida confirmación en cada herramienta de multi-agents.
- Gemini solo lee `.gemini/settings.json` en **carpetas de confianza**: acepta *"trust this folder"* cuando lo pregunte.
- `init --client gemini` crea un `GEMINI.md` con `@AGENTS.md`. Otra opción es poner `"context": { "fileName": ["AGENTS.md", "GEMINI.md"] }` en `settings.json`.

### Cursor

En `.cursor/mcp.json` del proyecto (o en `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "multi-agents": { "command": "NODE", "args": ["CLI", "connect", "--config", "CONFIG"] }
  }
}
```

### Cline

En el panel de MCP Servers, entra en *Configure* y edita `cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "multi-agents": {
      "command": "NODE",
      "args": ["CLI", "connect", "--config", "CONFIG"],
      "disabled": false,
      "timeout": 120
    }
  }
}
```

Pide a Cline que lea `AGENTS.md`, o copia el protocolo a `.clinerules`.

### Goose

En `~/.config/goose/config.yaml`, dentro de `extensions:`:

```yaml
  multi-agents:
    type: stdio
    name: multi-agents
    enabled: true
    cmd: NODE
    args: ["CLI", "connect", "--config", "CONFIG"]
    timeout: 300
```

### Cualquier otro cliente MCP

Cualquier cliente que pueda lanzar un servidor MCP por **stdio** sirve: solo necesita el comando `NODE CLI connect --config CONFIG`.

## Agentes sin MCP (Aider, scripts, agentes propios)

Ejecuta `multi-agents init --client cli --name <nombre> ...` en la carpeta del proyecto. Desde ahí cualquier comando funciona sin más configuración:

```bash
multi-agents protocol          # reglas completas
multi-agents task list         # tablero
multi-agents msg read          # bandeja de entrada
multi-agents ask "¿Uso A o B?" --options "A|B"   # preguntar por el hub
```

- **Aider:** usa `aider --read AGENTS.md`. Así conoce el protocolo y puede ejecutar los comandos con `/run multi-agents ...`.
- **Nombre de la herramienta en el dashboard:** para cambiarlo, ejecuta `AGENT_CLIENT=aider multi-agents init --client cli ...`.

## Consejo: preguntas por el hub

Algunas herramientas (OpenCode, Claude Code…) tienen su propio mecanismo de preguntas interactivas en la consola. Si el agente está en otra PC, nadie las ve y el agente se queda bloqueado. El protocolo les indica usar `ask`, que envía la pregunta a quien hizo el pedido y espera la respuesta. Si aun así alguno pregunta en la consola, recuérdaselo: *"hazme las preguntas por multi-agents"*.
