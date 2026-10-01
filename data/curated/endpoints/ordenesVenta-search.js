export const ordenesVentaSearch = {
  targetPath: ["Ordenes de venta", "Search"],
  method: "GET",
  urlMatch: "ordenesVenta/search",
  name: "Buscar órdenes de venta (search)",
  description: `## Para qué sirve
Permite buscar y listar órdenes de venta registradas en la cuenta (tanto creadas manualmente como provenientes de integraciones e-commerce) dentro de un rango de fechas.

Es la herramienta fundamental para **verificar el estado de las órdenes antes de facturar**, reconciliar carritos y recuperar el \`IDComprobante\` o el \`NumeroOrden\` (\`IdVentaIntegracion\`).

---

## Contrato de la Petición
\`GET /api/ordenesVenta/search?fechaDesde={fechaDesde}&fechaHasta={fechaHasta}&page={page}&pageSize={pageSize}\`

| Parámetro | Tipo | Obligatorio | Descripción y Validación |
| :--- | :--- | :---: | :--- |
| \`fechaDesde\` | string | **Sí** | Fecha inicial del rango. Formato recomendado: \`YYYY-MM-DD\` (o \`dd/mm/yyyy\`). |
| \`fechaHasta\` | string | **Sí** | Fecha final del rango. Formato recomendado: \`YYYY-MM-DD\` (o \`dd/mm/yyyy\`). |
| \`page\` | int | No | Número de página (base 1). Por defecto: \`1\`. |
| \`pageSize\` | int | No | Cantidad de registros por página. Por defecto: \`50\` (máximo permitido: \`50\`). |

---

## Estructura de la Respuesta (\`Items[]\`) y Mapeo Crítico
Cada ítem retornado en la lista contiene los campos clave para el flujo de facturación:

* **\`ID\`** (int): **Identificador numérico interno** de la orden en Contabilium (ej. \`41828059\`). Utilizable en \`/ordenesVenta/?id={ID}\`. ⚠️ **NO ENVIAR ESTE ID** al parámetro \`nro\` de \`emitirFE\`.
* **\`NumeroOrden\`** (string): **Referencia externa de la orden** (\`IdVentaIntegracion\`, ej: \`"00000003"\`, \`"FEN-10293"\`). ✅ **ESTE ES EL VALOR QUE DEBE ENVIARSE** como \`nro\` en \`/ordenesventa/emitirFE\`.
* **\`IDComprobante\`** (int): Identificador de la factura asociada.
  * Si es **\`0\`**: La orden aún no fue facturada (está pendiente).
  * Si es **\`> 0\`**: La orden **ya tiene factura emitida**. No se debe reintentar la emisión.
* **\`Estado\`** (string): Estado actual (\`"Pendiente"\`, \`"Finalizada"\`, \`"Cancelada"\`).
* **\`TipoDocumento\`** y **\`NroDocumento\`**: Datos del comprador para validar consistencia fiscal antes de emitir.

---

## Límites y Reglas de Paginación
* **Ventana máxima de consulta:** Se recomienda consultar rangos no mayores a **92 días** entre \`fechaDesde\` y \`fechaHasta\` para evitar timeouts de base de datos.
* **Límite de paginación:** Máximo 20 páginas por consulta (\`TotalPage\` máximo 20).

---

## Verificado contra Código
* **Fecha de Verificación:** 2026-10-01
* **Versión Backend:** Contabilium API v2 / v3
* **Referencias de Ingeniería:** \`src/tools/diagnosticar_orden.js\`, \`docs/tickets/OP-08.md\`.`,
  queryParams: [
    {
      key: "fechaDesde",
      value: "2026-09-01",
      description: "Fecha inicial del rango (YYYY-MM-DD)."
    },
    {
      key: "fechaHasta",
      value: "2026-09-30",
      description: "Fecha final del rango (YYYY-MM-DD). Rango máximo recomendado: 92 días."
    },
    {
      key: "page",
      value: "1",
      description: "Número de página a consultar (base 1)."
    },
    {
      key: "pageSize",
      value: "50",
      description: "Cantidad de órdenes por página (máx: 50)."
    }
  ],
  responses: [
    {
      name: "200 OK - Listado de órdenes encontradas",
      originalRequest: {
        method: "GET",
        header: [],
        url: {
          raw: "{{base_url}}/api/ordenesVenta/search?fechaDesde=2026-09-01&fechaHasta=2026-09-30&page=1&pageSize=50",
          host: ["{{base_url}}"],
          path: ["api", "ordenesVenta", "search"],
          query: [
            { key: "fechaDesde", value: "2026-09-01" },
            { key: "fechaHasta", value: "2026-09-30" },
            { key: "page", value: "1" },
            { key: "pageSize", value: "50" }
          ]
        }
      },
      status: "OK",
      code: 200,
      _postman_previewlanguage: "json",
      header: [{ key: "Content-Type", value: "application/json" }],
      body: JSON.stringify({
        TotalItems: 2,
        TotalPage: 1,
        Items: [
          {
            ID: 44744305,
            IDPersona: 46182871,
            IDComprobante: 95214075,
            FechaCreacion: "01/10/2026",
            FechaVencimiento: "01/10/2026",
            Total: "14.500,00",
            Comprador: "EMPRESA EJEMPLO S.A.",
            Moneda: "$",
            NumeroOrden: "FEN-10293",
            Estado: "Finalizada",
            TotalNeto: "11.983,47",
            Integracion: "Fenicio",
            TipoDocumento: "CUIT",
            NroDocumento: "30712345678",
            Observaciones: null,
            Deposito: "Central",
            Origen: "E-Commerce"
          },
          {
            ID: 44744306,
            IDPersona: 46183286,
            IDComprobante: 0,
            FechaCreacion: "01/10/2026",
            FechaVencimiento: "",
            Total: "8.200,00",
            Comprador: "JUAN PEREZ",
            Moneda: "$",
            NumeroOrden: "0008",
            Estado: "Pendiente",
            TotalNeto: null,
            Integracion: "WooCommerce",
            TipoDocumento: "DNI",
            NroDocumento: "35123456",
            Observaciones: null,
            Deposito: "Central",
            Origen: "E-Commerce"
          }
        ]
      }, null, 4)
    },
    {
      name: "400 Bad Request - Formato o rango de fechas inválido",
      originalRequest: {
        method: "GET",
        header: [],
        url: {
          raw: "{{base_url}}/api/ordenesVenta/search?fechaDesde=2024-01-01&fechaHasta=2024-12-31",
          host: ["{{base_url}}"],
          path: ["api", "ordenesVenta", "search"],
          query: [
            { key: "fechaDesde", value: "2024-01-01" },
            { key: "fechaHasta", value: "2024-12-31" }
          ]
        }
      },
      status: "Bad Request",
      code: 400,
      _postman_previewlanguage: "json",
      header: [{ key: "Content-Type", value: "application/json" }],
      body: JSON.stringify({
        Message: "El rango de fechas especificado supera el límite máximo permitido de 92 días.",
        ErrorCode: 400
      }, null, 4)
    }
  ]
};
