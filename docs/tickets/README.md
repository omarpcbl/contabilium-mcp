# 📋 Tablero de Tickets — MCP Contabilium (Dashboards & Reporting)

**Entorno de referencia:** `restapiqa.contabilium.com` / Producción  
**Autor:** @Omar  
**Fecha de Apertura:** 30 de septiembre de 2026  
**Última actualización:** 30 de septiembre de 2026  

---

## 📌 Estado General del Tablero

| Categoría | Total | Finalizados (Fase 1) | Backlog (Fase 2 / 3) |
|---|---|---|---|
| **Bugs (Defectos)** | 10 | 7 | 3 |
| **Mejoras (Features)** | 9 | 4 | 5 |
| **Total Items** | **19** | **11** | **8** |

---

## 🐞 Bugs (Defectos de QA)

| ID | Título | Tool | Severidad | Fase | Estado | Ticket Doc |
|---|---|---|---|---|---|---|
| **BUG-01** | Las notas de crédito suman al total de ventas en vez de restar | `resumen_ventas` | Crítico | Fase 1 | **FINALIZADO** | [BUG-01.md](./BUG-01.md) |
| **BUG-02** | Agrupar por producto o rubro devuelve "Ítems no detallados" y unidades en 0 | `resumen_ventas` | Crítico | Fase 2 | **BACKLOG** | [BUG-02.md](./BUG-02.md) |
| **BUG-03** | `incluir_items=true` devuelve `items: []` | `listar_ventas` | Alto | Fase 2 | **BACKLOG** | [BUG-03.md](./BUG-03.md) |
| **BUG-04** | El campo producto devuelve el código en lugar del nombre | `stock_por_deposito` | Alto | Fase 2 | **BACKLOG** | [BUG-04.md](./BUG-04.md) |
| **BUG-05** | `cantidad_comprobantes` cuenta las notas de crédito como ventas | `resumen_ventas` | Medio | Fase 1 | **FINALIZADO** | [BUG-05.md](./BUG-05.md) |
| **BUG-06** | La advertencia de sobreventa se dispara con stock negativo sin reservas | `stock_por_deposito` | Medio | Fase 1 | **FINALIZADO** | [BUG-06.md](./BUG-06.md) |
| **BUG-07** | Con `truncado: true`, el resumen no dice cuántos registros se leyeron ni el total | `stock_por_deposito` | Medio | Fase 1 | **FINALIZADO** | [BUG-07.md](./BUG-07.md) |
| **BUG-08** | No informa el rango de fechas que usó por defecto | `cuentas_por_cobrar` | Medio | Fase 1 | **FINALIZADO** | [BUG-08.md](./BUG-08.md) |
| **BUG-09** | Las advertencias muestran referencias a tickets internos `(API-1267)` | `buscar_productos` | Bajo | Fase 1 | **FINALIZADO** | [BUG-09.md](./BUG-09.md) |
| **BUG-10** | Informa token inactivo con la conexión activa | `contabilium_auth_status` | Bajo | Fase 1 | **FINALIZADO** | [BUG-10.md](./BUG-10.md) |

---

## 🚀 Mejoras Propuestas (Features de Negocio)

| ID | Título | Pregunta de Negocio | Fase | Estado | Ticket Doc |
|---|---|---|---|---|---|
| **MEJ-01** | Separar en `resumen_ventas` facturado bruto, notas de crédito y neto | *¿Cuánto vendí y cuánto me devolvieron?* | Fase 1 | **FINALIZADO** | [MEJ-01.md](./MEJ-01.md) |
| **MEJ-02** | Partir el rango en tramos dentro de `resumen_ventas` y `listar_ventas` | *¿Cómo vengo en el año?* | Fase 2 | **BACKLOG** | [MEJ-02.md](./MEJ-02.md) |
| **MEJ-03** | Comparación interanual (mismo período año anterior) | *¿Vendo más que el mismo mes del año pasado?* | Fase 2 | **BACKLOG** | [MEJ-03.md](./MEJ-03.md) |
| **MEJ-04** | Ticket promedio y clientes únicos en los totales de `resumen_ventas` | *¿Cuánto gasta cada cliente en promedio?* | Fase 1 | **FINALIZADO** | [MEJ-04.md](./MEJ-04.md) |
| **MEJ-05** | Antigüedad de deuda en tramos (0–30, 31–60, 61–90, >90 d) en `cuentas_por_cobrar` | *¿Qué deuda está más complicada de cobrar?* | Fase 1 | **FINALIZADO** | [MEJ-05.md](./MEJ-05.md) |
| **MEJ-06** | Ampliar el rango por defecto de `cuentas_por_cobrar` o permitir "toda la deuda" | *¿Quién me debe desde hace más de un año?* | Fase 2 | **BACKLOG** | [MEJ-06.md](./MEJ-06.md) |
| **MEJ-07** | Parámetro `top` y `orden` en `stock_por_deposito`, con total real en resumen | *¿Cuáles son los 20 productos más críticos?* | Fase 1 | **FINALIZADO** | [MEJ-07.md](./MEJ-07.md) |
| **MEJ-08** | Stock valorizado por depósito (`stock × costo_interno`) | *¿Cuánta plata tengo inmovilizada en cada depósito?* | Fase 2 | **BACKLOG** | [MEJ-08.md](./MEJ-08.md) |
| **MEJ-09** | Margen bruto por producto o rubro en `resumen_ventas` | *¿Qué productos me dejan más margen?* | Fase 3 | **BLOQUEADO API** | [MEJ-09.md](./MEJ-09.md) |
