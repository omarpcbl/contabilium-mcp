# Ticket BUG-06: La advertencia de sobreventa se dispara con stock negativo sin reservas

- **ID:** BUG-06
- **Tool:** `stock_por_deposito`
- **Severidad:** Medio
- **Fase:** Fase 1 (Quick Win)
- **Estado:** FINALIZADO
- **Fecha de resolución:** 30/09/2026

## Descripción del Problema
Al consultar depósitos con productos en stock negativo pero con `stock_reservado: 0` (ej. actual `-3`, reservado `0`), la tool emitía el mensaje: *"Se detectó sobreventa... El stock físico es menor que las reservas activas"*, confundiendo al usuario y llevándolo a buscar reservas inexistentes.

## Causa Raíz
En `src/tools/stock_por_deposito.js`, la bandera `huboSobreventa` se activaba siempre que `disponible < 0` (`stockActual - stockReservado < 0`), sin verificar si realmente existían reservas activas (`stockReservado > 0`).

## Solución Implementada
Se discriminaron ambas condiciones en el análisis de inventario:
1. **Sobreventa real:** `stockReservado > 0 && stockActual < stockReservado` -> *"Se detectó sobreventa: el stock físico es menor que las reservas activas comprometidas."*
2. **Stock físico negativo sin reservas:** `stockActual < 0 && stockReservado <= 0` -> *"Se detectaron existencias físicas negativas sin reservas activas registradas (posible desajuste de inventario)."*

## Pruebas de Verificación
- Suite: `tests/phase1.test.js`
- Test: "stock_por_deposito no dispara falso mensaje de sobreventa ante stock negativo sin reservas (BUG-06)"
- Resultado: Advierte sobre existencias físicas negativas y no sobre reservas activas.
