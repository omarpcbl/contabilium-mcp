#!/usr/bin/env node
/**
 * Contabilium Remote MCP Server (SSE Transport)
 * 
 * Servidor MCP accesible por URL HTTPS para conectar con Claude Desktop,
 * Claude Web u otros clientes sin requerir instalación local ni Node.js en el cliente.
 * 
 * Cumple con el estándar SSE de Model Context Protocol:
 * - GET /sse : Inicia la conexión SSE (Server-Sent Events)
 * - POST /messages : Recibe las solicitudes JSON-RPC vinculadas a la sesión
 */

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const PORT = process.env.PORT || 3000;
const app = express();

const COUNTRY_URLS = {
  AR: "https://rest.contabilium.com",
  CL: "https://rest.contabilium.cl",
  UY: "https://rest.contabilium.com.uy",
};

// Mapa de transportes por ID de sesión
const transports = new Map();

/**
 * Función fábrica para crear una instancia de McpServer configurada para una sesión
 */
function createMcpServerForSession(credentials = {}) {
  const clientId = credentials.clientId || process.env.CONTABILIUM_CLIENT_ID;
  const clientSecret = credentials.clientSecret || process.env.CONTABILIUM_CLIENT_SECRET;
  const country = (credentials.country || process.env.CONTABILIUM_COUNTRY || "AR").toUpperCase();
  const baseUrl = credentials.baseUrl || process.env.CONTABILIUM_BASE_URL || COUNTRY_URLS[country] || COUNTRY_URLS.AR;

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
        "Credenciales no encontradas. Configura CONTABILIUM_CLIENT_ID y CONTABILIUM_CLIENT_SECRET en el servidor o envíalas en los headers HTTP."
      );
    }

    const tokenUrl = `${baseUrl.replace(/\/+$/, "")}/token`;
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
      throw new Error(`Error de autenticación (${response.status}): ${errText}`);
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

    const url = new URL(`${baseUrl.replace(/\/+$/, "")}${cleanEndpoint}`);
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

  // Tools
  server.tool(
    "contabilium_auth_status",
    "Verifica el estado del token y conectividad con Contabilium.",
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

  server.tool(
    "contabilium_get_account_info",
    "Obtiene configuración y datos fiscales de la cuenta.",
    {},
    async () => {
      const res = await callApi("/usuarios/obtenerinfo", "GET");
      return { content: [{ type: "text", text: JSON.stringify(res.payload, null, 2) }] };
    }
  );

  server.tool(
    "contabilium_api_request",
    "Ejecuta llamadas autorizadas a la API de Contabilium.",
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
// Rutas HTTP
// -------------------------------------------------------------

// Healthcheck
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "contabilium-mcp-remote", version: "1.0.0" });
});

// Endpoint SSE
app.get("/sse", async (req, res) => {
  console.log(`[SSE] Nueva conexión entrante desde ${req.ip}`);

  // Permitir credenciales por cabeceras HTTP si es multi-tenant
  const credentials = {
    clientId: req.headers["x-contabilium-client-id"],
    clientSecret: req.headers["x-contabilium-client-secret"],
    country: req.headers["x-contabilium-country"],
  };

  const transport = new SSEServerTransport("/messages", res);
  const server = createMcpServerForSession(credentials);

  transports.set(transport.sessionId, transport);

  req.on("close", () => {
    console.log(`[SSE] Conexión cerrada para sesión ${transport.sessionId}`);
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
  console.log(`🚀 Contabilium Remote MCP Server corriendo en http://localhost:${PORT}`);
  console.log(`📡 Endpoint SSE para Claude: http://localhost:${PORT}/sse`);
});
