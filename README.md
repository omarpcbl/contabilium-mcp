# Contabilium MCP Server

Servidor oficial **Model Context Protocol (MCP)** para conectar asistentes de IA (Claude, Antigravity, Cursor, etc.) con la **API de Contabilium** de forma 100% segura y bajo una arquitectura de solo lectura.

---

## 🎯 Contexto y Filosofía del MVP (Solo Lectura)

Este servidor expone **8 tools de solo lectura** sobre endpoints existentes de la API REST de Contabilium. No abre endpoints nuevos en el backend de Contabilium: su objetivo es validar el valor de negocio respondiendo a tres flujos críticos:
1. **¿Cómo vengo vendiendo?** (`listar_ventas`, `resumen_ventas`)
2. **¿Qué stock tengo y dónde?** (`buscar_productos`, `listar_depositos`, `stock_por_deposito`)
3. **¿Quién me debe?** (`buscar_clientes`, `cuentas_por_cobrar`)

Además, incorpora `registrar_consulta_no_soportada` como instrumento de Product Discovery para capturar las intenciones de usuario no resueltas.

---

## 🔒 Arquitectura de Seguridad y Privacidad

1. **Sin escritura:** El servidor únicamente ejecuta llamadas `GET`. Ninguna tool crea, modifica ni elimina registros.
2. **Cero fuga de credenciales:** Tus credenciales (`client_id` y `client_secret`) nunca llegan al LLM. En despliegues remotos se transmiten cifradas con **AES-256-GCM** en el parámetro `?auth=...`.
3. **Gestión autónoma de OAuth2:** Renovación automática de tokens Bearer antes de expirar y reintento transparente ante respuestas 401.
4. **Rate Limiting Defensivo:** Token bucket integrado (2 req/s, máx 25 req / 10s) con pausas automáticas y reintentos ante 429.
5. **Normalización Monetaria:** Convierte formatos de moneda argentina (`"40.460,11"`) a números de coma flotante.
6. **Tope de Paginación:** Hasta 20 páginas (1.000 registros) marcando `truncado: true` cuando se alcanza el límite.

---

## 🛠️ Catálogo de Tools (8 Oficiales + 1 Diagnóstico)

| Tool | Flujo | Descripción |
|---|---|---|
| `buscar_clientes` | Catálogo | Busca clientes por nombre, razón social o CUIT. Devuelve IDs necesarios para filtrar ventas y deudas. |
| `buscar_productos` | Catálogo | Busca productos por SKU o nombre. Devuelve código, descripción, precio de venta, stock total, costo_interno y proveedor. |
| `buscar_proveedores` | Compras | Busca proveedores por nombre, razón social o CUIT con datos de contacto para reposición. |
| `listar_depositos` | Catálogo | Lista los depósitos configurados con sus IDs. Usar antes de consultar stock por depósito. |
| `listar_ventas` | Ventas | Lista comprobantes de venta emitidos en un período. Máximo 92 días por consulta. |
| `resumen_ventas` | Ventas | Totaliza ventas por período, agrupables por día, semana, mes o cliente. Resta Notas de Crédito. |
| `stock_por_deposito` | Stock | Consulta stock actual y reservado de un producto en un depósito específico o en todos. Calcula disponible real. |
| `cuentas_por_cobrar` | Deuda | Lista comprobantes con saldo pendiente de cobro y totaliza deuda agrupada por cliente. |
| `registrar_consulta_no_soportada` | Discovery | Registra internamente consultas fuera de alcance para priorizar el backlog de producto. |
| `contabilium_auth_status` | Diagnóstico | Valida conectividad y reporta Razón Social, CUIT y estado del token. |

---

## 🚀 Despliegue y Conexión

### Opción A: Claude (Streamable HTTP / SSE Remoto)
El servidor incluye una interfaz web integrada en `/` para generar tu URL segura:
1. Despliega el proyecto en **Vercel** o **Render**.
2. Ingresa a la URL de tu despliegue (ej. `https://tu-servidor.vercel.app/`).
3. Ingresa tu Email de API y tu API Key de Contabilium.
4. Copia la URL generada:
   - **Streamable HTTP (Estándar Claude):** `https://tu-servidor.vercel.app/mcp?auth=<TOKEN_CIFRADO>`
5. En Claude, ve a **Settings > Connectors > Add custom connector**:
   - **Name:** Contabilium
   - **MCP server URL:** Pega la URL generada
   - **Authentication:** `No sign-in (Detected)`
6. ¡Listo! Claude se conectará a tu cuenta de Contabilium con las 8 herramientas disponibles.

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
        "CONTABILIUM_COUNTRY": "AR"
      }
    }
  }
}
```
