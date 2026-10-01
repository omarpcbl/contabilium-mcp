# Ticket BUG-15: Las tools de facturación siguen expuestas en producción con validez fiscal

- **ID:** BUG-15
- **Tool:** Servidor MCP (`src/register-tools.js`, `src/instructions.js`)
- **Severidad:** Crítico
- **Fase:** Fase 1.1 (Blindaje de Producción)
- **Estado:** FINALIZADO
- **Fecha de resolución:** 30/09/2026

## Descripción del Problema
En el servidor conectado a la cuenta de producción con validez fiscal real ante AFIP, seguían expuestas las 4 herramientas de facturación: `crear_borrador_factura`, `autorizar_factura_electronica`, `emitir_factura_express` y `obtener_factura_pdf`. Una instrucción accidental o ambigua del LLM podía emitir una factura electrónica fiscal irreversible.

## Causa Raíz
Registro incondicional de las 13 herramientas en `src/register-tools.js`.

## Solución Implementada
1. **Ocultamiento por Defecto en el Servidor MCP:**
   Las 4 tools de facturación solo se registran si la variable de entorno `ENABLE_BILLING_TOOLS === "true"`. Por defecto (`ENABLE_BILLING_TOOLS=false` o no definida), el servidor expone estrictamente las 10 tools de lectura/diagnóstico.
2. **Directiva del Asistente en `SYSTEM_INSTRUCTION`:**
   Se incorporó la regla explícita:
   *"Si el usuario consulta si este asistente o el MCP permite facturar o emitir comprobantes, respondé claramente que actualmente la función de facturación no está habilitada para esta integración, la cual opera en modalidad de solo lectura para dashboards y consultas de gestión."*

## Pruebas de Verificación
- Suite: `tests/phase1.test.js`
- Test: "BUG-15: no registra tools de facturación por defecto y expone solo las 10 tools del MVP"
