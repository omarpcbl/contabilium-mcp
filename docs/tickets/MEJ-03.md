# Ticket MEJ-03: Comparación interanual en `resumen_ventas`

- **ID:** MEJ-03
- **Tool:** `resumen_ventas`
- **Fase:** Fase 2
- **Estado:** BACKLOG (Planificado para Fase 2)

## Pregunta de Negocio que Resuelve
*¿Vendo más que en el mismo mes del año pasado?*

## Análisis de Factibilidad
- Alta factibilidad para períodos mensuales o trimestrales (<= 92 días). Requiere disparar dos consultas paralelas a `/comprobantes/search`: una para el rango actual y otra para `subDays(fecha, 365)`.
- No requiere partición en tramos si el período analizado es de 30 o 60 días.
