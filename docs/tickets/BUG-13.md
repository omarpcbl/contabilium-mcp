# Ticket BUG-13: Un cliente vacío ("   ") aparece como cliente y suma a clientes únicos

- **ID:** BUG-13
- **Tool:** `resumen_ventas`, `cuentas_por_cobrar`
- **Severidad:** Medio
- **Fase:** Fase 1.1 (Estabilidad Fiscal)
- **Estado:** FINALIZADO
- **Fecha de resolución:** 30/09/2026

## Descripción del Problema
Al procesar comprobantes sin cliente o con espacios en blanco (ej. `"   "`), el ranking de clientes mostraba a `"   "` como el principal cliente con $18.900 y 42 comprobantes, incrementando incorrectamente la métrica `clientes_unicos`.

## Causa Raíz
Falta de sanitización estricta (`.trim()`) antes de utilizar la razón social como clave en la agrupación y en el conteo de clientes únicos.

## Solución Implementada
1. Sanitización de cadenas con `.trim()`. Si el nombre resultante está vacío o es `"0"`, se normaliza como `"Consumidor Final"`.
2. Al contabilizar `clientes_unicos`, se contabilizan exclusivamente identidades comerciales válidas (con CUIT o identificador no genérico), evitando inflar el conteo con ventas anónimas o sin informar.

## Pruebas de Verificación
- Suite: `tests/phase1.test.js`
- Test: "BUG-13: sanitiza clientes con espacios vacíos y no los cuenta como cliente único aislado"
