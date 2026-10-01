# Ticket MEJ-14: Corregir y armonizar descripciones de tools con schemas reales

- **ID:** MEJ-14
- **Tool / Módulo:** Catálogo de herramientas (`src/register-tools.js`, `src/tools/resumen_ventas.js`)
- **Fase:** Fase 1.2 (Interactividad y Acompañamiento)
- **Estado:** FINALIZADO
- **Fecha de resolución:** 30/09/2026

## Valor para el Usuario
Evita que el modelo alucine u ofrezca parámetros inexistentes (ej. agrupar por día en ventas) y habilita formalmente la agrupación diaria demandada por los tableros.

## Solución Implementada
1. Se incorporó formalmente `"dia"` en el enum del schema de `resumen_ventas` (`z.enum(["dia", "mes", "semana", "cliente", "producto", "rubro", "origen"])`).
2. Se implementó la lógica de agrupación diaria en `procesarComprobantes` utilizando `c.FechaEmision.slice(0, 10)`.
3. Se armonizaron las descripciones en `src/register-tools.js` reflejando fielmente las capacidades y límites de cada herramienta.

## Pruebas de Verificación
- Suite: `tests/phase1.test.js`
- Test: "MEJ-14: resumen_ventas soporta agrupar por dia y mantiene descripciones coherentes"
