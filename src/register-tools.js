import * as buscarClientes from "./tools/buscar_clientes.js";
import * as buscarProductos from "./tools/buscar_productos.js";
import * as buscarProveedores from "./tools/buscar_proveedores.js";
import * as listarDepositos from "./tools/listar_depositos.js";
import * as listarVentas from "./tools/listar_ventas.js";
import * as resumenVentas from "./tools/resumen_ventas.js";
import * as stockPorDeposito from "./tools/stock_por_deposito.js";
import * as cuentasPorCobrar from "./tools/cuentas_por_cobrar.js";
import * as registrarConsultaNoSoportada from "./tools/registrar_consulta_no_soportada.js";
import { z } from "zod";

/**
 * Registra las herramientas del servidor MCP de Contabilium
 * 
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server 
 * @param {import("./contabilium-client.js").ContabiliumClient} client 
 */
export function registerContabiliumTools(server, client) {
  // 1. buscar_clientes
  server.tool(
    "buscar_clientes",
    "Busca clientes por nombre, razón social o CUIT. Devuelve IDs necesarios para filtrar ventas y deudas.",
    buscarClientes.schema,
    async (args) => {
      try {
        return await buscarClientes.handler(args, client);
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: err.message, datos: [], resumen: "Error en la consulta", advertencias: [err.message], truncado: false }, null, 2) }],
          isError: true,
        };
      }
    }
  );

  // 2. buscar_productos
  server.tool(
    "buscar_productos",
    "Busca productos por SKU o nombre. Devuelve código, descripción, precio de venta, stock total consolidado, costo_interno (utilizado como costo de compra habitual ante proveedores) y proveedor asignado.",
    buscarProductos.schema,
    async (args) => {
      try {
        return await buscarProductos.handler(args, client);
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: err.message, datos: [], resumen: "Error en la consulta", advertencias: [err.message], truncado: false }, null, 2) }],
          isError: true,
        };
      }
    }
  );

  // 3. buscar_proveedores
  server.tool(
    "buscar_proveedores",
    "Busca proveedores por razón social, nombre de fantasía o CUIT. Devuelve datos de contacto para reposición y compras.",
    buscarProveedores.schema,
    async (args) => {
      try {
        return await buscarProveedores.handler(args, client);
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: err.message, datos: [], resumen: "Error en la consulta", advertencias: [err.message], truncado: false }, null, 2) }],
          isError: true,
        };
      }
    }
  );

  // 4. listar_depositos
  server.tool(
    "listar_depositos",
    "Lista los depósitos configurados con sus IDs. Usar antes de consultar stock por depósito.",
    listarDepositos.schema,
    async (args) => {
      try {
        return await listarDepositos.handler(args, client);
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: err.message, datos: [], resumen: "Error en la consulta", advertencias: [err.message], truncado: false }, null, 2) }],
          isError: true,
        };
      }
    }
  );

  // 5. listar_ventas
  server.tool(
    "listar_ventas",
    "Lista comprobantes de venta emitidos en un período. Máximo 92 días por consulta.",
    listarVentas.schema,
    async (args) => {
      try {
        return await listarVentas.handler(args, client);
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: err.message, datos: [], resumen: "Error en la consulta", advertencias: [err.message], truncado: false }, null, 2) }],
          isError: true,
        };
      }
    }
  );

  // 6. resumen_ventas
  server.tool(
    "resumen_ventas",
    "Totaliza ventas por período, agrupables por día, semana, mes o cliente. Calcula totales facturados y cantidad de operaciones.",
    resumenVentas.schema,
    async (args) => {
      try {
        return await resumenVentas.handler(args, client);
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: err.message, datos: [], resumen: "Error en la consulta", advertencias: [err.message], truncado: false }, null, 2) }],
          isError: true,
        };
      }
    }
  );

  // 7. stock_por_deposito
  server.tool(
    "stock_por_deposito",
    "Consulta stock actual y reservado de un producto en un depósito específico o en todos.",
    stockPorDeposito.schema,
    async (args) => {
      try {
        return await stockPorDeposito.handler(args, client);
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: err.message, datos: [], resumen: "Error en la consulta", advertencias: [err.message], truncado: false }, null, 2) }],
          isError: true,
        };
      }
    }
  );

  // 8. cuentas_por_cobrar
  server.tool(
    "cuentas_por_cobrar",
    "Lista comprobantes con saldo pendiente de cobro y totaliza la deuda agrupada por cliente.",
    cuentasPorCobrar.schema,
    async (args) => {
      try {
        return await cuentasPorCobrar.handler(args, client);
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: err.message, datos: [], resumen: "Error en la consulta", advertencias: [err.message], truncado: false }, null, 2) }],
          isError: true,
        };
      }
    }
  );

  // 9. registrar_consulta_no_soportada
  server.tool(
    "registrar_consulta_no_soportada",
    "Registra internamente una consulta que el MCP no pudo responder por falta de datos o endpoint. Usar de forma transparente cuando el usuario pida algo fuera del alcance.",
    registrarConsultaNoSoportada.schema,
    async (args) => {
      try {
        return await registrarConsultaNoSoportada.handler(args, client);
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: err.message, datos: { registrado: false }, resumen: "Error registrando", advertencias: [err.message], truncado: false }, null, 2) }],
          isError: true,
        };
      }
    }
  );

  // Tool auxiliar de diagnóstico y autenticación de la conexión
  server.tool(
    "contabilium_auth_status",
    "Verifica el estado del token y conectividad con la cuenta de Contabilium.",
    { ping: z.boolean().default(true).describe("Si es true, valida conexión en vivo con Contabilium.") },
    async ({ ping }) => {
      try {
        let masked = "NO_CONFIGURADO";
        if (client.clientId) {
          const parts = client.clientId.split("@");
          masked = parts.length === 2 ? `${parts[0].slice(0, 2)}***@${parts[1]}` : `${client.clientId.slice(0, 3)}***`;
        }

        const report = {
          configuracion: {
            usuarioIdentificador: masked,
            pais: client.country,
            urlBase: client.baseUrl,
          },
          token: {
            activo: Boolean(client.cachedToken && Date.now() < client.tokenExpiresAt),
            minutosRestantes: client.cachedToken ? Math.max(0, Math.round((client.tokenExpiresAt - Date.now()) / 60000)) : 0,
          },
        };

        if (ping) {
          const info = await client.get("/usuarios/obtenerinfo");
          report.conexionEnVivo = {
            conectado: true,
            razonSocial: info?.RazonSocial,
            cuit: info?.CUIT,
            condicionIVA: info?.CondicionIVA,
            tieneFE: Boolean(info?.TieneFE),
          };
        }

        return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ conectado: false, error: err.message }, null, 2) }],
          isError: true,
        };
      }
    }
  );
}
