# Ticket MEJ-05: Antigüedad de deuda en tramos (Aging Report) en `cuentas_por_cobrar`

- **ID:** MEJ-05
- **Tool:** `cuentas_por_cobrar`
- **Fase:** Fase 1 (Quick Win)
- **Estado:** FINALIZADO
- **Fecha de resolución:** 30/09/2026

## Pregunta de Negocio que Resuelve
*¿Qué deuda está más complicada de cobrar?*

## Descripción y Alcance
Divide la deuda exigible en los tramos estándar de finanzas corporativas:
- No vencida (corriente)
- Vencida 1 a 30 días
- Vencida 31 a 60 días
- Vencida 61 a 90 días
- Vencida más de 90 días

## Solución Implementada
En `src/tools/cuentas_por_cobrar.js`:
- El algoritmo evalúa `diasVencido` por cada comprobante con saldo impago.
- Se clasifican los montos en los 5 cubos de antigüedad (`antiguedad_deuda`).
- Se reporta el desglose tanto a nivel global como en cada cliente individual.
- Costo de red adicional: 0 llamadas de API (puro procesamiento en memoria).

## Pruebas de Verificación
- Suite: `tests/phase1.test.js`
- Test: "cuentas_por_cobrar clasifica la antigüedad de deuda por tramos de mora (MEJ-05)"
- Resultado: Validación de cálculo en cubos `1_30`, `31_60`, `61_90` y `mas_90`.
