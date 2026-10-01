# Ticket BUG-01: Las notas de crédito suman al total de ventas en vez de restar

- **ID:** BUG-01
- **Tool:** `resumen_ventas`
- **Severidad:** Crítico
- **Fase:** Fase 1 (Quick Win)
- **Estado:** FINALIZADO
- **Fecha de resolución:** 30/09/2026

## Descripción del Problema
Al calcular las ventas de un período (ejemplo: Junio 2026 con 12 facturas por $243.578,58 y 3 notas de crédito por $7.260,00), el total neto obtenido era $243.578,58 en vez del esperado $236.318,58.

## Causa Raíz
En `src/tools/resumen_ventas.js`, el endpoint `/comprobantes/search` de la API de Contabilium ya devuelve los importes de notas de crédito con signo negativo (`Total: -1210`). El código multiplicaba el importe por `-1` cuando `tipo.startsWith("NC")`, lo que convertía el monto negativo en positivo (`-1210 * -1 = +1210`), provocando que se sumara.

## Solución Implementada
Se normalizó la lectura de importes utilizando el valor absoluto y forzando el signo negativo únicamente para Notas de Crédito:
```javascript
const rawMontoAbsoluto = Math.abs(parseAmount(c.ImporteTotalNeto ?? c.Total ?? c.ImporteTotalBruto ?? 0));
const rawMonto = esNC ? -rawMontoAbsoluto : rawMontoAbsoluto;
```
Adicionalmente, se integró con MEJ-01 para acumular `total_facturado_bruto`, `total_notas_credito` y `total_neto`.

## Pruebas de Verificación
- Suite: `tests/phase1.test.js`
- Test: "resumen_ventas resta correctamente notas de crédito (BUG-01 y MEJ-01)"
- Resultado: 12 facturas ($243.578,58) - 3 NC ($7.260,00) = $236.318,58 exactos.
