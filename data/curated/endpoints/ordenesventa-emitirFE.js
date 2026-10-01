export const ordenesVentaEmitirFE = {
  targetPath: ["Workflows populares", "Ecommerce & Marketplaces", "Órdenes de venta", "Facturar una venta"],
  method: "GET",
  urlMatch: "ordenesventa/emitirFE",
  name: "Facturar una orden de venta (emitirFE)",
  description: `## Para qué sirve
Emite la Factura Electrónica (con CAE ante ARCA/AFIP) vinculada a una orden de venta de e-commerce previamente guardada en Contabilium, **actualizando su estado a 'Finalizada' y asociando el IDComprobante**.

> ⚠️ **NO USAR** \`/comprobantes/emitirFECobrada\` para facturar órdenes: ese endpoint crea una factura suelta pero **no actualiza la orden de venta**, dejándola abierta o pendiente en Contabilium (Error C1).

---

## Contrato de la Petición
\`GET /api/ordenesventa/emitirFE?nro={nro}&idIntegracion={idIntegracion}\`

| Parámetro | Tipo | Obligatorio | Descripción y Validación |
| :--- | :--- | :---: | :--- |
| \`nro\` | string | **Sí** | **Número externo de la orden** (\`IdVentaIntegracion\` o \`NumeroOrden\`, ej: \`"FEN-10293"\`, \`"0008"\`, \`"39104"\`).<br>❌ **NUNCA enviar el ID numérico interno** de Contabilium (ej. \`44744305\`), causará error *"La orden de venta es inexistente"*. |
| \`idIntegracion\` | int | **Sí** | Identificador de la integración e-commerce donde se registró la orden (ej: \`28778\`). Debe ser exactamente el mismo donde se creó la orden. |

---

## Reglas Fiscales y Letra del Comprobante (Prioridad 1.3)
La letra del comprobante emitido (**Factura A o B**) depende de la combinación entre el \`TipoDocumento\` enviado y la condición tributaria:

| TipoDocumento Enviado | Receptor en AFIP/ARCA | Resultado | Observación y Ticket de Soporte |
| :--- | :--- | :---: | :--- |
| **\`CUIT\`** (11 dígitos) | Responsable Inscripto | **Factura A** | Comportamiento correcto estándar. |
| **\`CUIT\`** (11 dígitos) | Monotributo / Exento / CF | **Factura B** | Comportamiento correcto estándar. |
| **\`CUIL\`** o **\`DNI\`** | Responsable Inscripto | ⚠️ **Factura B (Error C9)** | **Caso API-1156 (Hezka):** El padrón resuelve CUIL/DNI forzando Consumidor Final aunque el receptor sea RI. **Solución:** Enviar siempre \`TipoDocumento: CUIT\` si se requiere Factura A. |
| **\`DNI\`** | Consumidor Final | **Factura B** | Correcto para ventas a particulares / MercadoLibre. |

---

## Flujo y Receta de Integración
\`\`\`mermaid
flowchart TD
    A["1. Crear Orden<br/>POST /notificador/ecommerce"] -->|Esperar 3 a 5 seg| B["2. Verificar Guardado<br/>GET /ordenesVenta/search?fechaDesde=..."]
    B --> C["3. Emitir Factura<br/>GET /ordenesventa/emitirFE?nro=...&idIntegracion=..."]
    C -->|200 OK| D["Factura con CAE emitida<br/>Orden en estado 'Finalizada'"]
    C -->|504 Timeout ARCA| E["Consultar orden antes de reintentar<br/>GET /ordenesVenta/?id=..."]
\`\`\`

1. **Creación:** La orden ingresa por \`/notificador/ecommerce\` o webhook del canal.
2. **Espera de persistencia:** Aguardar de **3 a 5 segundos** antes de emitir para garantizar que la orden se haya grabado completamente en base de datos.
3. **Emisión:** Llamar a \`/ordenesventa/emitirFE\`.
4. **Si hay demora o Timeout (504):** **NO REINTENTAR A CIEGAS**. Consultar primero \`/ordenesVenta/?id={id}\`. Si \`IDComprobante > 0\`, el CAE se autorizó de manera asíncrona; si reintentas, generarás doble factura o error fiscal.

---

## Catálogo de Errores Literales y Soluciones

### 1. \`"La orden de venta es inexistente"\` (Status 400)
Es el error más común (18 tickets). Se debe a una de estas **4 causas exactas**:
* **Causa A (Parámetro \`nro\` erróneo - C5):** Se envió el ID interno (ej: \`28778\`) en lugar del número de orden externo (\`IdVentaIntegracion\`). **Solución:** Enviar el código externo original.
* **Causa B (Integración equivocada - C7):** El \`idIntegracion\` enviado no corresponde a la cuenta integrada donde se guardó la orden.
* **Causa C (Borrador trabado por rechazo previo - C3):** Si un intento anterior falló ante AFIP, la orden queda bloqueada vinculada a un borrador. **Solución:** Ver receta de recuperación de borrador abajo.
* **Causa D (Desfase de persistencia - C6):** La llamada a facturar se ejecutó milisegundos después del POST de creación antes de finalizar el commit en DB.

### 2. \`"La condición de venta no coincide"\` (Status 400 - Error C2)
* **Causa:** El nombre de la condición de venta configurada en la integración (ej. \`"Mercado Pago"\`) no coincide exactamente con la cargada en la cuenta (ej. \`"MercadoPago"\`).
* **Solución:** Configurar el string idéntico (case-sensitive y con los mismos espacios).

### 3. Recuperación de Borrador Trabado (Receta de Desbloqueo)
Si la orden quedó bloqueada con un borrador rechazado:
1. Consultar \`GET /api/ordenesVenta/?id={id}\` y extraer el campo \`IDComprobante\`.
2. Corregir el dato erróneo (ej. fecha o alícuota) con \`PUT /api/comprobantes\`.
3. Autorizar el borrador directamente llamando a \`GET /api/comprobantes/emitirFE?id={IDComprobante}\`.

---

## Límites y Política de Reintentos
* **Rate Limits:** Máximo **25 peticiones cada 10 segundos** por cuenta. Exceder este umbral genera un bloqueo temporal de 1 minuto (HTTP 429).
* **Errores que NO deben reintentarse automáticamente:** Errores 400 por CUIT inválido, condición tributaria incompatible o alícuotas erróneas. Requieren corrección de datos.
* **Errores que SÍ pueden reintentarse:** HTTP 500 / 503 / 504 (espera con backoff exponencial: 5s, 15s, 30s), **siempre verificando previamente** si la orden ya tiene comprobante asignado en \`GetById\`.

---

## Defectos Conocidos (Jira)
* **DEF-C11 (API-1278):** El alta automática de clientes con CUIT válido a través de la orden asigna ocasionalmente la condición 'Consumidor Final' en lugar de Responsable Inscripto si la integración no especifica la condición IVA.
* **DEF-C6:** Demoras de guardado asíncrono en picos de tráfico de e-commerce.

---

## Verificado contra Código
* **Fecha de Verificación:** 2026-10-01
* **Versión Backend:** Contabilium API v2 / v3
* **Referencias de Ingeniería:** \`src/tools/diagnosticar_orden.js\`, \`docs/tickets/OP-08.md\`, Tickets API-1084, API-1145, API-1156, API-1278.`,
  queryParams: [
    {
      key: "nro",
      value: "0008",
      description: "Número de orden dentro de la integración (IdVentaIntegracion o NumeroOrden, ej: 'FEN-10293'). NO enviar el ID interno numérico de Contabilium."
    },
    {
      key: "idIntegracion",
      value: "{{idintegracion}}",
      description: "ID de la integración e-commerce asociada (visible en Ventas > Integraciones)."
    }
  ],
  responses: [
    {
      name: "200 OK - Factura emitida y autorizada con CAE",
      originalRequest: {
        method: "GET",
        header: [],
        url: {
          raw: "{{base_url}}/api/ordenesventa/emitirFE?nro=0008&idIntegracion={{idintegracion}}",
          host: ["{{base_url}}"],
          path: ["api", "ordenesventa", "emitirFE"],
          query: [
            { key: "nro", value: "0008" },
            { key: "idIntegracion", value: "{{idintegracion}}" }
          ]
        }
      },
      status: "OK",
      code: 200,
      _postman_previewlanguage: "json",
      header: [{ key: "Content-Type", value: "application/json" }],
      body: JSON.stringify({
        ID: 95214075,
        CAE: "74010140223193",
        Numero: "0001-00026208",
        ObservacionesAFIP: "Nro de pedido ecommerce 0008",
        FechaCAE: "2026-10-01T00:00:00",
        Error: null,
        LinkPublico: "https://clientes.contabilium.com/public/factura?comprobante=3H4OJu+sSJg+uFUE/juyUg==",
        Total: 14500.00
      }, null, 4)
    },
    {
      name: "400 Bad Request - La orden de venta es inexistente (Causa C5 / C7 / C3)",
      originalRequest: {
        method: "GET",
        header: [],
        url: {
          raw: "{{base_url}}/api/ordenesventa/emitirFE?nro=44744305&idIntegracion={{idintegracion}}",
          host: ["{{base_url}}"],
          path: ["api", "ordenesventa", "emitirFE"],
          query: [
            { key: "nro", value: "44744305" },
            { key: "idIntegracion", value: "{{idintegracion}}" }
          ]
        }
      },
      status: "Bad Request",
      code: 400,
      _postman_previewlanguage: "json",
      header: [{ key: "Content-Type", value: "application/json" }],
      body: JSON.stringify({
        Message: "La orden de venta es inexistente",
        ErrorCode: 400,
        Detalle: "Verifique que 'nro' sea la referencia externa (IdVentaIntegracion) y no el ID interno. Verifique que no exista un borrador vinculado previamente en la orden."
      }, null, 4)
    },
    {
      name: "400 Bad Request - CondicionVenta no coincide (Causa C2)",
      originalRequest: {
        method: "GET",
        header: [],
        url: {
          raw: "{{base_url}}/api/ordenesventa/emitirFE?nro=0008&idIntegracion={{idintegracion}}",
          host: ["{{base_url}}"],
          path: ["api", "ordenesventa", "emitirFE"],
          query: [
            { key: "nro", value: "0008" },
            { key: "idIntegracion", value: "{{idintegracion}}" }
          ]
        }
      },
      status: "Bad Request",
      code: 400,
      _postman_previewlanguage: "json",
      header: [{ key: "Content-Type", value: "application/json" }],
      body: JSON.stringify({
        Message: "La condición de venta configurada en la integración no coincide con ninguna condición de venta registrada en la cuenta",
        ErrorCode: 400
      }, null, 4)
    },
    {
      name: "504 Gateway Timeout - Demora de ARCA (Verificar GetById antes de reintentar)",
      originalRequest: {
        method: "GET",
        header: [],
        url: {
          raw: "{{base_url}}/api/ordenesventa/emitirFE?nro=0008&idIntegracion={{idintegracion}}",
          host: ["{{base_url}}"],
          path: ["api", "ordenesventa", "emitirFE"],
          query: [
            { key: "nro", value: "0008" },
            { key: "idIntegracion", value: "{{idintegracion}}" }
          ]
        }
      },
      status: "Gateway Timeout",
      code: 504,
      _postman_previewlanguage: "json",
      header: [{ key: "Content-Type", value: "application/json" }],
      body: JSON.stringify({
        Message: "The gateway timed out waiting for the AFIP/ARCA authorization server.",
        Action: "NO REINTENTAR DIRECTAMENTE. Consultar GET /api/ordenesVenta/?id={id} para verificar si el CAE fue otorgado asíncronamente."
      }, null, 4)
    }
  ]
};
