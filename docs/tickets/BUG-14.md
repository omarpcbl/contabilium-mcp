# Ticket BUG-14: El período por defecto termina el 1/10 cuando hoy es 30/9

- **ID:** BUG-14
- **Tool:** `cuentas_por_cobrar`
- **Severidad:** Bajo
- **Fase:** Fase 1.1 (Estabilidad Fiscal)
- **Estado:** FINALIZADO
- **Fecha de resolución:** 30/09/2026

## Descripción del Problema
A las 21:50 hora de Buenos Aires del 30/9/2026, la consulta por defecto de `cuentas_por_cobrar` calculó el período hasta el `2026-10-01` en lugar de `2026-09-30`.

## Causa Raíz
El código utilizaba `new Date().toISOString().split("T")[0]`, que toma la hora del meridiano UTC. Dado que Argentina se encuentra en UTC-3, pasadas las 21:00 hs en Buenos Aires la fecha UTC ya corresponde al día siguiente.

## Solución Implementada
Se implementó `getTodayString(country)` en `src/utils.js` utilizando `Intl.DateTimeFormat` configurado con la zona horaria real del país (`America/Argentina/Buenos_Aires` para AR, `America/Santiago` para CL, `America/Montevideo` para UY), garantizando que la fecha actual corresponda siempre al día comercial local.

## Pruebas de Verificación
- Suite: `tests/phase1.test.js`
- Test: "BUG-14: calcula la fecha actual según la zona horaria de la cuenta y no en UTC"
