# Ticket BUG-03: `incluir_items=true` devuelve `items: []`

- **ID:** BUG-03
- **Tool:** `listar_ventas`
- **Severidad:** Alto
- **Fase:** Fase 2
- **Estado:** BACKLOG (En análisis de arquitectura)

## Descripción del Problema
Al invocar `listar_ventas` con el parámetro `incluir_items=true`, cada comprobante devuelto contiene `items: []`.

## Causa Raíz
El endpoint `GET /api/comprobantes/search` de la API de Contabilium retorna únicamente datos de encabezado (`Total`, `Saldo`, `RazonSocial`, `FechaEmision`) pero omite el detalle de renglones/ítems. La API requiere consultar `GET /api/comprobantes/getById?id={id}` para cada comprobante.

## Plan de Resolución para Fase 2
1. Permitir la hidratación con `GET /comprobantes/getById` únicamente si la cantidad de comprobantes listados es menor o igual a 10 (para evitar bloqueos por rate limit de 2 req/s y timeouts del cliente LLM).
2. Si la consulta supera los 10 comprobantes, emitir advertencia explícita sugiriendo filtrar por comprobante individual o acotar las fechas.
