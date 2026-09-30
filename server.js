#!/usr/bin/env node
/**
 * Contabilium Remote Multi-Tenant MCP Server (SSE Transport)
 * 
 * Permite a CUALQUIER usuario conectar su propia cuenta de Contabilium a Claude
 * sin necesidad de configurar variables de entorno en el servidor.
 * 
 * Formas en que un Usuario X envía sus credenciales:
 * 1. Parámetro 'auth' encriptado/ofuscado en la URL: /sse?auth=<token_base64>
 * 2. Parámetros query directos: /sse?client_id=...&client_secret=...&country=AR
 * 3. Headers HTTP (si el cliente los soporta)
 * 4. Portal Web incorporado en GET / para generar la URL lista para pegar en Claude.
 */

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const COUNTRY_URLS = {
  AR: "https://rest.contabilium.com",
  CL: "https://rest.contabilium.cl",
  UY: "https://rest.contabilium.com.uy",
};

// Mapa de transportes activos por ID de sesión
const transports = new Map();

/**
 * Helper para extraer credenciales desde query, headers o auth token
 */
function extractUserCredentials(req) {
  // 1. Si viene un token 'auth' codificado en Base64Url
  if (req.query.auth) {
    try {
      const decoded = Buffer.from(req.query.auth, "base64url").toString("utf8");
      const parsed = JSON.parse(decoded);
      return {
        clientId: parsed.clientId || parsed.client_id,
        clientSecret: parsed.clientSecret || parsed.client_secret,
        country: (parsed.country || "AR").toUpperCase(),
      };
    } catch (e) {
      console.error("[Auth] Error decodificando token auth:", e.message);
    }
  }

  // 2. Si vienen por Query String directo
  if (req.query.client_id && req.query.client_secret) {
    return {
      clientId: req.query.client_id,
      clientSecret: req.query.client_secret,
      country: (req.query.country || "AR").toUpperCase(),
    };
  }

  // 3. Si vienen por Headers HTTP
  if (req.headers["x-contabilium-client-id"] && req.headers["x-contabilium-client-secret"]) {
    return {
      clientId: req.headers["x-contabilium-client-id"],
      clientSecret: req.headers["x-contabilium-client-secret"],
      country: (req.headers["x-contabilium-country"] || "AR").toUpperCase(),
    };
  }

  // 4. Fallback a variables del servidor (modo mono-empresa)
  return {
    clientId: process.env.CONTABILIUM_CLIENT_ID,
    clientSecret: process.env.CONTABILIUM_CLIENT_SECRET,
    country: (process.env.CONTABILIUM_COUNTRY || "AR").toUpperCase(),
  };
}

/**
 * Fábrica de servidor MCP aislado por sesión de usuario
 */
function createMcpServerForSession(credentials) {
  const { clientId, clientSecret, country = "AR" } = credentials;
  const baseUrl = COUNTRY_URLS[country] || COUNTRY_URLS.AR;

  let cachedToken = null;
  let tokenExpiresAt = 0;

  async function ensureValidToken(forceRefresh = false) {
    const now = Date.now();
    const bufferMs = 5 * 60 * 1000;

    if (!forceRefresh && cachedToken && now < (tokenExpiresAt - bufferMs)) {
      return cachedToken;
    }

    if (!clientId || !clientSecret) {
      throw new Error(
        "Credenciales no encontradas para tu sesión. Conecta Claude usando una URL que contenga tu parámetro auth generado en el portal del servidor."
      );
    }

    const tokenUrl = `${baseUrl}/token`;
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
      const errText = await response.text();
      throw new Error(`Error de autenticación en Contabilium (${response.status}): ${errText}`);
    }

    const data = await response.json();
    cachedToken = data.access_token;
    const expiresIn = Number(data.expires_in) || 86399;
    tokenExpiresAt = Date.now() + (expiresIn * 1000);
    return cachedToken;
  }

  async function callApi(endpoint, method = "GET", params = null, body = null, retry = true) {
    const token = await ensureValidToken();
    let cleanEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
    if (!cleanEndpoint.startsWith("/api") && !cleanEndpoint.startsWith("/notificador")) {
      cleanEndpoint = `/api${cleanEndpoint}`;
    }

    const url = new URL(`${baseUrl}${cleanEndpoint}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) url.searchParams.append(k, String(v));
      }
    }

    const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    const opts = { method: method.toUpperCase(), headers };
    if (body && ["POST", "PUT", "PATCH"].includes(opts.method)) {
      headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }

    const res = await fetch(url.toString(), opts);
    if (res.status === 401 && retry) {
      await ensureValidToken(true);
      return callApi(endpoint, method, params, body, false);
    }

    if (res.status === 429) {
      throw new Error("HTTP 429: Límite de tasa excedido en Contabilium (25 req/10s). Pausa 60s.");
    }

    const cType = res.headers.get("content-type") || "";
    const payload = cType.includes("application/json") ? await res.json() : await res.text();
    return { status: res.status, ok: res.ok, payload };
  }

  const server = new McpServer({
    name: "contabilium-remote-mcp",
    version: "1.0.0",
  });

  // Tool 1: Estado y Salud
  server.tool(
    "contabilium_auth_status",
    "Verifica el estado del token y conectividad con tu cuenta de Contabilium.",
    { ping: z.boolean().default(true) },
    async ({ ping }) => {
      let masked = "NO_CONFIGURADO";
      if (clientId) {
        const parts = clientId.split("@");
        masked = parts.length === 2 ? `${parts[0].slice(0, 2)}***@${parts[1]}` : `${clientId.slice(0, 3)}***`;
      }
      const tokenActive = Boolean(cachedToken && Date.now() < tokenExpiresAt);
      const remainingMinutes = tokenActive ? Math.max(0, Math.round((tokenExpiresAt - Date.now()) / 60000)) : 0;

      const report = {
        configuracion: { usuarioIdentificador: masked, clientSecretConfigurado: Boolean(clientSecret), pais: country, urlBase: baseUrl },
        token: { activo: tokenActive, minutosRestantes: remainingMinutes },
      };

      if (ping && clientId && clientSecret) {
        try {
          const pingRes = await callApi("/usuarios/obtenerinfo", "GET");
          if (pingRes.ok && typeof pingRes.payload === "object") {
            report.conexionEnVivo = {
              conectado: true,
              razonSocial: pingRes.payload.RazonSocial,
              cuit: pingRes.payload.CUIT,
              condicionIVA: pingRes.payload.CondicionIVA,
              tieneFE: Boolean(pingRes.payload.TieneFE),
            };
          }
        } catch (e) {
          report.conexionEnVivo = { conectado: false, error: e.message };
        }
      }
      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    }
  );

  // Tool 2: Información de Cuenta
  server.tool(
    "contabilium_get_account_info",
    "Obtiene la configuración y datos fiscales de la cuenta en Contabilium.",
    {},
    async () => {
      const res = await callApi("/usuarios/obtenerinfo", "GET");
      return { content: [{ type: "text", text: JSON.stringify(res.payload, null, 2) }] };
    }
  );

  // Tool 3: Request General
  server.tool(
    "contabilium_api_request",
    "Ejecuta llamadas autorizadas contra cualquier endpoint de la API de Contabilium.",
    {
      endpoint: z.string(),
      method: z.enum(["GET", "POST", "PUT", "DELETE"]).default("GET"),
      params: z.record(z.any()).optional(),
      body: z.record(z.any()).optional(),
    },
    async ({ endpoint, method, params, body }) => {
      const res = await callApi(endpoint, method, params, body);
      return { content: [{ type: "text", text: JSON.stringify({ status: res.status, ok: res.ok, data: res.payload }, null, 2) }] };
    }
  );

  // Tool 4: Stock
  server.tool(
    "contabilium_get_stock",
    "Consulta existencias de inventario por SKU o por depósito.",
    {
      sku: z.string().optional(),
      idDeposito: z.number().optional(),
      timestampNovedades: z.string().optional(),
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
      const res = await callApi(endpoint, "GET", params);
      return { content: [{ type: "text", text: JSON.stringify(res.payload, null, 2) }] };
    }
  );

  return server;
}

// -------------------------------------------------------------
// Portal Web para que Usuario X genere su URL para Claude
// -------------------------------------------------------------
app.get("/", (req, res) => {
  const host = req.get("host");
  const protocol = req.protocol === "https" || req.get("x-forwarded-proto") === "https" ? "https" : "http";
  const baseUrl = `${protocol}://${host}`;

  res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Conector Claude MCP - Contabilium</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #0f172a; color: #f8fafc; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 20px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 32px; max-width: 520px; width: 100%; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.3); }
    h1 { font-size: 22px; margin-top: 0; color: #38bdf8; display: flex; align-items: center; gap: 8px; }
    p { font-size: 14px; color: #94a3b8; line-height: 1.5; }
    label { font-size: 13px; font-weight: 600; display: block; margin-top: 16px; margin-bottom: 6px; color: #e2e8f0; }
    input, select { width: 100%; padding: 10px 12px; background: #0f172a; border: 1px solid #475569; border-radius: 8px; color: #fff; font-size: 14px; box-sizing: border-box; }
    input:focus, select:focus { outline: none; border-color: #38bdf8; ring: 2px solid #38bdf8; }
    button { width: 100%; margin-top: 24px; padding: 12px; background: #0284c7; color: #fff; border: none; border-radius: 8px; font-weight: 600; font-size: 15px; cursor: pointer; transition: background 0.2s; }
    button:hover { background: #0369a1; }
    .result { display: none; margin-top: 24px; background: #0f172a; border: 1px dashed #38bdf8; border-radius: 8px; padding: 16px; }
    .result label { margin-top: 0; color: #38bdf8; }
    .url-box { word-break: break-all; font-family: monospace; font-size: 13px; color: #a5f3fc; background: #1e293b; padding: 10px; border-radius: 6px; margin: 8px 0; border: 1px solid #334155; }
    .copy-btn { width: auto; padding: 8px 16px; font-size: 13px; background: #334155; margin-top: 6px; }
    .copy-btn:hover { background: #475569; }
  </style>
</head>
<body>
  <div class="card">
    <h1><span>⚡</span> Conectar Contabilium con Claude</h1>
    <p>Genera tu enlace personalizado para agregar a Claude como <strong>Custom Connector MCP</strong> sin exponer tus credenciales en el chat.</p>

    <form id="setupForm">
      <label for="clientId">Email de API de Contabilium (client_id)</label>
      <input type="email" id="clientId" placeholder="ejemplo@tuempresa.com" required>

      <label for="clientSecret">API Key Privada (client_secret)</label>
      <input type="password" id="clientSecret" placeholder="Tu API Key de Contabilium" required>

      <label for="country">País de radicación</label>
      <select id="country">
        <option value="AR">Argentina (AFIP)</option>
        <option value="CL">Chile (SII)</option>
        <option value="UY">Uruguay (DGI)</option>
      </select>

      <button type="submit">Generar URL para Claude</button>
    </form>

    <div class="result" id="resultBox">
      <label>Tu URL para el conector de Claude:</label>
      <div class="url-box" id="generatedUrl"></div>
      <button type="button" class="copy-btn" onclick="copyUrl()">Copiar URL</button>
      <p style="font-size: 12px; margin-top: 12px; color: #64748b;">
        👉 En Claude: pega esta URL en el campo <strong>"MCP server URL"</strong> de la ventana "Add custom connector".
      </p>
    </div>
  </div>

  <script>
    const form = document.getElementById("setupForm");
    const resultBox = document.getElementById("resultBox");
    const generatedUrl = document.getElementById("generatedUrl");
    const baseUrl = "${baseUrl}";

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const clientId = document.getElementById("clientId").value.trim();
      const clientSecret = document.getElementById("clientSecret").value.trim();
      const country = document.getElementById("country").value;

      const payload = { clientId, clientSecret, country };
      const rawString = JSON.stringify(payload);
      
      // Codificar en Base64Url
      const base64 = btoa(unescape(encodeURIComponent(rawString)))
        .replace(/\\+/g, '-')
        .replace(/\\//g, '_')
        .replace(/=+$/, '');

      const finalUrl = baseUrl + "/sse?auth=" + base64;
      generatedUrl.innerText = finalUrl;
      resultBox.style.display = "block";
    });

    function copyUrl() {
      navigator.clipboard.writeText(generatedUrl.innerText);
      alert("¡URL copiada al portapapeles! Pégala en Claude.");
    }
  </script>
</body>
</html>
  `);
});

// Endpoint SSE (Multi-Tenant)
app.get("/sse", async (req, res) => {
  const credentials = extractUserCredentials(req);

  if (!credentials.clientId || !credentials.clientSecret) {
    res.status(400).send("Faltan credenciales de Contabilium. Proporciona el parámetro auth generado en el portal.");
    return;
  }

  console.log(`[SSE] Nueva sesión para usuario: ${credentials.clientId.slice(0, 3)}*** (${credentials.country})`);

  const transport = new SSEServerTransport("/messages", res);
  const server = createMcpServerForSession(credentials);

  transports.set(transport.sessionId, transport);

  req.on("close", () => {
    console.log(`[SSE] Sesión cerrada: ${transport.sessionId}`);
    transports.delete(transport.sessionId);
  });

  await server.connect(transport);
});

// Endpoint de Mensajes JSON-RPC
app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports.get(sessionId);

  if (!transport) {
    res.status(404).send("Sesión no encontrada o expirada");
    return;
  }

  await transport.handlePostMessage(req, res);
});

app.listen(PORT, () => {
  console.log(`🚀 Contabilium Remote MCP Server corriendo en el puerto ${PORT}`);
});
