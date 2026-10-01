# Ticket BUG-12: Los totales y comparaciones se calculan sobre datos truncados y se presentan como completos

- **ID:** BUG-12
- **Tool:** `resumen_ventas`, `cuentas_por_cobrar`
- **Severidad:** Crítico
- **Fase:** Fase 1.1 (Estabilidad Fiscal)
- **Estado:** FINALIZADO
- **Fecha de resolución:** 30/09/2026

## Descripción del Problema
Cuando una consulta trimestral superaba el límite de 20 páginas y se cortaba en el primer mes (ej. solo julio), la tool presentaba el total como si fuera el trimestre completo y calculaba un falso `+37,8%` de variación contra el período anterior.
Similarmente, en `cuentas_por_cobrar`, al cortarse la paginación reportaba `$ 0` en deuda a más de 90 días, ocultando la deuda más antigua no leída.

## Causa Raíz
Las herramientas no inhibían las métricas comparativas cuando `truncado` era `true` y omitían advertir el corte en el encabezado del resumen ejecutivo.

## Solución Implementada
1. En `resumen_ventas`:
   - Si `truncado: true`, se inhabilita el cálculo porcentual (`variacion_total_pct: null` y `variacion_pct: null`).
   - El resumen comienza con: `"[DATOS PARCIALES / TRUNCADOS] Lectura cortada por límite de 20 páginas de la API (solo cubre comprobantes hasta ${fechaCorte}). No se calculan variaciones porcentuales sobre períodos incompletos."`
2. En `cuentas_por_cobrar`:
   - Si `truncado: true`, se expone la bandera `totales.antiguedad_deuda_incompleta: true` y se aclara que la deuda más antigua podría estar incompleta.

## Pruebas de Verificación
- Suite: `tests/phase1.test.js`
- Test: "BUG-12: no calcula variaciones porcentuales cuando los datos están truncados"
