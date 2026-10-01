# Ticket MEJ-17: Blindaje contra Truncamiento Prematuro por Cotizaciones en Cuentas de Alto Volumen

- **ID:** MEJ-17
- **Tool:** `resumen_ventas`, `contabilium-client`
- **Severidad:** Crítico (Integridad de Datos)
- **Fase:** Fase 1.3
- **Estado:** FINALIZADO
- **Fecha de Apertura:** 1 de octubre de 2026
- **Fecha de Resolución:** 1 de octubre de 2026

## Descripción del Problema
En cuentas corporativas o de alto volumen (como `automation_restv1_ar_RI`), se emiten ~65 comprobantes diarios, de los cuales ~75% corresponden a cotizaciones no fiscales (`COT`/`NCT`).

Debido a que el endpoint `GET /api/comprobantes/search` de Contabilium ignora el filtro por tipo de comprobante en la query (defecto documentado en `API-1213`), la API devuelve todos los comprobantes mezclados. Al consultar un período mensual (ej. 30 días, ~1.950 comprobantes totales), la paginación tradicional de 20 páginas (1.000 comprobantes) se agotaba prematuramente hacia el día 16.

Como resultado:
- Se leían únicamente los comprobantes del 1 al 16 de septiembre.
- Se descartaban 738 cotizaciones y solo quedaban 262 facturas fiscales.
- Las ventas del 17 al 30 de septiembre quedaban completamente omitidas.
- Las ventas netas se reportaban como \$ 128.260 en lugar del total real de \$ 275.880, y el período se marcaba como `truncado: true`, bloqueando comparaciones porcentuales.

## Causa Raíz
La paginación con un único tramo de 30 días concentra todo el volumen en una sola consulta paginada que choca contra el tope de seguridad de 20 páginas antes de cubrir el mes.

## Solución Implementada: Particionado por Ventanas Temporales (`chunkedDateGet`)
1. **Método `chunkedDateGet` en `ContabiliumClient`:**
   - Para períodos mayores a 7 días, se particiona automáticamente el rango en ventanas deslizantes de 7 días (ej. 1 al 7, 8 al 14, 15 al 21, 22 al 28, y 29 al 30).
   - Cada tramo de 7 días dispone de un presupuesto independiente de páginas (`maxPagesPerChunk = 15`), suficiente para absorber los ~450 comprobantes semanales sin truncar.
   - Se concatenan todos los tramos preservando el orden cronológico.
   - Presupuesto global controlado (`maxTotalPages = 50`) con respeto al rate limit de 2 req/s.

2. **Integración en `resumen_ventas`:**
   - Se reemplazó la llamada directa por `chunkedDateGet` tanto para el período principal como para el período de comparación previa.
   - En unit tests o clientes mock sin `chunkedDateGet`, se mantiene fallback automático a `paginatedGet`.

3. **Verificación en Producción Real:**
   - Consulta probada en vivo en `automation_restv1_ar_RI` para septiembre de 2026:
     - **Cotizaciones omitidas:** 1.534 comprobantes no fiscales.
     - **Comprobantes fiscales analizados:** 538 comprobantes (383 facturas + 155 NC).
     - **Facturado bruto:** \$ 463.430,00 | **Notas de Crédito:** \$ 187.550,00.
     - **Ventas netas reales del mes completo:** \$ 275.880,00.
     - **Truncado:** `false` (100% de los 30 días leídos y consolidados).
