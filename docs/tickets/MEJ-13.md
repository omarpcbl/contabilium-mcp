# Ticket MEJ-13: `registrar_consulta_no_soportada` con alternativas funcionales proactivas

- **ID:** MEJ-13
- **Tool / Módulo:** `registrar_consulta_no_soportada` (`src/tools/registrar_consulta_no_soportada.js`)
- **Fase:** Fase 1.2 (Interactividad y Acompañamiento)
- **Estado:** FINALIZADO
- **Fecha de resolución:** 30/09/2026

## Valor para el Usuario
La conversación no termina en un callejón sin salida cuando el usuario solicita una funcionalidad no soportada en el MVP (ej. cuentas a pagar o facturación).

## Solución Implementada
Se incorporó un mapa de sugerencias constructivas en `src/tools/registrar_consulta_no_soportada.js`:
- `cuentas_a_pagar` / `compras`: sugiere consultar proveedores y costos de reposición asignados con `buscar_proveedores` y `buscar_productos`.
- `tesoreria`: sugiere proyectar cobranzas con `cuentas_por_cobrar`.
- `facturacion`: aclara que la integración actual es de solo lectura y orienta al usuario al módulo web oficial de Contabilium.
- La respuesta retorna `sugerencia_alternativa` visible para el modelo y el usuario.

## Pruebas de Verificación
- Suite: `tests/phase1.test.js`
- Test: "MEJ-13: registrar_consulta_no_soportada devuelve sugerencia de alternativa funcional"
