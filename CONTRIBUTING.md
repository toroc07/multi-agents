# Cómo contribuir

¡Gracias por tu interés en **multi-agents**! Se aceptan reportes de errores, ideas, mejoras de documentación y pull requests.

## Reportar un error o proponer una idea

- Antes de abrir un issue, busca entre los [issues existentes](https://github.com/toroc07/multi-agents/issues) por si ya está reportado.
- Usa la plantilla correspondiente (error o propuesta) e incluye la versión (`multi-agents --version`), el sistema operativo, la versión de Node y el cliente de IA que usas (Claude Code, Codex, OpenCode…).
- Los problemas de seguridad **no** se reportan en issues públicos; ver [SECURITY.md](SECURITY.md).

## Preparar el entorno

Requiere Node.js 22 o superior para desarrollar (para usarlo basta con Node 20).

```bash
git clone https://github.com/toroc07/multi-agents.git
cd multi-agents
npm install
npm test        # compila y ejecuta los tests unitarios y e2e
```

Comandos útiles:

| Comando | Qué hace |
|---|---|
| `npm run build` | Compila `src/` a `dist/` |
| `npm run typecheck` | Comprueba los tipos sin compilar |
| `npm test` | Build más todos los tests (vitest) |
| `npm run test:unit` | Solo los tests unitarios, sin build |
| `npm run hub` | Arranca un hub local |

## Estructura

```
src/hub/       servidor HTTP, estado, persistencia y dashboard
src/bridge/    cliente del hub, servidor MCP y comandos CLI
src/shared/    tipos, reglas de rutas y protocolo de colaboración
src/init.ts    asistente de configuración por cliente
test/          tests unitarios (state, paths) y e2e
docs/          documentación para usuarios
```

La lógica de negocio vive en `src/hub/state.ts`, que es puro y fácil de testear. El servidor, el MCP y la CLI son capas finas por encima de ese estado.

## Pull requests

1. Crea una rama desde `main`: `git switch -c feat/mi-cambio`.
2. Haz cambios pequeños y enfocados, y añade o actualiza los tests.
3. Asegúrate de que `npm test` pasa.
4. Usa mensajes de commit con el formato [Conventional Commits](https://www.conventionalcommits.org/es/): `feat:`, `fix:`, `docs:`, `test:`, `chore:`…
5. Abre el PR describiendo **qué** cambia y **por qué**. El CI lo prueba en Linux, Windows y macOS.

### Pautas

- **Agnóstico de agente:** nada debe depender de un cliente o modelo concreto. Si algo es específico de un cliente, va en `init.ts` o en `docs/clients.md`.
- **Agnóstico de proveedor git:** el hub no llama a APIs de GitHub, GitLab, etc.
- **Sin dependencias nativas:** el proyecto tiene que instalarse sin compilar nada en Windows, macOS y Linux.
- El texto que leen los agentes (protocolo, descripciones de herramientas) va en **inglés**. La documentación para personas va en **español**.
- Las salidas para agentes deben ser compactas, porque cada token cuenta.

## Licencia

Al contribuir aceptas que tu aporte se publique bajo la [licencia MIT](LICENSE) del proyecto.
