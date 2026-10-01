# Ticket MEJ-08: Stock valorizado por depósito (`stock × costo_interno`)

- **ID:** MEJ-08
- **Tool:** `stock_por_deposito`
- **Fase:** Fase 2
- **Estado:** BACKLOG (En análisis de arquitectura)

## Pregunta de Negocio que Resuelve
*¿Cuánta plata tengo inmovilizada en cada depósito?*

## Análisis de Factibilidad
- El endpoint `/inventarios/getStockByDeposito` no devuelve costos ni precios.
- Requiere cruce con `/conceptos/search`.
- Viabilidad técnica en MCP: Diseñar un servicio `CatalogoCache` con TTL de 1 hora para asociar SKU con `CostoInterno` sin disparar N llamadas en tiempo real.
