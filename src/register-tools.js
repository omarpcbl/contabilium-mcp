import * as buscarClientes from "./tools/buscar_clientes.js";
import * as buscarProductos from "./tools/buscar_productos.js";
import * as buscarProveedores from "./tools/buscar_proveedores.js";
import * as listarDepositos from "./tools/listar_depositos.js";
import * as listarVentas from "./tools/listar_ventas.js";
import * as resumenVentas from "./tools/resumen_ventas.js";
import * as stockPorDeposito from "./tools/stock_por_deposito.js";
import * as cuentasPorCobrar from "./tools/cuentas_por_cobrar.js";
import * as quePuedoConsultar from "./tools/que_puedo_consultar.js";
import * as diagnosticarOrden from "./tools/diagnosticar_orden.js";
import * as crearBorradorFactura from "./tools/crear_borrador_factura.js";
import * as autorizarFacturaElectronica from "./tools/autorizar_factura_electronica.js";
import * as emitirFacturaExpress from "./tools/emitir_factura_express.js";
import * as obtenerFacturaPdf from "./tools/obtener_factura_pdf.js";
import * as registrarConsultaNoSoportada from "./tools/registrar_consulta_no_soportada.js";
import { z } from "zod";

/**
 * Registra las herramientas y prompts del servidor MCP de Contabilium
 * 
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server 
 * @param {import("./contabilium-client.js").ContabiliumClient} client 
 */
export function registerContabiliumTools(server, client) {
  // 0. que_puedo_consultar (MEJ-12: Onboarding interactivo y capacidades)
  server.tool(
    "que_puedo_consultar",
    "Guía de asistencia y bienvenida: explica qué módulos y consultas están disponibles (ventas, stock, cobranzas), sus límites operacionales y ofrece preguntas sugeridas listas para ejecutar.",
    quePuedoConsultar.schema,
    async (args) => {
      try {
        return await quePuedoConsultar.handler(args, client);
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: err.message, datos: null, resumen: "Error al obtener guía", advertencias: [err.message], truncado: false }, null, 2) }],
          isError: true,
        };
      }
    }
  );

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

  // 6. resumen_ventas (MEJ-14: descripción armonizada con schema)
  server.tool(
    "resumen_ventas",
    "Totaliza ventas por período, agrupables por día, mes, semana, cliente, producto, rubro u origen. Resta notas de crédito y excluye cotizaciones.",
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
    "Consulta stock actual y reservado de un producto en un depósito específico o en todos. Calcula disponible real y alerta sobreventas.",
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

  // 8. cuentas_por_cobrar (MEJ-14: descripción armonizada)
  server.tool(
    "cuentas_por_cobrar",
    "Lista comprobantes pendientes de cobro y genera el reporte de antigüedad de deuda (Aging: 0-30, 31-60, 61-90, >90 días). Excluye cotizaciones.",
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

  // OP-08: diagnosticar_orden (Diagnóstico de órdenes e integraciones e-commerce)
  server.tool(
    "diagnosticar_orden",
    "Diagnóstico automatizado de órdenes e integraciones e-commerce (Fenicio, Base, Vestetic, Luna, etc.): detecta duplicados, valida CUIT/RUT del cliente, verifica existencia de SKUs en catálogo, revisa stock disponible en depósito y señala la causa raíz si la orden no se facturó.",
    diagnosticarOrden.schema,
    async (args) => {
      try {
        return await diagnosticarOrden.handler(args, client);
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: err.message, datos: null, resumen: "Error al diagnosticar orden", advertencias: [err.message], truncado: false }, null, 2) }],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Módulo de Facturación y Emisión Electrónica (BUG-15)
  // En el MVP de solo lectura para dashboards, las tools de facturación se ocultan
  // por defecto para prevenir emisiones accidentales con validez fiscal.
  // ---------------------------------------------------------------------------
  if (process.env.ENABLE_BILLING_TOOLS === "true") {
    // 9. crear_borrador_factura (Paso 1 del Flujo Seguro)
    server.tool(
      "crear_borrador_factura",
      "Paso 1 del flujo seguro: Prepara y guarda un borrador de factura en Contabilium (sin impacto fiscal ni llamada a AFIP aún) para presentar el preview interactivo al usuario.",
      crearBorradorFactura.schema,
      async (args) => {
        try {
          return await crearBorradorFactura.handler(args, client);
        } catch (err) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: err.message, datos: null, resumen: "Error al crear el borrador de factura", advertencias: [err.message], truncado: false }, null, 2) }],
            isError: true,
          };
        }
      }
    );

    // 10. autorizar_factura_electronica (Paso 2 del Flujo Seguro)
    server.tool(
      "autorizar_factura_electronica",
      "Paso 2 del flujo seguro: Recibe el ID de un borrador ya confirmado por el humano y lo envía a autorizar ante el fisco (AFIP/SII) para obtener el CAE/Folio y el link PDF.",
      autorizarFacturaElectronica.schema,
      async (args) => {
        try {
          return await autorizarFacturaElectronica.handler(args, client);
        } catch (err) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: err.message, datos: null, resumen: "Error al autorizar electrónicamente la factura ante el fisco", advertencias: [err.message], truncado: false }, null, 2) }],
            isError: true,
          };
        }
      }
    );

    // 11. emitir_factura_express (Flujo Express / Directo)
    server.tool(
      "emitir_factura_express",
      "Emisión express en 1 solo paso: Crea, cobra y autoriza fiscalmente la factura de forma inmediata. Usar ÚNICAMENTE si el usuario lo solicita explícitamente.",
      emitirFacturaExpress.schema,
      async (args) => {
        try {
          return await emitirFacturaExpress.handler(args, client);
        } catch (err) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: err.message, datos: null, resumen: "Error en la emisión express", advertencias: [err.message], truncado: false }, null, 2) }],
            isError: true,
          };
        }
      }
    );

    // 12. obtener_factura_pdf
    server.tool(
      "obtener_factura_pdf",
      "Obtiene el estado de emisión y la URL para visualizar y descargar el PDF oficial de una factura emitida.",
      obtenerFacturaPdf.schema,
      async (args) => {
        try {
          return await obtenerFacturaPdf.handler(args, client);
        } catch (err) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: err.message, datos: null, resumen: "Error al obtener el PDF de la factura", advertencias: [err.message], truncado: false }, null, 2) }],
            isError: true,
          };
        }
      }
    );
  }

  // 13. registrar_consulta_no_soportada
  server.tool(
    "registrar_consulta_no_soportada",
    "Registra internamente una consulta que el MCP no pudo responder y devuelve una alternativa constructiva para orientar al usuario.",
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
      const esAmbientePruebas = Boolean(
        client.isParallel ||
        client.ambiente?.includes("QA") ||
        /(qa|staging|dev|sandbox|test)/i.test(client.baseUrl || "") ||
        process.env.MCP_ENVIRONMENT === "qa"
      );

      try {
        let masked = "NO_CONFIGURADO";
        if (client.clientId) {
          const parts = client.clientId.split("@");
          masked = parts.length === 2 ? `${parts[0].slice(0, 2)}***@${parts[1]}` : `${client.clientId.slice(0, 3)}***`;
        }

        let conexionEnVivo = null;
        if (ping) {
          const info = await client.get("/usuarios/obtenerinfo");
          conexionEnVivo = {
            conectado: true,
            razonSocial: info?.RazonSocial,
            cuit: info?.CUIT,
            condicionIVA: info?.CondicionIVA,
            tieneFE: Boolean(info?.TieneFE),
          };
        } else {
          await client.ensureValidToken().catch(() => {});
        }

        const report = {
          configuracion: {
            ambiente: esAmbientePruebas 
              ? "QA / Pruebas (Ambiente de Testing - Sin validez fiscal ante AFIP)" 
              : "Producción (Ambiente Real - Con validez fiscal ante AFIP)",
            validezFiscalReal: !esAmbientePruebas,
            usuarioIdentificador: masked,
            pais: client.country,
          },
          token: {
            activo: Boolean(client.cachedToken && Date.now() < client.tokenExpiresAt),
            minutosRestantes: client.cachedToken ? Math.max(0, Math.round((client.tokenExpiresAt - Date.now()) / 60000)) : 0,
          },
        };

        if (conexionEnVivo) {
          report.conexionEnVivo = conexionEnVivo;
        }

        return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
      } catch (err) {
        let sugerencia = "Revisa la conectividad de red con el servicio de Contabilium.";
        const msg = err.message || "";
        if (msg.includes("CERT") || msg.includes("certificate") || msg.includes("self-signed")) {
          sugerencia = "Certificado SSL no reconocido por Node.js. Agrega CONTABILIUM_IGNORE_SSL: 'true' en tu configuración.";
        } else if (msg.includes("ENOTFOUND")) {
          sugerencia = "El dominio no pudo resolverse por DNS. Si es entorno de QA, verifica si la VPN está conectada.";
        } else if (msg.includes("ECONNREFUSED") || msg.includes("ETIMEDOUT") || msg.includes("ConnectTimeoutError")) {
          sugerencia = "Conexión rechazada o expirada. Verifica que la red o VPN permita el acceso.";
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              conectado: false,
              ambiente: esAmbientePruebas
                ? "QA / Pruebas (Ambiente de Testing - Sin validez fiscal ante AFIP)"
                : "Producción (Ambiente Real - Con validez fiscal ante AFIP)",
              validezFiscalReal: !esAmbientePruebas,
              error: err.message,
              diagnostico: sugerencia
            }, null, 2)
          }],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Prompts oficiales del Servidor MCP (MEJ-11)
  // ---------------------------------------------------------------------------
  if (typeof server.prompt === "function") {
    // 1. Resumen del mes
    server.prompt(
      "resumen_del_mes",
      "Genera un resumen ejecutivo de ventas y operaciones del mes actual con desglose de facturado, notas de crédito y ticket promedio.",
      {
        mes: z.string().optional().describe("Mes a consultar en formato YYYY-MM (por defecto: mes en curso)."),
      },
      ({ mes }) => {
        const m = mes || new Date().toISOString().slice(0, 7);
        return {
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: `Por favor generá un resumen ejecutivo de las ventas de ${m} usando resumen_ventas, indicando facturado bruto, notas de crédito, total neto, ticket promedio y principales clientes o grupos.`,
              },
            },
          ],
        };
      }
    );

    // 2. Comparar con mes anterior
    server.prompt(
      "comparar_con_mes_anterior",
      "Compara las ventas del mes en curso contra el mes anterior inmediato para evaluar crecimiento.",
      {},
      () => {
        return {
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: "Compará las ventas de este mes contra el mes pasado usando resumen_ventas con comparar_con_periodo_anterior=true. Explicá la variación porcentual de ventas y qué rubros crecieron o cayeron.",
              },
            },
          ],
        };
      }
    );

    // 3. ¿Quién me debe?
    server.prompt(
      "quien_me_debe",
      "Consulta clientes con deuda vencida y desglosa el reporte de antigüedad de saldos (Aging).",
      {
        solo_vencidas: z.boolean().default(true).describe("Si es true, solo analiza deuda vencida."),
      },
      ({ solo_vencidas }) => {
        return {
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: `Mostrame quiénes son los principales clientes que me deben usando cuentas_por_cobrar con solo_vencidas=${solo_vencidas}. Detallá los tramos de antigüedad de deuda (0-30, 31-60, 61-90 y más de 90 días) y qué clientes tienen mayor atraso.`,
              },
            },
          ],
        };
      }
    );

    // 4. Productos sin stock
    server.prompt(
      "productos_sin_stock",
      "Identifica productos sin existencias o en situación de sobreventa en los depósitos.",
      {},
      () => {
        return {
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: "Consultá los productos sin stock o con sobreventa usando stock_por_deposito con filtro='sin_stock', top=20 y orden='menor_disponible'. Alertá si detectás sobreventas por reservas comprometidas.",
              },
            },
          ],
        };
      }
    );
  }
}
