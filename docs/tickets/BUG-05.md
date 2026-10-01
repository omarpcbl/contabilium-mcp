# Ticket BUG-05: `cantidad_comprobantes` cuenta las notas de crédito como ventas

- **ID:** BUG-05
- **Tool:** `resumen_ventas`
- **Severidad:** Medio
- **Fase:** Fase 1 (Quick Win)
- **Estado:** FINALIZADO
- **Fecha de resolución:** 30/09/2026

## Descripción del Problema
En el resumen de ventas de Junio 2026 (12 facturas y 3 notas de crédito), el campo `cantidad_comprobantes` reportaba `15`. Esto distorsionaba la métrica de operaciones de venta y arruinaba el cálculo del ticket promedio.

## Causa Raíz
En `src/tools/resumen_ventas.js`, el acumulador `comprobantesGeneral += 1` y `g.cantidad_comprobantes += 1` incrementaba incondicionalmente para cada registro procesado sin diferenciar comprobantes de venta (facturas) de comprobantes de anulación/devolución (notas de crédito).

## Solución Implementada
Se desacoplaron los contadores en memoria:
- `cantidad_facturas` (solo FC)
- `cantidad_notas_credito` (solo NC)
- `cantidad_comprobantes` (total de documentos procesados)
- En cada grupo devuelto se expone `cantidad_facturas`, `cantidad_nc` y `cantidad_comprobantes`.

## Pruebas de Verificación
- Suite: `tests/phase1.test.js`
- Test: "resumen_ventas desglosa cantidad de facturas vs notas de crédito (BUG-05)"
- Resultado: `cantidad_facturas: 12`, `cantidad_notas_credito: 3`.
