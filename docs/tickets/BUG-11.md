# Ticket BUG-11: Ventas y deuda incluyen cotizaciones (COT, NCT) y comprobantes con tipo inválido (-1, 0, XXX, FAKE)

- **ID:** BUG-11
- **Tool:** `resumen_ventas`, `cuentas_por_cobrar`, `listar_ventas`
- **Severidad:** Crítico
- **Fase:** Fase 1.1 (Estabilidad Fiscal)
- **Estado:** FINALIZADO
- **Fecha de resolución:** 30/09/2026

## Descripción del Problema
En el entorno productivo de pruebas (ej. 1/7/2026 con 65 comprobantes de 13 tipos diferentes), las ventas netas salían 3,2 veces más altas que las reales ($34.911,75 bruto vs $14.520 real).
La causa fue que se computaban cotizaciones (`COT`), notas de crédito de cotización (`NCT`), y comprobantes con códigos inválidos (`-1`, `0`, `XXX`, `FAKE`) como ventas y deuda genuinas.

## Causa Raíz
La validación anterior solo verificaba `tipo.startsWith("NC")`, acumulando cualquier otro comprobante como venta válida. Además, `NCT` (nota de crédito de cotización) era interpretada como nota de crédito fiscal real porque comenzaba con `NC`.

## Solución Implementada
1. **Lista Blanca Fiscal Estricta (`classifyFiscalInvoice` en `src/utils.js`):**
   - Comprobantes de Venta que suman: Facturas (`FCA`, `FCB`, `FCC`, `FCE`, `FCM`) y Notas de Débito (`NDA`, `NDB`, etc.).
   - Comprobantes de Crédito que restan: Notas de Crédito (`NCA`, `NCB`, `NCC`, `NCE`, `NCM`).
   - Exclusiones explícitas: `COT`, `NCT`, `PRE`, `REM`, `PED`, `-1`, `0`, `XXX`, `FAKE`.
2. **Notificación Obligatoria al Usuario:**
   Tanto en `resumen_ventas` como en `cuentas_por_cobrar` se informa explícitamente en `advertencias`:
   *"Se excluyen cotizaciones (COT/NCT), presupuestos y comprobantes no fiscales de los totales."*

## Pruebas de Verificación
- Suite: `tests/phase1.test.js`
- Test: "BUG-11: excluye cotizaciones (COT, NCT) y tipos inválidos de ventas y deuda"
- Resultado: En el lote de prueba del 1/7/2026, el bruto calculado es exactamente $14.520,00, las NC son $6.050,00 y el neto es $8.470,00.
