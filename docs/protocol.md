# Protocolo de colaboración

Los agentes reciben el protocolo por tres vías:

- en las **instrucciones MCP** al conectarse;
- en **`AGENTS.md`**, que genera `multi-agents init`;
- con **`multi-agents protocol`** o la herramienta `get_project`.

Se genera según el flujo de trabajo del proyecto y está escrito en inglés, porque es el idioma que todos los modelos siguen con más fiabilidad. Este documento lo explica en español.

## Reglas comunes

1. **Al empezar**, revisar quién está conectado, los mensajes y el tablero.
2. **Una tarea a la vez, siempre reclamada.** `claim_task` es atómico: si dos agentes intentan reclamar la misma tarea, solo uno lo consigue. Si no hay una tarea adecuada, el agente crea una y la reclama.
   - El hub impone un límite de tareas activas por agente (`claimed` o `in_progress`): **1 por defecto**, configurable con `--max-active-tasks`, donde 0 significa sin límite. Las tareas en `review` o `blocked` no cuentan.
3. **Bloquear antes de editar.** `lock_files` acepta archivos o carpetas, y una carpeta bloquea todo lo que contiene. La operación es *todo o nada*: si cualquiera de las rutas está tomada, falla e indica quién la tiene. Además, el intento queda registrado en el historial como conflicto.
4. **Estado visible.** El hub actualiza solo el estado de cada agente según lo que hace. `set_status` sirve para añadir detalle; si es más reciente que la última acción, se muestra ese.
5. **Revisar la bandeja a menudo.** Cada respuesta del hub dice cuántos mensajes hay sin leer. Las preguntas (❓) se responden con `send_message` y `reply_to`. Si otra persona responde una pregunta que iba dirigida a un agente (por ejemplo, un humano desde el dashboard), el hub también se lo comunica a ese agente.
6. **Nunca preguntar en la consola local.** El agente puede estar en otra PC sin nadie delante, y los pedidos pueden llegar desde el dashboard. Para decisiones o aclaraciones se usa **`ask`**: la pregunta, con opciones si las hay, va a quien hizo el pedido y el agente espera la respuesta.
7. **Al terminar**, pasar la tarea a `review` (o a `done` si no necesita revisión) con una nota de qué se hizo y cómo se verificó, y liberar los locks. No hace falta anunciarlo: **el hub lo anuncia solo**.
8. **Revisar trabajo ajeno.** Cualquier agente puede revisar una tarea en `review` que no sea suya.
   - Primero lee la tarea (`get_task`) y comprueba **cada requisito de su título y descripción**: comandos exactos, formatos, nombres de archivo. Que "funcione" no basta si hace algo distinto de lo pedido.
   - Después ejecuta los tests y, o la cierra (`done`, tras fusionarla si le corresponde), o la devuelve a `in_progress` con una nota de los requisitos que faltan.
   - Cuando se fusiona el trabajo propio, hay que asegurarse de que su tarea quede en `done`.
9. **Si se bloquea**, poner la tarea en `blocked` con una nota y preguntar con `ask` a quien pueda ayudar.
10. **Si está libre**, usar `wait_for_messages` en lugar de terminar.

## Anuncios del hub (📢)

El hub envía un mensaje de tipo *evento* a todos los agentes, salvo al que hizo la acción, cuando una tarea:
- se crea, indicando a quién se asignó si la tiene;
- se reclama, con su rama;
- pasa a `review`, con la rama y el enlace de revisión;
- se cierra (`done`);
- se bloquea;
- se libera (vuelve a `open`);
- o se devuelve con cambios pedidos.

Así, un agente que espera con `wait_for_messages` se despierta en cuanto hay trabajo nuevo o algo que revisar.

## Estados de una tarea

```
open ──claim──► claimed ──► in_progress ──► review ──► done
  ▲                              ▲              │
  │                              └── cambios ───┘   (cualquier revisor)
  └──────── (status=open) ◄─────────────────────────► blocked
```

- Una tarea creada con `assignee` solo la puede reclamar ese agente.
- El estado lo pueden cambiar el agente asignado y el creador de la tarea. Además:
  - **cualquier agente** puede pasar una tarea en `review` a `done` o devolverla a `in_progress`;
  - los **humanos** del dashboard pueden cambiar cualquier tarea.
- Cualquiera puede añadir notas.
- Volver a `open` libera la tarea para que otro la tome.

## Locks

- Las rutas son **relativas a la raíz del proyecto**. `.` bloquea el proyecto entero.
- La comparación no distingue mayúsculas de minúsculas, para evitar conflictos entre Windows/macOS y Linux. No se admiten comodines (`*`).
- Caducan tras su TTL: 60 min por defecto con MCP y 30 min con la CLI. Volver a bloquear una ruta propia renueva el plazo.
- Un agente MCP que se desconecta, o que deja de dar señales durante 60 s, **pierde sus locks automáticamente**.
- Desde el dashboard o con `multi-agents unlock <ruta> --force`, un humano puede liberar un lock que se haya quedado colgado.
- El panel **Actividad** del dashboard muestra cada bloqueo, cada liberación (con su motivo) y cada conflicto.

## Flujo `github` (por defecto)

- **Una rama por tarea:** `agent/<nombre>/task-<id>` por defecto. Al reclamar la tarea, el hub la guarda en ella y se la indica al agente. Se configura con `--branch-pattern`, que admite `{agent}` y `{task}`; por ejemplo, `agent/{agent}` para una rama por agente.
- La rama se crea desde la rama base más reciente: `git fetch origin && git switch -c agent/<nombre>/task-<id> origin/main`.
- Nunca se hace push directo a la rama base ni a ramas de otros agentes.
- Antes del PR: `git fetch origin && git rebase origin/main`.
- El PR se abre con `gh pr create --base main --fill`, y su URL se guarda en la tarea (`review_url`).
- Tras el merge, la siguiente tarea empieza desde `origin/main` actualizado.

Los proyectos creados con la v0.1 conservan su patrón anterior (`agent/{agent}`) hasta que lo cambies con `multi-agents project update <id> --branch-pattern ...`.

## Flujo `git`

Es igual que `github`, pero para cualquier remoto (GitLab, Bitbucket, Gitea, un servidor propio). La revisión se hace con merge request o con el flujo que use el equipo, y en `review_url` se guarda el enlace al MR o el nombre de la rama.

## Flujo `none`

Es para proyectos sin control de versiones coordinado, por ejemplo una carpeta compartida por Syncthing o una unidad de red.

- Los locks son **obligatorios**: un agente solo edita archivos que tiene bloqueados.
- Hay que evitar reformateos o renombrados masivos.
- Al cambiar archivos compartidos (configuración, interfaces, esquemas), se avisa a `all`.

El hub **no transfiere archivos**: cada PC necesita acceso a los mismos archivos por su cuenta.

## Consejos para humanos

- Antes de lanzar los agentes, crea unas cuantas tareas desde el dashboard con descripciones claras (criterios de aceptación, archivos relevantes).
- **Asignar tareas** ayuda cuando los agentes tienen velocidades muy distintas; si no, el más rápido puede acabar haciendo casi todo.
- Usa nombres de agente que identifiquen la herramienta o la máquina: `claude-1`, `codex-backend`, `pc2-gemini`.
- Desde el dashboard puedes:
  - escribir a `todos` para dar instrucciones globales;
  - **responder las preguntas pendientes** con un clic;
  - cambiar el estado de cualquier tarea;
  - quitar agentes desconectados.
