# Ticket MEJ-15: Etiquetas de período legibles para humanos

- **ID:** MEJ-15
- **Tool / Módulo:** Formato de períodos (`src/utils.js`, `src/tools/resumen_ventas.js`)
- **Fase:** Fase 1.2 (Interactividad y Acompañamiento)
- **Estado:** FINALIZADO
- **Fecha de resolución:** 30/09/2026

## Valor para el Usuario
Presenta agrupaciones temporales comerciales listas para leer sin exigir cálculos mentales ni traducciones de formato ISO (ej. `"Semana 27 (29/06 al 05/07/2026)"` en lugar de `"2026-W27"`, y `"Julio 2026"` en lugar de `"2026-07"`).

## Solución Implementada
Se desarrollaron las funciones en `src/utils.js`:
- `formatIsoWeekLabel(yearWeekStr)`: calcula las fechas de inicio y fin de la semana ISO y devuelve la etiqueta comercial con rango.
- `formatYearMonthLabel(yearMonthStr)`: devuelve el nombre del mes en español y el año (ej. `"Julio 2026"`).
- Integración en `resumen_ventas.js` para los campos `grupo` y `etiqueta_periodo`.

## Pruebas de Verificación
- Suite: `tests/phase1.test.js`
- Test: "MEJ-15: formatIsoWeekLabel y formatYearMonthLabel generan etiquetas comerciales legibles"
