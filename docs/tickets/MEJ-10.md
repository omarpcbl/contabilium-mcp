# Ticket MEJ-10: Implementar las instrucciones de servidor en el Handshake MCP

- **ID:** MEJ-10
- **Tool / Módulo:** Handshake del Servidor (`src/instructions.js`, `server.js`, `index.js`)
- **Fase:** Fase 1.2 (Interactividad y Acompañamiento)
- **Estado:** FINALIZADO
- **Fecha de resolución:** 30/09/2026

## Valor para el Usuario
Permite que el modelo LLM comprenda desde el inicio de la sesión qué puede y qué no puede hacer: foco estricto en dashboards, límites técnicos de la API (92 días, tope de 20 páginas, exclusión de cotizaciones) y qué hacer ante preguntas fuera de alcance, evitando alucinaciones o explicaciones vacías ante "¿Qué podés hacer?".

## Solución Implementada
Se sincronizó `SYSTEM_INSTRUCTION` inyectada en el constructor de `McpServer` con:
1. Declaración explícita de servidor de solo lectura para dashboards y consultas de gestión.
2. Directiva de responder que la facturación no está habilitada en esta integración.
3. Límites operacionales claros (92 días, exclusión de cotizaciones, truncado de páginas).
4. Derivación constructiva ante consultas fuera de alcance hacia `registrar_consulta_no_soportada`.

## Pruebas de Verificación
- Suite: `tests/phase1.test.js`
- Test: "MEJ-10: SYSTEM_INSTRUCTION contiene las directivas de alcance de dashboards y límites de operación"
