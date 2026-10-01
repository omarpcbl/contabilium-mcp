# Ticket MEJ-04: Ticket promedio y clientes únicos en los totales de `resumen_ventas`

- **ID:** MEJ-04
- **Tool:** `resumen_ventas`
- **Fase:** Fase 1 (Quick Win)
- **Estado:** FINALIZADO
- **Fecha de resolución:** 30/09/2026

## Pregunta de Negocio que Resuelve
*¿Cuánto gasta cada cliente en promedio?*

## Descripción y Alcance
Permite al responsable de ventas evaluar la calidad del ticket y la penetración comercial en el período analizado.

## Solución Implementada
En `src/tools/resumen_ventas.js`:
- `clientes_unicos`: calculado mediante un `Set` sobre los identificadores de clientes (`c.IdCliente || c.RazonSocial`).
- `ticket_promedio`: calculado como `Math.round((totalFacturado / cantidadFacturas) * 100) / 100`.
- Se expone tanto en la respuesta agregada general como en el texto del resumen.

## Pruebas de Verificación
- Suite: `tests/phase1.test.js`
- Test: "resumen_ventas calcula ticket promedio y clientes únicos (MEJ-04)"
- Resultado: Ticket promedio verificado en $20.298,22 para 12 facturas de venta.
