# Changelog

Todos los cambios relevantes del proyecto. El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el proyecto usa [versionado semántico](https://semver.org/lang/es/).

## [0.2.0] - 2026-10-01

Versión basada en pruebas reales con varios agentes (OpenCode y Gemini CLI) trabajando a la vez sobre el mismo repositorio.

### Añadido

- **Preguntas por el hub.**
  - Nueva herramienta MCP `ask` y comando `multi-agents ask "…" --options "A|B"`: el agente pregunta y espera la respuesta.
  - La pregunta va por defecto a quien le hizo el pedido, aunque esté en otra PC o en el dashboard.
  - Se responde con `send_message` + `reply_to` o con `msg send --reply-to`.
  - El dashboard muestra las preguntas pendientes con un botón por opción.
- **Estado automático de cada agente**, deducido de sus acciones: tarea reclamada, archivos bloqueados, en revisión, esperando mensajes o una respuesta. El estado manual (`set_status`) se muestra si es más reciente.
- **Anuncios del hub (📢):** se avisa a todos cuando una tarea se crea, se reclama, pasa a revisión, se cierra, se bloquea, se libera o se devuelve con cambios.
- **Historial de actividad** por proyecto: conexiones, tareas, bloqueos y liberaciones (con su motivo), **conflictos de bloqueo** y preguntas. Disponible en el dashboard y en `GET /api/projects/:p/log`.
- **Revisión entre agentes:** cualquier agente puede cerrar (`done`) o devolver (`in_progress`) una tarea en revisión que no sea suya.
- **Límite de tareas activas por agente** (por defecto 1; `--max-active-tasks`, 0 = sin límite).
- **Rama por tarea:** el patrón por defecto pasa a ser `agent/{agent}/task-{task}`. Al reclamar una tarea, el hub le asigna su rama y se la indica al agente.
- **Dashboard:**
  - cambiar el estado de cualquier tarea;
  - quitar agentes desconectados, lo que libera sus bloqueos y reabre sus tareas;
  - panel de actividad con filtros;
  - contador y límite de 200 caracteres en el título;
  - errores en español.
- **`init --write`:** configura el cliente automáticamente.
  - Claude Code: `claude mcp add`.
  - Codex: `~/.codex/config.toml`.
  - OpenCode, Gemini y Cursor: su archivo JSON del proyecto.
  - Fusiona los archivos de forma segura y guarda copias `.bak`.
- `connect --config <ruta>` y la variable `MULTI_AGENTS_CONFIG`.
- `DELETE /api/projects/:p/agents/:name`, `POST|GET /api/projects/:p/questions` y `GET /api/projects/:p/messages/:id`.

### Cambiado

- **La configuración MCP de los clientes ya no contiene el token:** apunta a `.multi-agents.json`, que es el único archivo con secretos y está en `.gitignore`.
- El protocolo para agentes:
  - prohíbe hacer preguntas en la consola local;
  - explica la revisión entre agentes;
  - ya no pide anunciar cada cambio, porque lo hace el hub.
- El aviso directo de "te asigné una tarea" se sustituye por el anuncio del hub.
- Los agentes nuevos empiezan con la bandeja vacía en lugar de recibir todo el historial como no leído.
- `init` solo usa el `.multi-agents.json` de la carpeta indicada, nunca uno de una carpeta superior.

### Corregido

- `init` conserva los saltos de línea de cada archivo (CRLF/LF) y es idempotente: ya no aparece `AGENTS.md` como modificado en checkouts de Windows.
- `init` tolera el BOM que PowerShell añade a `.gitignore`.

### Compatibilidad

- Los archivos de estado de la v0.1 (`data/hub-state.json`) se cargan sin cambios.
- Los proyectos existentes conservan su patrón de rama. Sí se les aplica el límite de 1 tarea activa por agente; para desactivarlo: `multi-agents project update <id> --max-active-tasks 0`.
- Las configuraciones de clientes con variables de entorno siguen funcionando.

## [0.1.0] - 2026-10-01

Primera versión pública.

- Hub HTTP con autenticación por token, persistencia en JSON y eventos en vivo (SSE).
- Servidor MCP con mensajes, espera de mensajes, tablero de tareas, bloqueo de archivos y presencia.
- CLI para agentes sin MCP y API HTTP documentada.
- Dashboard web en vivo.
- `multi-agents init` para Claude Code, Codex, OpenCode, Gemini CLI, Cursor, Cline, Goose y cualquier cliente MCP.
- Flujos de trabajo por proyecto: `github`, `git` y `none`.

[0.2.0]: https://github.com/toroc07/multi-agents/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/toroc07/multi-agents/releases/tag/v0.1.0
