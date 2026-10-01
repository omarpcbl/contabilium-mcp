# Ticket BUG-08: No informa el rango de fechas que usó por defecto

- **ID:** BUG-08
- **Tool:** `cuentas_por_cobrar`
- **Severidad:** Medio
- **Fase:** Fase 1 (Quick Win)
- **Estado:** FINALIZADO
- **Fecha de resolución:** 30/09/2026

## Descripción del Problema
Cuando el usuario ejecuta `cuentas_por_cobrar` sin especificar fechas, la tool calcula internamente un rango de los últimos 365 días pero no lo explicita. En consecuencia, la deuda histórica anterior a 12 meses queda excluida sin aviso, siendo esa deuda la más urgente de gestionar.

## Causa Raíz
En `src/tools/cuentas_por_cobrar.js`, el resumen no incluía `finalDesde` y `finalHasta`, y el array de advertencias no notificaba el rango por defecto aplicado.

## Solución Implementada
1. En el `resumen`: se especifica siempre el rango evaluado: `"(período analizado: ${finalDesde} al ${finalHasta})"`.
2. En `advertencias`: cuando `fecha_desde` no fue provista por el usuario, se añade: *"Se utilizó el rango por defecto de los últimos 12 meses (${finalDesde} al ${finalHasta}). Deuda anterior a 12 meses no está incluida; para consultarla especifique el parámetro 'fecha_desde'."*

## Pruebas de Verificación
- Suite: `tests/phase1.test.js`
- Test: "cuentas_por_cobrar explicita el rango de fechas por defecto en resumen y advertencias (BUG-08)"
- Resultado: El resumen y las advertencias contienen el período `finalDesde al finalHasta`.
