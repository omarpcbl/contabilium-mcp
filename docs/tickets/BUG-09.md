# Ticket BUG-09: Las advertencias muestran referencias a tickets internos `(API-1267)`

- **ID:** BUG-09
- **Tool:** `buscar_productos`
- **Severidad:** Bajo
- **Fase:** Fase 1 (Quick Win)
- **Estado:** FINALIZADO
- **Fecha de resolución:** 30/09/2026

## Descripción del Problema
Al buscar productos, el array de advertencias retornaba: `"stock_total suma todos los depósitos (API-1267). Para stock por depósito, usar stock_por_deposito."`, exponiendo códigos de tickets internos de ingeniería al usuario final.

## Causa Raíz
String estático hardcodeado en `src/tools/buscar_productos.js`.

## Solución Implementada
Se eliminó la referencia `(API-1267)` del mensaje de advertencia, manteniendo la aclaración funcional y transparente para el usuario final.

## Pruebas de Verificación
- Suite: `tests/phase1.test.js`
- Test: "buscar_productos no expone identificadores internos de tickets (BUG-09)"
- Resultado: El texto retornado no contiene `"API-1267"`.
