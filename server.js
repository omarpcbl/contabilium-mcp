#!/usr/bin/env node
/**
 * Contabilium Remote Multi-Tenant MCP Server (SSE Transport)
 * 
 * Implementación con Cifrado Militar AES-256-GCM:
 * - Las credenciales del Usuario X se cifran con la clave maestra privada del servidor.
 * - Lo que viaja en la URL de Claude es un bloque criptográfico indescifrable (IV + Ciphertext + AuthTag).
 * - Cero texto plano, cero fugas en logs de Render/proxies o bases de datos de Claude.
 * - Portal Web integrado en GET / para validar credenciales y generar la URL lista para Claude.
 */

import express from "express";
import crypto from "crypto";
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

// -------------------------------------------------------------
// Módulo Criptográfico (AES-256-GCM)
// -------------------------------------------------------------
const ENCRYPTION_PASSPHRASE = process.env.ENCRYPTION_SECRET || "contabilium-mcp-secure-master-key-2026-default";
const MASTER_KEY = crypto.scryptSync(ENCRYPTION_PASSPHRASE, "cbl-salt-mcp-gcm-2026", 32);

/**
 * Cifra un payload con AES-256-GCM
 * Retorna formato: <iv_base64url>.<ciphertext_base64url>.<authTag_base64url>
 */
function encryptPayload(data) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", MASTER_KEY, iv);
  const jsonString = JSON.stringify(data);
  let encrypted = cipher.update(jsonString, "utf8", "base64url");
  encrypted += cipher.final("base64url");
  const authTag = cipher.getAuthTag().toString("base64url");
  return `${iv.toString("base64url")}.${encrypted}.${authTag}`;
}

/**
 * Descifra y valida la autenticidad del token con AES-256-GCM
 */
function decryptPayload(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [ivStr, ciphertextStr, authTagStr] = parts;
    const iv = Buffer.from(ivStr, "base64url");
    const authTag = Buffer.from(authTagStr, "base64url");

    const decipher = crypto.createDecipheriv("aes-256-gcm", MASTER_KEY, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertextStr, "base64url", "utf8");
    decrypted += decipher.final("utf8");

    return JSON.parse(decrypted);
  } catch (err) {
    console.error("[Crypto] Fallo de descifrado o token adulterado:", err.message);
    return null;
  }
}

// Mapa de transportes activos por ID de sesión
const transports = new Map();

/**
 * Extrae y valida credenciales del request entrante
 */
function extractUserCredentials(req) {
  // 1. Token cifrado AES-256-GCM en el query string
  if (req.query.auth) {
    const decrypted = decryptPayload(req.query.auth);
    if (decrypted && decrypted.clientId && decrypted.clientSecret) {
      return {
        clientId: decrypted.clientId,
        clientSecret: decrypted.clientSecret,
        country: (decrypted.country || "AR").toUpperCase(),
      };
    }
  }

  // 2. Fallback por Headers HTTP
  if (req.headers["x-contabilium-client-id"] && req.headers["x-contabilium-client-secret"]) {
    return {
      clientId: req.headers["x-contabilium-client-id"],
      clientSecret: req.headers["x-contabilium-client-secret"],
      country: (req.headers["x-contabilium-country"] || "AR").toUpperCase(),
    };
  }

  // 3. Fallback de variables de servidor
  if (process.env.CONTABILIUM_CLIENT_ID && process.env.CONTABILIUM_CLIENT_SECRET) {
    return {
      clientId: process.env.CONTABILIUM_CLIENT_ID,
      clientSecret: process.env.CONTABILIUM_CLIENT_SECRET,
      country: (process.env.CONTABILIUM_COUNTRY || "AR").toUpperCase(),
    };
  }

  return null;
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
        configuracion: { usuarioIdentificador: masked, clientSecretProtegido: true, cifrado: "AES-256-GCM", pais: country, urlBase: baseUrl },
        token: { activo: tokenActive, minutosRestantes: remainingMinutes },
      };

      if (ping) {
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

  server.tool(
    "contabilium_get_account_info",
    "Obtiene la configuración y datos fiscales de la cuenta en Contabilium.",
    {},
    async () => {
      const res = await callApi("/usuarios/obtenerinfo", "GET");
      return { content: [{ type: "text", text: JSON.stringify(res.payload, null, 2) }] };
    }
  );

  server.tool(
    "contabilium_api_request",
    "Ejecuta llamadas autorizadas contra cualquier endpoint de la API de Contabilium.",
    {
      endpoint: z.string().describe("Ruta del endpoint (ej. '/api/conceptos/search', '/api/stock/Novedades', '/api/comprobantes/search')."),
      method: z.enum(["GET", "POST", "PUT", "DELETE"]).default("GET"),
      params: z.record(z.any()).optional(),
      body: z.record(z.any()).optional(),
    },
    async ({ endpoint, method, params, body }) => {
      const res = await callApi(endpoint, method, params, body);
      return { content: [{ type: "text", text: JSON.stringify({ status: res.status, ok: res.ok, data: res.payload }, null, 2) }] };
    }
  );

  server.tool(
    "contabilium_get_stock",
    "Consulta existencias de inventario por SKU o por depósito.",
    {
      sku: z.string().optional().describe("Código SKU del producto."),
      idDeposito: z.number().optional().describe("ID del depósito para consultar sus existencias."),
      timestampNovedades: z.string().optional().describe("Fecha ISO para consultar deltas de inventario."),
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
// Endpoint API: Generador y Validador de Token Cifrado
// -------------------------------------------------------------
app.post("/api/generate-token", async (req, res) => {
  const { clientId, clientSecret, country = "AR" } = req.body;

  if (!clientId || !clientSecret) {
    return res.status(400).json({ ok: false, error: "Debes ingresar tu email de API y tu API Key." });
  }

  const baseUrl = COUNTRY_URLS[country.toUpperCase()] || COUNTRY_URLS.AR;

  // 1. Validar las credenciales en vivo contra Contabilium antes de generar la URL
  try {
    const tokenUrl = `${baseUrl}/token`;
    const bodyParams = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId.trim(),
      client_secret: clientSecret.trim(),
    });

    const authRes = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: bodyParams.toString(),
    });

    if (!authRes.ok) {
      const errText = await authRes.text();
      return res.status(401).json({
        ok: false,
        error: `Credenciales inválidas en Contabilium (${authRes.status}): Revisa tu Email de API y tu API Key.`,
      });
    }

    const authData = await authRes.json();
    const token = authData.access_token;

    // Obtener razón social para confirmar conexión exitosa
    let razonSocial = "Empresa Verificada";
    let cuit = "";
    try {
      const infoRes = await fetch(`${baseUrl}/api/usuarios/obtenerinfo`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (infoRes.ok) {
        const infoData = await infoRes.json();
        razonSocial = infoData.RazonSocial || razonSocial;
        cuit = infoData.CUIT || "";
      }
    } catch {
      // Omitir si falla info
    }

    // 2. Cifrar con AES-256-GCM
    const cipherToken = encryptPayload({
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
      country: country.toUpperCase(),
      createdAt: Date.now(),
    });

    const host = req.get("host");
    const protocol = req.protocol === "https" || req.get("x-forwarded-proto") === "https" ? "https" : "http";
    const claudeUrl = `${protocol}://${host}/sse?auth=${cipherToken}`;

    return res.json({
      ok: true,
      url: claudeUrl,
      empresa: razonSocial,
      cuit,
      pais: country.toUpperCase(),
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: `Error conectando con Contabilium: ${err.message}` });
  }
});

// -------------------------------------------------------------
// Portal Web UI
// -------------------------------------------------------------
app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Conector Seguro Claude MCP - Contabilium</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #0b0f19; color: #f8fafc; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 20px; }
    .card { background: #131c2e; border: 1px solid #1e293b; border-radius: 14px; padding: 36px; max-width: 540px; width: 100%; box-shadow: 0 20px 40px -15px rgba(0,0,0,0.5); }
    h1 { font-size: 22px; margin-top: 0; color: #38bdf8; display: flex; align-items: center; gap: 10px; }
    .badge { background: #0369a1; color: #e0f2fe; font-size: 11px; padding: 3px 8px; border-radius: 999px; font-weight: 700; text-transform: uppercase; }
    p { font-size: 14px; color: #94a3b8; line-height: 1.5; margin-bottom: 20px; }
    label { font-size: 13px; font-weight: 600; display: block; margin-top: 16px; margin-bottom: 6px; color: #cbd5e1; }
    input, select { width: 100%; padding: 11px 14px; background: #0b0f19; border: 1px solid #334155; border-radius: 8px; color: #fff; font-size: 14px; box-sizing: border-box; }
    input:focus, select:focus { outline: none; border-color: #38bdf8; }
    button { width: 100%; margin-top: 24px; padding: 13px; background: #0284c7; color: #fff; border: none; border-radius: 8px; font-weight: 600; font-size: 15px; cursor: pointer; transition: background 0.2s; }
    button:hover { background: #0369a1; }
    button:disabled { background: #475569; cursor: not-allowed; }
    .alert-error { display: none; margin-top: 20px; background: #450a0a; border: 1px solid #ef4444; border-radius: 8px; padding: 14px; color: #fecaca; font-size: 13px; }
    .result { display: none; margin-top: 24px; background: #0b0f19; border: 1px solid #10b981; border-radius: 10px; padding: 20px; }
    .result-header { color: #34d399; font-weight: 700; font-size: 14px; margin-bottom: 10px; display: flex; align-items: center; gap: 6px; }
    .url-box { word-break: break-all; font-family: monospace; font-size: 12px; color: #67e8f9; background: #131c2e; padding: 12px; border-radius: 6px; margin: 8px 0; border: 1px solid #1e293b; max-height: 100px; overflow-y: auto; }
    .copy-btn { width: auto; padding: 8px 16px; font-size: 13px; background: #10b981; margin-top: 8px; }
    .copy-btn:hover { background: #059669; }
    .security-note { font-size: 12px; color: #64748b; margin-top: 20px; border-top: 1px solid #1e293b; padding-top: 16px; line-height: 1.4; }
  </style>
</head>
<body>
  <div class="card">
    <h1><span>🔒</span> Conector Seguro Claude MCP <span class="badge">AES-256</span></h1>
    <p>Conecta tu cuenta de Contabilium con Claude sin exponer tus credenciales en el chat ni en los servidores de Anthropic.</p>

    <form id="setupForm">
      <label for="clientId">Email de API de Contabilium (client_id)</label>
      <input type="email" id="clientId" placeholder="ejemplo@tuempresa.com" required>

      <label for="clientSecret">API Key Privada (client_secret)</label>
      <input type="password" id="clientSecret" placeholder="Tu API Key privada" required>

      <label for="country">País de radicación</label>
      <select id="country">
        <option value="AR">Argentina (AFIP)</option>
        <option value="CL">Chile (SII)</option>
        <option value="UY">Uruguay (DGI)</option>
      </select>

      <button type="submit" id="submitBtn">Verificar y Generar Conector Seguro</button>
    </form>

    <div class="alert-error" id="errorBox"></div>

    <div class="result" id="resultBox">
      <div class="result-header">✅ Cuenta Verificada con Éxito</div>
      <div style="font-size: 13px; color: #94a3b8; margin-bottom: 12px;" id="companyInfo"></div>
      
      <label style="color: #38bdf8; font-size: 12px;">Tu URL Cifrada para Claude (Cero Texto Plano):</label>
      <div class="url-box" id="generatedUrl"></div>
      <button type="button" class="copy-btn" onclick="copyUrl()">Copiar URL</button>
      
      <p style="font-size: 12px; margin-top: 14px; color: #94a3b8;">
        👉 En Claude: pega esta URL en el campo <strong>"MCP server URL"</strong> de la ventana "Add custom connector".
      </p>
    </div>

    <div class="security-note">
      🛡️ <strong>Garantía Criptográfica:</strong> Tu API Key se cifra mediante <strong>AES-256-GCM</strong>. Ni Claude, ni los logs de internet pueden leer tus credenciales. Solo este servidor MCP puede descifrarlas en memoria durante la sesión activa.
    </div>
  </div>

  <script>
    const form = document.getElementById("setupForm");
    const submitBtn = document.getElementById("submitBtn");
    const resultBox = document.getElementById("resultBox");
    const errorBox = document.getElementById("errorBox");
    const generatedUrl = document.getElementById("generatedUrl");
    const companyInfo = document.getElementById("companyInfo");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errorBox.style.display = "none";
      resultBox.style.display = "none";
      submitBtn.disabled = true;
      submitBtn.innerText = "Verificando con Contabilium...";

      const clientId = document.getElementById("clientId").value.trim();
      const clientSecret = document.getElementById("clientSecret").value.trim();
      const country = document.getElementById("country").value;

      try {
        const response = await fetch("/api/generate-token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientId, clientSecret, country }),
        });

        const data = await response.json();

        if (!data.ok) {
          errorBox.innerText = data.error || "Error al verificar las credenciales.";
          errorBox.style.display = "block";
        } else {
          companyInfo.innerText = "Empresa: " + data.empresa + (data.cuit ? " | CUIT: " + data.cuit : "") + " (" + data.pais + ")";
          generatedUrl.innerText = data.url;
          resultBox.style.display = "block";
        }
      } catch (err) {
        errorBox.innerText = "Error de red al conectar con el servidor: " + err.message;
        errorBox.style.display = "block";
      } finally {
        submitBtn.disabled = false;
        submitBtn.innerText = "Verificar y Generar Conector Seguro";
      }
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

// -------------------------------------------------------------
// Endpoint SSE (Multi-Tenant Cifrado)
// -------------------------------------------------------------
app.get("/sse", async (req, res) => {
  const credentials = extractUserCredentials(req);

  if (!credentials) {
    res.status(401).send("No autorizado: Falta el parámetro auth cifrado o es inválido.");
    return;
  }

  console.log(`[SSE] Nueva sesión autenticada (AES-256) para: ${credentials.clientId.slice(0, 3)}*** (${credentials.country})`);

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
  console.log(`🚀 Contabilium Remote MCP Server (AES-256-GCM) corriendo en el puerto ${PORT}`);
});
