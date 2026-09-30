#!/usr/bin/env node
/**
 * Contabilium MCP Server
 * 
 * Implementado bajo el estándar oficial de Model Context Protocol (MCP) 2026:
 * https://modelcontextprotocol.io/docs/2026-07-28/develop/build-server
 * 
 * Características arquitectónicas:
 * - Instancia de McpServer de alto nivel (@modelcontextprotocol/sdk/server/mcp.js)
 * - Esquemas tipados y validados con Zod
 * - Transporte STDIO puro (sin escrituras en stdout, solo stderr vía console.error)
 * - Gestión autónoma del Bearer Token (OAuth2 Client Credentials, TTL 24h, auto-refresh)
 * - Cero fuga de credenciales sensibles (client_secret) hacia el contexto del LLM
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// Cargar .env si existe en el directorio local
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, ".env") });

// -----------------------------------------------------------------------------
// Configuración y Endpoints Base por País
// -----------------------------------------------------------------------------
const COUNTRY_URLS = {
  AR: "https://rest.contabilium.com",
  CL: "https://rest.contabilium.cl",
  UY: "https://rest.contabilium.com.uy",
};

function getBaseUrl() {
  if (process.env.CONTABILIUM_BASE_URL) {
    return process.env.CONTABILIUM_BASE_URL.replace(/\/+$/, "");
  }
  const country = (process.env.CONTABILIUM_COUNTRY || "AR").toUpperCase();
  return COUNTRY_URLS[country] || COUNTRY_URLS.AR;
}

// -----------------------------------------------------------------------------
// Estado en Memoria del Token (Aislado y Seguro)
// -----------------------------------------------------------------------------
let cachedToken = null;
let tokenExpiresAt = 0;

/**
 * Garantiza un token de acceso válido sin exponer credenciales al LLM.
 * Renueva automáticamente si restan menos de 5 minutos de validez o ante 401.
 */
async function ensureValidToken(forceRefresh = false) {
  const now = Date.now();
  const bufferMs = 5 * 60 * 1000; // Margen de 5 minutos

  if (!forceRefresh && cachedToken && now < (tokenExpiresAt - bufferMs)) {
    return cachedToken;
  }

  const clientId = process.env.CONTABILIUM_CLIENT_ID;
  const clientSecret = process.env.CONTABILIUM_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "Credenciales de Contabilium no configuradas. Define CONTABILIUM_CLIENT_ID y CONTABILIUM_CLIENT_SECRET en mcp_config.json o en .env"
    );
  }

  const baseUrl = getBaseUrl();
  const tokenUrl = `${baseUrl}/token`;

  console.error(`[Auth] Solicitando token OAuth2 a ${tokenUrl}...`);

  const bodyParams = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId.trim(),
    client_secret: clientSecret.trim(),
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: bodyParams.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Fallo de autenticación en Contabilium (HTTP ${response.status}): ${errorText || response.statusText}. Verifica client_id y client_secret.`
    );
  }

  const data = await response.json();
  if (!data.access_token) {
    throw new Error("Respuesta inválida de /token: no contiene access_token.");
  }

  cachedToken = data.access_token;
  const expiresInSeconds = Number(data.expires_in) || 86399; // 24 horas estándar
  tokenExpiresAt = Date.now() + (expiresInSeconds * 1000);

  console.error(`[Auth] Token renovado exitosamente. Válido por ${Math.round(expiresInSeconds / 3600)} horas.`);
  return cachedToken;
}

/**
 * Ejecutor HTTP autorizado contra la API de Contabilium
 */
async function callContabiliumApi(endpoint, method = "GET", params = null, body = null, retryOn401 = true) {
  const token = await ensureValidToken();
  const baseUrl = getBaseUrl();

  let cleanEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  if (!cleanEndpoint.startsWith("/api") && !cleanEndpoint.startsWith("/notificador")) {
    cleanEndpoint = `/api${cleanEndpoint}`;
  }

  const url = new URL(`${baseUrl}${cleanEndpoint}`);

  if (params && typeof params === "object") {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        url.searchParams.append(key, String(value));
      }
    }
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };

  const options = {
    method: method.toUpperCase(),
    headers,
  };

  if (body && (options.method === "POST" || options.method === "PUT" || options.method === "PATCH")) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  console.error(`[API] ${options.method} ${url.pathname}${url.search}`);

  let response;
  try {
    response = await fetch(url.toString(), options);
  } catch (err) {
    throw new Error(`Error de red al conectar con ${url.toString()}: ${err.message}`);
  }

  if (response.status === 401 && retryOn401) {
    console.error("[API] Token expirado o revocado (401). Forzando renovación...");
    await ensureValidToken(true);
    return callContabiliumApi(endpoint, method, params, body, false);
  }

  if (response.status === 429) {
    throw new Error(
      "HTTP 429 Too Many Requests: Límite de tasa excedido en Contabilium (25 req/10s en AR, 15 req/10s en CL/UY). Pausar llamadas por 60 segundos."
    );
  }

  const contentType = response.headers.get("content-type") || "";
  let payload;
  if (contentType.includes("application/json")) {
    try {
      payload = await response.json();
    } catch {
      payload = await response.text();
    }
  } else {
    payload = await response.text();
  }

  return {
    status: response.status,
    ok: response.ok,
    payload,
  };
}

// -----------------------------------------------------------------------------
// Inicialización del Servidor MCP Oficial
// -----------------------------------------------------------------------------
const server = new McpServer({
  name: "contabilium-mcp",
  version: "1.0.0",
});

// -----------------------------------------------------------------------------
// REGISTRO DE HERRAMIENTAS (TOOLS) CON ZOD
// -----------------------------------------------------------------------------

// 1. Verificación de Autenticación y Conectividad
server.tool(
  "contabilium_auth_status",
  "Verifica la conectividad y estado del token con Contabilium sin revelar credenciales secretas al modelo.",
  {
    ping: z.boolean().default(true).describe("Si es true, ejecuta una llamada de verificación a /api/usuarios/obtenerinfo."),
  },
  async ({ ping }) => {
    const clientId = process.env.CONTABILIUM_CLIENT_ID;
    const hasSecret = Boolean(process.env.CONTABILIUM_CLIENT_SECRET);
    const country = (process.env.CONTABILIUM_COUNTRY || "AR").toUpperCase();
    const baseUrl = getBaseUrl();

    let maskedEmail = "NO_CONFIGURADO";
    if (clientId) {
      const parts = clientId.split("@");
      maskedEmail = parts.length === 2 ? `${parts[0].slice(0, 2)}***@${parts[1]}` : `${clientId.slice(0, 3)}***`;
    }

    const tokenActive = Boolean(cachedToken && Date.now() < tokenExpiresAt);
    const remainingMinutes = tokenActive ? Math.max(0, Math.round((tokenExpiresAt - Date.now()) / 60000)) : 0;

    const report = {
      configuracion: {
        usuarioIdentificador: maskedEmail,
        clientSecretConfigurado: hasSecret,
        pais: country,
        urlBase: baseUrl,
      },
      token: {
        activo: tokenActive,
        minutosRestantes: remainingMinutes,
        estrategia: "En memoria con auto-refresh transparente antes de expirar",
      },
    };

    if (ping && clientId && hasSecret) {
      try {
        const pingRes = await callContabiliumApi("/usuarios/obtenerinfo", "GET");
        if (pingRes.ok && typeof pingRes.payload === "object") {
          report.conexionEnVivo = {
            conectado: true,
            razonSocial: pingRes.payload.RazonSocial || "N/A",
            cuit: pingRes.payload.CUIT || "N/A",
            condicionIVA: pingRes.payload.CondicionIVA || "N/A",
            tieneFacturaElectronica: Boolean(pingRes.payload.TieneFE),
          };
        } else {
          report.conexionEnVivo = { conectado: false, detalle: pingRes.payload };
        }
      } catch (err) {
        report.conexionEnVivo = { conectado: false, error: err.message };
      }
    }

    return {
      content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
    };
  }
);

// 2. Información de Cuenta y Datos Fiscales
server.tool(
  "contabilium_get_account_info",
  "Obtiene la configuración fiscal, puntos de venta y datos de la empresa en Contabilium.",
  {},
  async () => {
    const res = await callContabiliumApi("/usuarios/obtenerinfo", "GET");
    return {
      content: [{ type: "text", text: JSON.stringify(res.payload, null, 2) }],
    };
  }
);

// 3. Despachador Universal de Peticiones API
server.tool(
  "contabilium_api_request",
  "Ejecuta cualquier petición autorizada contra la API Pública de Contabilium. Inyecta el Bearer Token automáticamente.",
  {
    endpoint: z.string().describe("Ruta del endpoint (ej. '/api/conceptos/search', '/api/stock/Novedades', '/api/comprobantes/search')."),
    method: z.enum(["GET", "POST", "PUT", "DELETE"]).default("GET").describe("Método HTTP."),
    params: z.record(z.any()).optional().describe("Parámetros query string en objeto clave-valor."),
    body: z.record(z.any()).optional().describe("Cuerpo JSON para peticiones POST o PUT."),
  },
  async ({ endpoint, method, params, body }) => {
    const res = await callContabiliumApi(endpoint, method, params, body);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              status: res.status,
              ok: res.ok,
              data: res.payload,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// 4. Consulta Rápida de Inventarios y Stock
server.tool(
  "contabilium_get_stock",
  "Consulta existencias de inventario por SKU, por depósito o detecta deltas de novedades recientes.",
  {
    sku: z.string().optional().describe("Código SKU del producto."),
    idDeposito: z.number().optional().describe("ID del depósito para consultar sus existencias."),
    timestampNovedades: z.string().optional().describe("Fecha ISO (ej: '2026-09-30T00:00:00') para traer novedades."),
  },
  async ({ sku, idDeposito, timestampNovedades }) => {
    let endpoint = "/inventarios/getDepositos";
    let params = {};

    if (sku) {
      endpoint = "/inventarios/getStockBySKU";
      params = { codigo: sku };
    } else if (idDeposito !== undefined) {
      endpoint = "/inventarios/getStockByDeposito";
      params = { id: idDeposito };
    } else if (timestampNovedades) {
      endpoint = "/stock/Novedades";
      params = { timestamp: timestampNovedades };
    }

    const res = await callContabiliumApi(endpoint, "GET", params);
    return {
      content: [{ type: "text", text: JSON.stringify(res.payload, null, 2) }],
    };
  }
);

// 5. Búsqueda de Comprobantes Fiscales
server.tool(
  "contabilium_search_comprobantes",
  "Busca facturas, notas de crédito y recibos por rango de fechas.",
  {
    fechaDesde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Fecha inicial en formato YYYY-MM-DD."),
    fechaHasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Fecha final en formato YYYY-MM-DD."),
    page: z.number().int().min(1).default(1).describe("Número de página."),
  },
  async ({ fechaDesde, fechaHasta, page }) => {
    const params = { fechaDesde, fechaHasta, page };
    const res = await callContabiliumApi("/comprobantes/search", "GET", params);
    return {
      content: [{ type: "text", text: JSON.stringify(res.payload, null, 2) }],
    };
  }
);

// -----------------------------------------------------------------------------
// RECURSOS (RESOURCES) ESTÁTICOS Y PLANTILLAS
// -----------------------------------------------------------------------------
server.resource(
  "referencia-impuestos",
  "contabilium://referencias/impuestos",
  async (uri) => {
    const taxDoc = {
      argentina: {
        condicionIva: ["CF (Consumidor Final)", "RI (Responsable Inscripto)", "MO (Monotributista)", "EX (Exento)"],
        alicuotasIva: [0, 2.5, 5, 10.5, 21, 27],
        tipoDoc: ["DNI", "CUIT", "CUIL"],
      },
      chile: {
        condicionIva: ["CF (Consumidor Final)", "EMPCL (Empresas)", "EXT (Exterior)"],
        alicuotasIva: [0, 19],
        tipoDoc: ["RUT", "CI", "PAS"],
      },
      uruguay: {
        condicionIva: ["CF (Consumidor Final)", "EMPUY (Empresas)", "PEQUY (Pequeña Empresa)", "EXT (Exterior)"],
        alicuotasIva: [0, 10, 22],
        tipoDoc: ["RUT", "CI", "DNI", "PAS", "NIFE"],
      },
    };
    return {
      contents: [
        {
          uri: uri.href,
          text: JSON.stringify(taxDoc, null, 2),
          mimeType: "application/json",
        },
      ],
    };
  }
);

// -----------------------------------------------------------------------------
// PROMPTS PREDEFINIDOS PARA EL PRODUCT BUILDER
// -----------------------------------------------------------------------------
server.prompt(
  "diagnostico-conexion",
  "Plantilla para validar la conexión y reportar el estado de la cuenta sin exponer claves.",
  {},
  () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: "Ejecuta la herramienta contabilium_auth_status para validar si la conexión está lista, verificar los datos fiscales de mi empresa y confirmar cuántos minutos de validez tiene el token actual.",
        },
      },
    ],
  })
);

// -----------------------------------------------------------------------------
// Arranque sobre STDIO
// -----------------------------------------------------------------------------
async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Contabilium MCP Server (McpServer SDK 2026) activo y escuchando en STDIO.");
}

run().catch((err) => {
  console.error("Error fatal en Contabilium MCP Server:", err);
  process.exit(1);
});
