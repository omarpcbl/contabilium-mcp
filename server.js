#!/usr/bin/env node
/**
 * Contabilium Remote Multi-Tenant MCP Server
 * 
 * Soporta dos transportes de Model Context Protocol:
 * 1. Streamable HTTP (/mcp) : El NUEVO estándar moderno 2026 recomendado por Claude y Vercel (sin avisos de deprecación).
 * 2. Server-Sent Events (/sse) : Transporte legacy retrocompatible.
 * 
 * Seguridad: Cifrado Militar AES-256-GCM para aislar credenciales sin exponerlas al LLM.
 */

import express from "express";
import crypto from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import dotenv from "dotenv";
import { ContabiliumClient } from "./src/contabilium-client.js";
import { registerContabiliumTools } from "./src/register-tools.js";
import { SYSTEM_INSTRUCTION } from "./src/instructions.js";

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

function encryptPayload(data) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", MASTER_KEY, iv);
  const jsonString = JSON.stringify(data);
  let encrypted = cipher.update(jsonString, "utf8", "base64url");
  encrypted += cipher.final("base64url");
  const authTag = cipher.getAuthTag().toString("base64url");
  return `${iv.toString("base64url")}.${encrypted}.${authTag}`;
}

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

// Mapa de transportes SSE por ID de sesión
const sseTransports = new Map();

/**
 * Extrae y valida credenciales del request entrante
 */
function extractUserCredentials(req) {
  // 1. Token cifrado AES-256-GCM en el query string (?auth=...)
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
  const client = new ContabiliumClient(credentials);
  const server = new McpServer(
    {
      name: "contabilium-mcp",
      version: "1.0.0",
    },
    {
      instructions: SYSTEM_INSTRUCTION,
    }
  );

  registerContabiliumTools(server, client);

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
      // Ignorar fallo de info
    }

    const cipherToken = encryptPayload({
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
      country: country.toUpperCase(),
      createdAt: Date.now(),
    });

    const host = req.get("host");
    const protocol = req.protocol === "https" || req.get("x-forwarded-proto") === "https" ? "https" : "http";
    
    // URL moderna Streamable HTTP (/mcp) recomendada por Claude
    const mcpUrl = `${protocol}://${host}/mcp?auth=${cipherToken}`;
    // URL legacy SSE (/sse)
    const sseUrl = `${protocol}://${host}/sse?auth=${cipherToken}`;

    return res.json({
      ok: true,
      url: mcpUrl,
      sseUrl,
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
    .card { background: #131c2e; border: 1px solid #1e293b; border-radius: 14px; padding: 36px; max-width: 560px; width: 100%; box-shadow: 0 20px 40px -15px rgba(0,0,0,0.5); }
    h1 { font-size: 22px; margin-top: 0; color: #38bdf8; display: flex; align-items: center; gap: 10px; }
    .badge { background: #0284c7; color: #e0f2fe; font-size: 11px; padding: 3px 8px; border-radius: 999px; font-weight: 700; text-transform: uppercase; }
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
    <h1><span>🔒</span> Conector Claude MCP <span class="badge">Streamable HTTP</span></h1>
    <p>Conecta tu cuenta de Contabilium con Claude usando el <strong>nuevo estándar Streamable HTTP</strong> de Anthropic con cifrado AES-256-GCM.</p>

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

      <button type="submit" id="submitBtn">Verificar y Generar Conector para Claude</button>
    </form>

    <div class="alert-error" id="errorBox"></div>

    <div class="result" id="resultBox">
      <div class="result-header">✅ Cuenta Verificada con Éxito</div>
      <div style="font-size: 13px; color: #94a3b8; margin-bottom: 12px;" id="companyInfo"></div>
      
      <label style="color: #38bdf8; font-size: 12px;">URL Streamable HTTP (Estándar Moderno sin avisos de deprecación):</label>
      <div class="url-box" id="generatedUrl"></div>
      <button type="button" class="copy-btn" onclick="copyUrl()">Copiar URL</button>
      
      <p style="font-size: 12px; margin-top: 14px; color: #94a3b8;">
        👉 Pega esta URL en el campo <strong>"MCP server URL"</strong> de la ventana "Add custom connector" en Claude.
      </p>
    </div>

    <div class="security-note">
      🛡️ <strong>Protocolo 2026:</strong> Utiliza el nuevo transporte <em>Streamable HTTP</em> (<code>/mcp</code>) recomendado por Anthropic, totalmente stateless y optimizado para Serverless (Vercel). Tus claves se cifran con AES-256-GCM.
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
        submitBtn.innerText = "Verificar y Generar Conector para Claude";
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
// 1. TRANSPORTE MODERNO: Streamable HTTP (/mcp)
// El estándar actual de Claude y Vercel (Reemplazo oficial de SSE)
// -------------------------------------------------------------
app.all("/mcp", async (req, res) => {
  const credentials = extractUserCredentials(req);

  if (!credentials) {
    res.status(401).json({ error: "No autorizado: Falta el parámetro auth cifrado o es inválido." });
    return;
  }

  try {
    const transport = new StreamableHTTPServerTransport({});
    const server = createMcpServerForSession(credentials);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[StreamableHTTP] Error procesando request:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

// -------------------------------------------------------------
// 2. TRANSPORTE RETROCOMPATIBLE: Server-Sent Events (/sse)
// -------------------------------------------------------------
app.get("/sse", async (req, res) => {
  const credentials = extractUserCredentials(req);

  if (!credentials) {
    res.status(401).send("No autorizado: Falta el parámetro auth cifrado o es inválido.");
    return;
  }

  const transport = new SSEServerTransport("/messages", res);
  const server = createMcpServerForSession(credentials);

  sseTransports.set(transport.sessionId, transport);

  req.on("close", () => {
    sseTransports.delete(transport.sessionId);
  });

  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = sseTransports.get(sessionId);

  if (!transport) {
    res.status(404).send("Sesión SSE no encontrada o expirada");
    return;
  }

  await transport.handlePostMessage(req, res);
});

// Arrancar en standalone si no corre en Vercel Serverless
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`🚀 Contabilium MCP Server activo en puerto ${PORT}`);
    console.log(`✨ Streamable HTTP (Estándar Claude): http://localhost:${PORT}/mcp`);
    console.log(`📡 Legacy SSE: http://localhost:${PORT}/sse`);
  });
}

export default app;
