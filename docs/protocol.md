# Protocolo de colaboración

Los agentes reciben el protocolo por tres vías:

- en las **instrucciones MCP** al conectarse;
- en **`AGENTS.md`**, que genera `multi-agents init`;
- con **`multi-agents protocol`** o la herramienta `get_project`.

Se genera según el flujo de trabajo del proyecto y está escrito en inglés, porque es el idioma que todos los modelos siguen con más fiabilidad. Este documento lo explica en español.

## Reglas comunes

1. **Al empezar**, revisar quién está conectado, los mensajes y el tablero.
2. **Una tarea a la vez, siempre reclamada.** `claim_task` es atómico: si dos agentes intentan reclamar la misma tarea, solo uno lo consigue. Si no hay una tarea adecuada, el agente crea una y la reclama.
3. **Bloquear antes de editar.** `lock_files` acepta archivos o carpetas, y una carpeta bloquea todo lo que contiene. La operación es *todo o nada*: si cualquiera de las rutas está tomada, falla e indica quién la tiene.
4. **Estado visible** con `set_status`.
5. **Revisar la bandeja a menudo.** Cada respuesta del hub dice cuántos mensajes hay sin leer.
6. **Al terminar**, pasar la tarea a `review` o `done` con una nota, liberar los locks y avisar a `all`.
7. **Si se bloquea**, poner la tarea en `blocked` con una nota y escribir a quien pueda ayudar.
8. **Si está libre**, usar `wait_for_messages` en lugar de terminar.

## Estados de una tarea

```
open ──claim──► claimed ──► in_progress ──► review ──► done
  ▲                                │
  └──────── (status=open) ◄────────┴──► blocked
```

- Al crear una tarea con `assignee`, el hub le envía un mensaje al agente asignado, y solo ese agente puede reclamarla.
- El estado solo lo pueden cambiar el agente asignado o el creador de la tarea. Cualquiera puede añadir notas.
- Volver a `open` libera la tarea para que otro la tome.

## Locks

- Las rutas son **relativas a la raíz del proyecto**. `.` bloquea el proyecto entero.
- La comparación no distingue mayúsculas de minúsculas, para evitar conflictos entre Windows/macOS y Linux. No se admiten comodines (`*`).
- Caducan tras su TTL: 60 min por defecto con MCP y 30 min con la CLI. Volver a bloquear una ruta propia renueva el plazo.
- Un agente MCP que se desconecta, o que deja de dar señales durante 60 s, **pierde sus locks automáticamente**.
- Desde el dashboard o con `multi-agents unlock <ruta> --force`, un humano puede liberar un lock que se haya quedado colgado.

## Flujo `github` (por defecto)

- Cada agente trabaja en su rama, `agent/<nombre>` por defecto (configurable con `--branch-pattern`, que admite `{agent}` y `{task}`).
- La rama se crea desde la rama base más reciente: `git fetch origin && git switch -c agent/<nombre> origin/main`.
- Nunca se hace push directo a la rama base ni a ramas de otros agentes.
- Antes del PR: `git fetch origin && git rebase origin/main`.
- El PR se abre con `gh pr create --base main --fill`, y su URL se guarda en la tarea (`review_url`).
- Tras el merge, la siguiente tarea empieza desde `origin/main` actualizado.

## Flujo `git`

Es igual que `github`, pero para cualquier remoto (GitLab, Bitbucket, Gitea, un servidor propio). La revisión se hace con merge request o con el flujo que use el equipo, y en `review_url` se guarda el enlace al MR o el nombre de la rama.

## Flujo `none`

Es para proyectos sin control de versiones coordinado, por ejemplo una carpeta compartida por Syncthing o una unidad de red.

- Los locks son **obligatorios**: un agente solo edita archivos que tiene bloqueados.
- Hay que evitar reformateos o renombrados masivos.
- Al cambiar archivos compartidos (configuración, interfaces, esquemas), se avisa a `all`.

En la v1 el hub **no transfiere archivos**: cada PC necesita acceso a los mismos archivos por su cuenta.

## Consejos para humanos

- Antes de lanzar los agentes, crea unas cuantas tareas desde el dashboard con descripciones claras (criterios de aceptación, archivos relevantes).
- Usa nombres de agente que identifiquen la herramienta o la máquina: `claude-1`, `codex-backend`, `pc2-gemini`.
- Desde el dashboard puedes escribir a `todos` para dar instrucciones globales; los agentes las verán en su próxima llamada.
