# Ticket MEJ-11: Exponer 4 Prompts oficiales de MCP

- **ID:** MEJ-11
- **Tool / Módulo:** Prompts MCP (`src/prompts/`, `src/register-tools.js`)
- **Fase:** Fase 1.2 (Interactividad y Acompañamiento)
- **Estado:** FINALIZADO
- **Fecha de resolución:** 30/09/2026

## Valor para el Usuario
El usuario arranca sin pensar qué preguntar. En clientes compatibles con MCP Prompts (Claude Desktop, LibreChat, Cursor), se despliegan como menú interactivo con 1 clic.

## Solución Implementada
Se registraron 4 prompts nativos vía `server.prompt`:
1. `resumen_del_mes`: Consulta ventas y cobranzas del mes actual con desglose bruto, NC y neto.
2. `comparar_con_mes_anterior`: Realiza una comparativa intermensual del período reciente.
3. `quien_me_debe`: Lista clientes con saldo deudor y reporte de antigüedad (Aging Report).
4. `productos_sin_stock`: Consulta productos con stock disponible menor o igual a cero en el depósito principal.

## Pruebas de Verificación
- Suite: `tests/phase1.test.js`
- Test: "MEJ-11: registra los 4 prompts nativos de MCP en el servidor"
