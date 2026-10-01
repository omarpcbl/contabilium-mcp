# Ticket BUG-02: Agrupar por producto o rubro devuelve "Ítems no detallados"

- **ID:** BUG-02
- **Tool:** `resumen_ventas`
- **Severidad:** Crítico
- **Fase:** Fase 2
- **Estado:** BACKLOG (En análisis de arquitectura)

## Descripción del Problema
Al ejecutar `resumen_ventas` con `agrupar_por=producto` o `agrupar_por=rubro`, devuelve una única fila llamada "Ítems no detallados" con unidades en 0.

## Causa Raíz
Depende directamente de BUG-03: el endpoint `/comprobantes/search` no incluye el desglose de ítems (`c.Items` es vacío o indefinido). Al no haber ítems, el algoritmo agrupa todo en el fallback `"Ítems no detallados"`.

## Plan de Resolución para Fase 2
1. Para rangos acotados (<= 15 comprobantes), hidratar los comprobantes con `GET /comprobantes/getById?id={id}` respetando el rate limiter de 2 req/s.
2. Si el volumen es mayor, devolver una advertencia clara indicando que la API masiva de Contabilium no incluye detalle de ítems para períodos extensos y registrar en `registrar_consulta_no_soportada`.
