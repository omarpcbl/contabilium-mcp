# Ticket BUG-07: Con truncado: true, el resumen no dice cuántos registros se leyeron ni el total

- **ID:** BUG-07
- **Tool:** `stock_por_deposito`
- **Severidad:** Medio
- **Fase:** Fase 1 (Quick Win)
- **Estado:** FINALIZADO
- **Fecha de resolución:** 30/09/2026

## Descripción del Problema
Al obtener 389 productos sin stock, la tool devolvía todas las filas (389 objetos JSON en el payload), saturando el contexto del LLM, y en el resumen indicaba confusamente: *"Se encontraron 389 registro(s)"* junto con `truncado: true`, sin aclarar si 389 era el total o el corte de paginación.

## Causa Raíz
La tool no limitaba la cantidad de objetos retornados al LLM y redactaba un resumen ambiguo sin contrastar registros encontrados vs registros retornados.

## Solución Implementada
Se implementó en conjunto con MEJ-07:
1. Incorporación de los parámetros `top` (default 20, máx 200) y `orden` (`menor_disponible`, `mayor_disponible`, `alfabetico`).
2. Corte seguro de resultados: `datos = todasLasFilas.slice(0, top)`.
3. Redacción exacta en el resumen: *"Se encontraron 389 producto(s) con filtro 'sin_stock' (mostrando los 20 principales ordenados por menor_disponible)."*
4. Advertencia explícita si hay más resultados que los mostrados.

## Pruebas de Verificación
- Suite: `tests/phase1.test.js`
- Test: "stock_por_deposito aplica top, orden y resumen descriptivo de registros leídos (BUG-07 y MEJ-07)"
- Resultado: Retorna exactamente el `top` solicitado informando el total real encontrado.
