# Ticket BUG-04: El campo producto devuelve el código en lugar del nombre comercial

- **ID:** BUG-04
- **Tool:** `stock_por_deposito`
- **Severidad:** Alto
- **Fase:** Fase 2
- **Estado:** BACKLOG (En análisis de arquitectura)

## Descripción del Problema
Al consultar `stock_por_deposito`, el campo `producto` contiene el código SKU (ej. `"100/ROJO"`) en vez de la descripción comercial (ej. `"A REMBRANDT CASCO KROL ROJO LARGE"`).

## Causa Raíz
El endpoint `GET /api/inventarios/getStockByDeposito` devuelve solo cantidades físicas y código de SKU, no la descripción del concepto. El código actual hace fallback a `item.Codigo`.

## Plan de Resolución para Fase 2
Implementar un servicio singleton `CatalogoCache` en memoria con TTL de 30-60 minutos que cargue el mapeo `Codigo -> Nombre` desde `GET /api/conceptos/search`, resolviendo el nombre comercial en O(1) sin degradar la latencia.
