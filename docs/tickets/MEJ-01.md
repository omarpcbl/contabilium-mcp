# Ticket MEJ-01: Separar en `resumen_ventas` facturado bruto, notas de crédito y neto

- **ID:** MEJ-01
- **Tool:** `resumen_ventas`
- **Fase:** Fase 1 (Quick Win)
- **Estado:** FINALIZADO
- **Fecha de resolución:** 30/09/2026

## Pregunta de Negocio que Resuelve
*¿Cuánto vendí y cuánto me devolvieron?*

## Descripción y Alcance
En tableros ejecutivos no alcanza con conocer únicamente el total neto; los usuarios necesitan visualizar en paralelo la facturación bruta comercial, las notas de crédito emitidas y el resultado neto final.

## Solución Implementada
En `src/tools/resumen_ventas.js` se añadieron acumuladores en memoria por tipo de comprobante:
- `total_facturado_bruto`: suma total de comprobantes de facturación (FCA, FCB, etc.)
- `total_notas_credito`: suma total de notas de crédito (NCA, NCB, etc.)
- `total_neto`: `total_facturado_bruto - total_notas_credito`
- Mismo desglose disponible a nivel de grupo (`g.total_facturado`, `g.total_notas_credito`, `g.total`).

## Pruebas de Verificación
- Suite: `tests/phase1.test.js`
- Test: "resumen_ventas desglosa facturado bruto, notas de crédito y neto (MEJ-01)"
