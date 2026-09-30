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
// Endpoint API: Generador y Validador de Token Cifrado
// -------------------------------------------------------------
app.post("/api/generate-token", async (req, res) => {
  const { clientId, clientSecret, country = "AR", target, key } = req.body;
  const isParallel = target === "qa" || target === "parallel";

  if (isParallel && !validateQaAccess({ query: { key }, headers: req.headers })) {
    return res.status(401).json({ ok: false, error: "No autorizado: Secreto de acceso a QA inválido." });
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
        error: `Credenciales inválidas en Contabilium (${authRes.status}): Revisa tu Email de API y tu API Key. (Base URL: ${baseUrl})`,
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
      baseUrl,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: `Error conectando con Contabilium (${baseUrl}): ${err.message}` });
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
  res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Conector MCP - Contabilium</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" />
  <style>
    :root {
      /* Éxito */
      --cbl-success-text: #0B5F4E;
      --cbl-success-bg: #E6F7F4;
      --cbl-success-accent: #12A594;

      /* Error */
      --cbl-danger-text: #E91E63;
      --cbl-danger-bg: #FDE8EE;

      /* Advertencia */
      --cbl-warning-text: #9A4B06;
      --cbl-warning-bg: #FEF3E9;
      --cbl-warning-accent: #FF8C00;

      /* Resaltado / CTA */
      --cbl-highlight: #4C46C6;
      --cbl-highlight-hover: #5B5BF0;
      --cbl-highlight-bg: #EFEEFC;

      /* Neutros */
      --cbl-text-primary: #111111;
      --cbl-text-secondary: #666666;
      --cbl-border: #d9d9d9;
      --cbl-bg: #eeeeee;

      /* Material Design 3 - Dark Theme Surfaces sobre fondo negro */
      --m3-surface: #101014;
      --m3-surface-container: #16161c;
      --m3-surface-container-high: #1e1e26;
      --m3-surface-container-highest: #262632;
      --m3-outline: #383846;
      --m3-outline-variant: #262632;
      --m3-on-surface: #f4f4f7;
      --m3-on-surface-variant: #a0a0b2;
      --m3-motion-standard: cubic-bezier(0.2, 0, 0, 1);
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: 'Roboto', -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background-color: #000000;
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

    /* Fondo ambiental sutil (sin layout shift) */
    body::before {
      content: "";
      position: absolute;
      top: -160px;
      left: 50%;
      transform: translateX(-50%);
      width: 640px;
      height: 480px;
      background: radial-gradient(circle, rgba(76, 70, 198, 0.16) 0%, rgba(0, 0, 0, 0) 70%);
      pointer-events: none;
      z-index: 0;
    }

    /* Regla UI/UX Pro Max: Focus Visible universal de alto contraste */
    :focus-visible {
      outline: 2px solid var(--cbl-highlight-hover);
      outline-offset: 2px;
    }

    .card {
      position: relative;
      z-index: 1;
      background-color: var(--m3-surface);
      border: 1px solid var(--m3-outline-variant);
      border-radius: 28px;
      padding: 40px;
      max-width: 580px;
      width: 100%;
      box-shadow: 0 16px 40px -12px rgba(0, 0, 0, 0.8), 0 0 1px 1px rgba(255, 255, 255, 0.05);
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
      border-radius: 16px;
      background: var(--cbl-highlight-bg);
      color: var(--cbl-highlight);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      box-shadow: 0 4px 12px rgba(76, 70, 198, 0.2);
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
      background: var(--cbl-highlight-bg);
      color: var(--cbl-highlight);
      font-size: 11px;
      font-weight: 600;
      padding: 4px 12px;
      border-radius: 9999px;
      letter-spacing: 0.3px;
      border: 1px solid rgba(76, 70, 198, 0.25);
    }

    .badge .badge-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--cbl-highlight);
      animation: pulseDot 2s infinite;
    }

    @keyframes pulseDot {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.35; transform: scale(0.85); }
    }

    .subtitle {
      font-size: 14px;
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

    .field-label {
      font-size: 13px;
      font-weight: 500;
      color: var(--m3-on-surface);
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
    }

    .field-label .material-symbols-outlined {
      font-size: 18px;
      color: var(--m3-on-surface-variant);
    }

    .input-container {
      position: relative;
      display: flex;
      align-items: center;
      background: var(--m3-surface-container);
      border: 1px solid var(--m3-outline);
      border-radius: 14px;
      min-height: 48px;
      transition: all 0.2s var(--m3-motion-standard);
    }

    .input-container:hover {
      border-color: #555568;
    }

    .input-container:focus-within {
      border-color: var(--cbl-highlight);
      box-shadow: 0 0 0 3px rgba(76, 70, 198, 0.25);
      background: var(--m3-surface-container-high);
    }

    .input-container.input-error {
      border-color: var(--cbl-danger-text) !important;
      box-shadow: 0 0 0 3px rgba(233, 30, 99, 0.2) !important;
    }

    .input-container input,
    .input-container select {
      width: 100%;
      background: transparent;
      border: none;
      padding: 13px 16px;
      font-size: 16px;
      font-family: inherit;
      color: var(--m3-on-surface);
      outline: none;
    }

    .input-container input::placeholder {
      color: #6a6a7c;
      font-size: 14px;
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
      border-radius: 10px;
      margin-right: 4px;
      transition: color 0.15s, background-color 0.15s;
    }

    .toggle-visibility-btn:hover {
      color: var(--m3-on-surface);
      background: rgba(255, 255, 255, 0.05);
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

    /* M3 Button */
    .btn-submit {
      width: 100%;
      margin-top: 12px;
      min-height: 48px;
      padding: 14px 24px;
      background: var(--cbl-highlight);
      color: #ffffff;
      border: none;
      border-radius: 9999px;
      font-family: inherit;
      font-weight: 600;
      font-size: 15px;
      letter-spacing: 0.2px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      cursor: pointer;
      box-shadow: 0 4px 14px rgba(76, 70, 198, 0.35);
      transition: background-color 0.2s, box-shadow 0.2s, transform 0.15s var(--m3-motion-standard);
      position: relative;
      overflow: hidden;
    }

    .btn-submit:hover:not(:disabled) {
      background: var(--cbl-highlight-hover);
      box-shadow: 0 6px 18px rgba(91, 91, 240, 0.45);
      transform: translateY(-1px);
    }

    .btn-submit:active:not(:disabled) {
      transform: translateY(0);
      box-shadow: 0 2px 8px rgba(76, 70, 198, 0.3);
    }

    .btn-submit:disabled {
      background: #2b2b36;
      color: #6d6d7e;
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
      background: var(--cbl-highlight);
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
      border: 1px solid var(--cbl-danger-text);
      border-radius: 16px;
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
      color: var(--cbl-danger-text);
    }

    /* Tarjeta de Resultado M3 */
    .result-card {
      display: none;
      margin-top: 24px;
      background: var(--m3-surface-container-high);
      border: 1px solid var(--m3-outline);
      border-radius: 20px;
      padding: 24px;
      animation: fadeIn 0.3s ease-out;
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
      background: var(--cbl-success-bg);
      color: var(--cbl-success-text);
      padding: 6px 14px;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 600;
      border: 1px solid var(--cbl-success-accent);
    }

    .status-badge-success .material-symbols-outlined {
      font-size: 18px;
      color: var(--cbl-success-accent);
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
      min-height: 44px;
      padding: 8px 16px;
      border-radius: 10px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s var(--m3-motion-standard);
    }

    .tab-btn.active {
      background: var(--cbl-highlight-bg);
      color: var(--cbl-highlight);
      font-weight: 600;
      border-color: rgba(76, 70, 198, 0.3);
    }

    .tab-btn:hover:not(.active) {
      color: var(--m3-on-surface);
      background: var(--m3-surface-container-highest);
    }

    .url-display-box {
      position: relative;
      background: var(--m3-surface);
      border: 1px solid var(--m3-outline);
      border-radius: 12px;
      padding: 14px 54px 14px 14px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      color: #93c5fd;
      word-break: break-all;
      line-height: 1.5;
      max-height: 100px;
      overflow-y: auto;
    }

    .copy-icon-btn {
      position: absolute;
      top: 10px;
      right: 10px;
      background: var(--cbl-highlight);
      color: #ffffff;
      border: none;
      border-radius: 10px;
      min-width: 44px;
      min-height: 44px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: background-color 0.15s, transform 0.15s;
      box-shadow: 0 2px 6px rgba(76, 70, 198, 0.3);
    }

    .copy-icon-btn:hover {
      background: var(--cbl-highlight-hover);
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
      margin-top: 24px;
      padding: 16px;
      border-radius: 16px;
      background: var(--m3-surface-container);
      border: 1px solid var(--m3-outline-variant);
      display: flex;
      align-items: flex-start;
      gap: 12px;
    }

    .security-card .material-symbols-outlined {
      font-size: 22px;
      color: var(--cbl-success-accent);
      flex-shrink: 0;
      margin-top: 2px;
    }

    .security-card-content {
      font-size: 12px;
      color: var(--m3-on-surface-variant);
      line-height: 1.5;
    }

    .security-card-content strong {
      color: var(--m3-on-surface);
    }

    /* M3 Floating Toast / Snackbar */
    .snackbar {
      visibility: hidden;
      min-width: 280px;
      background: #1c1c24;
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
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.1);
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

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
      }
      .btn-submit:hover:not(:disabled) {
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
    }
  </style>
</head>
<body>
  <main class="card" role="main">
    <!-- Header -->
    <header class="card-header">
      <div class="header-icon-box" aria-hidden="true">
        <span class="material-symbols-outlined">lock_open</span>
      </div>
      <div class="header-title-wrap">
        <div class="title-row">
          <h1>Conector Contabilium MCP</h1>
          <div class="badge" aria-label="Protocolo Model Context Protocol">
            <span class="badge-dot" aria-hidden="true"></span>
            <span>Protocolo MCP</span>
          </div>
        </div>
        <p class="subtitle">Conecta tu cuenta de Contabilium con asistentes y herramientas de IA mediante el protocolo estándar MCP.</p>
      </div>
    </header>

    <!-- Formulario M3 Accesible -->
    <form id="setupForm" novalidate aria-label="Formulario de conexión a Contabilium">
      <div class="form-group">
        <label class="field-label" for="clientId">
          <span class="material-symbols-outlined" aria-hidden="true">mail</span>
          Email de API (client_id)
        </label>
        <div class="input-container" id="clientIdContainer">
          <input type="email" id="clientId" placeholder="ejemplo@tuempresa.com" required autocomplete="email" aria-describedby="clientIdHelp clientIdError" aria-invalid="false">
        </div>
        <span class="supporting-text" id="clientIdHelp">El correo registrado en tu cuenta de Contabilium para la API.</span>
        <span class="inline-error-msg" id="clientIdError" role="alert">Ingresa un formato de correo electrónico válido.</span>
      </div>

      <div class="form-group">
        <label class="field-label" for="clientSecret">
          <span class="material-symbols-outlined" aria-hidden="true">key</span>
          API Key Privada (client_secret)
        </label>
        <div class="input-container" id="clientSecretContainer">
          <input type="password" id="clientSecret" placeholder="Tu API Key de Contabilium" required autocomplete="current-password" aria-describedby="clientSecretHelp clientSecretError" aria-invalid="false">
          <button type="button" class="toggle-visibility-btn" id="togglePasswordBtn" aria-label="Mostrar contraseña" aria-pressed="false">
            <span class="material-symbols-outlined" id="togglePasswordIcon" aria-hidden="true">visibility</span>
          </button>
        </div>
        <span class="supporting-text" id="clientSecretHelp">Generada en la sección Integraciones > API de tu panel.</span>
        <span class="inline-error-msg" id="clientSecretError" role="alert">La API Key es obligatoria.</span>
      </div>

      <div class="form-group">
        <label class="field-label" for="country">
          <span class="material-symbols-outlined" aria-hidden="true">public</span>
          País de radicación fiscal
        </label>
        <div class="input-container">
          <select id="country" aria-label="Selecciona el país de radicación fiscal">
            <option value="AR">Argentina (AFIP)</option>
            <option value="CL">Chile (SII)</option>
            <option value="UY">Uruguay (DGI)</option>
          </select>
          <span class="material-symbols-outlined select-arrow" aria-hidden="true">expand_more</span>
        </div>
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
        <span class="material-symbols-outlined" aria-hidden="true" style="color: var(--cbl-highlight-hover); font-size:18px;">arrow_forward</span>
        <span>Pega esta URL en el campo de configuración de servidores MCP de tu asistente o cliente de IA preferido.</span>
      </div>
    </section>

    <!-- Nota de Seguridad M3 -->
    <aside class="security-card" aria-label="Información de seguridad y cifrado">
      <span class="material-symbols-outlined" aria-hidden="true">verified_user</span>
      <div class="security-card-content">
        <strong>Seguridad y Privacidad:</strong> Tus credenciales se cifran con <strong>AES-256-GCM</strong> y nunca se exponen en texto plano ante el modelo de IA ni terceros.
      </div>
    </aside>
  </main>

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

    let currentStreamableUrl = "";
    let currentSseUrl = "";
    let activeTab = "streamable";

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
            (data.cuit ? "<div><strong>Identificación Fiscal (CUIT/RUT):</strong> " + escapeHtml(data.cuit) + "</div>" : "") +
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
  </script>
</body>
</html>
  `);
});

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
  <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" />
  <style>
    :root {
      --qa-accent: #FF8C00;
      --qa-bg-tint: #FEF3E9;
      --m3-surface: #141210;
      --m3-surface-container: #1c1815;
      --m3-surface-container-high: #26211c;
      --m3-outline: #42382e;
      --m3-outline-variant: #2e261f;
      --m3-on-surface: #f7f4f0;
      --m3-on-surface-variant: #b2a498;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Roboto', sans-serif;
      background-color: #080706;
      color: var(--m3-on-surface);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      padding: 24px 16px;
    }
    .card {
      background-color: var(--m3-surface);
      border: 1px solid var(--m3-outline);
      border-radius: 28px;
      padding: 36px;
      max-width: 580px;
      width: 100%;
      box-shadow: 0 16px 40px rgba(0,0,0,0.8);
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
    }
    h1 { font-size: 22px; margin-bottom: 8px; color: #fff; }
    p { font-size: 14px; color: var(--m3-on-surface-variant); margin-bottom: 20px; line-height: 1.5; }
    .info-box {
      background: var(--m3-surface-container);
      border: 1px solid var(--m3-outline-variant);
      border-radius: 14px;
      padding: 16px;
      margin-bottom: 20px;
      font-size: 13px;
    }
    .info-box div { margin-bottom: 6px; }
    .info-box strong { color: #fff; }
    .code-box {
      position: relative;
      background: #000;
      border: 1px solid var(--m3-outline);
      border-radius: 12px;
      padding: 14px 50px 14px 14px;
      font-family: monospace;
      font-size: 12px;
      color: #fde047;
      word-break: break-all;
      margin-bottom: 14px;
    }
    .copy-btn {
      position: absolute;
      top: 8px;
      right: 8px;
      background: var(--qa-accent);
      color: #fff;
      border: none;
      border-radius: 8px;
      width: 36px;
      height: 36px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .btn-submit {
      width: 100%;
      min-height: 48px;
      padding: 12px 20px;
      background: var(--qa-accent);
      color: #fff;
      border: none;
      border-radius: 9999px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      margin-top: 12px;
    }
    .input-row {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 14px;
    }
    input {
      background: var(--m3-surface-container);
      border: 1px solid var(--m3-outline);
      border-radius: 10px;
      padding: 12px;
      color: #fff;
      font-size: 14px;
      outline: none;
    }
    input:focus { border-color: var(--qa-accent); }
    .tag-secret {
      background: #3b2a1a;
      color: #f59e0b;
      padding: 2px 8px;
      border-radius: 6px;
      font-size: 11px;
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
    <p>Este endpoint opera independientemente del MCP principal y utiliza una URL base y credenciales aisladas.</p>

    ${hasSecretConfigured && !isAuthorized ? `
      <div style="background:#2a1b1b; border:1px solid #7f1d1d; border-radius:12px; padding:16px; margin-bottom:16px;">
        <strong style="color:#f87171;">Acceso Restringido</strong>
        <p style="margin-top:6px; margin-bottom:12px; font-size:13px;">Se requiere la clave secreta de QA configurada en <code>MCP_QA_SECRET</code> para ver o utilizar este panel.</p>
        <form method="GET" action="${QA_PATH}">
          <div class="input-row">
            <input type="password" name="key" placeholder="Ingresa MCP_QA_SECRET" required>
          </div>
          <button type="submit" class="btn-submit">Validar Acceso</button>
        </form>
      </div>
    ` : `
      <div class="info-box">
        <div><strong>URL Base Contabilium API:</strong> ${qaBaseUrl}</div>
        <div><strong>Ruta MCP Paralela:</strong> <code>${QA_PATH}/mcp</code></div>
        <div><strong>Autenticación en Vercel:</strong> ${hasServerCredentials ? '<span style="color:#4ade80;">Credenciales Fijas Configuradas</span>' : '<span style="color:#fbbf24;">Requiere Token Cifrado (?auth=)</span>'}</div>
        ${hasSecretConfigured ? '<div><strong>Protección de Secreto:</strong> <span class="tag-secret">Activa</span></div>' : ''}
      </div>

      ${hasServerCredentials ? `
        <div style="margin-bottom:16px;">
          <label style="font-size:13px; font-weight:600; color:#fff; display:block; margin-bottom:6px;">URL de Conexión Directa (Streamable HTTP):</label>
          <div class="code-box">
            <span id="directUrl">${directMcpUrl}</span>
            <button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('directUrl').innerText); alert('URL Copiada');" title="Copiar URL">
              <span class="material-symbols-outlined">content_copy</span>
            </button>
          </div>
        </div>
      ` : `
        <div style="font-size:13px; margin-bottom:10px; color:#fff;"><strong>Generar Token Cifrado para QA:</strong></div>
        <form id="qaTokenForm">
          <div class="input-row">
            <input type="email" id="qaClientId" placeholder="Email de API (QA)" required>
          </div>
          <div class="input-row">
            <input type="password" id="qaClientSecret" placeholder="API Key Privada (QA)" required>
          </div>
          <button type="submit" class="btn-submit" id="btnGenQa">Generar URL QA</button>
        </form>
        <div id="qaResult" style="display:none; margin-top:16px;">
          <div class="code-box">
            <span id="qaGeneratedUrl"></span>
            <button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('qaGeneratedUrl').innerText); alert('URL Copiada');" title="Copiar URL">
              <span class="material-symbols-outlined">content_copy</span>
            </button>
          </div>
        </div>
        <script>
          document.getElementById('qaTokenForm')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = document.getElementById('btnGenQa');
            btn.disabled = true;
            btn.innerText = 'Verificando con Contabilium QA...';
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
              btn.innerText = 'Generar URL QA';
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
