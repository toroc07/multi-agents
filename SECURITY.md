# Política de seguridad

## Versiones con soporte

Se dan correcciones de seguridad para la última versión publicada.

| Versión | Soporte |
|---|---|
| 0.1.x | ✅ |

## Reportar una vulnerabilidad

**No abras un issue público.** Repórtala de forma privada desde la pestaña **Security → Report a vulnerability** de este repositorio.

Incluye:

- una descripción del problema y su impacto;
- los pasos para reproducirlo (versión, sistema operativo, configuración del hub);
- una posible solución, si la tienes.

Recibirás una respuesta lo antes posible. Una vez corregido, el problema se publicará con el crédito correspondiente, salvo que prefieras quedar en el anonimato.

## Modelo de seguridad

Para valorar si algo es una vulnerabilidad, ten en cuenta cómo está diseñado el hub:

- Todos los agentes de un hub comparten **un único token**. Cualquiera con el token puede actuar con cualquier nombre de agente; esto es intencional en la v0.1.
- El hub habla **HTTP sin cifrar**. Para usarlo por internet hay que ponerlo detrás de Tailscale o de un túnel o proxy HTTPS (ver [docs/setup-network.md](docs/setup-network.md)).
- El estado se guarda en texto plano en `data/hub-state.json`.

**Sí** se consideran vulnerabilidades, entre otras:

- acceder a la API sin token o con un token incorrecto;
- inyección de HTML o scripts en el dashboard;
- lectura o escritura de archivos fuera del directorio de datos;
- caídas del hub provocadas por peticiones malformadas.
