# 📋 Tablero de Tickets — MCP Contabilium (Dashboards & Reporting)

**Entorno de referencia:** Producción (`rest.contabilium.com`, con validez fiscal AFIP) / QA  
**Autor:** @Omar  
**Fecha de Apertura:** 30 de septiembre de 2026  
**Última actualización:** 30 de septiembre de 2026 (Sprint de Interactividad y Acompañamiento)  

---

## 📌 Estado General del Tablero

| Categoría | Total | Finalizados | Backlog (Fase 2 / 3) |
|---|---|---|---|
| **Bugs (Defectos)** | 15 | 12 | 3 |
| **Mejoras (Features & UX)** | 16 | 11 | 5 |
| **Operaciones & Diagnóstico** | 1 | 1 | 0 |
| **Total Items** | **32** | **24** | **8** |

---

## 🐞 Bugs (Defectos de QA y Re-Auditoría)

| ID | Título | Tool | Severidad | Fase | Estado | Ticket Doc |
|---|---|---|---|---|---|---|
| **BUG-15** | Las tools de facturación siguen expuestas en producción con validez fiscal | Servidor MCP | Crítico | Fase 1.1 | **FINALIZADO** | [BUG-15.md](./BUG-15.md) |
| **BUG-11** | Ventas y deuda incluyen cotizaciones (COT, NCT) y comprobantes con tipo inválido | `resumen_ventas`, `cuentas_por_cobrar` | Crítico | Fase 1.1 | **FINALIZADO** | [BUG-11.md](./BUG-11.md) |
| **BUG-12** | Totales y comparaciones se calculan sobre datos truncados presentados como completos | `resumen_ventas`, `cuentas_por_cobrar` | Crítico | Fase 1.1 | **FINALIZADO** | [BUG-12.md](./BUG-12.md) |
| **BUG-01** | Las notas de crédito suman al total de ventas en vez de restar | `resumen_ventas` | Crítico | Fase 1 | **FINALIZADO** | [BUG-01.md](./BUG-01.md) |
| **BUG-02** | Agrupar por producto o rubro devuelve "Ítems no detallados" y unidades en 0 | `resumen_ventas` | Crítico | Fase 2 | **BACKLOG** | [BUG-02.md](./BUG-02.md) |
| **BUG-03** | `incluir_items=true` devuelve `items: []` | `listar_ventas` | Alto | Fase 2 | **BACKLOG** | [BUG-03.md](./BUG-03.md) |
| **BUG-04** | El campo producto devuelve el código en lugar del nombre | `stock_por_deposito` | Alto | Fase 2 | **BACKLOG** | [BUG-04.md](./BUG-04.md) |
| **BUG-13** | Un cliente vacío ("   ") aparece como cliente y suma a clientes únicos | `resumen_ventas`, `cuentas_por_cobrar` | Medio | Fase 1.1 | **FINALIZADO** | [BUG-13.md](./BUG-13.md) |
| **BUG-05** | `cantidad_comprobantes` cuenta las notas de crédito como ventas | `resumen_ventas` | Medio | Fase 1 | **FINALIZADO** | [BUG-05.md](./BUG-05.md) |
| **BUG-06** | La advertencia de sobreventa se dispara con stock negativo sin reservas | `stock_por_deposito` | Medio | Fase 1 | **FINALIZADO** | [BUG-06.md](./BUG-06.md) |
| **BUG-07** | Con truncado: true, el resumen no diferencia tope de API del total real | `stock_por_deposito` | Medio | Fase 1.1 | **FINALIZADO** | [BUG-07.md](./BUG-07.md) |
| **BUG-08** | No informa el rango de fechas que usó por defecto | `cuentas_por_cobrar` | Medio | Fase 1 | **FINALIZADO** | [BUG-08.md](./BUG-08.md) |
| **BUG-14** | El período por defecto termina el 1/10 cuando hoy es 30/9 (desfasaje UTC) | `cuentas_por_cobrar` | Bajo | Fase 1.1 | **FINALIZADO** | [BUG-14.md](./BUG-14.md) |
| **BUG-09** | Las advertencias muestran referencias a tickets internos `(API-1267)` | `buscar_productos` | Bajo | Fase 1 | **FINALIZADO** | [BUG-09.md](./BUG-09.md) |
| **BUG-10** | Informa token inactivo con la conexión activa | `contabilium_auth_status` | Bajo | Fase 1 | **FINALIZADO** | [BUG-10.md](./BUG-10.md) |

---

## 🚀 Mejoras Propuestas (Features y Experiencia de Usuario)

| ID | Título | Pregunta / Necesidad de Negocio | Fase | Estado | Ticket Doc |
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
| **MEJ-10** | Instrucciones de servidor en Handshake (dashboards, límites, alcances) | *¿Qué podés hacer?* sin alucinaciones de facturación | Fase 1.2 | **FINALIZADO** | [MEJ-10.md](./MEJ-10.md) |
| **MEJ-11** | Exponer 4 Prompts oficiales de MCP (`resumen_del_mes`, `quien_me_debe`, etc.) | *No sé qué preguntar* (Menú interactivo con 1 clic) | Fase 1.2 | **FINALIZADO** | [MEJ-11.md](./MEJ-11.md) |
| **MEJ-12** | Tool `que_puedo_consultar` con guía, límites y preguntas contextuales | Primer contacto guiado universal (onboarding y métricas) | Fase 1.2 | **FINALIZADO** | [MEJ-12.md](./MEJ-12.md) |
| **MEJ-13** | `registrar_consulta_no_soportada` con alternativas funcionales proactivas | Evitar callejones sin salida en preguntas fuera de alcance | Fase 1.2 | **FINALIZADO** | [MEJ-13.md](./MEJ-13.md) |
| **MEJ-14** | Corregir y armonizar descripciones de tools (soporte de agrupación por día) | Evitar alucinaciones y habilitar curva de ventas diaria | Fase 1.2 | **FINALIZADO** | [MEJ-14.md](./MEJ-14.md) |
| **MEJ-15** | Etiquetas de período legibles (*«Semana 27 (29/6 al 5/7)»*, *«Julio 2026»*) | Respuestas comerciales legibles sin traducción de ISO | Fase 1.2 | **FINALIZADO** | [MEJ-15.md](./MEJ-15.md) |
| **MEJ-16** | Visualización gráfica robusta (Barras tipográficas seguras sin fallos) | Visualizar proporciones y tendencias sin riesgo de rotura | Fase 1.2 | **FINALIZADO** | [MEJ-16.md](./MEJ-16.md) |

---

## 🔧 Operaciones & Diagnóstico de Integraciones

| ID | Título | Caso de Uso / Impacto | Fase | Estado | Ticket Doc |
|---|---|---|---|---|---|
| **OP-08** | Diagnóstico automatizado de órdenes e integraciones e-commerce (Fenicio, Base, Vestetic, Luna) | Reducción del TTR en ~30 tickets de soporte semestrales mediante detección heurística en cascada (comprobantes previos, CUIT/RUT, existencia de SKUs, stock disponible y diagnóstico de webhooks) | Fase 1.3 | **FINALIZADO** | [OP-08.md](./OP-08.md) |
