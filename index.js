#!/usr/bin/env node
/**
 * Contabilium MCP Server (STDIO Mode)
 * 
 * Implementado bajo el estándar oficial de Model Context Protocol (MCP) 2026:
 * https://modelcontextprotocol.io/docs/2026-07-28/develop/build-server
 * 
 * Características:
 * - Instancia de McpServer de alto nivel (@modelcontextprotocol/sdk/server/mcp.js)
 * - Transporte STDIO puro (sin escrituras en stdout, solo stderr vía console.error)
 * - 8 herramientas de solo lectura + 1 de diagnóstico
 * - Inyección de instrucciones oficiales del sistema en el handshake
 * - Manejo automático de rate-limiting (Token bucket 2 req/s) y reintentos ante 429
 * - Normalización monetaria y paginación con tope de 1.000 registros
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { ContabiliumClient } from "./src/contabilium-client.js";
import { registerContabiliumTools } from "./src/register-tools.js";
import { SYSTEM_INSTRUCTION } from "./src/instructions.js";

// Cargar .env si existe en el directorio local
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, ".env") });

const client = new ContabiliumClient({
  clientId: process.env.CONTABILIUM_CLIENT_ID,
  clientSecret: process.env.CONTABILIUM_CLIENT_SECRET,
  country: process.env.CONTABILIUM_COUNTRY || "AR",
  baseUrl: process.env.CONTABILIUM_BASE_URL,
});

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

// -----------------------------------------------------------------------------
// Arranque sobre STDIO
// -----------------------------------------------------------------------------
async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Contabilium MCP Server (STDIO) activo y escuchando.");
}

run().catch((err) => {
  console.error("Error fatal en Contabilium MCP Server:", err);
  process.exit(1);
});
