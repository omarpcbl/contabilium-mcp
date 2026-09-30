# Contabilium MCP Server

Servidor **Model Context Protocol (MCP)** para integrar agentes de IA (Antigravity, Claude Desktop, Cursor, etc.) con la **API Pública de Contabilium** de forma 100% segura.

---

## 🔒 Problema que Resuelve: Cero Exposición de Credenciales

En una integración convencional, tendrías que pegar tu `client_secret` (API Key) o tu Bearer Token en el chat o en el contexto del modelo, lo que representa un riesgo de seguridad y satura la ventana de contexto.

Este servidor MCP actúa como una **capa intermedia aislada**:
1. **Credenciales Ocultas:** `client_secret` vive en tu máquina (en variables de entorno o archivo `.env`). El agente de IA **nunca** lo ve ni puede filtrarlo.
2. **Ciclo de Vida Automático del Token:** El servidor solicita el `access_token` OAuth2 (`POST /token`), lo mantiene en memoria durante sus 24 horas de vigencia y lo renueva de forma transparente antes de que expire (o ante un error 401).
3. **Mapeo Multipaís:** Soporta automáticamente Argentina (`rest.contabilium.com`), Chile (`rest.contabilium.cl`) y Uruguay (`rest.contabilium.com.uy`).
4. **Protección contra 429 (Rate Limit):** Detecta exceso de tasa (25 req/10s) y notifica al agente con diagnósticos claros.

---

## 🛠️ Herramientas Expuestas al Agente (Tools)

1. `contabilium_auth_status`
   - Verifica la validez del token y la conexión sin exponer secretos.
   - Realiza un ping a `/api/usuarios/obtenerinfo` y reporta: Razón Social, CUIT/RUT, Condición de IVA y estado del token.
2. `contabilium_get_account_info`
   - Retorna la configuración completa de la empresa (puntos de venta, estado fiscal, modo QA, etc.).
3. `contabilium_api_request`
   - Despachador universal: Permite al agente ejecutar cualquier endpoint (`/api/...`) con método `GET`, `POST`, `PUT` o `DELETE`, inyectando automáticamente la cabecera `Authorization: Bearer <token>`.
4. `contabilium_get_stock`
   - Helper de inventario: búsqueda directa por SKU, por ID de depósito o novedades delta por `timestamp`.
5. `contabilium_search_comprobantes`
   - Búsqueda de facturas y notas de crédito emitidas por rango de fechas.

---

## 🚀 Configuración en Antigravity

El servidor se registra en tu archivo global de configuración MCP:
`C:\Users\Usuario\.gemini\config\mcp_config.json`

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

*Alternativa con archivo `.env`:*
Puedes crear un archivo `.env` dentro de `C:\cbl\contabilium-mcp` a partir de `.env.example` y dejar el objeto `"env": {}` vacío en `mcp_config.json`.
