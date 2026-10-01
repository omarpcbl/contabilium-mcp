# Ticket BUG-04: El campo producto devuelve el código en lugar del nombre comercial

- **ID:** BUG-04
- **Tool:** `stock_por_deposito`
- **Severidad:** Alto
- **Fase:** Fase 1.3
- **Estado:** FINALIZADO
- **Fecha de Resolución:** 1 de octubre de 2026

## Descripción del Problema
Al consultar `stock_por_deposito`, el campo `producto` contenía el código SKU bruto (ej. `"CB-1767810439004-742581"`) en vez de la descripción comercial (ej. `"COMBO QA"`).

## Causa Raíz
El endpoint `GET /api/inventarios/getStockByDeposito` devuelve solo cantidades físicas y código de SKU, omitiendo `Nombre` o `Concepto`. El código hacía fallback automático a `item.Codigo`.

## Resolución Implementada
1. Se incorporó una caché en memoria `skuNameCache` con TTL de 30 minutos (1800s) para nombres comerciales de productos (`SKU -> Nombre`).
2. Se implementó la función `resolveProductNames(items, client)` que toma el lote de productos mostrados (`top`, acotado a un lote seguro de hasta 25 llamadas con coincidencia exacta de SKU) y resuelve su descripción comercial contra `GET /api/conceptos/search?filtro={sku}`.
3. Se probó tanto en tests unitarios automatizados como en el entorno real de producción contra la cuenta `automation_restv1_ar_RI`, confirmando que códigos como `"CB-1767810439004-742581"` y `"CB-1767810439565-642372"` se resuelven a `"COMBO QA"`.
