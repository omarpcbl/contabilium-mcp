export const ordenesVentaGetById = {
  targetPath: ["Ordenes de venta", "GetById"],
  method: "GET",
  urlMatch: "ordenesVenta/?id=",
  name: "Obtener orden de venta por ID (GetById)",
  description: `## Para qué sirve
Retorna el detalle completo de una orden de venta de un cliente, incluyendo el comprador, totales netos y brutos, estado, comprobante asociado y la lista detallada de productos vendidos en el array \`Items\`.

### 🛡️ Rol Crítico en la Prevención de Doble Facturación
Ante demoras de AFIP/ARCA o respuestas de error/timeout (HTTP 504) al invocar \`/ordenesventa/emitirFE\`:
1. **NUNCA reintente la emisión de inmediato.**
2. **Consulte este endpoint:** \`GET /api/ordenesVenta/?id={ID}\`.
3. Verifique el campo **\`IDComprobante\`**:
   * Si **\`IDComprobante > 0\`**: La orden **ya fue facturada con éxito** (la autorización fiscal concluyó de forma diferida).
   * Si **\`IDComprobante === 0\`**: La orden no llegó a emitirse y puede reintentarse de forma segura.
   * Si la orden quedó trabada con un borrador rechazado (Causa C3), el \`IDComprobante\` indicará el ID del borrador a reparar.

---

## Contrato de la Petición
\`GET /api/ordenesVenta/?id={id}\`

| Parámetro | Tipo | Obligatorio | Descripción |
| :--- | :--- | :---: | :--- |
| \`id\` | int | **Sí** | **Identificador numérico interno** de la orden en Contabilium (el campo \`ID\` obtenido en \`search\` o en la creación). |

---

## Campos Clave de la Respuesta
* **\`ID\`** (int): Identificador único interno de la orden.
* **\`NumeroOrden\`** (string): Referencia externa asignada por la integración (\`IdVentaIntegracion\`). Es el valor que se envía a \`emitirFE?nro=...\`.
* **\`IDComprobante\`** (int): \`0\` si no está facturada; mayor a \`0\` si ya tiene comprobante fiscal o borrador asignado.
* **\`Estado\`** (string): \`"Pendiente"\`, \`"Finalizada"\` o \`"Cancelada"\`.
* **\`Items[]\`**: Array con los conceptos vendidos (SKU, cantidad, precio unitario sin IVA, alícuota de IVA y bonificación).

---

## Verificado contra Código
* **Fecha de Verificación:** 2026-10-01
* **Versión Backend:** Contabilium API v2 / v3
* **Referencias de Ingeniería:** \`src/tools/diagnosticar_orden.js\`, \`docs/tickets/OP-08.md\`.`,
  queryParams: [
    {
      key: "id",
      value: "44744305",
      description: "Identificador numérico interno de la orden (ID)."
    }
  ],
  responses: [
    {
      name: "200 OK - Detalle de orden facturada",
      originalRequest: {
        method: "GET",
        header: [],
        url: {
          raw: "{{base_url}}/api/ordenesVenta/?id=44744305",
          host: ["{{base_url}}"],
          path: ["api", "ordenesVenta", ""],
          query: [{ key: "id", value: "44744305" }]
        }
      },
      status: "OK",
      code: 200,
      _postman_previewlanguage: "json",
      header: [{ key: "Content-Type", value: "application/json" }],
      body: JSON.stringify({
        ID: 44744305,
        IDCliente: 46182871,
        Comprador: "EMPRESA EJEMPLO S.A.",
        FechaCreacion: "01/10/2026",
        FechaVencimiento: "",
        NumeroOrden: "FEN-10293",
        Total: "14.500,00",
        TotalNeto: "11.983,47",
        Estado: "Finalizada",
        Integracion: "Fenicio",
        IDComprobante: 95214075,
        Observaciones: "",
        Origen: "E-Commerce",
        Items: [
          {
            Id: 0,
            IdConcepto: 10535931,
            Cantidad: 1,
            Concepto: "PRODUCTO DESTACADO",
            PrecioUnitario: 11983.47,
            Iva: 21,
            Bonificacion: 0,
            IDMoneda: 42508,
            Codigo: "SKU-001",
            Tipo: "P",
            IdRubro: 167909,
            IdSubRubro: null
          }
        ]
      }, null, 4)
    },
    {
      name: "400 Bad Request - ID de orden inexistente",
      originalRequest: {
        method: "GET",
        header: [],
        url: {
          raw: "{{base_url}}/api/ordenesVenta/?id=999999999",
          host: ["{{base_url}}"],
          path: ["api", "ordenesVenta", ""],
          query: [{ key: "id", value: "999999999" }]
        }
      },
      status: "Bad Request",
      code: 400,
      _postman_previewlanguage: "json",
      header: [{ key: "Content-Type", value: "application/json" }],
      body: JSON.stringify({
        Message: "No se encontró ninguna orden de venta con el ID especificado.",
        ErrorCode: 400
      }, null, 4)
    }
  ]
};
