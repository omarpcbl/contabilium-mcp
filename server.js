#!/usr/bin/env node
/**
 * Contabilium Remote Multi-Tenant MCP Server
 * 
 * Soporta dos transportes de Model Context Protocol:
 * 1. Streamable HTTP (/mcp) : El nuevo estándar moderno recomendado para MCP y entornos Serverless (sin avisos de deprecación).
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
import { getDiscoveryLogs } from "./src/tools/registrar_consulta_no_soportada.js";

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

function normalizePath(p, defaultVal) {
  if (!p) return defaultVal;
  let clean = p.trim();
  if (!clean.startsWith("/")) clean = "/" + clean;
  return clean.replace(/\/+$/, "");
}

// Ruta para el MCP paralelo / secundario (QA o permisos especiales)
const QA_PATH = normalizePath(process.env.MCP_QA_PATH || process.env.MCP_PARALLEL_PATH, "/qa");

/**
 * Helper para leer cookies en requests de Express sin dependencias externas
 */
function getCookie(req, name) {
  const cookieHeader = req?.headers?.cookie || "";
  const match = cookieHeader.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Valida acceso al endpoint paralelo/QA si se configuró MCP_QA_SECRET
 */
function validateQaAccess(req) {
  const qaSecret = process.env.MCP_QA_SECRET;
  if (!qaSecret) return true;

  const providedSecret = req.query?.key || 
                         req.query?.secret || 
                         req.headers?.["x-qa-secret"] || 
                         req.headers?.["x-mcp-secret"] ||
                         (req.headers?.authorization && req.headers.authorization.startsWith("Bearer ") ? req.headers.authorization.slice(7).trim() : null);

  return providedSecret === qaSecret;
}

/**
 * Valida acceso al Portal Web si se configuró clave de acceso restringido
 * Por defecto para el equipo: "contabilium2026" (o variable PORTAL_ACCESS_SECRET)
 * Para desactivar la máscara: PORTAL_ACCESS_SECRET=disabled o false
 */
function validatePortalAccess(req) {
  const portalSecret = process.env.PORTAL_ACCESS_SECRET || process.env.PORTAL_ACCESS_KEY || "contabilium2026";
  if (portalSecret === "disabled" || portalSecret === "false") return true;

  const providedSecret = req?.query?.key || 
                         req?.query?.access || 
                         req?.query?.secret || 
                         getCookie(req, "cbl_portal_access") ||
                         req?.headers?.["x-portal-key"] || 
                         req?.headers?.["x-access-key"];

  return providedSecret === portalSecret;
}

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
 * Soporta tanto el entorno productivo estándar como el MCP paralelo/QA
 */
function extractUserCredentials(req, isParallel = false) {
  const targetBaseUrl = isParallel
    ? (process.env.CONTABILIUM_QA_BASE_URL || process.env.CONTABILIUM_BASE_URL || "").trim().replace(/\/+$/, "")
    : (process.env.CONTABILIUM_BASE_URL || "").trim().replace(/\/+$/, "");

  // 1. Token cifrado AES-256-GCM en el query string (?auth=...)
  if (req.query.auth) {
    const decrypted = decryptPayload(req.query.auth);
    if (decrypted && decrypted.clientId && decrypted.clientSecret) {
      const country = (decrypted.country || "AR").toUpperCase();
      const baseUrl = targetBaseUrl || decrypted.baseUrl || COUNTRY_URLS[country] || COUNTRY_URLS.AR;
      return {
        clientId: decrypted.clientId,
        clientSecret: decrypted.clientSecret,
        country,
        baseUrl,
        isParallel,
      };
    }
  }

  // 2. Fallback por Headers HTTP
  if (req.headers["x-contabilium-client-id"] && req.headers["x-contabilium-client-secret"]) {
    const country = (req.headers["x-contabilium-country"] || "AR").toUpperCase();
    const baseUrl = targetBaseUrl || COUNTRY_URLS[country] || COUNTRY_URLS.AR;
    return {
      clientId: req.headers["x-contabilium-client-id"],
      clientSecret: req.headers["x-contabilium-client-secret"],
      country,
      baseUrl,
      isParallel,
    };
  }

  // 3. Fallback de variables de servidor para QA (si es paralelo)
  if (isParallel && process.env.CONTABILIUM_QA_CLIENT_ID && process.env.CONTABILIUM_QA_CLIENT_SECRET) {
    const country = (process.env.CONTABILIUM_QA_COUNTRY || process.env.CONTABILIUM_COUNTRY || "AR").toUpperCase();
    const baseUrl = targetBaseUrl || COUNTRY_URLS[country] || COUNTRY_URLS.AR;
    return {
      clientId: process.env.CONTABILIUM_QA_CLIENT_ID,
      clientSecret: process.env.CONTABILIUM_QA_CLIENT_SECRET,
      country,
      baseUrl,
      isParallel: true,
    };
  }

  // 4. Fallback de variables de servidor generales
  if (process.env.CONTABILIUM_CLIENT_ID && process.env.CONTABILIUM_CLIENT_SECRET) {
    const country = (process.env.CONTABILIUM_COUNTRY || "AR").toUpperCase();
    const baseUrl = targetBaseUrl || COUNTRY_URLS[country] || COUNTRY_URLS.AR;
    return {
      clientId: process.env.CONTABILIUM_CLIENT_ID,
      clientSecret: process.env.CONTABILIUM_CLIENT_SECRET,
      country,
      baseUrl,
      isParallel,
    };
  }

  return null;
}

/**
 * Fábrica de servidor MCP aislado por sesión de usuario
 */
function createMcpServerForSession(credentials, isParallel = false) {
  const client = new ContabiliumClient({ ...credentials, isParallel });
  const server = new McpServer(
    {
      name: isParallel ? (process.env.MCP_QA_NAME || "contabilium-mcp-qa") : "contabilium-mcp",
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
// Endpoint API: Verificación de acceso al Portal Privado
// -------------------------------------------------------------
app.post("/api/verify-portal-access", (req, res) => {
  const { key } = req.body || {};
  const portalSecret = process.env.PORTAL_ACCESS_SECRET || process.env.PORTAL_ACCESS_KEY || "contabilium2026";

  if (portalSecret === "disabled" || portalSecret === "false" || key === portalSecret) {
    res.cookie("cbl_portal_access", portalSecret, {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      httpOnly: false,
      sameSite: "lax",
      path: "/"
    });
    return res.json({ ok: true });
  }

  return res.status(401).json({ ok: false, error: "Clave de acceso incorrecta. Verifica con el equipo." });
});

// -------------------------------------------------------------
// Endpoint API: Generador y Validador de Token Cifrado
// -------------------------------------------------------------
app.post("/api/generate-token", async (req, res) => {
  const { clientId, clientSecret, country = "AR", target, key } = req.body;
  const isParallel = target === "qa" || target === "parallel";

  if (isParallel && !validateQaAccess({ query: { key }, headers: req.headers })) {
    return res.status(401).json({ ok: false, error: "No autorizado: Secreto de acceso a QA inválido." });
  }

  if (!isParallel && !validatePortalAccess(req) && !validatePortalAccess({ query: { key }, headers: req.headers })) {
    return res.status(401).json({ ok: false, error: "No autorizado: Acceso restringido al portal." });
  }

  if (!clientId || !clientSecret) {
    return res.status(400).json({ ok: false, error: "Debes ingresar tu email de API y tu API Key." });
  }

  const envBaseUrl = isParallel
    ? (process.env.CONTABILIUM_QA_BASE_URL || process.env.CONTABILIUM_BASE_URL)
    : process.env.CONTABILIUM_BASE_URL;

  const baseUrl = (envBaseUrl || COUNTRY_URLS[country.toUpperCase()] || COUNTRY_URLS.AR).replace(/\/+$/, "");

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

    let razonSocial = isParallel ? "Empresa Verificada (QA)" : "Empresa Verificada";
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
      target: isParallel ? "qa" : "prod",
    });

    const host = req.get("host");
    const protocol = req.protocol === "https" || req.get("x-forwarded-proto") === "https" ? "https" : "http";
    const pathPrefix = isParallel ? QA_PATH : "";
    const secretParam = isParallel && process.env.MCP_QA_SECRET ? `&key=${encodeURIComponent(process.env.MCP_QA_SECRET)}` : "";
    
    // URL moderna Streamable HTTP (/mcp o ${pathPrefix}/mcp)
    const mcpUrl = `${protocol}://${host}${pathPrefix}/mcp?auth=${cipherToken}${secretParam}`;
    // URL legacy SSE (/sse o ${pathPrefix}/sse)
    const sseUrl = `${protocol}://${host}${pathPrefix}/sse?auth=${cipherToken}${secretParam}`;

    return res.json({
      ok: true,
      url: mcpUrl,
      sseUrl,
      empresa: razonSocial,
      cuit,
      pais: country.toUpperCase(),
      ambiente: isParallel ? "QA / Paralelo" : "Producción",
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: `Error conectando con Contabilium: ${err.message}` });
  }
});

// Endpoint para auditar y descargar consultas no soportadas (Discovery)
app.get("/api/discovery-logs", (req, res) => {
  const logs = getDiscoveryLogs();
  return res.json({
    total: logs.length,
    logs,
  });
});

// -------------------------------------------------------------
// Portal Web UI (Material Design 3 + UI/UX Pro Max)
// -------------------------------------------------------------
app.get("/", (req, res) => {
  const isAuthorized = validatePortalAccess(req);
  const portalSecret = process.env.PORTAL_ACCESS_SECRET || process.env.PORTAL_ACCESS_KEY || "contabilium2026";

  if (isAuthorized) {
    if (req.query?.key === portalSecret || req.query?.access === portalSecret || req.query?.secret === portalSecret) {
      res.cookie("cbl_portal_access", portalSecret, {
        maxAge: 30 * 24 * 60 * 60 * 1000,
        httpOnly: false,
        sameSite: "lax",
        path: "/"
      });
    }
    return res.send(renderMainPortalHtml());
  }

  return res.send(renderAccessGateHtml());
});

function renderMainPortalHtml() {
  return `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Conector MCP - Contabilium</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Work+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" />
  <style>
    :root {
      /* Colores Esencia Contabilium */
      --cbl-brand: #00C7AF;             /* Turquesa / Teal Primario Contabilium */
      --cbl-brand-hover: #00E2C8;       /* Hover más luminoso */
      --cbl-brand-active: #00A994;      /* Active / Pressed */
      --cbl-brand-tint: rgba(0, 199, 175, 0.12); /* Glow / Badge de fondo */
      --cbl-brand-glow: rgba(0, 199, 175, 0.25); /* Focus Ring / Glow */

      /* Estados del Sistema (según Design Kit de Contabilium) */
      --cbl-success-text: #00E5C8;
      --cbl-success-bg: rgba(0, 199, 175, 0.12);
      --cbl-success-accent: #00C7AF;

      --cbl-danger-text: #FF648A;
      --cbl-danger-bg: rgba(243, 36, 101, 0.14);
      --cbl-danger-accent: #F32465;

      --cbl-warning-text: #FFB347;
      --cbl-warning-bg: rgba(255, 140, 0, 0.14);
      --cbl-warning-accent: #FF8C00;

      /* Material 3 / Modern Dark Theme Surfaces */
      --m3-surface: #0E1015;
      --m3-surface-container: #141720;
      --m3-surface-container-high: #1A1E29;
      --m3-surface-container-highest: #222736;
      --m3-outline: #2C3344;
      --m3-outline-variant: #1E2330;
      --m3-on-surface: #F3F4F6;
      --m3-on-surface-variant: #9CA3AF;
      --m3-motion-standard: cubic-bezier(0.2, 0, 0, 1);
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: 'Work Sans', -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background-color: #07080B;
      color: var(--m3-on-surface);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      padding: 24px 16px;
      line-height: 1.5;
      position: relative;
      overflow-x: hidden;
    }

    /* Fondo ambiental sutil con el glow turquesa de Contabilium */
    body::before {
      content: "";
      position: absolute;
      top: -160px;
      left: 50%;
      transform: translateX(-50%);
      width: 680px;
      height: 480px;
      background: radial-gradient(circle, rgba(0, 199, 175, 0.12) 0%, rgba(7, 8, 11, 0) 70%);
      pointer-events: none;
      z-index: 0;
    }

    /* Regla UI/UX Pro Max: Focus Visible universal de alto contraste */
    :focus-visible {
      outline: 2px solid var(--cbl-brand);
      outline-offset: 2px;
    }

    .card {
      position: relative;
      z-index: 1;
      background-color: var(--m3-surface);
      border: 1px solid var(--m3-outline-variant);
      border-radius: 24px;
      padding: 36px;
      max-width: 580px;
      width: 100%;
      box-shadow: 0 20px 50px -10px rgba(0, 0, 0, 0.9), 0 0 1px 1px rgba(255, 255, 255, 0.05);
      transition: border-color 0.25s var(--m3-motion-standard);
    }

    .card-header {
      display: flex;
      align-items: flex-start;
      gap: 16px;
      margin-bottom: 24px;
    }

    .header-icon-box {
      width: 48px;
      height: 48px;
      border-radius: 14px;
      background: var(--cbl-brand-tint);
      color: var(--cbl-brand);
      border: 1px solid rgba(0, 199, 175, 0.25);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      box-shadow: 0 4px 16px rgba(0, 199, 175, 0.15);
    }

    .header-icon-box .material-symbols-outlined {
      font-size: 26px;
    }

    .header-title-wrap {
      flex: 1;
    }

    .title-row {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 6px;
    }

    h1 {
      font-size: 22px;
      font-weight: 600;
      color: var(--m3-on-surface);
      letter-spacing: -0.2px;
    }

    /* M3 Tonal Badge */
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: var(--cbl-brand-tint);
      color: var(--cbl-brand);
      font-size: 11px;
      font-weight: 600;
      padding: 3px 10px;
      border-radius: 9999px;
      letter-spacing: 0.3px;
      border: 1px solid rgba(0, 199, 175, 0.25);
    }

    .badge .badge-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--cbl-brand);
      animation: pulseDot 2s infinite;
    }

    @keyframes pulseDot {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.35; transform: scale(0.85); }
    }

    .subtitle {
      font-size: 13.5px;
      color: var(--m3-on-surface-variant);
      line-height: 1.5;
    }

    /* Form Fields */
    .form-group {
      margin-bottom: 20px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .field-label-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .field-label {
      font-size: 13px;
      font-weight: 500;
      color: var(--m3-on-surface);
      cursor: pointer;
    }

    .field-badge-mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 10.5px;
      color: #9CA3AF;
      background: rgba(255, 255, 255, 0.05);
      padding: 2px 7px;
      border-radius: 5px;
      border: 1px solid var(--m3-outline);
    }

    .field-direct-link {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11.5px;
      font-weight: 500;
      color: var(--cbl-brand);
      text-decoration: none;
      transition: color 0.15s, opacity 0.15s;
    }

    .field-direct-link:hover {
      color: var(--cbl-brand-hover);
      text-decoration: underline;
    }

    .input-container {
      position: relative;
      display: flex;
      align-items: center;
      background: var(--m3-surface-container);
      border: 1px solid var(--m3-outline);
      border-radius: 12px;
      min-height: 48px;
      transition: all 0.2s var(--m3-motion-standard);
    }

    .input-container:hover {
      border-color: #3E475C;
    }

    .input-container:focus-within {
      border-color: var(--cbl-brand);
      box-shadow: 0 0 0 3px var(--cbl-brand-glow);
      background: var(--m3-surface-container-high);
    }

    .input-container.input-error {
      border-color: var(--cbl-danger-accent) !important;
      box-shadow: 0 0 0 3px rgba(243, 36, 101, 0.25) !important;
    }

    .input-container input,
    .input-container select {
      width: 100%;
      background: transparent;
      border: none;
      padding: 13px 16px;
      font-size: 15px;
      font-family: inherit;
      color: var(--m3-on-surface);
      outline: none;
    }

    .input-container input::placeholder {
      color: #5E6678;
      font-size: 13.5px;
    }

    .input-container select {
      cursor: pointer;
      appearance: none;
      -webkit-appearance: none;
      padding-right: 44px;
    }

    .input-container select option {
      background: var(--m3-surface-container);
      color: var(--m3-on-surface);
    }

    .select-arrow {
      position: absolute;
      right: 14px;
      pointer-events: none;
      color: var(--m3-on-surface-variant);
      font-size: 22px;
    }

    .toggle-visibility-btn {
      background: none;
      border: none;
      color: var(--m3-on-surface-variant);
      cursor: pointer;
      min-width: 44px;
      min-height: 44px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 8px;
      margin-right: 4px;
      transition: color 0.15s, background-color 0.15s;
    }

    .toggle-visibility-btn:hover {
      color: var(--m3-on-surface);
      background: rgba(255, 255, 255, 0.06);
    }

    .supporting-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding-left: 2px;
    }

    .supporting-text {
      font-size: 12px;
      color: var(--m3-on-surface-variant);
      padding-left: 2px;
      line-height: 1.4;
    }

    .inline-error-msg {
      display: none;
      font-size: 12px;
      color: var(--cbl-danger-text);
      padding-left: 2px;
      font-weight: 500;
    }

    /* M3 Button - Contabilium Brand Action */
    .btn-submit {
      width: 100%;
      margin-top: 14px;
      min-height: 48px;
      padding: 13px 24px;
      background: var(--cbl-brand);
      color: #07090D;
      border: none;
      border-radius: 12px;
      font-family: inherit;
      font-weight: 700;
      font-size: 15px;
      letter-spacing: 0.1px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      cursor: pointer;
      box-shadow: 0 4px 18px rgba(0, 199, 175, 0.35);
      transition: background-color 0.2s, box-shadow 0.2s, transform 0.15s var(--m3-motion-standard);
      position: relative;
      overflow: hidden;
    }

    .btn-submit:hover:not(:disabled) {
      background: var(--cbl-brand-hover);
      box-shadow: 0 6px 24px rgba(0, 199, 175, 0.45);
      transform: translateY(-1px);
    }

    .btn-submit:active:not(:disabled) {
      background: var(--cbl-brand-active);
      transform: translateY(0);
      box-shadow: 0 2px 8px rgba(0, 199, 175, 0.3);
    }

    .btn-submit:disabled {
      background: #1F2430;
      color: #555E70;
      box-shadow: none;
      cursor: not-allowed;
      transform: none;
    }

    /* M3 Linear Progress Bar (Indeterminate) */
    .linear-progress {
      display: none;
      height: 4px;
      width: 100%;
      background: var(--m3-surface-container);
      border-radius: 2px;
      overflow: hidden;
      margin-top: 12px;
      position: relative;
    }

    .linear-progress::before {
      content: "";
      position: absolute;
      background: var(--cbl-brand);
      top: 0;
      left: 0;
      bottom: 0;
      width: 35%;
      border-radius: 2px;
      animation: m3Indeterminate 1.4s infinite ease-in-out;
    }

    @keyframes m3Indeterminate {
      0% { left: -35%; width: 35%; }
      50% { left: 40%; width: 50%; }
      100% { left: 100%; width: 25%; }
    }

    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }

    /* Alerta de Error M3 */
    .alert-error {
      display: none;
      margin-top: 20px;
      background: var(--cbl-danger-bg);
      border: 1px solid var(--cbl-danger-accent);
      border-radius: 14px;
      padding: 16px;
      color: var(--cbl-danger-text);
      font-size: 13px;
      font-weight: 500;
      align-items: flex-start;
      gap: 12px;
      animation: fadeIn 0.25s ease-out;
    }

    .alert-error .material-symbols-outlined {
      font-size: 20px;
      flex-shrink: 0;
      color: var(--cbl-danger-accent);
    }

    /* Tarjeta de Resultado M3 */
    .result-card {
      display: none;
      margin-top: 24px;
      background: var(--m3-surface-container-high);
      border: 1px solid var(--cbl-brand);
      border-radius: 18px;
      padding: 24px;
      animation: fadeIn 0.3s ease-out;
      box-shadow: 0 10px 30px rgba(0, 199, 175, 0.1);
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .result-header-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
      flex-wrap: wrap;
      gap: 8px;
    }

    .status-badge-success {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: var(--cbl-brand-tint);
      color: var(--cbl-brand);
      padding: 6px 14px;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 600;
      border: 1px solid var(--cbl-brand);
    }

    .status-badge-success .material-symbols-outlined {
      font-size: 18px;
      color: var(--cbl-brand);
    }

    .company-details {
      font-size: 13px;
      color: var(--m3-on-surface);
      background: var(--m3-surface);
      padding: 14px;
      border-radius: 12px;
      border: 1px solid var(--m3-outline-variant);
      margin-bottom: 18px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .company-details strong {
      color: #ffffff;
    }

    /* Tabs de URL Streamable HTTP / SSE accesibles */
    .url-tabs-header {
      display: flex;
      gap: 8px;
      margin-bottom: 8px;
    }

    .tab-btn {
      background: none;
      border: 1px solid transparent;
      color: var(--m3-on-surface-variant);
      font-family: inherit;
      font-size: 13px;
      font-weight: 500;
      min-height: 42px;
      padding: 8px 16px;
      border-radius: 10px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s var(--m3-motion-standard);
    }

    .tab-btn.active {
      background: var(--cbl-brand-tint);
      color: var(--cbl-brand);
      font-weight: 600;
      border-color: rgba(0, 199, 175, 0.35);
    }

    .tab-btn:hover:not(.active) {
      color: var(--m3-on-surface);
      background: var(--m3-surface-container-highest);
    }

    .url-display-box {
      position: relative;
      background: #050608;
      border: 1px solid var(--m3-outline);
      border-radius: 12px;
      padding: 14px 54px 14px 14px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      color: var(--cbl-brand);
      word-break: break-all;
      line-height: 1.5;
      max-height: 100px;
      overflow-y: auto;
    }

    .copy-icon-btn {
      position: absolute;
      top: 8px;
      right: 8px;
      background: var(--cbl-brand);
      color: #07090D;
      border: none;
      border-radius: 9px;
      min-width: 42px;
      min-height: 42px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: background-color 0.15s, transform 0.15s;
      box-shadow: 0 2px 8px rgba(0, 199, 175, 0.35);
    }

    .copy-icon-btn:hover {
      background: var(--cbl-brand-hover);
      transform: scale(1.04);
    }

    .copy-icon-btn .material-symbols-outlined {
      font-size: 20px;
    }

    .action-instruction {
      margin-top: 14px;
      font-size: 13px;
      color: var(--m3-on-surface-variant);
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .action-instruction strong {
      color: var(--m3-on-surface);
    }

    /* Card de Seguridad M3 */
    .security-card {
      margin-top: 20px;
      padding: 14px 16px;
      border-radius: 14px;
      background: var(--m3-surface-container);
      border: 1px solid var(--m3-outline-variant);
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .security-card .material-symbols-outlined {
      font-size: 20px;
      color: var(--cbl-brand);
      flex-shrink: 0;
    }

    .security-card-content {
      font-size: 12px;
      color: var(--m3-on-surface-variant);
      line-height: 1.45;
    }

    .security-card-content strong {
      color: var(--m3-on-surface);
    }

    /* M3 Floating Toast / Snackbar */
    .snackbar {
      visibility: hidden;
      min-width: 280px;
      background: #171A22;
      color: #ffffff;
      text-align: center;
      border-radius: 12px;
      padding: 14px 22px;
      position: fixed;
      z-index: 100;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      font-size: 13px;
      font-weight: 500;
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.8), 0 0 0 1px rgba(255, 255, 255, 0.1);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
    }

    .snackbar.show {
      visibility: visible;
      animation: snackbarIn 0.25s, snackbarOut 0.25s 2.75s;
    }

    @keyframes snackbarIn {
      from { bottom: 0; opacity: 0; }
      to { bottom: 24px; opacity: 1; }
    }

    @keyframes snackbarOut {
      from { bottom: 24px; opacity: 1; }
      to { bottom: 0; opacity: 0; }
    }

    /* Trigger de Guía de Conexión en Header */
    .btn-help-trigger {
      background: var(--m3-surface-container);
      border: 1px solid var(--m3-outline);
      color: var(--m3-on-surface);
      font-family: inherit;
      font-size: 12px;
      font-weight: 500;
      padding: 6px 14px;
      border-radius: 9999px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s var(--m3-motion-standard);
      flex-shrink: 0;
      min-height: 38px;
    }

    .btn-help-trigger:hover {
      background: var(--m3-surface-container-high);
      border-color: var(--cbl-brand);
      color: var(--cbl-brand);
      transform: translateY(-1px);
    }

    .btn-help-trigger .material-symbols-outlined {
      font-size: 18px;
      color: var(--cbl-brand);
    }

    /* Footer link de ayuda secundaria */
    .card-help-footer {
      margin-top: 18px;
      text-align: center;
      padding-top: 12px;
      border-top: 1px dashed var(--m3-outline-variant);
    }

    .help-link-action {
      background: none;
      border: none;
      color: var(--m3-on-surface-variant);
      font-family: inherit;
      font-size: 12.5px;
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 8px 14px;
      border-radius: 8px;
      transition: color 0.15s, background-color 0.15s;
    }

    .help-link-action:hover {
      color: var(--cbl-brand);
      background: var(--cbl-brand-tint);
    }

    .help-link-action .material-symbols-outlined {
      font-size: 18px;
    }

    /* Modal Backdrop M3 (Oculto por defecto) */
    .help-modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.78);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      padding: 20px 16px;
      animation: modalFadeIn 0.2s var(--m3-motion-standard);
    }

    @keyframes modalFadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    /* Modal Card M3 */
    .help-modal-card {
      background: var(--m3-surface);
      border: 1px solid var(--m3-outline);
      border-radius: 28px;
      max-width: 660px;
      width: 100%;
      max-height: 88vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.9), 0 0 1px 1px rgba(255, 255, 255, 0.08);
      animation: modalScaleUp 0.25s var(--m3-motion-standard);
    }

    @keyframes modalScaleUp {
      from { opacity: 0; transform: scale(0.95); }
      to { opacity: 1; transform: scale(1); }
    }

    .help-modal-header {
      padding: 24px 28px 18px;
      border-bottom: 1px solid var(--m3-outline-variant);
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      background: var(--m3-surface-container);
    }

    .help-modal-title-wrap {
      display: flex;
      align-items: flex-start;
      gap: 14px;
    }

    .help-icon-badge {
      width: 44px;
      height: 44px;
      border-radius: 12px;
      background: var(--cbl-brand-tint);
      color: var(--cbl-brand);
      border: 1px solid rgba(0, 199, 175, 0.25);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .help-icon-badge .material-symbols-outlined {
      font-size: 24px;
    }

    .help-modal-header h2 {
      font-size: 19px;
      font-weight: 600;
      color: #ffffff;
      line-height: 1.3;
      margin-bottom: 4px;
    }

    .help-modal-subtitle {
      font-size: 13px;
      color: var(--m3-on-surface-variant);
      line-height: 1.4;
    }

    .btn-close-modal {
      background: transparent;
      border: none;
      color: var(--m3-on-surface-variant);
      min-width: 44px;
      min-height: 44px;
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.15s;
    }

    .btn-close-modal:hover {
      background: rgba(255, 255, 255, 0.08);
      color: #ffffff;
    }

    .btn-close-modal .material-symbols-outlined {
      font-size: 22px;
    }

    .help-modal-body {
      padding: 24px 28px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 22px;
    }

    /* Pasos de Ayuda */
    .help-step-item {
      display: flex;
      gap: 16px;
      align-items: flex-start;
    }

    .step-indicator {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: var(--cbl-brand);
      color: #07090D;
      font-weight: 700;
      font-size: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      box-shadow: 0 2px 8px rgba(0, 199, 175, 0.35);
      margin-top: 2px;
    }

    .step-content {
      flex: 1;
    }

    .step-content h3 {
      font-size: 15px;
      font-weight: 600;
      color: #ffffff;
      margin-bottom: 6px;
    }

    .step-content p {
      font-size: 13px;
      color: var(--m3-on-surface-variant);
      line-height: 1.5;
      margin-bottom: 8px;
    }

    .link-inline {
      color: var(--cbl-brand);
      text-decoration: underline;
      text-underline-offset: 3px;
      font-weight: 500;
      transition: color 0.15s;
    }

    .link-inline:hover {
      color: var(--cbl-brand-hover);
    }

    .step-note {
      background: var(--m3-surface-container);
      border: 1px solid var(--m3-outline-variant);
      border-radius: 10px;
      padding: 10px 12px;
      font-size: 12px;
      color: var(--m3-on-surface);
      display: flex;
      align-items: flex-start;
      gap: 8px;
      margin-top: 6px;
    }

    .step-note .material-symbols-outlined {
      font-size: 18px;
      color: var(--cbl-brand);
      flex-shrink: 0;
      margin-top: 1px;
    }

    /* Tabs de clientes en el paso 3 */
    .client-tabs-nav {
      display: flex;
      gap: 6px;
      background: var(--m3-surface-container);
      border-radius: 10px;
      padding: 4px;
      margin: 12px 0 10px;
      border: 1px solid var(--m3-outline-variant);
    }

    .client-tab {
      flex: 1;
      background: transparent;
      border: none;
      color: var(--m3-on-surface-variant);
      font-family: inherit;
      font-size: 12px;
      font-weight: 500;
      padding: 8px 10px;
      min-height: 38px;
      border-radius: 8px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: all 0.15s;
    }

    .client-tab.active {
      background: var(--cbl-brand-tint);
      color: var(--cbl-brand);
      font-weight: 600;
    }

    .client-tab:hover:not(.active) {
      color: #ffffff;
      background: rgba(255, 255, 255, 0.05);
    }

    .client-tab-panel {
      background: var(--m3-surface-container);
      border: 1px solid var(--m3-outline-variant);
      border-radius: 12px;
      padding: 14px 16px;
      animation: fadeIn 0.2s ease-out;
    }

    .client-instructions-list {
      padding-left: 20px;
      margin: 0;
      font-size: 12px;
      color: var(--m3-on-surface-variant);
      line-height: 1.6;
    }

    .client-instructions-list li {
      margin-bottom: 6px;
    }

    .client-instructions-list strong {
      color: var(--m3-on-surface);
    }

    .client-instructions-list code,
    .help-code-block code {
      background: #000000;
      padding: 2px 6px;
      border-radius: 6px;
      font-size: 11px;
      color: var(--cbl-brand);
      border: 1px solid var(--m3-outline);
      font-family: monospace;
    }

    .help-code-block {
      background: #000000;
      border: 1px solid var(--m3-outline);
      border-radius: 10px;
      padding: 12px;
      margin: 0;
      overflow-x: auto;
      font-size: 11px;
      line-height: 1.4;
      color: var(--cbl-brand);
    }

    /* Capabilities Box */
    .help-capabilities-box {
      background: var(--m3-surface-container);
      border: 1px solid var(--m3-outline-variant);
      border-radius: 14px;
      padding: 16px;
    }

    .help-capabilities-box h4 {
      font-size: 13px;
      font-weight: 600;
      color: #ffffff;
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 10px;
    }

    .help-capabilities-box h4 .material-symbols-outlined {
      font-size: 18px;
      color: var(--cbl-brand);
    }

    .capabilities-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .cap-pill {
      background: var(--m3-surface-container-high);
      border: 1px solid var(--m3-outline);
      color: var(--m3-on-surface);
      font-size: 12px;
      padding: 6px 12px;
      border-radius: 9999px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .cap-pill .material-symbols-outlined {
      font-size: 15px;
      color: var(--cbl-brand);
    }

    /* Footer Modal */
    .help-modal-footer {
      padding: 16px 28px 20px;
      border-top: 1px solid var(--m3-outline-variant);
      display: flex;
      justify-content: flex-end;
      background: var(--m3-surface-container);
    }

    .btn-help-primary {
      background: var(--cbl-brand);
      color: #07090D;
      border: none;
      border-radius: 10px;
      padding: 12px 24px;
      font-family: inherit;
      font-weight: 700;
      font-size: 14px;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      min-height: 44px;
      transition: background-color 0.15s, transform 0.15s;
    }

    .btn-help-primary:hover {
      background: var(--cbl-brand-hover);
      transform: translateY(-1px);
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
      }
      .btn-submit:hover:not(:disabled),
      .btn-help-primary:hover,
      .btn-help-trigger:hover {
        transform: none !important;
      }
    }

    @media (max-width: 480px) {
      .card {
        padding: 24px 18px;
        border-radius: 22px;
      }
      h1 {
        font-size: 20px;
      }
      .help-modal-card {
        max-height: 94vh;
        border-radius: 20px;
      }
      .help-modal-header,
      .help-modal-body,
      .help-modal-footer {
        padding: 18px 16px;
      }
      .client-tabs-nav {
        flex-direction: column;
      }
      .help-btn-text {
        display: none;
      }
      .btn-help-trigger {
        padding: 8px;
        min-width: 38px;
        justify-content: center;
      }
    }
  </style>
</head>
<body>
  <main class="card" role="main">
    <!-- Header -->
    <header class="card-header">
      <div class="header-icon-box" aria-hidden="true">
        <span class="material-symbols-outlined">shield_lock</span>
      </div>
      <div class="header-title-wrap">
        <div class="title-row">
          <h1>Conector Contabilium MCP</h1>
          <div class="badge" aria-label="Protocolo MCP">
            <span class="badge-dot" aria-hidden="true"></span>
            <span>MCP</span>
          </div>
        </div>
        <p class="subtitle">Accede a tu facturación y stock desde tu asistente de IA.</p>
      </div>

      <!-- Acciones de Cabecera: Guía de Ayuda y Bloqueo -->
      <div style="display:flex; align-items:center; gap:8px;">
        <button type="button" class="btn-help-trigger" id="openHelpBtn" aria-haspopup="dialog" aria-controls="helpModal" title="¿Cómo conectar este servidor MCP?">
          <span class="material-symbols-outlined">help</span>
          <span class="help-btn-text">¿Cómo conectar?</span>
        </button>
        <button type="button" class="btn-help-trigger" onclick="lockPortalSession()" title="Bloquear portal y cerrar sesión" aria-label="Bloquear interfaz" style="padding:8px 10px; min-width:38px; justify-content:center;">
          <span class="material-symbols-outlined" style="font-size:17px;">lock</span>
        </button>
      </div>
    </header>

    <!-- Formulario M3 Accesible -->
    <form id="setupForm" novalidate aria-label="Formulario de conexión a Contabilium">
      
      <!-- 1. País / Región -->
      <div class="form-group">
        <label class="field-label" for="country">País</label>
        <div class="input-container">
          <select id="country" aria-label="Selecciona tu país">
            <option value="AR">🇦🇷 Argentina (api.contabilium.com)</option>
            <option value="CL">🇨🇱 Chile</option>
            <option value="UY">🇺🇾 Uruguay</option>
          </select>
          <span class="material-symbols-outlined select-arrow" aria-hidden="true">expand_more</span>
        </div>
      </div>

      <!-- 2. Email de API -->
      <div class="form-group">
        <label class="field-label" for="clientId">Email de API</label>
        <div class="input-container" id="clientIdContainer">
          <input type="email" id="clientId" placeholder="usuario@empresa.com" required autocomplete="email" aria-describedby="clientIdError" aria-invalid="false">
        </div>
        <span class="inline-error-msg" id="clientIdError" role="alert">Ingresa un formato de correo electrónico válido.</span>
      </div>

      <!-- 3. API Key -->
      <div class="form-group">
        <div class="field-label-row">
          <label class="field-label" for="clientSecret">API Key</label>
          <a href="https://app.contabilium.com/modulos/miCuenta/api.aspx" target="_blank" rel="noopener noreferrer" class="field-direct-link" title="Obtener credenciales en Contabilium">
            <span>Mi cuenta - API - Credenciales</span>
            <span class="material-symbols-outlined" style="font-size:14px;">open_in_new</span>
          </a>
        </div>
        <div class="input-container" id="clientSecretContainer">
          <input type="password" id="clientSecret" placeholder="Pega tu API Key de Contabilium" required autocomplete="current-password" aria-describedby="clientSecretError" aria-invalid="false">
          <button type="button" class="toggle-visibility-btn" id="togglePasswordBtn" aria-label="Mostrar contraseña" aria-pressed="false">
            <span class="material-symbols-outlined" id="togglePasswordIcon" aria-hidden="true">visibility</span>
          </button>
        </div>
        <span class="inline-error-msg" id="clientSecretError" role="alert">La API Key es obligatoria.</span>
      </div>

      <button type="submit" class="btn-submit" id="submitBtn" aria-busy="false">
        <span class="material-symbols-outlined" id="btnIcon" aria-hidden="true">bolt</span>
        <span id="btnText">Verificar y Conectar</span>
      </button>

      <div class="linear-progress" id="progressBar" role="progressbar" aria-label="Verificando credenciales"></div>
    </form>

    <!-- Alerta de Error Accesible -->
    <div class="alert-error" id="errorBox" role="alert" aria-live="assertive">
      <span class="material-symbols-outlined" aria-hidden="true">error</span>
      <div id="errorText"></div>
    </div>

    <!-- Resultado Exitoso Accesible -->
    <section class="result-card" id="resultBox" role="region" aria-label="Resultado de conexión" aria-live="polite">
      <div class="result-header-row">
        <span class="status-badge-success">
          <span class="material-symbols-outlined" aria-hidden="true">check_circle</span>
          Cuenta Verificada con Éxito
        </span>
      </div>

      <div class="company-details" id="companyInfo"></div>

      <!-- Selector de formato de URL con roles tablist -->
      <div class="url-tabs-header" role="tablist" aria-label="Formatos de transporte MCP">
        <button type="button" class="tab-btn active" id="tabStreamable" role="tab" aria-selected="true" aria-controls="urlBoxContainer" onclick="switchUrlTab('streamable')">
          <span class="material-symbols-outlined" aria-hidden="true" style="font-size:16px;">hub</span>
          Streamable HTTP (Recomendado)
        </button>
        <button type="button" class="tab-btn" id="tabSse" role="tab" aria-selected="false" aria-controls="urlBoxContainer" onclick="switchUrlTab('sse')">
          <span class="material-symbols-outlined" aria-hidden="true" style="font-size:16px;">rss_feed</span>
          SSE (Legacy)
        </button>
      </div>

      <div class="url-display-box" id="urlBoxContainer" tabindex="0" role="region" aria-label="URL del conector">
        <span id="generatedUrl"></span>
        <button type="button" class="copy-icon-btn" id="copyBtn" onclick="copyActiveUrl()" aria-label="Copiar URL al portapapeles" title="Copiar URL al portapapeles">
          <span class="material-symbols-outlined" id="copyBtnIcon" aria-hidden="true">content_copy</span>
        </button>
      </div>

      <div class="action-instruction">
        <span class="material-symbols-outlined" aria-hidden="true" style="color: var(--cbl-brand); font-size:18px;">arrow_forward</span>
        <span>Pega esta URL en el campo de configuración de servidores MCP de tu asistente o cliente de IA preferido.</span>
      </div>
    </section>

    <!-- Nota de Seguridad M3 -->
    <aside class="security-card" aria-label="Información de seguridad y cifrado">
      <span class="material-symbols-outlined" aria-hidden="true">lock</span>
      <div class="security-card-content">
        <strong>Cifrado AES-256:</strong> Tus credenciales viajan cifradas y nunca se exponen al modelo ni a terceros.
      </div>
    </aside>

    <div style="display:none;" aria-hidden="true">
      <button type="button" id="openHelpBtnFooter"></button>
    </div>
  </main>

  <!-- Modal Dialog de Ayuda M3 (Oculto por defecto) -->
  <div class="help-modal-backdrop" id="helpModal" role="dialog" aria-modal="true" aria-labelledby="helpModalTitle" style="display:none;">
    <div class="help-modal-card">
      <div class="help-modal-header">
        <div class="help-modal-title-wrap">
          <div class="help-icon-badge" aria-hidden="true">
            <span class="material-symbols-outlined">auto_stories</span>
          </div>
          <div>
            <h2 id="helpModalTitle">¿Cómo conectar este servidor MCP?</h2>
            <p class="help-modal-subtitle">Conecta Contabilium con cualquier cliente o asistente de IA compatible en 3 simples pasos.</p>
          </div>
        </div>
        <button type="button" class="btn-close-modal" id="closeHelpBtn" aria-label="Cerrar guía de conexión">
          <span class="material-symbols-outlined" aria-hidden="true">close</span>
        </button>
      </div>

      <div class="help-modal-body">
        <!-- Paso 1 -->
        <div class="help-step-item">
          <div class="step-indicator" aria-hidden="true">1</div>
          <div class="step-content">
            <h3>Obtén tus claves en Contabilium</h3>
            <p>Ingresa a tu cuenta de Contabilium y dirígete a:
              <br><a href="https://app.contabilium.com/modulos/miCuenta/api.aspx" target="_blank" rel="noopener noreferrer" class="link-inline"><strong>Mi cuenta - API - Credenciales ↗</strong></a>.
            </p>
            <div class="step-note">
              <span class="material-symbols-outlined" aria-hidden="true">info</span>
              <span>Copia tu <strong>Email de API</strong> y tu <strong>API Key Privada</strong>.</span>
            </div>
          </div>
        </div>

        <!-- Paso 2 -->
        <div class="help-step-item">
          <div class="step-indicator" aria-hidden="true">2</div>
          <div class="step-content">
            <h3>Genera tu URL de conexión en este portal</h3>
            <p>Ingresa tus credenciales en el formulario principal, selecciona tu país y haz clic en <strong>Verificar y Conectar</strong>.</p>
            <p>El portal validará tus credenciales y generará una <strong>URL cifrada única</strong> (AES-256-GCM) para tu sesión de Model Context Protocol.</p>
          </div>
        </div>

        <!-- Paso 3 -->
        <div class="help-step-item">
          <div class="step-indicator" aria-hidden="true">3</div>
          <div class="step-content">
            <h3>Configura tu cliente o asistente de IA</h3>
            <p>Copia la URL generada y agrégala a tu herramienta de IA según tu entorno:</p>

            <div class="client-tabs-nav" role="tablist" aria-label="Instrucciones por cliente">
              <button type="button" class="client-tab active" id="tabClientApps" role="tab" aria-selected="true" onclick="switchClientHelpTab('apps')">
                <span class="material-symbols-outlined" aria-hidden="true">apps</span>
                Claude / Apps
              </button>
              <button type="button" class="client-tab" id="tabClientIde" role="tab" aria-selected="false" onclick="switchClientHelpTab('ide')">
                <span class="material-symbols-outlined" aria-hidden="true">code</span>
                Cursor / Windsurf / IDEs
              </button>
              <button type="button" class="client-tab" id="tabClientConfig" role="tab" aria-selected="false" onclick="switchClientHelpTab('config')">
                <span class="material-symbols-outlined" aria-hidden="true">terminal</span>
                Archivo JSON / Stdio
              </button>
            </div>

            <div class="client-tab-panel" id="panelClientApps">
              <ol class="client-instructions-list">
                <li>Abre tu cliente de IA y dirígete a <strong>Ajustes &gt; Conectores</strong> (o <em>Developer Settings</em>).</li>
                <li>Haz clic en <strong>Add Custom Connector (Agregar conector)</strong>.</li>
                <li>Asigna un nombre (ej. <code>Contabilium</code>) y pega la <strong>URL Streamable HTTP</strong> generada.</li>
                <li>Guarda y verifica que el conector quede activo con todas las herramientas habilitadas.</li>
              </ol>
            </div>

            <div class="client-tab-panel" id="panelClientIde" style="display:none;">
              <ol class="client-instructions-list">
                <li>En Cursor, Windsurf o VS Code, abre <strong>Settings &gt; Features &gt; MCP Servers</strong>.</li>
                <li>Haz clic en <strong>Add new MCP server</strong>.</li>
                <li>Selecciona el transporte tipo <strong>Streamable HTTP</strong> o <strong>SSE</strong> y pega tu URL cifrada.</li>
                <li>Guarda y comprueba el indicador verde de conexión activa.</li>
              </ol>
            </div>

            <div class="client-tab-panel" id="panelClientConfig" style="display:none;">
              <p style="font-size:12px; margin-bottom:8px; color:var(--m3-on-surface-variant);">Si tu entorno utiliza un archivo de configuración <code>claude_desktop_config.json</code> o <code>mcp.json</code>, puedes agregar:</p>
              <pre class="help-code-block"><code>{
  "mcpServers": {
    "contabilium": {
      "url": "&lt;URL_GENERADA_AQUI&gt;"
    }
  }
}</code></pre>
            </div>
          </div>
        </div>

        <!-- Capacidades de la IA -->
        <div class="help-capabilities-box">
          <h4><span class="material-symbols-outlined" aria-hidden="true">verified</span> ¿Qué podrá resolver tu IA una vez conectada?</h4>
          <div class="capabilities-grid">
            <span class="cap-pill"><span class="material-symbols-outlined" aria-hidden="true">inventory_2</span> Stock por depósito</span>
            <span class="cap-pill"><span class="material-symbols-outlined" aria-hidden="true">search</span> Catálogo de productos y precios</span>
            <span class="cap-pill"><span class="material-symbols-outlined" aria-hidden="true">receipt_long</span> Listado y estado de comprobantes</span>
            <span class="cap-pill"><span class="material-symbols-outlined" aria-hidden="true">account_balance_wallet</span> Cuentas corrientes por cobrar</span>
            <span class="cap-pill"><span class="material-symbols-outlined" aria-hidden="true">group</span> Consulta de clientes y datos fiscales</span>
          </div>
        </div>
      </div>

      <div class="help-modal-footer">
        <button type="button" class="btn-help-primary" id="closeHelpBtnAction">
          <span class="material-symbols-outlined" aria-hidden="true">check</span>
          <span>Entendido, volver al conector</span>
        </button>
      </div>
    </div>
  </div>

  <!-- Toast Snackbar -->
  <div id="snackbar" class="snackbar" role="status" aria-live="polite">
    <span class="material-symbols-outlined" aria-hidden="true" style="color: var(--cbl-success-accent); font-size: 20px;">check</span>
    <span id="snackbarText">URL copiada al portapapeles</span>
  </div>

  <script>
    const form = document.getElementById("setupForm");
    const submitBtn = document.getElementById("submitBtn");
    const btnIcon = document.getElementById("btnIcon");
    const btnText = document.getElementById("btnText");
    const progressBar = document.getElementById("progressBar");
    const resultBox = document.getElementById("resultBox");
    const errorBox = document.getElementById("errorBox");
    const errorText = document.getElementById("errorText");
    const generatedUrl = document.getElementById("generatedUrl");
    const companyInfo = document.getElementById("companyInfo");
    const togglePasswordBtn = document.getElementById("togglePasswordBtn");
    const clientIdInput = document.getElementById("clientId");
    const clientSecretInput = document.getElementById("clientSecret");
    const clientIdContainer = document.getElementById("clientIdContainer");
    const clientSecretContainer = document.getElementById("clientSecretContainer");
    const clientIdError = document.getElementById("clientIdError");
    const clientSecretError = document.getElementById("clientSecretError");
    const togglePasswordIcon = document.getElementById("togglePasswordIcon");
    const tabStreamable = document.getElementById("tabStreamable");
    const tabSse = document.getElementById("tabSse");
    const snackbar = document.getElementById("snackbar");
    const snackbarText = document.getElementById("snackbarText");

    // Elementos del Modal de Ayuda
    const helpModal = document.getElementById("helpModal");
    const openHelpBtn = document.getElementById("openHelpBtn");
    const openHelpBtnFooter = document.getElementById("openHelpBtnFooter");
    const closeHelpBtn = document.getElementById("closeHelpBtn");
    const closeHelpBtnAction = document.getElementById("closeHelpBtnAction");
    let lastActiveTrigger = null;

    let currentStreamableUrl = "";
    let currentSseUrl = "";
    let activeTab = "streamable";

    // Funciones de Apertura / Cierre de Guía
    function openHelpModal(triggerEl) {
      lastActiveTrigger = triggerEl || openHelpBtn;
      helpModal.style.display = "flex";
      document.body.style.overflow = "hidden";
      closeHelpBtn.focus();
    }

    function closeHelpModal() {
      helpModal.style.display = "none";
      document.body.style.overflow = "";
      if (lastActiveTrigger) {
        lastActiveTrigger.focus();
      }
    }

    openHelpBtn.addEventListener("click", () => openHelpModal(openHelpBtn));
    openHelpBtnFooter.addEventListener("click", () => openHelpModal(openHelpBtnFooter));
    closeHelpBtn.addEventListener("click", closeHelpModal);
    closeHelpBtnAction.addEventListener("click", () => {
      closeHelpModal();
      clientIdInput.focus();
    });

    // Cerrar al hacer clic en el backdrop exterior
    helpModal.addEventListener("click", (e) => {
      if (e.target === helpModal) {
        closeHelpModal();
      }
    });

    // Cerrar con Escape
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && helpModal.style.display === "flex") {
        closeHelpModal();
      }
    });

    // Pestañas de ayuda por cliente
    function switchClientHelpTab(clientKey) {
      const tabs = {
        apps: { tab: document.getElementById("tabClientApps"), panel: document.getElementById("panelClientApps") },
        ide: { tab: document.getElementById("tabClientIde"), panel: document.getElementById("panelClientIde") },
        config: { tab: document.getElementById("tabClientConfig"), panel: document.getElementById("panelClientConfig") }
      };

      Object.keys(tabs).forEach(k => {
        if (k === clientKey) {
          tabs[k].tab.classList.add("active");
          tabs[k].tab.setAttribute("aria-selected", "true");
          tabs[k].panel.style.display = "block";
        } else {
          tabs[k].tab.classList.remove("active");
          tabs[k].tab.setAttribute("aria-selected", "false");
          tabs[k].panel.style.display = "none";
        }
      });
    }

    // Toggle de visibilidad de password con aria-pressed y aria-label
    togglePasswordBtn.addEventListener("click", () => {
      const isPassword = clientSecretInput.type === "password";
      clientSecretInput.type = isPassword ? "text" : "password";
      togglePasswordIcon.innerText = isPassword ? "visibility_off" : "visibility";
      togglePasswordBtn.setAttribute("aria-label", isPassword ? "Ocultar contraseña" : "Mostrar contraseña");
      togglePasswordBtn.setAttribute("aria-pressed", isPassword ? "true" : "false");
    });

    // Validación inline para email (UI/UX Pro Max)
    function validateEmail(email) {
      return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email);
    }

    clientIdInput.addEventListener("blur", () => {
      const val = clientIdInput.value.trim();
      if (val && !validateEmail(val)) {
        clientIdContainer.classList.add("input-error");
        clientIdError.style.display = "block";
        clientIdInput.setAttribute("aria-invalid", "true");
      } else {
        clientIdContainer.classList.remove("input-error");
        clientIdError.style.display = "none";
        clientIdInput.setAttribute("aria-invalid", "false");
      }
    });

    clientIdInput.addEventListener("input", () => {
      clientIdContainer.classList.remove("input-error");
      clientIdError.style.display = "none";
      clientIdInput.setAttribute("aria-invalid", "false");
      errorBox.style.display = "none";
    });

    clientSecretInput.addEventListener("input", () => {
      clientSecretContainer.classList.remove("input-error");
      clientSecretError.style.display = "none";
      clientSecretInput.setAttribute("aria-invalid", "false");
      errorBox.style.display = "none";
    });

    // Cambiar tabs entre Streamable HTTP y SSE
    function switchUrlTab(tab) {
      activeTab = tab;
      if (tab === "streamable") {
        tabStreamable.classList.add("active");
        tabStreamable.setAttribute("aria-selected", "true");
        tabSse.classList.remove("active");
        tabSse.setAttribute("aria-selected", "false");
        generatedUrl.innerText = currentStreamableUrl;
      } else {
        tabSse.classList.add("active");
        tabSse.setAttribute("aria-selected", "true");
        tabStreamable.classList.remove("active");
        tabStreamable.setAttribute("aria-selected", "false");
        generatedUrl.innerText = currentSseUrl;
      }
    }

    function showSnackbar(msg) {
      snackbarText.innerText = msg;
      snackbar.className = "snackbar show";
      setTimeout(() => {
        snackbar.className = "snackbar";
      }, 3000);
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errorBox.style.display = "none";
      resultBox.style.display = "none";
      
      const clientId = clientIdInput.value.trim();
      const clientSecret = clientSecretInput.value.trim();
      const country = document.getElementById("country").value;

      let hasError = false;

      if (!clientId || !validateEmail(clientId)) {
        clientIdContainer.classList.add("input-error");
        clientIdError.style.display = "block";
        clientIdInput.setAttribute("aria-invalid", "true");
        hasError = true;
      }

      if (!clientSecret) {
        clientSecretContainer.classList.add("input-error");
        clientSecretError.style.display = "block";
        clientSecretInput.setAttribute("aria-invalid", "true");
        hasError = true;
      }

      if (hasError) {
        return;
      }

      submitBtn.disabled = true;
      submitBtn.setAttribute("aria-busy", "true");
      btnIcon.innerText = "sync";
      btnIcon.style.animation = "spin 1s infinite linear";
      btnText.innerText = "Autenticando con Contabilium...";
      progressBar.style.display = "block";

      try {
        const response = await fetch("/api/generate-token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientId, clientSecret, country }),
        });

        const data = await response.json();

        if (!data.ok) {
          errorText.innerText = data.error || "Error al verificar las credenciales.";
          errorBox.style.display = "flex";
        } else {
          currentStreamableUrl = data.url;
          currentSseUrl = data.sseUrl || data.url.replace("/mcp?", "/sse?");
          
          companyInfo.innerHTML = "<div><strong>Razón Social:</strong> " + escapeHtml(data.empresa) + "</div>" +
            (data.cuit ? "<div><strong>Identificación Fiscal:</strong> " + escapeHtml(data.cuit) + "</div>" : "") +
            "<div><strong>Región:</strong> " + escapeHtml(data.pais) + "</div>";
          
          switchUrlTab("streamable");
          resultBox.style.display = "block";
          resultBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
      } catch (err) {
        errorText.innerText = "Error de conexión con el servidor: " + err.message;
        errorBox.style.display = "flex";
      } finally {
        submitBtn.disabled = false;
        submitBtn.setAttribute("aria-busy", "false");
        btnIcon.innerText = "bolt";
        btnIcon.style.animation = "none";
        btnText.innerText = "Verificar y Conectar";
        progressBar.style.display = "none";
      }
    });

    async function copyActiveUrl() {
      const textToCopy = generatedUrl.innerText;
      if (!textToCopy) return;

      try {
        await navigator.clipboard.writeText(textToCopy);
        const copyIcon = document.getElementById("copyBtnIcon");
        copyIcon.innerText = "check";
        showSnackbar("¡URL copiada al portapapeles!");
        setTimeout(() => {
          copyIcon.innerText = "content_copy";
        }, 2000);
      } catch (e) {
        showSnackbar("No se pudo copiar automáticamente. Selecciónala manualmente.");
      }
    }

    function escapeHtml(str) {
      if (!str) return "";
      return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    // Limpieza de parámetros en la barra de direcciones para no filtrar la clave si se copia la URL
    if (window.location.search.includes('key=') || window.location.search.includes('access=') || window.location.search.includes('secret=')) {
      const cleanUrl = new URL(window.location);
      cleanUrl.searchParams.delete('key');
      cleanUrl.searchParams.delete('access');
      cleanUrl.searchParams.delete('secret');
      window.history.replaceState({}, document.title, cleanUrl.pathname + (cleanUrl.search ? cleanUrl.search : ''));
    }

    // Bloquear portal y borrar cookie de sesión
    function lockPortalSession() {
      document.cookie = 'cbl_portal_access=; path=/; max-age=0; SameSite=Lax';
      window.location.href = '/';
    }
  </script>
</body>
</html>
  `;
}

/**
 * Máscara de Acceso Restringido (Gate Screen)
 * Protege el portal con Work Sans, colores Contabilium y diseño minimalista.
 */
function renderAccessGateHtml() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Acceso Restringido - Contabilium MCP</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Work+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" />
  <style>
    :root {
      --cbl-brand: #00C7AF;
      --cbl-brand-hover: #00E2C8;
      --cbl-brand-active: #00A994;
      --cbl-brand-tint: rgba(0, 199, 175, 0.12);
      --cbl-brand-glow: rgba(0, 199, 175, 0.25);
      --cbl-danger-text: #FF648A;
      --cbl-danger-bg: rgba(243, 36, 101, 0.14);
      --cbl-danger-accent: #F32465;
      --m3-surface: #0E1015;
      --m3-surface-container: #141720;
      --m3-surface-container-high: #1A1E29;
      --m3-outline: #2C3344;
      --m3-outline-variant: #1E2330;
      --m3-on-surface: #F3F4F6;
      --m3-on-surface-variant: #9CA3AF;
      --m3-motion-standard: cubic-bezier(0.2, 0, 0, 1);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Work Sans', -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background-color: #07080B;
      color: var(--m3-on-surface);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      padding: 24px 16px;
      line-height: 1.5;
      position: relative;
      overflow-x: hidden;
    }
    body::before {
      content: "";
      position: absolute;
      top: -160px;
      left: 50%;
      transform: translateX(-50%);
      width: 680px;
      height: 480px;
      background: radial-gradient(circle, rgba(0, 199, 175, 0.12) 0%, rgba(7, 8, 11, 0) 70%);
      pointer-events: none;
      z-index: 0;
    }
    :focus-visible {
      outline: 2px solid var(--cbl-brand);
      outline-offset: 2px;
    }
    .gate-card {
      position: relative;
      z-index: 1;
      background-color: var(--m3-surface);
      border: 1px solid var(--m3-outline-variant);
      border-radius: 24px;
      padding: 36px 32px;
      max-width: 440px;
      width: 100%;
      box-shadow: 0 20px 50px -10px rgba(0, 0, 0, 0.9), 0 0 1px 1px rgba(255, 255, 255, 0.05);
      animation: gateFadeIn 0.3s var(--m3-motion-standard);
    }
    @keyframes gateFadeIn {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .gate-header {
      text-align: center;
      margin-bottom: 24px;
    }
    .gate-icon-box {
      width: 52px;
      height: 52px;
      margin: 0 auto 16px;
      border-radius: 16px;
      background: var(--cbl-brand-tint);
      color: var(--cbl-brand);
      border: 1px solid rgba(0, 199, 175, 0.3);
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 0 24px rgba(0, 199, 175, 0.2);
    }
    .gate-icon-box .material-symbols-outlined {
      font-size: 28px;
    }
    .gate-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: var(--cbl-brand-tint);
      color: var(--cbl-brand);
      font-size: 11px;
      font-weight: 600;
      padding: 3px 12px;
      border-radius: 9999px;
      border: 1px solid rgba(0, 199, 175, 0.25);
      margin-bottom: 12px;
    }
    .gate-badge-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--cbl-brand);
    }
    h1 {
      font-size: 21px;
      font-weight: 600;
      color: #ffffff;
      letter-spacing: -0.2px;
      margin-bottom: 8px;
    }
    p.gate-subtitle {
      font-size: 13.5px;
      color: var(--m3-on-surface-variant);
      line-height: 1.5;
    }
    .gate-form {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .gate-input-wrap {
      position: relative;
      display: flex;
      align-items: center;
      background: var(--m3-surface-container);
      border: 1px solid var(--m3-outline);
      border-radius: 12px;
      min-height: 48px;
      transition: all 0.2s;
    }
    .gate-input-wrap:focus-within {
      border-color: var(--cbl-brand);
      box-shadow: 0 0 0 3px var(--cbl-brand-glow);
      background: var(--m3-surface-container-high);
    }
    .gate-input-wrap input {
      width: 100%;
      background: transparent;
      border: none;
      padding: 13px 16px;
      font-size: 14.5px;
      font-family: inherit;
      color: var(--m3-on-surface);
      outline: none;
    }
    .gate-input-wrap input::placeholder {
      color: #5E6678;
      font-size: 13.5px;
    }
    .toggle-pw-btn {
      background: none;
      border: none;
      color: var(--m3-on-surface-variant);
      cursor: pointer;
      min-width: 44px;
      min-height: 44px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 8px;
      margin-right: 4px;
      transition: color 0.15s;
    }
    .toggle-pw-btn:hover {
      color: #fff;
    }
    .btn-gate-submit {
      width: 100%;
      min-height: 48px;
      padding: 13px 20px;
      background: var(--cbl-brand);
      color: #07090D;
      border: none;
      border-radius: 12px;
      font-family: inherit;
      font-weight: 700;
      font-size: 14.5px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      box-shadow: 0 4px 18px rgba(0, 199, 175, 0.35);
      transition: all 0.2s var(--m3-motion-standard);
    }
    .btn-gate-submit:hover:not(:disabled) {
      background: var(--cbl-brand-hover);
      box-shadow: 0 6px 24px rgba(0, 199, 175, 0.45);
      transform: translateY(-1px);
    }
    .btn-gate-submit:disabled {
      background: #1F2430;
      color: #555E70;
      cursor: not-allowed;
      box-shadow: none;
      transform: none;
    }
    .gate-error {
      display: none;
      background: var(--cbl-danger-bg);
      border: 1px solid var(--cbl-danger-accent);
      border-radius: 10px;
      padding: 10px 14px;
      color: var(--cbl-danger-text);
      font-size: 12.5px;
      font-weight: 500;
      text-align: center;
      animation: gateShake 0.35s ease-in-out;
    }
    @keyframes gateShake {
      0%, 100% { transform: translateX(0); }
      20%, 60% { transform: translateX(-6px); }
      40%, 80% { transform: translateX(6px); }
    }
    .gate-instructions {
      margin-top: 22px;
      padding-top: 18px;
      border-top: 1px solid var(--m3-outline-variant);
      font-size: 12px;
      color: var(--m3-on-surface-variant);
      line-height: 1.5;
      text-align: center;
    }
    .gate-instructions strong {
      color: #fff;
    }
    .gate-instructions code {
      background: #050608;
      border: 1px solid var(--m3-outline);
      color: var(--cbl-brand);
      padding: 2px 6px;
      border-radius: 5px;
      font-family: ui-monospace, monospace;
      font-size: 11px;
    }
  </style>
</head>
<body>
  <main class="gate-card">
    <div class="gate-header">
      <div class="gate-icon-box" aria-hidden="true">
        <span class="material-symbols-outlined">lock</span>
      </div>
      <div class="gate-badge">
        <span class="gate-badge-dot"></span>
        <span>Acceso Privado</span>
      </div>
      <h1>Acceso Restringido</h1>
      <p class="gate-subtitle">Este portal se encuentra en fase de validación interna. Ingresa la clave de acceso autorizada para ingresar.</p>
    </div>

    <form class="gate-form" id="gateForm" novalidate>
      <div>
        <label for="gateKey" style="display:block; font-size:12.5px; font-weight:500; margin-bottom:6px;">Clave de acceso</label>
        <div class="gate-input-wrap">
          <input type="password" id="gateKey" placeholder="Ingresa la clave del equipo" required autocomplete="current-password" autofocus>
          <button type="button" class="toggle-pw-btn" id="toggleGatePw" aria-label="Mostrar clave">
            <span class="material-symbols-outlined" id="toggleGateIcon" style="font-size:20px;">visibility</span>
          </button>
        </div>
      </div>

      <div class="gate-error" id="gateErrorBox" role="alert"></div>

      <button type="submit" class="btn-gate-submit" id="gateSubmitBtn">
        <span class="material-symbols-outlined" style="font-size:18px;">lock_open</span>
        <span>Desbloquear interfaz</span>
      </button>
    </form>

    <div class="gate-instructions">
      <strong>Instrucciones para el equipo:</strong>
      <p style="margin-top:4px;">
        Puedes ingresar directamente agregando <code>?key=tu_clave</code> a la URL. Si necesitas la clave, solicítala al equipo de producto o revisa <code>PORTAL_ACCESS_SECRET</code>.
      </p>
    </div>
  </main>

  <script>
    const gatePw = document.getElementById('gateKey');
    const toggleGatePw = document.getElementById('toggleGatePw');
    const toggleGateIcon = document.getElementById('toggleGateIcon');
    const gateForm = document.getElementById('gateForm');
    const gateSubmitBtn = document.getElementById('gateSubmitBtn');
    const gateErrorBox = document.getElementById('gateErrorBox');

    if (toggleGatePw && gatePw) {
      toggleGatePw.addEventListener('click', () => {
        const isPw = gatePw.type === 'password';
        gatePw.type = isPw ? 'text' : 'password';
        toggleGateIcon.innerText = isPw ? 'visibility_off' : 'visibility';
      });
    }

    gateForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const key = gatePw.value.trim();
      if (!key) return;

      gateErrorBox.style.display = 'none';
      gateSubmitBtn.disabled = true;
      gateSubmitBtn.innerHTML = '<span class="material-symbols-outlined" style="animation:spin 1s infinite linear; font-size:18px;">sync</span><span>Validando clave...</span>';

      try {
        const res = await fetch('/api/verify-portal-access', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key })
        });
        const data = await res.json();
        if (data.ok) {
          window.location.reload();
        } else {
          gateErrorBox.innerText = data.error || 'Clave de acceso incorrecta.';
          gateErrorBox.style.display = 'block';
          gatePw.select();
        }
      } catch (err) {
        gateErrorBox.innerText = 'Error de conexión: ' + err.message;
        gateErrorBox.style.display = 'block';
      } finally {
        gateSubmitBtn.disabled = false;
        gateSubmitBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:18px;">lock_open</span><span>Desbloquear interfaz</span>';
      }
    });
  </script>
</body>
</html>`;
}

// -------------------------------------------------------------
// 1. TRANSPORTE MODERNO: Streamable HTTP (/mcp)
// El estándar actual recomendado para MCP (Reemplazo oficial de SSE)
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

// -------------------------------------------------------------
// 3. TRANSPORTE PARALELO / QA: Streamable HTTP (${QA_PATH}/mcp)
// Endpoint aislado para QA o permisos diferenciados
// -------------------------------------------------------------
app.all(`${QA_PATH}/mcp`, async (req, res) => {
  if (!validateQaAccess(req)) {
    res.status(401).json({ error: "No autorizado: Token de acceso o secreto de QA inválido." });
    return;
  }

  const credentials = extractUserCredentials(req, true);

  if (!credentials) {
    res.status(401).json({ 
      error: "No autorizado: Falta autenticación de QA (parámetro ?auth= o variables CONTABILIUM_QA_* en el entorno)." 
    });
    return;
  }

  try {
    const transport = new StreamableHTTPServerTransport({});
    const server = createMcpServerForSession(credentials, true);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[StreamableHTTP QA] Error procesando request:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

// -------------------------------------------------------------
// 4. TRANSPORTE PARALELO / QA: Server-Sent Events (${QA_PATH}/sse)
// -------------------------------------------------------------
app.get(`${QA_PATH}/sse`, async (req, res) => {
  if (!validateQaAccess(req)) {
    res.status(401).send("No autorizado: Token de acceso o secreto de QA inválido.");
    return;
  }

  const credentials = extractUserCredentials(req, true);

  if (!credentials) {
    res.status(401).send("No autorizado: Falta autenticación de QA.");
    return;
  }

  const transport = new SSEServerTransport(`${QA_PATH}/messages`, res);
  const server = createMcpServerForSession(credentials, true);

  sseTransports.set(transport.sessionId, transport);

  req.on("close", () => {
    sseTransports.delete(transport.sessionId);
  });

  await server.connect(transport);
});

app.post(`${QA_PATH}/messages`, async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = sseTransports.get(sessionId);

  if (!transport) {
    res.status(404).send("Sesión SSE QA no encontrada o expirada");
    return;
  }

  await transport.handlePostMessage(req, res);
});

// -------------------------------------------------------------
// Portal Web UI Privado para QA / MCP Paralelo (${QA_PATH})
// No expuesto en la navegación pública
// -------------------------------------------------------------
app.get(QA_PATH, (req, res) => {
  const hasSecretConfigured = Boolean(process.env.MCP_QA_SECRET);
  const isAuthorized = validateQaAccess(req);

  const host = req.get("host");
  const protocol = req.protocol === "https" || req.get("x-forwarded-proto") === "https" ? "https" : "http";
  const qaBaseUrl = process.env.CONTABILIUM_QA_BASE_URL || process.env.CONTABILIUM_BASE_URL || "Preestablecida por país / producción";
  const hasServerCredentials = Boolean(process.env.CONTABILIUM_QA_CLIENT_ID && process.env.CONTABILIUM_QA_CLIENT_SECRET);
  const secretParam = process.env.MCP_QA_SECRET ? `?key=${encodeURIComponent(process.env.MCP_QA_SECRET)}` : "";
  const directMcpUrl = `${protocol}://${host}${QA_PATH}/mcp${secretParam}`;
  const directSseUrl = `${protocol}://${host}${QA_PATH}/sse${secretParam}`;

  res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>MCP Paralelo / QA - Contabilium</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Work+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" />
  <style>
    :root {
      --cbl-brand: #00C7AF;
      --cbl-brand-hover: #00E2C8;
      --cbl-brand-active: #00A994;
      --cbl-brand-tint: rgba(0, 199, 175, 0.12);
      --cbl-brand-glow: rgba(0, 199, 175, 0.25);

      --qa-accent: #FF9800;
      --qa-bg-tint: rgba(255, 152, 0, 0.14);

      --m3-surface: #0E1015;
      --m3-surface-container: #141720;
      --m3-surface-container-high: #1A1E29;
      --m3-outline: #2C3344;
      --m3-outline-variant: #1E2330;
      --m3-on-surface: #F3F4F6;
      --m3-on-surface-variant: #9CA3AF;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Work Sans', -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background-color: #07080B;
      color: var(--m3-on-surface);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      padding: 24px 16px;
      line-height: 1.5;
      position: relative;
      overflow-x: hidden;
    }
    body::before {
      content: "";
      position: absolute;
      top: -160px;
      left: 50%;
      transform: translateX(-50%);
      width: 680px;
      height: 480px;
      background: radial-gradient(circle, rgba(255, 152, 0, 0.12) 0%, rgba(7, 8, 11, 0) 70%);
      pointer-events: none;
      z-index: 0;
    }
    .card {
      position: relative;
      z-index: 1;
      background-color: var(--m3-surface);
      border: 1px solid var(--m3-outline-variant);
      border-radius: 24px;
      padding: 36px;
      max-width: 580px;
      width: 100%;
      box-shadow: 0 20px 50px -10px rgba(0,0,0,0.9), 0 0 1px 1px rgba(255, 255, 255, 0.05);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: var(--qa-bg-tint);
      color: var(--qa-accent);
      font-size: 11px;
      font-weight: 700;
      padding: 4px 12px;
      border-radius: 9999px;
      margin-bottom: 12px;
      border: 1px solid rgba(255, 152, 0, 0.3);
      letter-spacing: 0.3px;
    }
    h1 { font-size: 22px; font-weight: 600; margin-bottom: 6px; color: #fff; letter-spacing: -0.2px; }
    p.subtitle { font-size: 13.5px; color: var(--m3-on-surface-variant); margin-bottom: 20px; line-height: 1.5; }
    
    .info-box {
      background: var(--m3-surface-container);
      border: 1px solid var(--m3-outline-variant);
      border-radius: 14px;
      padding: 16px;
      margin-bottom: 20px;
      font-size: 13px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .info-box strong { color: #fff; }
    
    .code-box {
      position: relative;
      background: #050608;
      border: 1px solid var(--m3-outline);
      border-radius: 12px;
      padding: 14px 52px 14px 14px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      color: var(--cbl-brand);
      word-break: break-all;
      margin-bottom: 14px;
      line-height: 1.45;
    }
    .copy-btn {
      position: absolute;
      top: 8px;
      right: 8px;
      background: var(--cbl-brand);
      color: #07090D;
      border: none;
      border-radius: 8px;
      width: 38px;
      height: 38px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s;
    }
    .copy-btn:hover {
      background: var(--cbl-brand-hover);
      transform: scale(1.04);
    }
    
    .field-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 6px;
    }
    .field-label {
      font-size: 13px;
      font-weight: 500;
      color: var(--m3-on-surface);
    }
    .field-direct-link {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11.5px;
      font-weight: 500;
      color: var(--cbl-brand);
      text-decoration: none;
      transition: color 0.15s;
    }
    .field-direct-link:hover {
      color: var(--cbl-brand-hover);
      text-decoration: underline;
    }
    
    .input-row {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 16px;
    }
    .input-wrap {
      position: relative;
      display: flex;
      align-items: center;
      background: var(--m3-surface-container);
      border: 1px solid var(--m3-outline);
      border-radius: 12px;
      min-height: 48px;
      transition: border-color 0.2s;
    }
    .input-wrap:focus-within {
      border-color: var(--cbl-brand);
      box-shadow: 0 0 0 3px var(--cbl-brand-glow);
      background: var(--m3-surface-container-high);
    }
    .input-wrap input {
      width: 100%;
      background: transparent;
      border: none;
      padding: 13px 16px;
      font-size: 14.5px;
      color: #fff;
      outline: none;
      font-family: inherit;
    }
    .input-wrap input::placeholder {
      color: #5E6678;
      font-size: 13.5px;
    }
    .toggle-pw-btn {
      background: none;
      border: none;
      color: var(--m3-on-surface-variant);
      cursor: pointer;
      min-width: 44px;
      min-height: 44px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 8px;
      margin-right: 4px;
      transition: color 0.15s;
    }
    .toggle-pw-btn:hover {
      color: #fff;
    }
    
    .btn-submit {
      width: 100%;
      min-height: 48px;
      padding: 13px 20px;
      background: var(--cbl-brand);
      color: #07090D;
      border: none;
      border-radius: 12px;
      font-weight: 700;
      font-size: 14.5px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      margin-top: 10px;
      box-shadow: 0 4px 18px rgba(0, 199, 175, 0.35);
      transition: all 0.2s;
    }
    .btn-submit:hover:not(:disabled) {
      background: var(--cbl-brand-hover);
      transform: translateY(-1px);
    }
    .btn-submit:disabled {
      background: #1F2430;
      color: #555E70;
      cursor: not-allowed;
      box-shadow: none;
    }
    .tag-secret {
      background: rgba(255, 152, 0, 0.15);
      color: #FFB74D;
      padding: 2px 8px;
      border-radius: 6px;
      font-size: 11px;
      border: 1px solid rgba(255, 152, 0, 0.3);
    }
    .tag-ok {
      background: var(--cbl-brand-tint);
      color: var(--cbl-brand);
      padding: 2px 8px;
      border-radius: 6px;
      font-size: 11px;
      border: 1px solid rgba(0, 199, 175, 0.3);
    }
  </style>
</head>
<body>
  <main class="card">
    <div class="badge">
      <span class="material-symbols-outlined" style="font-size:14px;">science</span>
      CANAL PARALELO / QA MCP
    </div>
    <h1>Conector MCP Paralelo (QA)</h1>
    <p class="subtitle">Este endpoint opera independientemente del MCP principal y utiliza una URL base y credenciales aisladas para pruebas.</p>

    ${hasSecretConfigured && !isAuthorized ? `
      <div style="background:rgba(243, 36, 101, 0.12); border:1px solid #F32465; border-radius:14px; padding:18px; margin-bottom:16px;">
        <strong style="color:#FF648A; display:flex; align-items:center; gap:6px;">
          <span class="material-symbols-outlined" style="font-size:18px;">lock</span>
          Acceso Restringido
        </strong>
        <p style="margin-top:6px; margin-bottom:14px; font-size:13px; color:#E5E7EB;">Se requiere la clave secreta de QA configurada en <code>MCP_QA_SECRET</code> para ver o utilizar este panel.</p>
        <form method="GET" action="${QA_PATH}">
          <div class="input-wrap" style="margin-bottom:12px;">
            <input type="password" name="key" placeholder="Ingresa MCP_QA_SECRET" required>
          </div>
          <button type="submit" class="btn-submit">Validar Acceso</button>
        </form>
      </div>
    ` : `
      <div class="info-box">
        <div><strong>URL Base Contabilium API:</strong> <code style="color:var(--cbl-brand);">${qaBaseUrl}</code></div>
        <div><strong>Ruta MCP Paralela:</strong> <code>${QA_PATH}/mcp</code></div>
        <div><strong>Autenticación en Vercel:</strong> ${hasServerCredentials ? '<span class="tag-ok">Credenciales Fijas Configuradas</span>' : '<span style="color:#fbbf24;">Requiere Token Cifrado (?auth=)</span>'}</div>
        ${hasSecretConfigured ? '<div><strong>Protección de Secreto:</strong> <span class="tag-secret">Activa</span></div>' : ''}
      </div>

      ${hasServerCredentials ? `
        <div style="margin-bottom:16px;">
          <label style="font-size:13px; font-weight:600; color:#fff; display:block; margin-bottom:6px;">URL de Conexión Directa (Streamable HTTP):</label>
          <div class="code-box">
            <span id="directUrl">${directMcpUrl}</span>
            <button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('directUrl').innerText); alert('URL Copiada al portapapeles');" title="Copiar URL">
              <span class="material-symbols-outlined" style="font-size:18px;">content_copy</span>
            </button>
          </div>
        </div>
      ` : `
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px;">
          <span style="font-size:13px; font-weight:600; color:#fff;">Generar Token Cifrado para QA:</span>
          <a href="https://app.contabilium.com/modulos/miCuenta/api.aspx" target="_blank" rel="noopener noreferrer" class="field-direct-link" title="Obtener credenciales en el panel de Contabilium">
            <span>Mi cuenta - API - Credenciales</span>
            <span class="material-symbols-outlined" style="font-size:14px;">open_in_new</span>
          </a>
        </div>
        
        <form id="qaTokenForm">
          <div class="input-row">
            <div class="field-row">
              <label class="field-label" for="qaClientId">Email de API (QA)</label>
            </div>
            <div class="input-wrap">
              <input type="email" id="qaClientId" placeholder="usuario@empresa.com" required autocomplete="email">
            </div>
          </div>
          
          <div class="input-row">
            <div class="field-row">
              <label class="field-label" for="qaClientSecret">API Key Privada (QA)</label>
            </div>
            <div class="input-wrap">
              <input type="password" id="qaClientSecret" placeholder="Tu API Key de Contabilium" required autocomplete="current-password">
              <button type="button" class="toggle-pw-btn" id="qaTogglePw" aria-label="Mostrar contraseña">
                <span class="material-symbols-outlined" id="qaToggleIcon" style="font-size:20px;">visibility</span>
              </button>
            </div>
          </div>
          
          <button type="submit" class="btn-submit" id="btnGenQa">
            <span class="material-symbols-outlined" style="font-size:18px;">key</span>
            <span>Generar URL QA</span>
          </button>
        </form>
        
        <div id="qaResult" style="display:none; margin-top:20px;">
          <label style="font-size:12px; font-weight:600; color:#fff; display:block; margin-bottom:6px;">URL MCP Generada con Token Cifrado:</label>
          <div class="code-box">
            <span id="qaGeneratedUrl"></span>
            <button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('qaGeneratedUrl').innerText); alert('URL Copiada al portapapeles');" title="Copiar URL">
              <span class="material-symbols-outlined" style="font-size:18px;">content_copy</span>
            </button>
          </div>
        </div>
        
        <script>
          const qaPwInput = document.getElementById('qaClientSecret');
          const qaTogglePw = document.getElementById('qaTogglePw');
          const qaToggleIcon = document.getElementById('qaToggleIcon');
          
          if (qaTogglePw && qaPwInput) {
            qaTogglePw.addEventListener('click', () => {
              const isPw = qaPwInput.type === 'password';
              qaPwInput.type = isPw ? 'text' : 'password';
              qaToggleIcon.innerText = isPw ? 'visibility_off' : 'visibility';
            });
          }
          
          document.getElementById('qaTokenForm')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = document.getElementById('btnGenQa');
            btn.disabled = true;
            btn.innerHTML = '<span class=\"material-symbols-outlined\" style=\"animation:spin 1s infinite linear; font-size:18px;\">sync</span><span>Verificando con Contabilium QA...</span>';
            try {
              const res = await fetch('/api/generate-token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  clientId: document.getElementById('qaClientId').value.trim(),
                  clientSecret: document.getElementById('qaClientSecret').value.trim(),
                  target: 'qa',
                  key: new URLSearchParams(window.location.search).get('key') || ''
                })
              });
              const data = await res.json();
              if (data.ok) {
                document.getElementById('qaGeneratedUrl').innerText = data.url;
                document.getElementById('qaResult').style.display = 'block';
              } else {
                alert(data.error || 'Error generando token de QA');
              }
            } catch (err) {
              alert('Error de conexión: ' + err.message);
            } finally {
              btn.disabled = false;
              btn.innerHTML = '<span class=\"material-symbols-outlined\" style=\"font-size:18px;\">key</span><span>Generar URL QA</span>';
            }
          });
        </script>
      `}
    `}
  </main>
</body>
</html>
  `);
});

// Arrancar en standalone si no corre en Vercel Serverless
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`🚀 Contabilium MCP Server activo en puerto ${PORT}`);
    console.log(`✨ Streamable HTTP Producción: http://localhost:${PORT}/mcp`);
    console.log(`📡 Legacy SSE Producción: http://localhost:${PORT}/sse`);
    console.log(`🧪 Streamable HTTP QA / Paralelo: http://localhost:${PORT}${QA_PATH}/mcp`);
    console.log(`🔬 Legacy SSE QA / Paralelo: http://localhost:${PORT}${QA_PATH}/sse`);
    console.log(`⚙️  Portal Privado QA: http://localhost:${PORT}${QA_PATH}`);
  });
}

export default app;
