# Ticket MEJ-07: Parámetro `top` y `orden` en `stock_por_deposito`, con total real en el resumen

- **ID:** MEJ-07
- **Tool:** `stock_por_deposito`
- **Fase:** Fase 1 (Quick Win)
- **Estado:** FINALIZADO
- **Fecha de resolución:** 30/09/2026

## Pregunta de Negocio que Resuelve
*¿Cuáles son los 20 productos más críticos?*

## Descripción y Alcance
Evita inundar el contexto del modelo con cientos de filas JSON no priorizadas y permite al usuario enfocar el análisis en los productos con mayor quiebre de stock o sobreventa.

## Solución Implementada
En `src/tools/stock_por_deposito.js`:
- Parámetros añadidos al schema:
  - `top`: `z.number().int().min(1).max(200).default(20)`
  - `orden`: `z.enum(["menor_disponible", "mayor_disponible", "alfabetico"]).default("menor_disponible")`
- Ordenamiento y recorte seguro en memoria.
- Resumen con métricas claras de total encontrado vs devuelto.

## Pruebas de Verificación
- Suite: `tests/phase1.test.js`
- Test: "stock_por_deposito aplica top, orden y resumen descriptivo de registros leídos (BUG-07 y MEJ-07)"
