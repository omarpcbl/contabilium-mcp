# Ticket MEJ-09: Margen bruto por producto o rubro en `resumen_ventas`

- **ID:** MEJ-09
- **Tool:** `resumen_ventas`
- **Fase:** Fase 3
- **Estado:** BLOQUEADO API (Requiere endpoint de Backend Contabilium)

## Pregunta de Negocio que Resuelve
*¿Qué productos me dejan más margen?*

## Análisis de Factibilidad
- Para calcular margen bruto se requiere:
  1. Conocer las ventas desglosadas por ítem/producto.
  2. Conocer el costo unitario de compra o costo interno.
- Dado que `/comprobantes/search` no expone ítems, calcular esto en el MCP para 100-300 facturas mensuales requeriría cientos de llamadas GET individuales (`/comprobantes/getById`), lo cual tardaría más de 60 segundos a 2 req/s, produciendo timeouts en Claude/MCP (HTTP 504) o 429 Too Many Requests.
- **Veredicto:** No es viable implementar en tiempo real en la capa del MCP sin un endpoint nativo de reporte en el backend de Contabilium (ej. `GET /api/reportes/ventas-por-producto`).
- Se recomienda canalizar estas intenciones de usuario a través de `registrar_consulta_no_soportada` para respaldar el requerimiento ante el equipo de backend de Contabilium.
