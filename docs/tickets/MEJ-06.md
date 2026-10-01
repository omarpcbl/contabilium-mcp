# Ticket MEJ-06: Ampliar rango por defecto de `cuentas_por_cobrar` o permitir "toda la deuda"

- **ID:** MEJ-06
- **Tool:** `cuentas_por_cobrar`
- **Fase:** Fase 2
- **Estado:** BACKLOG (En análisis de arquitectura)

## Pregunta de Negocio que Resuelve
*¿Quién me debe desde hace más de un año?*

## Análisis de Factibilidad
- Contabilium no cuenta con endpoint nativo de saldo acumulado histórico.
- Reconstruir deuda de varios años implica iterar múltiples trimestres, consumiendo el tope de 20 páginas y arriesgando truncar comprobantes en clientes grandes.
- Recomendación: Permitir `toda_la_deuda=true` únicamente si se especifica `cliente_id`, o permitir ampliar `fecha_desde` manual con advertencia de truncado.
