# Contabilium MCP Server

Servidor oficial **Model Context Protocol (MCP)** para conectar asistentes de IA (Claude, Antigravity, Cursor, etc.) con la **API de Contabilium** de forma segura, con herramientas de analítica de negocio, gestión de órdenes/catálogo y **simulación asistida para integradores de la API**.

---

## 🎯 Contexto y Capacidades Principales

Este servidor MCP está diseñado tanto para **usuarios de gestión** como para **desarrolladores e integradores** que están dando sus primeros pasos con la API REST de Contabilium:

1. **¿Cómo vengo vendiendo?** (`listar_ventas`, `resumen_ventas`, `buscar_ordenes_venta`, `enviar_venta`)
2. **¿Qué stock tengo y cómo actualizo mi catálogo?** (`buscar_productos`, `listar_depositos`, `stock_por_deposito`, `modificar_concepto`, `modificar_stock_concepto`)
3. **¿Quién me debe?** (`buscar_clientes`, `cuentas_por_cobrar`)
4. **Onboarding, Simulación y Diagnóstico para Integradores API:**
   - `que_puedo_consultar`: Guía interactiva que explica cómo funciona cada tool internamente, qué parámetros espera y ejemplos de uso.
   - `emular_facturacion`: **Simulador Dry-Run (100% lectura, sin impacto fiscal)** que valida cliente, algoritmo de CUIT/DNI/RUT, letra del comprobante según la Matriz Oficial de AFIP (`FA`/`FB`/`FC`), punto de venta, condición de venta (`Error C2`), SKUs y stock, devolviendo los **contratos HTTP y payloads JSON exactos listos para copiar y pegar**.
   - `crear_borrador_factura`: Guarda un borrador de factura en Contabilium (`POST /api/comprobantes/crear`) sin solicitar CAE ante AFIP/ARCA.
   - `diagnosticar_orden`: Audita por qué una orden de e-commerce no facturó o fue rechazada (`C1` a `C15`).

---

## 🔒 Arquitectura de Seguridad y Privacidad

1. **Protección Fiscal por Defecto:** Las herramientas que autorizan comprobantes reales con CAE ante AFIP/ARCA (`autorizar_factura_electronica`, `emitir_factura_express`, `obtener_factura_pdf`) están **bloqueadas por defecto**. En su lugar se disponibilizan `emular_facturacion` (Dry-Run) y `crear_borrador_factura` (solo borrador sin CAE).
2. **Interruptor por Tool (`NOT_ALLOWED_TOOLS`):** Permite apagar cualquier tool de forma individual mediante variables de entorno sin tocar código.
3. **Cero fuga de credenciales:** Tus credenciales (`client_id` y `client_secret`) nunca llegan al LLM. En despliegues remotos se transmiten cifradas con **AES-256-GCM** en el parámetro `?auth=...`.
4. **Gestión autónoma de OAuth2:** Renovación automática de tokens Bearer antes de expirar y reintento transparente ante respuestas 401.
5. **Rate Limiting Defensivo:** Token bucket integrado (2 req/s, máx 25 req / 10s) con pausas automáticas y reintentos ante 429.
6. **Normalización Monetaria y Paginación por Tramos:** Convierte formatos de moneda latina (`"40.460,11"`) y particiona rangos largos para evitar truncamientos por cotizaciones.

---

## 🛠️ Catálogo de Tools

### Tools Habilitadas por Defecto (18)

| Tool | Flujo | Descripción |
|---|---|---|
| `que_puedo_consultar` | Onboarding / Guía | Explica los módulos disponibles y detalla cómo funciona internamente cualquier tool (parámetros obligatorios/opcionales y ejemplos). |
| `buscar_clientes` | Catálogo / Cobranzas | Busca clientes por nombre, razón social o CUIT. Devuelve IDs necesarios para filtrar ventas y deudas. |
| `buscar_productos` | Catálogo | Busca productos por SKU o nombre. Devuelve código, descripción, precio de venta, stock total, `costo_interno` y proveedor. |
| `modificar_concepto` | Catálogo / Edición | Modifica datos de un concepto existente (precio, costo interno, IVA, nombre, descripción, estado activo/inactivo, código de barras, SKU). No crea nuevos. |
| `buscar_proveedores` | Compras | Busca proveedores por nombre, razón social o CUIT con datos de contacto para reposición. |
| `listar_depositos` | Stock | Lista los depósitos configurados con sus IDs. |
| `stock_por_deposito` | Stock | Consulta stock físico, reservado y disponible real de un producto en un depósito específico o en todos. |
| `modificar_stock_concepto` | Stock / Edición | Modifica o reemplaza el stock físico (y opcionalmente precio) de un producto por SKU o por ID en un depósito. |
| `listar_ventas` | Ventas | Lista comprobantes fiscales de venta emitidos en un período (máximo 92 días por consulta). |
| `resumen_ventas` | Ventas | Totaliza ventas netas por período, agrupables por día, semana, mes, cliente u origen. Resta Notas de Crédito y excluye cotizaciones. |
| `buscar_ordenes_venta` | Ventas / E-commerce | Busca órdenes de preventa o e-commerce por rango de fechas, filtro (número de orden externa) e ID de integración opcional. |
| `enviar_venta` | Ventas / E-commerce | Envía (crea o actualiza) una orden de venta e-commerce en Contabilium (`POST /notificador/ecommerce`), resolviendo el depósito por nombre (`deposito`) o ID (`id_deposito`). |
| `emular_facturacion` | Facturación (Dry-Run) | **Simulador 100% libre de riesgo fiscal:** valida cliente, CUIT, Matriz AFIP (`FA`/`FB`/`FC`), punto de venta, condición de venta, SKUs y stock, y genera los payloads JSON exactos para integrar con la API. |
| `crear_borrador_factura` | Facturación (Borrador) | Guarda un borrador en Contabilium (`POST /api/comprobantes/crear`) con precálculo fiscal AFIP sin pedir CAE a AFIP. |
| `cuentas_por_cobrar` | Deuda | Lista comprobantes pendientes de cobro y genera el reporte de antigüedad de deuda (Aging: 0-30, 31-60, 61-90, >90 días). |
| `diagnosticar_orden` | Diagnóstico | Diagnóstico automatizado de órdenes e integraciones e-commerce (detecta duplicados, valida CUIT/RUT, stock y causa raíz C1-C15). |
| `registrar_consulta_no_soportada` | Discovery | Registra internamente consultas fuera de alcance para priorizar el backlog de producto. |
| `contabilium_auth_status` | Diagnóstico | Valida conectividad y reporta Razón Social, CUIT, ambiente y estado del token. |

### Tools de Emisión Fiscal Directa (Bloqueadas por defecto)

| Tool | Flujo | Estado por defecto |
|---|---|---|
| `autorizar_factura_electronica` | Facturación AFIP/SII | Bloqueada (requiere `ENABLE_BILLING_TOOLS=true`) |
| `emitir_factura_express` | Facturación AFIP/SII | Bloqueada (requiere `ENABLE_BILLING_TOOLS=true`) |
| `obtener_factura_pdf` | Facturación AFIP/SII | Bloqueada (requiere `ENABLE_BILLING_TOOLS=true`) |

---

## ⚙️ Cómo Apagar o Prender Tools (`NOT_ALLOWED_TOOLS`)

Todas las tools están habilitadas por defecto (salvo las 3 de emisión fiscal directa ante AFIP). Si considerás riesgosa alguna tool en un entorno determinado, podés **apagarla individualmente** agregándola a la variable de entorno `NOT_ALLOWED_TOOLS` (separadas por coma) en tu `.env` o en el panel de **Vercel** (`Settings > Environment Variables`):

```env
# Ejemplo: apagar modificación de stock, modificación de conceptos y creación de borradores
NOT_ALLOWED_TOOLS=autorizar_factura_electronica,emitir_factura_express,obtener_factura_pdf,modificar_stock_concepto,modificar_concepto,crear_borrador_factura
```

Cuando una tool se incluye en `NOT_ALLOWED_TOOLS`:
1. **No se registra en el servidor MCP**, por lo que el LLM ni siquiera la ve en su listado de herramientas.
2. **Se oculta automáticamente del catálogo activo** en `que_puedo_consultar`.

---

## 🚀 Despliegue y Conexión

### Opción A: Claude / Clientes Remotos (Streamable HTTP / SSE)
El servidor incluye una interfaz web integrada en `/` para generar tu URL segura:
1. Despliega el proyecto en **Vercel** o **Render**.
2. Ingresa a la URL de tu despliegue (ej. `https://tu-servidor.vercel.app/`).
3. Ingresa la clave de acceso del portal (`PORTAL_ACCESS_SECRET`), tu Email de API y tu API Key de Contabilium.
4. Copia la URL generada:
   - **Streamable HTTP (Estándar Claude):** `https://tu-servidor.vercel.app/mcp?auth=<TOKEN_CIFRADO>`
5. En Claude, ve a **Settings > Connectors > Add custom connector**:
   - **Name:** Contabilium
   - **MCP server URL:** Pega la URL generada
   - **Authentication:** `No sign-in (Detected)`

### Opción B: Local (STDIO)
Ideal para Antigravity, Claude Desktop o Cursor:
```json
{
  "mcpServers": {
    "contabilium": {
      "command": "node",
      "args": ["C:\\cbl\\contabilium-mcp\\index.js"],
      "env": {
        "CONTABILIUM_CLIENT_ID": "tu_email@empresa.com",
        "CONTABILIUM_CLIENT_SECRET": "tu_api_key_privada",
        "CONTABILIUM_COUNTRY": "AR",
        "CONTABILIUM_BASE_URL": "https://rest.contabilium.com",
        "NOT_ALLOWED_TOOLS": "autorizar_factura_electronica,emitir_factura_express,obtener_factura_pdf"
      }
    }
  }
}
```

---

## 🧪 Cómo Probar en Local Apuntando a QA / Staging

Haber desactivado la ruta pública `/qa` en el servidor web remoto **no impide probar contra QA**. Podés apuntar el MCP al entorno de QA de forma 100% local y segura (sin exponer rutas en internet) de dos maneras:

### Alternativa 1: Por STDIO en tu IDE / Cliente MCP (Recomendado)
Podés registrar una instancia local dedicada a QA (e incluso tener Producción y QA al mismo tiempo en Antigravity, Cursor o Claude Desktop) sobrescribiendo `CONTABILIUM_BASE_URL` y `MCP_ENVIRONMENT`:

```json
{
  "mcpServers": {
    "contabilium-local-qa": {
      "command": "node",
      "args": ["C:\\cbl\\contabilium-mcp\\index.js"],
      "env": {
        "CONTABILIUM_CLIENT_ID": "tu_email_qa@contabilium.com",
        "CONTABILIUM_CLIENT_SECRET": "tu_api_key_qa",
        "CONTABILIUM_COUNTRY": "AR",
        "CONTABILIUM_BASE_URL": "https://rest-qa.contabilium.com",
        "MCP_ENVIRONMENT": "qa",
        "CONTABILIUM_IGNORE_SSL": "true",
        "NOT_ALLOWED_TOOLS": ""
      }
    }
  }
}
```

> **Detalles útiles para QA:**
> - **`CONTABILIUM_BASE_URL`**: Apunta todas las llamadas OAuth2 (`/token`) y de API (`/api/...`, `/notificador/ecommerce`) al servidor de QA/Staging que indiques.
> - **`MCP_ENVIRONMENT: "qa"`**: Hace que el cliente y la tool `contabilium_auth_status` reporten explícitamente `"QA / Pruebas (Ambiente de Testing - Sin validez fiscal ante AFIP)"` (`validezFiscalReal: false`). Además, el cliente detecta automáticamente URLs que contengan `qa`, `staging`, `dev`, `sandbox` o `test`.
> - **`CONTABILIUM_IGNORE_SSL: "true"`**: Útil si el entorno interno de QA (vía VPN) utiliza certificados SSL autofirmados.
> - **`ENABLE_BILLING_TOOLS: "true"`** *(Opcional)*: Si en QA querés probar también las tools de emisión electrónica (`autorizar_factura_electronica`, `emitir_factura_express`), podés agregar `"ENABLE_BILLING_TOOLS": "true"` únicamente en tu configuración local de QA.

### Alternativa 2: Servidor HTTP Local (`localhost:3000`) apuntando a QA
Si querés probar el portal web y el transporte Streamable HTTP (`/mcp`) localmente contra QA:

1. Editá tu archivo `.env` local (que está ignorado por Git):
   ```env
   CONTABILIUM_CLIENT_ID=tu_email_qa@contabilium.com
   CONTABILIUM_CLIENT_SECRET=tu_api_key_qa
   CONTABILIUM_COUNTRY=AR
   CONTABILIUM_BASE_URL=https://rest-qa.contabilium.com
   MCP_ENVIRONMENT=qa
   CONTABILIUM_IGNORE_SSL=true
   ```
2. Ejecutá el servidor en tu máquina:
   ```bash
   npm start
   ```
3. Conectá tu cliente MCP a `http://localhost:3000/mcp` (o abrí `http://localhost:3000` en el navegador para generar el token cifrado local).
4. Para verificar que estás conectado a QA, ejecutá la tool `contabilium_auth_status` y comprobá que devuelva `"validezFiscalReal": false` y `"ambiente": "QA / Pruebas..."`.
