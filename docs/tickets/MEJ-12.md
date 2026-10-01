# Ticket MEJ-12: Tool `que_puedo_consultar` con capacidades, límites y preguntas sugeridas

- **ID:** MEJ-12
- **Tool / Módulo:** Tool `que_puedo_consultar` (`src/tools/que_puedo_consultar.js`)
- **Fase:** Fase 1.2 (Interactividad y Acompañamiento)
- **Estado:** FINALIZADO
- **Fecha de resolución:** 30/09/2026

## Valor para el Usuario
Ofrece una bienvenida guiada y contextualizada con datos reales de la cuenta (nombre de la empresa, depósitos activos) para clientes que no soportan prompts. Además, permite medir la intención y primeras consultas del usuario para Product Discovery.

## Solución Implementada
Se implementó la tool `que_puedo_consultar`:
- Responde con el perfil conectado, capacidades habilitadas (Ventas, Inventario, Cobranzas), límites operacionales y 4 preguntas de ejemplo listas para copiar y pegar.
- Cero impacto de latencia: reutiliza datos cacheados de la sesión.

## Pruebas de Verificación
- Suite: `tests/phase1.test.js`
- Test: "MEJ-12: tool que_puedo_consultar devuelve guía contextualizada con límites y preguntas sugeridas"
