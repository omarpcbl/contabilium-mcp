# Ticket MEJ-02: Partir el rango en tramos dentro de `resumen_ventas` y `listar_ventas`

- **ID:** MEJ-02
- **Tool:** `resumen_ventas`, `listar_ventas`
- **Fase:** Fase 2
- **Estado:** BACKLOG (Planificado para Fase 2)

## Pregunta de Negocio que Resuelve
*¿Cómo vengo en el año?* (Superar el límite de 92 días por consulta).

## Análisis de Factibilidad
- En `resumen_ventas`: Factible mediante el algoritmo de partición en ventanas de 89 días ya probado en `cuentas_por_cobrar.js`. Requiere controlar el presupuesto de páginas (ej. 20 a 30 páginas máx).
- En `listar_ventas`: Debe implementarse con un tope estricto de comprobantes (`limit: 100`) para no saturar el contexto del modelo.
