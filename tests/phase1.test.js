import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as resumenVentas from "../src/tools/resumen_ventas.js";
import * as stockPorDeposito from "../src/tools/stock_por_deposito.js";
import * as cuentasPorCobrar from "../src/tools/cuentas_por_cobrar.js";
import * as buscarProductos from "../src/tools/buscar_productos.js";
import * as modificarConcepto from "../src/tools/modificar_concepto.js";
import * as modificarStockConcepto from "../src/tools/modificar_stock_concepto.js";
import * as quePuedoConsultar from "../src/tools/que_puedo_consultar.js";
import * as registrarConsultaNoSoportada from "../src/tools/registrar_consulta_no_soportada.js";
import * as diagnosticarOrden from "../src/tools/diagnosticar_orden.js";
import * as buscarOrdenesVenta from "../src/tools/buscar_ordenes_venta.js";
import * as enviarVenta from "../src/tools/enviar_venta.js";
import * as emularFacturacion from "../src/tools/emular_facturacion.js";
import { registerContabiliumTools, isToolAllowed } from "../src/register-tools.js";
import { classifyFiscalInvoice, formatIsoWeekLabel, formatYearMonthLabel, getTodayString, renderProgressBar, validateTaxId } from "../src/utils.js";
import { SYSTEM_INSTRUCTION } from "../src/instructions.js";
import { ContabiliumClient } from "../src/contabilium-client.js";

describe("Fase 1, 1.1 y 1.2 — Verificación Automatizada de Tickets", () => {

  describe("resumen_ventas (BUG-01, BUG-05, MEJ-01, MEJ-04)", () => {
    it("resta correctamente notas de crédito y separa facturado bruto vs neto", async () => {
      const mockItems = [
        ...Array.from({ length: 11 }, (_, i) => ({
          Id: i + 1,
          TipoFc: "FCB",
          ImporteTotalNeto: 20000.00,
          Total: 20000.00,
          FechaEmision: "2026-06-10T10:00:00",
          RazonSocial: "Consumidor Final",
          IdCliente: 999,
        })),
        {
          Id: 12,
          TipoFc: "FCB",
          ImporteTotalNeto: 23578.58,
          Total: 23578.58,
          FechaEmision: "2026-06-15T10:00:00",
          RazonSocial: "Consumidor Final",
          IdCliente: 999,
        },
        // 3 Notas de crédito B (La API las retorna con signo negativo)
        {
          Id: 13,
          TipoFc: "NCB",
          ImporteTotalNeto: -2420.00,
          Total: -2420.00,
          FechaEmision: "2026-06-20T10:00:00",
          RazonSocial: "Consumidor Final",
          IdCliente: 999,
        },
        {
          Id: 14,
          TipoFc: "NCB",
          ImporteTotalNeto: -2420.00,
          Total: -2420.00,
          FechaEmision: "2026-06-21T10:00:00",
          RazonSocial: "Consumidor Final",
          IdCliente: 999,
        },
        {
          Id: 15,
          TipoFc: "NCB",
          ImporteTotalNeto: -2420.00,
          Total: -2420.00,
          FechaEmision: "2026-06-22T10:00:00",
          RazonSocial: "Consumidor Final",
          IdCliente: 999,
        },
      ];

      const mockClient = {
        paginatedGet: async () => ({
          items: mockItems,
          truncado: false,
          paginasLeidas: 1,
          totalRegistros: 15,
        }),
      };

      const result = await resumenVentas.handler(
        {
          fecha_desde: "2026-06-01",
          fecha_hasta: "2026-06-30",
          agrupar_por: "mes",
          top: 10,
          comparar_con_periodo_anterior: false,
        },
        mockClient
      );

      const parsed = JSON.parse(result.content[0].text);
      const totales = parsed.datos.totales_generales;

      assert.equal(totales.total_facturado_bruto, 243578.58);
      assert.equal(totales.total_notas_credito, 7260.00);
      assert.equal(totales.total_neto, 236318.58);
      assert.equal(totales.cantidad_facturas, 12);
      assert.equal(totales.cantidad_notas_credito, 3);
      assert.equal(totales.cantidad_comprobantes, 15);
      assert.equal(totales.ticket_promedio, 20298.22);
      assert.equal(totales.clientes_unicos, 1);
    });
  });

  describe("Sanitización Fiscal y Exclusión de Cotizaciones (BUG-11)", () => {
    it("clasificador classifyFiscalInvoice discrimina comprobantes fiscales de cotizaciones y basura", () => {
      assert.equal(classifyFiscalInvoice("FCA").esFiscal, true);
      assert.equal(classifyFiscalInvoice("FCB").esVenta, true);
      assert.equal(classifyFiscalInvoice("NDA").esVenta, true);
      assert.equal(classifyFiscalInvoice("FACTURA A").esVenta, true);

      assert.equal(classifyFiscalInvoice("NCA").esNC, true);
      assert.equal(classifyFiscalInvoice("NCB").esNC, true);
      assert.equal(classifyFiscalInvoice("NCC").esNC, true);

      assert.equal(classifyFiscalInvoice("COT").esFiscal, false);
      assert.equal(classifyFiscalInvoice("NCT").esFiscal, false);
      assert.equal(classifyFiscalInvoice("PRE").esFiscal, false);
      assert.equal(classifyFiscalInvoice("REMITO").esFiscal, false);
      assert.equal(classifyFiscalInvoice("-1").esFiscal, false);
      assert.equal(classifyFiscalInvoice("0").esFiscal, false);
      assert.equal(classifyFiscalInvoice("XXX").esFiscal, false);
      assert.equal(classifyFiscalInvoice("FAKE").esFiscal, false);
    });

    it("resumen_ventas excluye cotizaciones (COT, NCT) y tipos inválidos de los totales fiscales", async () => {
      const mockItems = [
        ...Array.from({ length: 12 }, (_, i) => ({
          Id: i + 1,
          TipoFc: "FCA",
          Total: 1210.00,
          RazonSocial: `Cliente ${i + 1}`,
          IdCliente: i + 1,
        })),
        ...Array.from({ length: 5 }, (_, i) => ({
          Id: 20 + i,
          TipoFc: "NCA",
          Total: -1210.00,
          RazonSocial: `Cliente ${i + 1}`,
          IdCliente: i + 1,
        })),
        ...Array.from({ length: 30 }, (_, i) => ({
          Id: 40 + i,
          TipoFc: "COT",
          Total: 450.00,
          RazonSocial: "Consumidor Final",
        })),
        ...Array.from({ length: 3 }, (_, i) => ({
          Id: 80 + i,
          TipoFc: "COT",
          Total: 497.25,
          RazonSocial: "Consumidor Final",
        })),
        ...Array.from({ length: 3 }, (_, i) => ({
          Id: 90 + i,
          TipoFc: "NCT",
          Total: -450.00,
          RazonSocial: "Consumidor Final",
        })),
        { Id: 100, TipoFc: "-1", Total: 450.00 },
        { Id: 101, TipoFc: "0", Total: 450.00 },
        { Id: 102, TipoFc: "XXX", Total: 450.00 },
        { Id: 103, TipoFc: "FAKE", Total: 450.00 },
      ];

      const mockClient = {
        paginatedGet: async () => ({
          items: mockItems,
          truncado: false,
          paginasLeidas: 1,
          totalRegistros: mockItems.length,
        }),
      };

      const result = await resumenVentas.handler(
        { fecha_desde: "2026-07-01", fecha_hasta: "2026-07-01", agrupar_por: "mes" },
        mockClient
      );

      const parsed = JSON.parse(result.content[0].text);
      const totales = parsed.datos.totales_generales;

      assert.equal(totales.total_facturado_bruto, 14520.00);
      assert.equal(totales.total_notas_credito, 6050.00);
      assert.equal(totales.total_neto, 8470.00);
      assert.equal(totales.cantidad_facturas, 12);
      assert.equal(totales.cantidad_notas_credito, 5);
      assert.ok(totales.cotizaciones_excluidas >= 39);
      assert.ok(parsed.advertencias.some(a => a.includes("Se excluyen cotizaciones")));
    });
  });

  describe("Cálculos sobre datos truncados (BUG-12)", () => {
    it("resumen_ventas anula variaciones porcentuales si la consulta fue truncada por límite de páginas", async () => {
      const mockClient = {
        paginatedGet: async () => ({
          items: [{ Id: 1, TipoFc: "FCA", Total: 50000, FechaEmision: "2026-07-15" }],
          truncado: true,
          paginasLeidas: 20,
          totalRegistros: 1000,
        }),
      };

      const result = await resumenVentas.handler(
        { fecha_desde: "2026-07-01", fecha_hasta: "2026-09-30", agrupar_por: "mes", comparar_con_periodo_anterior: true },
        mockClient
      );

      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.truncado, true);
      assert.equal(parsed.datos.totales_generales.variacion_total_pct, null);
      assert.equal(parsed.datos.filas[0].variacion_pct, null);
      assert.match(parsed.resumen, /\[DATOS PARCIALES \/ TRUNCADOS\]/);
    });
  });

  describe("Sanitización de Cliente Vacío (BUG-13)", () => {
    it("resumen_ventas normaliza clientes vacíos o con solo espacios a Consumidor Final", async () => {
      const mockItems = [
        { Id: 1, TipoFc: "FCA", Total: 1000, RazonSocial: "   ", IdCliente: null },
        { Id: 2, TipoFc: "FCA", Total: 2000, RazonSocial: "Acme Corp", IdCliente: 50 },
      ];

      const mockClient = {
        paginatedGet: async () => ({ items: mockItems, truncado: false, paginasLeidas: 1, totalRegistros: 2 }),
      };

      const result = await resumenVentas.handler(
        { fecha_desde: "2026-07-01", fecha_hasta: "2026-07-01", agrupar_por: "cliente" },
        mockClient
      );

      const parsed = JSON.parse(result.content[0].text);
      const filas = parsed.datos.filas;

      assert.ok(!filas.some(f => f.grupo.trim() === ""));
      assert.ok(filas.some(f => f.grupo === "Consumidor Final"));
      assert.equal(parsed.datos.totales_generales.clientes_unicos, 1);
    });
  });

  describe("Zona Horaria Local para Fechas por Defecto (BUG-14)", () => {
    it("getTodayString respeta la zona horaria del país evitando desfasaje UTC", () => {
      const todayAr = getTodayString("AR");
      assert.match(todayAr, /^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe("Blindaje de Tools de Facturación y Control por NOT_ALLOWED_TOOLS (BUG-15)", () => {
    it("habilita por defecto emular_facturacion y crear_borrador_factura y oculta emisión fiscal directa ante AFIP", () => {
      delete process.env.ENABLE_BILLING_TOOLS;
      delete process.env.NOT_ALLOWED_TOOLS;
      delete process.env.DISABLED_TOOLS;

      const registeredTools = new Map();
      const registeredPrompts = new Map();
      const mockServer = {
        tool: (name, desc, schema, handler) => {
          registeredTools.set(name, handler);
        },
        prompt: (name, desc, schema, handler) => {
          registeredPrompts.set(name, handler);
        },
      };

      registerContabiliumTools(mockServer, { isParallel: false });

      // Bloqueadas por defecto las de emisión fiscal directa / PDF
      assert.equal(registeredTools.has("autorizar_factura_electronica"), false);
      assert.equal(registeredTools.has("emitir_factura_express"), false);
      assert.equal(registeredTools.has("obtener_factura_pdf"), false);

      // Habilitadas por defecto las 18 tools (incluyendo emular_facturacion y crear_borrador_factura)
      const expectedTools = [
        "que_puedo_consultar",
        "buscar_clientes",
        "buscar_productos",
        "modificar_concepto",
        "modificar_stock_concepto",
        "buscar_proveedores",
        "listar_depositos",
        "listar_ventas",
        "resumen_ventas",
        "stock_por_deposito",
        "cuentas_por_cobrar",
        "diagnosticar_orden",
        "buscar_ordenes_venta",
        "enviar_venta",
        "emular_facturacion",
        "crear_borrador_factura",
        "registrar_consulta_no_soportada",
        "contabilium_auth_status",
      ];

      for (const t of expectedTools) {
        assert.equal(registeredTools.has(t), true, `La tool ${t} debe estar registrada`);
      }
      assert.equal(registeredTools.size, 18);
    });

    it("permite apagar tools individuales mediante la variable de entorno NOT_ALLOWED_TOOLS", async () => {
      const prevNotAllowed = process.env.NOT_ALLOWED_TOOLS;
      try {
        process.env.NOT_ALLOWED_TOOLS = "modificar_stock_concepto, enviar_venta, crear_borrador_factura";

        assert.equal(isToolAllowed("modificar_stock_concepto"), false);
        assert.equal(isToolAllowed("enviar_venta"), false);
        assert.equal(isToolAllowed("crear_borrador_factura"), false);
        assert.equal(isToolAllowed("emular_facturacion"), true);
        assert.equal(isToolAllowed("modificar_concepto"), true);

        const registeredTools = new Map();
        const mockServer = {
          tool: (name, _desc, _schema, handler) => {
            registeredTools.set(name, handler);
          },
          prompt: () => {},
        };

        registerContabiliumTools(mockServer, { isParallel: false });

        assert.equal(registeredTools.has("modificar_stock_concepto"), false);
        assert.equal(registeredTools.has("enviar_venta"), false);
        assert.equal(registeredTools.has("crear_borrador_factura"), false);
        assert.equal(registeredTools.has("emular_facturacion"), true);

        // Además que_puedo_consultar refleja el estado deshabilitado
        const mockClient = { get: async () => null };
        const guideRes = await quePuedoConsultar.handler({ tool: "enviar_venta" }, mockClient);
        const guideParsed = JSON.parse(guideRes.content[0].text);
        assert.equal(guideParsed.datos.detalle_tool_consultada.habilitada_actualmente, false);
        assert.match(guideParsed.datos.detalle_tool_consultada.aviso_estado, /NOT_ALLOWED_TOOLS/);
        assert.equal("enviar_venta" in guideParsed.datos.catalogo_tools, false);
      } finally {
        if (prevNotAllowed !== undefined) {
          process.env.NOT_ALLOWED_TOOLS = prevNotAllowed;
        } else {
          delete process.env.NOT_ALLOWED_TOOLS;
        }
      }
    });

    it("SYSTEM_INSTRUCTION instruye rechazar facturación indicando que no está habilitado actualmente (MEJ-10)", () => {
      assert.match(SYSTEM_INSTRUCTION, /actualmente no se está habilitado para esto/i);
    });
  });

  describe("Prompts Oficiales de MCP (MEJ-11)", () => {
    it("registra los 4 prompts nativos en el servidor", () => {
      const registeredPrompts = new Map();
      const mockServer = {
        tool: () => {},
        prompt: (name, desc, schema, handler) => {
          registeredPrompts.set(name, handler);
        },
      };

      registerContabiliumTools(mockServer, {});

      assert.equal(registeredPrompts.has("resumen_del_mes"), true);
      assert.equal(registeredPrompts.has("comparar_con_mes_anterior"), true);
      assert.equal(registeredPrompts.has("quien_me_debe"), true);
      assert.equal(registeredPrompts.has("productos_sin_stock"), true);

      // Validar contenido del prompt
      const handlerMes = registeredPrompts.get("resumen_del_mes");
      const res = handlerMes({ mes: "2026-06" });
      assert.match(res.messages[0].content.text, /2026-06/);
    });
  });

  describe("Tool que_puedo_consultar (MEJ-12)", () => {
    it("devuelve capacidades, límites y preguntas sugeridas", async () => {
      const mockClient = {
        get: async (endpoint) => {
          if (endpoint.includes("obtenerinfo")) return { RazonSocial: "Test Corp", CUIT: "20123" };
          if (endpoint.includes("getDepositos")) return [{ Id: 1, Nombre: "Depósito Central", Activo: true }];
          return null;
        },
      };

      const result = await quePuedoConsultar.handler({ categoria: "todos" }, mockClient);
      const parsed = JSON.parse(result.content[0].text);

      assert.equal(parsed.datos.cuenta_conectada.empresa, "Test Corp");
      assert.ok(parsed.datos.modulos.length >= 3);
      assert.ok(parsed.datos.limites_del_servicio.some(l => l.includes("92 días")));
      assert.ok(parsed.datos.preguntas_sugeridas_para_iniciar.length >= 4);
    });
  });

  describe("Alternativas Proactivas en registrar_consulta_no_soportada (MEJ-13)", () => {
    it("devuelve alternativa útil ante consultas fuera de alcance", async () => {
      const result = await registrarConsultaNoSoportada.handler(
        { pregunta: "¿Cuánto le debo a mis proveedores?", categoria: "cuentas_a_pagar", motivo: "sin_endpoint" },
        { country: "AR" }
      );

      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.datos.registrado, true);
      assert.match(parsed.datos.sugerencia_alternativa, /buscar_proveedores/i);
      assert.match(parsed.resumen, /Alternativa sugerida:/i);
    });
  });

  describe("Armonización y Agrupación por Día en resumen_ventas (MEJ-14)", () => {
    it("resumen_ventas soporta agrupar_por='dia' y agrupa por fecha exacta", async () => {
      const mockItems = [
        { Id: 1, TipoFc: "FCA", Total: 1000, FechaEmision: "2026-06-01T10:00:00" },
        { Id: 2, TipoFc: "FCA", Total: 1500, FechaEmision: "2026-06-01T15:00:00" },
        { Id: 3, TipoFc: "FCA", Total: 2000, FechaEmision: "2026-06-02T11:00:00" },
      ];

      const mockClient = {
        paginatedGet: async () => ({ items: mockItems, truncado: false, paginasLeidas: 1, totalRegistros: 3 }),
      };

      const result = await resumenVentas.handler(
        { fecha_desde: "2026-06-01", fecha_hasta: "2026-06-05", agrupar_por: "dia" },
        mockClient
      );

      const parsed = JSON.parse(result.content[0].text);
      const filas = parsed.datos.filas;

      assert.equal(filas.length, 2);
      const dia1 = filas.find(f => f.grupo === "2026-06-01");
      assert.equal(dia1.total, 2500);
      assert.equal(dia1.cantidad_comprobantes, 2);
    });
  });

  describe("Etiquetas de Período Legibles (MEJ-15)", () => {
    it("formatYearMonthLabel y formatIsoWeekLabel generan etiquetas comerciales", () => {
      assert.equal(formatYearMonthLabel("2026-07"), "Julio 2026");
      assert.equal(formatYearMonthLabel("2026-01"), "Enero 2026");

      const labelSemana = formatIsoWeekLabel("2026-W27");
      assert.match(labelSemana, /Semana 27 \(\d{2}\/\d{2} al \d{2}\/\d{2}\/\d{4}\)/);
    });
  });

  describe("Visualización Gráfica Robusta (MEJ-16)", () => {
    it("renderProgressBar genera barras proporcionales seguras y sin fallos", () => {
      assert.equal(renderProgressBar(50, 100, 10), "█████░░░░░ 50%");
      assert.equal(renderProgressBar(100, 100, 10), "██████████ 100%");
      assert.equal(renderProgressBar(0, 100, 10), "░░░░░░░░░░ 0%");
    });

    it("resumen_ventas incluye barras visuales tipográficas y estructura lista para gráficos", async () => {
      const mockItems = [
        { Id: 1, TipoFc: "FCA", Total: 10000, FechaEmision: "2026-06-01" },
        { Id: 2, TipoFc: "FCA", Total: 5000, FechaEmision: "2026-07-01" },
      ];

      const mockClient = {
        paginatedGet: async () => ({ items: mockItems, truncado: false, paginasLeidas: 1, totalRegistros: 2 }),
      };

      const result = await resumenVentas.handler(
        { fecha_desde: "2026-06-01", fecha_hasta: "2026-07-31", agrupar_por: "mes" },
        mockClient
      );

      const parsed = JSON.parse(result.content[0].text);
      const filas = parsed.datos.filas;

      assert.ok(filas[0].barra_visual.includes("█"));
      assert.equal(parsed.datos.grafico.tipo, "barras");
      assert.equal(parsed.datos.grafico.eje_x.length, 2);
    });
  });

  describe("stock_por_deposito (BUG-06, BUG-07, MEJ-07)", () => {
    it("no emite falsa sobreventa con stock negativo sin reservas (BUG-06)", async () => {
      const mockClient = {
        get: async (endpoint) => {
          if (endpoint.includes("getDepositos")) {
            return [{ Id: 3363, Nombre: "A - PRINCIPAL", Activo: true }];
          }
          return null;
        },
        paginatedGet: async () => ({
          items: [
            { Codigo: "107-0015/NEGRO", StockActual: -3, StockReservado: 0 },
            { Codigo: "100/ROJO", StockActual: 0, StockReservado: 0 },
          ],
          truncado: false,
          paginasLeidas: 1,
          totalRegistros: 2,
        }),
      };

      const result = await stockPorDeposito.handler(
        { deposito_id: 3363, filtro: "sin_stock", top: 10, orden: "menor_disponible" },
        mockClient
      );

      const parsed = JSON.parse(result.content[0].text);
      const adv = parsed.advertencias.join(" ");

      assert.doesNotMatch(adv, /reservas activas comprometidas/i);
      assert.match(adv, /existencias físicas negativas sin reservas/i);
    });

    it("emite sobreventa real cuando stock_reservado > stock_actual", async () => {
      const mockClient = {
        get: async () => [{ Id: 3363, Nombre: "A - PRINCIPAL", Activo: true }],
        paginatedGet: async () => ({
          items: [
            { Codigo: "CASCO-01", StockActual: 2, StockReservado: 5 },
          ],
          truncado: false,
          paginasLeidas: 1,
          totalRegistros: 1,
        }),
      };

      const result = await stockPorDeposito.handler(
        { deposito_id: 3363, filtro: "sin_stock", top: 10, orden: "menor_disponible" },
        mockClient
      );

      const parsed = JSON.parse(result.content[0].text);
      const adv = parsed.advertencias.join(" ");
      assert.match(adv, /sobreventa: el stock físico es menor que las reservas activas comprometidas/i);
    });

    it("aplica top y orden informando el total de registros en el resumen (BUG-07 y MEJ-07)", async () => {
      const mockItems = Array.from({ length: 50 }, (_, i) => ({
        Codigo: `SKU-${String(i + 1).padStart(3, "0")}`,
        StockActual: i - 25,
        StockReservado: 0,
      }));

      const mockClient = {
        get: async () => [{ Id: 3363, Nombre: "A - PRINCIPAL", Activo: true }],
        paginatedGet: async () => ({
          items: mockItems,
          truncado: false,
          paginasLeidas: 1,
          totalRegistros: 50,
        }),
      };

      const result = await stockPorDeposito.handler(
        { deposito_id: 3363, filtro: "todos", top: 5, orden: "menor_disponible" },
        mockClient
      );

      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.datos.length, 5);
      assert.equal(parsed.datos[0].disponible, -25);
      assert.match(parsed.resumen, /Se encontraron 50 producto\(s\)/);
      assert.equal(parsed.truncado, true);
    });

    it("diferencia claramente en el resumen cuando se alcanza el tope de páginas de la API (BUG-07 refinado)", async () => {
      const mockItems = Array.from({ length: 500 }, (_, i) => ({
        Codigo: `SKU-${i}`,
        StockActual: i,
        StockReservado: 0,
      }));

      const mockClient = {
        get: async () => [{ Id: 3363, Nombre: "A - PRINCIPAL", Activo: true }],
        paginatedGet: async () => ({
          items: mockItems,
          truncado: true,
          paginasLeidas: 10,
          totalRegistros: 500,
        }),
      };

      const result = await stockPorDeposito.handler(
        { deposito_id: 3363, filtro: "todos", top: 10, orden: "menor_disponible" },
        mockClient
      );

      const parsed = JSON.parse(result.content[0].text);
      assert.match(parsed.resumen, /tope máximo de 10 páginas de la API alcanzado; existen más registros/i);
    });
  });

  describe("cuentas_por_cobrar (BUG-08, MEJ-05, BUG-11, BUG-12)", () => {
    it("explicita el rango de fechas analizado, excluye cotizaciones y calcula antigüedad de deuda", async () => {
      const hoy = new Date();
      const hace15Dias = new Date(hoy.getTime() - 15 * 86400000).toISOString().split("T")[0];
      const hace45Dias = new Date(hoy.getTime() - 45 * 86400000).toISOString().split("T")[0];
      const hace75Dias = new Date(hoy.getTime() - 75 * 86400000).toISOString().split("T")[0];
      const hace120Dias = new Date(hoy.getTime() - 120 * 86400000).toISOString().split("T")[0];
      const en10Dias = new Date(hoy.getTime() + 10 * 86400000).toISOString().split("T")[0];

      const mockItems = [
        { Id: 1, TipoFc: "FCA", Numero: "A-0001", Saldo: 1000, FechaVencimiento: en10Dias, RazonSocial: "Cliente Alfa", IdCliente: 10 },
        { Id: 2, TipoFc: "FCB", Numero: "A-0002", Saldo: 2000, FechaVencimiento: hace15Dias, RazonSocial: "Cliente Alfa", IdCliente: 10 },
        { Id: 3, TipoFc: "FCA", Numero: "A-0003", Saldo: 3000, FechaVencimiento: hace45Dias, RazonSocial: "Cliente Beta", IdCliente: 20 },
        { Id: 4, TipoFc: "FCB", Numero: "A-0004", Saldo: 4000, FechaVencimiento: hace75Dias, RazonSocial: "Cliente Beta", IdCliente: 20 },
        { Id: 5, TipoFc: "FCA", Numero: "A-0005", Saldo: 5000, FechaVencimiento: hace120Dias, RazonSocial: "Cliente Gamma", IdCliente: 30 },
        { Id: 6, TipoFc: "COT", Numero: "COT-01", Saldo: 50000, FechaVencimiento: hace15Dias, RazonSocial: "   " },
      ];

      let calls = 0;
      const mockClient = {
        country: "AR",
        paginatedGet: async () => {
          calls++;
          return {
            items: calls === 1 ? mockItems : [],
            truncado: false,
            paginasLeidas: 1,
            totalRegistros: calls === 1 ? mockItems.length : 0,
          };
        },
      };

      const result = await cuentasPorCobrar.handler(
        { solo_vencidas: false, agrupar_por: "cliente" },
        mockClient
      );

      const parsed = JSON.parse(result.content[0].text);
      const totales = parsed.datos.totales;

      assert.ok(totales.periodo_analizado.es_rango_por_defecto);
      assert.match(parsed.resumen, /período analizado:/);
      assert.ok(parsed.advertencias.some(a => a.includes("últimos 12 meses")));
      assert.ok(parsed.advertencias.some(a => a.includes("Se excluyen cotizaciones")));

      assert.equal(totales.saldo_total, 15000);
      assert.equal(totales.saldo_vencido, 14000);
      assert.equal(totales.saldo_no_vencido, 1000);

      const aging = totales.antiguedad_deuda_general;
      assert.equal(aging.no_vencida, 1000);
      assert.equal(aging.vencida_1_30, 2000);
      assert.equal(aging.vencida_31_60, 3000);
      assert.equal(aging.vencida_61_90, 4000);
      assert.equal(aging.vencida_mas_90, 5000);
    });
  });

  describe("buscar_productos (BUG-09)", () => {
    it("no incluye la referencia interna (API-1267) en las advertencias", async () => {
      const mockClient = {
        get: async (endpoint) => {
          if (endpoint.includes("conceptos/rubros")) return [];
          if (endpoint.includes("conceptos/search")) {
            return [{ Id: 10, Codigo: "PROD-1", Nombre: "Producto Test", Precio: 100 }];
          }
          return null;
        },
      };

      const result = await buscarProductos.handler(
        { texto: "Test", limite: 10 },
        mockClient
      );

      const parsed = JSON.parse(result.content[0].text);
      const advText = parsed.advertencias.join(" ");
      assert.doesNotMatch(advText, /API-1267/i);
      assert.match(advText, /stock_total suma todos los depósitos/);
    });
  });

  describe("contabilium_auth_status (BUG-10)", () => {
    it("reporta token activo coherente tras un ping exitoso", async () => {
      const registeredTools = new Map();
      const mockServer = {
        tool: (name, desc, schema, handler) => {
          registeredTools.set(name, handler);
        },
      };

      const mockClient = {
        clientId: "test@empresa.com",
        country: "AR",
        isParallel: false,
        ambiente: "Producción",
        cachedToken: null,
        tokenExpiresAt: 0,
        get: async (endpoint) => {
          if (endpoint === "/usuarios/obtenerinfo") {
            mockClient.cachedToken = "fake-jwt-token";
            mockClient.tokenExpiresAt = Date.now() + 3600 * 1000;
            return {
              RazonSocial: "Bernardo Cura",
              CUIT: "20123456789",
              CondicionIVA: "Responsable Inscripto",
              TieneFE: true,
            };
          }
          return null;
        },
        ensureValidToken: async () => {
          mockClient.cachedToken = "fake-jwt-token";
          mockClient.tokenExpiresAt = Date.now() + 3600 * 1000;
          return mockClient.cachedToken;
        },
      };

      registerContabiliumTools(mockServer, mockClient);

      const authTool = registeredTools.get("contabilium_auth_status");
      assert.ok(authTool);

      const response = await authTool({ ping: true });
      const parsed = JSON.parse(response.content[0].text);

      assert.equal(parsed.conexionEnVivo.conectado, true);
      assert.equal(parsed.token.activo, true);
      assert.ok(parsed.token.minutosRestantes > 50);
    });
  });

  describe("Diagnóstico de Órdenes e Integraciones E-Commerce (OP-08)", () => {
    it("valida CUITs con algoritmo módulo 11 y discriminación fiscal", () => {
      // 20-12345678-6: sum=148, 148%11=5, 11-5=6 -> Válido
      const valOk = validateTaxId("20123456786", "AR");
      assert.equal(valOk.valido, true);
      assert.equal(valOk.tipo, "CUIT");

      // Dígito verificador incorrecto
      const valErr = validateTaxId("20123456789", "AR");
      assert.equal(valErr.valido, false);
      assert.match(valErr.motivo, /Dígito verificador inválido/);

      // DNI válido
      const valDni = validateTaxId("34567890", "AR");
      assert.equal(valDni.valido, true);
      assert.equal(valDni.tipo, "DNI");
    });

    it("detecta comprobante ya emitido evitando dobles facturaciones", async () => {
      const mockClient = {
        country: "AR",
        get: async (endpoint, params) => {
          if (endpoint === "/comprobantes/search") {
            return {
              Items: [
                {
                  Id: 4501,
                  Numero: "B-0001-00004501",
                  TipoFc: "FCB",
                  FechaEmision: "2026-09-28T12:00:00",
                  RazonSocial: "Juan Perez",
                  ImporteTotalNeto: 15400,
                  Observaciones: "Orden de Fenicio #FEN-98213",
                  Origen: "Fenicio",
                },
              ],
            };
          }
          return null;
        },
      };

      const result = await diagnosticarOrden.handler(
        {
          referencia_externa: "FEN-98213",
          canal_origen: "Fenicio",
          fecha_aproximada: "2026-09-29",
        },
        mockClient
      );

      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.datos.estado, "COMPROBANTE_YA_EMITIDO");
      assert.equal(parsed.datos.checks.comprobante_previo.encontrado, true);
      assert.equal(parsed.datos.checks.comprobante_previo.numero, "B-0001-00004501");
      assert.match(parsed.resumen, /ya fue emitida previamente/);
    });

    it("detecta SKU inexistente y CUIT inválido como bloqueantes críticos", async () => {
      const mockClient = {
        country: "AR",
        get: async (endpoint, params) => {
          if (endpoint === "/comprobantes/search") {
            return { Items: [] };
          }
          if (endpoint === "/conceptos/search") {
            // El SKU no existe en catálogo
            return { Items: [] };
          }
          return null;
        },
      };

      const result = await diagnosticarOrden.handler(
        {
          referencia_externa: "BASE-4011",
          canal_origen: "Base",
          cliente: { cuit_o_dni: "20123456789", razon_social: "Comprador Falso" }, // CUIT inválido
          items: [{ sku: "ZAPATILLA-RUN-42", cantidad: 2 }],
        },
        mockClient
      );

      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.datos.estado, "BLOQUEANTE_DETECTADO");
      assert.equal(parsed.datos.bloqueantes.length, 2);

      const codigos = parsed.datos.bloqueantes.map((b) => b.codigo);
      assert.ok(codigos.includes("CLIENTE_DOCUMENTO_INVALIDO"));
      assert.ok(codigos.includes("SKU_INEXISTENTE"));
      assert.ok(parsed.datos.acciones_recomendadas.some((a) => a.includes("Dar de alta el SKU")));
    });

    it("detecta stock insuficiente en el depósito asignado", async () => {
      const mockClient = {
        country: "AR",
        get: async (endpoint, params) => {
          if (endpoint === "/comprobantes/search") {
            return { Items: [] };
          }
          if (endpoint === "/conceptos/search") {
            return {
              Items: [
                { Id: 88, Codigo: "REM-01", Nombre: "Remera Blanca", Activo: true, Estado: "A" },
              ],
            };
          }
          if (endpoint === "/inventarios/getStockBySKU") {
            return {
              Codigo: "REM-01",
              StockActual: 5,
              StockReservado: 4, // Disponible = 1
            };
          }
          return null;
        },
      };

      const result = await diagnosticarOrden.handler(
        {
          referencia_externa: "VEST-1002",
          canal_origen: "Vestetic",
          items: [{ sku: "REM-01", cantidad: 3 }], // Requiere 3 pero solo hay 1 disponible
        },
        mockClient
      );

      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.datos.estado, "BLOQUEANTE_DETECTADO");
      const stockIssue = parsed.datos.bloqueantes.find((b) => b.codigo === "STOCK_INSUFICIENTE");
      assert.ok(stockIssue);
      assert.match(stockIssue.descripcion, /solicitado 3, disponible 1/);
    });

    it("Caso 1: solo la referencia devuelve sin diagnóstico con datos faltantes sin afirmar falsedades", async () => {
      const mockClient = { country: "AR", get: async () => ({ Items: [] }) };

      const result = await diagnosticarOrden.handler(
        { referencia_externa: "FEN-10293" },
        mockClient
      );

      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.datos.estado, "SIN_DIAGNOSTICO_CON_INFORMACION_DISPONIBLE");
      assert.equal(parsed.datos.causas_detectadas.length, 0);
      assert.doesNotMatch(parsed.resumen, /se encuentran correctos/i);
      assert.ok(parsed.datos.datos_no_verificados.some((d) => d.includes("cliente")));
      assert.ok(parsed.datos.datos_no_verificados.some((d) => d.includes("SKUs")));
    });

    it("Caso 2: CUIL enviado, cliente RI, SKU inexistente, stock -955 sin reservas (sin falsos C11 ni C15)", async () => {
      const mockClient = {
        country: "AR",
        get: async (endpoint) => {
          if (endpoint === "/clientes/search") {
            return { Items: [{ Id: 10, NroDoc: "20123456786", RazonSocial: "Empresa RI", CondicionIva: "Responsable Inscripto" }] };
          }
          if (endpoint === "/conceptos/search") return { Items: [] }; // SKU inexistente
          if (endpoint === "/comprobantes/search") return { Items: [] };
          return null;
        },
      };

      const result = await diagnosticarOrden.handler(
        {
          referencia_externa: "ORD-TEST-2",
          tipo_documento_enviado: "CUIL",
          cliente: { cuit_o_dni: "20123456786", condicion_iva: "Responsable Inscripto" },
          items: [{ sku: "SKU-INEXISTENTE-99", cantidad: 1 }],
        },
        mockClient
      );

      const parsed = JSON.parse(result.content[0].text);
      // Prioridad: El error bloqueante de datos (SKU inexistente) manda sobre el contrato
      assert.equal(parsed.datos.estado, "BLOQUEANTE_DETECTADO");
      
      const codigos = parsed.datos.causas_detectadas.map((c) => c.codigo);
      assert.ok(codigos.includes("SKU_INEXISTENTE"));
      assert.ok(codigos.includes("TIPO_DOCUMENTO_INCOMPATIBLE_C9"));
      assert.equal(codigos.includes("DEF-C11"), false, "No debe disparar DEF-C11 porque el cliente ya era RI");
      assert.equal(codigos.includes("DEF-C15"), false, "No debe disparar DEF-C15 porque no hay reservas");
    });

    it("Caso 3: emitirFECobrada y condición 'Mercado Pago' (detecta C1 y C2)", async () => {
      const mockClient = {
        country: "AR",
        get: async (endpoint) => {
          if (endpoint === "/usuarios/condicionesVenta" || endpoint === "/opciones/condiciones-venta") {
            return [{ Id: 1, Nombre: "MercadoPago" }];
          }
          if (endpoint === "/comprobantes/search") return { Items: [] };
          return null;
        },
      };

      const result = await diagnosticarOrden.handler(
        {
          referencia_externa: "ORD-1084",
          endpoint_utilizado: "comprobantes/emitirFECobrada",
          condicion_venta: "Mercado Pago",
        },
        mockClient
      );

      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.datos.estado, "ERROR_CONTRATO_PARTNER");
      const codigos = parsed.datos.causas_detectadas.map((c) => c.codigo);
      assert.ok(codigos.includes("ENDPOINT_INCORRECTO_C1"));
      assert.ok(codigos.includes("CONDICION_VENTA_NO_COINCIDE_C2"));
      const c2 = parsed.datos.causas_detectadas.find((c) => c.codigo === "CONDICION_VENTA_NO_COINCIDE_C2");
      assert.match(c2.descripcion, /MercadoPago/);
    });

    it("Caso 4: 'Inexistente', nro con ID interno 28778 distinto de la referencia (detecta C5, no C6)", async () => {
      const mockClient = {
        country: "AR",
        get: async () => ({ Items: [] }),
      };

      const result = await diagnosticarOrden.handler(
        {
          referencia_externa: "ORD-EXT-99",
          nro: "28778",
          id_integracion_enviado: 28778,
          error_recibido: "La orden de venta es inexistente",
        },
        mockClient
      );

      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.datos.estado, "ERROR_CONTRATO_PARTNER");
      const codigos = parsed.datos.causas_detectadas.map((c) => c.codigo);
      assert.ok(codigos.includes("CONFUSION_PARAMETRO_NRO_C5"));
      assert.equal(codigos.includes("DEF-C6"), false, "No debe culpar a C6 si el error se explica por C5");
      assert.ok(!parsed.datos.causas_detectadas.some(c => c.descripcion.includes("la orden existe previamente")));
    });

    it("Caso 5: Código -3 con idIntegracion 25917 (detecta C12)", async () => {
      const mockClient = { country: "AR", get: async () => ({ Items: [] }) };

      const result = await diagnosticarOrden.handler(
        {
          referencia_externa: "PIROUT-1087",
          id_integracion_enviado: 25917,
          error_recibido: "-3",
        },
        mockClient
      );

      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.datos.estado, "ERROR_CONTRATO_PARTNER");
      const c12 = parsed.datos.causas_detectadas.find((c) => c.codigo === "TIPO_INTEGRACION_O_FECHA_INVALIDA_C12");
      assert.ok(c12);
    });

    it("Caso 6: CUIT inválido y depósito inexistente (999999) no inventa stock ni dispara C15", async () => {
      const mockClient = {
        country: "AR",
        get: async (endpoint) => {
          if (endpoint === "/inventarios/getDepositos") {
            return [{ Id: 3363, Nombre: "Depósito Principal", Activo: true }];
          }
          if (endpoint === "/comprobantes/search") return { Items: [] };
          return null;
        },
      };

      const result = await diagnosticarOrden.handler(
        {
          referencia_externa: "ORD-DEP-ERR",
          cliente: { cuit_o_dni: "20123456789" }, // Dígito verificador inválido
          deposito_id: 999999,
          items: [{ sku: "ZAP-01", cantidad: 1 }],
        },
        mockClient
      );

      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.datos.estado, "BLOQUEANTE_DETECTADO");
      const codigos = parsed.datos.causas_detectadas.map((c) => c.codigo);
      assert.ok(codigos.includes("CLIENTE_DOCUMENTO_INVALIDO"));
      assert.ok(codigos.includes("DEPOSITO_INEXISTENTE"));
      assert.equal(codigos.includes("DEF-C15"), false, "No debe inventar stock en depósito inexistente ni disparar C15");
    });

    it("Caso 7: API-1156 Hezka con CUIL enviado para cliente con CUIT verificado en base", async () => {
      const mockClient = {
        country: "AR",
        get: async (endpoint) => {
          if (endpoint === "/clientes/search") {
            return { Items: [{ Id: 10, NroDoc: "20123456786", RazonSocial: "Hezka Cliente RI", CondicionIva: "Responsable Inscripto" }] };
          }
          if (endpoint === "/comprobantes/search") return { Items: [] };
          return null;
        },
      };

      const result = await diagnosticarOrden.handler(
        {
          referencia_externa: "HEZ-1156",
          tipo_documento_enviado: "CUIL",
          cliente: { cuit_o_dni: "20123456786" },
        },
        mockClient
      );

      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.datos.estado, "ERROR_CONTRATO_PARTNER");
      const c9 = parsed.datos.causas_detectadas.find((c) => c.codigo === "TIPO_DOCUMENTO_INCOMPATIBLE_C9");
      assert.ok(c9);
      assert.match(c9.titulo, /Responsable Inscripto/);
      assert.match(c9.descripcion, /TipoDocumento: 'CUIL'/);
    });

    it("Caso 7b: CUIL enviado sin cliente previo en cuenta ni condición informada no afirma falsamente que es RI", async () => {
      const mockClient = {
        country: "AR",
        get: async () => ({ Items: [] }),
      };

      const result = await diagnosticarOrden.handler(
        {
          referencia_externa: "HEZ-1156-NUEVO",
          tipo_documento_enviado: "CUIL",
          cliente: { cuit_o_dni: "20123456786" },
        },
        mockClient
      );

      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.datos.estado, "ERROR_CONTRATO_PARTNER");
      const c9 = parsed.datos.causas_detectadas.find((c) => c.codigo === "TIPO_DOCUMENTO_INCOMPATIBLE_C9");
      assert.ok(c9);
      assert.equal(c9.titulo.includes("para cliente Responsable Inscripto"), false);
      assert.match(c9.titulo, /fuerza condición de Consumidor Final/);
    });

    it("Caso C8: orden facturada asíncronamente tras error 500 / timeout en emisión previa", async () => {
      const mockClient = {
        country: "AR",
        get: async (endpoint) => {
          if (endpoint === "/ordenesVenta/search") {
            return {
              Items: [
                {
                  ID: 44744305,
                  NumeroOrden: "ORD-500-OK",
                  IDComprobante: 95214075,
                  Estado: "Finalizada",
                  IDIntegracion: 27341,
                  Comprador: "EMPRESA EJEMPLO S.A.",
                  TipoDocumento: "CUIT",
                  NroDocumento: "30712345678",
                  Total: 14500,
                },
              ],
            };
          }
          if (endpoint === "/comprobantes/search") return { Items: [] };
          return null;
        },
      };

      const result = await diagnosticarOrden.handler(
        {
          referencia_externa: "ORD-500-OK",
          sintoma: "error_500",
          error_recibido: "500 Internal Server Error",
        },
        mockClient
      );

      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.datos.estado, "COMPROBANTE_YA_EMITIDO");
      assert.equal(parsed.datos.checks.comprobante_previo.encontrado, true);
      assert.equal(parsed.datos.checks.comprobante_previo.id, 95214075);
      const c8 = parsed.datos.causas_detectadas.find((c) => c.codigo === "ORDEN_YA_FACTURADA_ASINCRONA_C8");
      assert.ok(c8, "Debe detectar ORDEN_YA_FACTURADA_ASINCRONA_C8");
      assert.match(c8.descripcion, /95214075/);
      assert.match(parsed.resumen, /ya fue emitida previamente en Contabilium/);
    });

    it("Caso C3: orden con borrador vinculado tras rechazo previo de ARCA", async () => {
      const mockClient = {
        country: "AR",
        get: async (endpoint) => {
          if (endpoint === "/ordenesVenta/search") {
            return {
              Items: [
                {
                  ID: 44744306,
                  NumeroOrden: "ORD-ARCA-DRAFT",
                  IDComprobante: 88123,
                  Estado: "Pendiente",
                  IDIntegracion: 28778,
                },
              ],
            };
          }
          if (endpoint === "/comprobantes/search") {
            return {
              Items: [
                {
                  Id: 88123,
                  Numero: "Borrador-001",
                  TipoFc: "Factura B Borrador",
                  Estado: "Borrador",
                  Observaciones: "ORD-ARCA-DRAFT",
                  ErrorAFIP: "CUIT del comprador no registrado en AFIP",
                },
              ],
            };
          }
          return null;
        },
      };

      const result = await diagnosticarOrden.handler(
        {
          referencia_externa: "ORD-ARCA-DRAFT",
          error_recibido: "La orden de venta es inexistente",
        },
        mockClient
      );

      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.datos.estado, "BLOQUEANTE_DETECTADO");
      const c3 = parsed.datos.causas_detectadas.find((c) => c.codigo === "BORRADOR_HUERFANO_ARCA_C3");
      assert.ok(c3, "Debe detectar BORRADOR_HUERFANO_ARCA_C3");
      assert.match(c3.descripcion, /88123/);
      assert.match(c3.accion_recomendada, /Eliminar el borrador/);
    });

    it("Caso C7: orden cargada en otra integración (25917 vs 28778 enviada)", async () => {
      const mockClient = {
        country: "AR",
        get: async (endpoint) => {
          if (endpoint === "/ordenesVenta/search") {
            return {
              Items: [
                {
                  ID: 44744307,
                  NumeroOrden: "ORD-INT-OTRA",
                  IDIntegracion: 25917,
                  IDComprobante: 0,
                  Estado: "Pendiente",
                },
              ],
            };
          }
          if (endpoint === "/comprobantes/search") return { Items: [] };
          return null;
        },
      };

      const result = await diagnosticarOrden.handler(
        {
          referencia_externa: "ORD-INT-OTRA",
          id_integracion_enviado: 28778,
          error_recibido: "La orden de venta es inexistente",
        },
        mockClient
      );

      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.datos.estado, "ERROR_CONTRATO_PARTNER");
      const c7 = parsed.datos.causas_detectadas.find((c) => c.codigo === "ID_INTEGRACION_INCORRECTO_C7");
      assert.ok(c7, "Debe detectar ID_INTEGRACION_INCORRECTO_C7");
      assert.match(c7.descripcion, /25917/);
      assert.match(c7.descripcion, /28778/);
      assert.match(c7.accion_recomendada, /25917/);
      assert.ok(parsed.datos.evidencias.integraciones_consultadas.includes(25917));
    });

    it("Ronda 8: diagnosticar_orden con integración 28778 encuentra la orden, hidrata ítems y comprobante, y concluye C8 (orden ya facturada)", async () => {
      const mockClient = {
        country: "AR",
        get: async (endpoint, params) => {
          if (endpoint === "/ordenesVenta/search") {
            if (params?.IDIntegracion === 28778 && params?.filtro === "39104") {
              return {
                Items: [
                  {
                    ID: 44744308,
                    NumeroOrden: "39104",
                    IDVentaIntegracion: "39104",
                    Estado: "Finalizada",
                    IDComprobante: 182765963,
                    Origen: "Ecommerce",
                  },
                ],
              };
            }
            return { Items: [] };
          }
          if (endpoint === "/ordenesVenta" && params?.id === 44744308) {
            return {
              ID: 44744308,
              IDIntegracion: 28778,
              Items: [
                { Id: 1, Codigo: "HEZ-SKU-1", Concepto: "Calzado Deportivo", Cantidad: 1, PrecioUnitario: 25000 },
              ],
            };
          }
          if (endpoint === "/comprobantes" && params?.id === 182765963) {
            return {
              Id: 182765963,
              Numero: "B-0001-00018276",
              TipoFc: "Factura B",
              Total: 25000,
              IDIntegracion: 28778,
            };
          }
          if (endpoint === "/comprobantes/search") return { Items: [] };
          return null;
        },
      };

      const result = await diagnosticarOrden.handler(
        {
          referencia_externa: "39104",
          id_integracion_enviado: 28778,
          fecha_aproximada: "2026-09-30",
        },
        mockClient
      );

      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.datos.estado, "COMPROBANTE_YA_EMITIDO");
      assert.match(parsed.resumen, /ya está facturada.*182765963/i);
      assert.equal(parsed.datos.checks.comprobante_previo.encontrado, true);
      assert.equal(parsed.datos.checks.comprobante_previo.id, 182765963);
      assert.equal(parsed.datos.checks.comprobante_previo.numero, "B-0001-00018276");

      // Verificación de orden encontrada hidratada
      assert.equal(parsed.datos.evidencias.orden_encontrada.id_integracion, 28778);
      assert.equal(parsed.datos.evidencias.orden_encontrada.items_cantidad, 1);
      assert.equal(parsed.datos.evidencias.orden_encontrada.items[0].sku, "HEZ-SKU-1");

      // No debe advertir falsamente C7
      assert.doesNotMatch(parsed.advertencias.join(" "), /Causa C7/);
    });

    it("Ronda 8: diagnosticar_orden por referencia sin id_integracion busca a través de las integraciones activas de la cuenta", async () => {
      const mockClient = {
        country: "AR",
        get: async (endpoint, params) => {
          if (endpoint === "/comprobantes/search" && !params?.filtro) {
            return {
              Items: [{ Id: 100, IDIntegracion: 28778 }],
            };
          }
          if (endpoint === "/ordenesVenta/search") {
            if (params?.IDIntegracion === 28778 && params?.filtro === "39104") {
              return {
                Items: [
                  {
                    ID: 44744309,
                    NumeroOrden: "39104",
                    IDVentaIntegracion: "39104",
                    Estado: "Finalizada",
                    IDComprobante: 182765964,
                  },
                ],
              };
            }
            return { Items: [] };
          }
          if (endpoint === "/ordenesVenta" && params?.id === 44744309) {
            return {
              ID: 44744309,
              IDIntegracion: 28778,
              Items: [{ Codigo: "SKU-AUTO", Concepto: "Auto Item", Cantidad: 2, PrecioUnitario: 1000 }],
            };
          }
          if (endpoint === "/comprobantes/search") return { Items: [] };
          return null;
        },
      };

      const result = await diagnosticarOrden.handler(
        {
          referencia_externa: "39104",
          fecha_aproximada: "2026-09-30",
        },
        mockClient
      );

      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.datos.estado, "COMPROBANTE_YA_EMITIDO");
      assert.equal(parsed.datos.evidencias.orden_encontrada.id_integracion, 28778);
      assert.equal(parsed.datos.evidencias.orden_encontrada.items_cantidad, 1);
    });

    it("que_puedo_consultar expone el módulo de diagnóstico de integraciones", async () => {
      const mockClient = {
        ambiente: "Producción",
        get: async () => null,
      };

      const res = await quePuedoConsultar.handler({ categoria: "diagnostico" }, mockClient);
      const parsed = JSON.parse(res.content[0].text);

      assert.equal(parsed.datos.modulos.length, 1);
      assert.equal(parsed.datos.modulos[0].nombre, "Diagnóstico de Órdenes e Integraciones E-Commerce (OP-08)");
      assert.ok(parsed.datos.modulos[0].tools.includes("diagnosticar_orden"));
    });
  });

  describe("buscar_ordenes_venta (Mapeo de Integraciones, Facturación y Filtro sin Integración)", () => {
    it("mapea exhaustivamente IDVentaIntegracion, IDIntegracion, cliente, IDComprobante e ítems", async () => {
      const mockClient = {
        get: async (endpoint) => {
          if (endpoint === "/ordenesVenta/search") {
            return {
              TotalItems: 1,
              TotalPage: 1,
              Items: [
                {
                  ID: 44744305,
                  IDPersona: 46182871,
                  IDComprobante: 95214075,
                  FechaCreacion: "01/10/2026",
                  Total: "14.500,00",
                  Comprador: "EMPRESA EJEMPLO S.A.",
                  NumeroOrden: "FEN-10293",
                  Estado: "Finalizada",
                  Integracion: "Fenicio",
                  IDIntegracion: 27341,
                  TipoDocumento: "CUIT",
                  NroDocumento: "30712345678",
                  Items: [
                    {
                      Id: 1,
                      Codigo: "SKU-001",
                      Concepto: "PRODUCTO DESTACADO",
                      Cantidad: 2,
                      PrecioUnitario: "5.000,00",
                    },
                  ],
                },
              ],
            };
          }
          return null;
        },
      };

      const result = await buscarOrdenesVenta.handler(
        { fecha_desde: "2026-09-01", fecha_hasta: "2026-10-01" },
        mockClient
      );

      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.datos.ordenes.length, 1);
      const ord = parsed.datos.ordenes[0];

      assert.equal(ord.id, 44744305);
      assert.equal(ord.numero_orden, "FEN-10293");
      assert.equal(ord.id_venta_integracion, "FEN-10293");
      assert.equal(ord.id_integracion, 27341);
      assert.equal(ord.id_comprobante, 95214075);
      assert.equal(ord.facturada, true);
      assert.equal(ord.estado, "Finalizada");

      // Cliente mapeado
      assert.ok(ord.cliente);
      assert.equal(ord.cliente.nombre, "EMPRESA EJEMPLO S.A.");
      assert.equal(ord.cliente.tipo_documento, "CUIT");
      assert.equal(ord.cliente.documento, "30712345678");

      // Ítems mapeados
      assert.equal(ord.items_cantidad, 1);
      assert.equal(ord.items[0].sku, "SKU-001");
      assert.equal(ord.items[0].nombre, "PRODUCTO DESTACADO");
      assert.equal(ord.items[0].cantidad, 2);
      assert.equal(ord.items[0].precio, 5000);

      // Resumen informa Facturadas 1/1
      assert.match(parsed.resumen, /Facturadas: 1\/1/);
    });

    it("no informa 'Facturadas: 0/50' si la respuesta del API carece de campos de facturación", async () => {
      const mockClient = {
        get: async () => ({
          TotalItems: 2,
          TotalPage: 1,
          Items: [
            { ID: 1, NumeroOrden: "ORD-01", Total: 100 },
            { ID: 2, NumeroOrden: "ORD-02", Total: 200 },
          ],
        }),
      };

      const result = await buscarOrdenesVenta.handler(
        { fecha_desde: "2026-09-01", fecha_hasta: "2026-10-01" },
        mockClient
      );

      const parsed = JSON.parse(result.content[0].text);
      assert.doesNotMatch(parsed.resumen, /Facturadas: 0\/2/);
      assert.match(parsed.resumen, /Estado de facturación no disponible en el listado/);
    });

    it("la búsqueda por referencia funciona sin parámetro id_integracion", async () => {
      const mockClient = {
        get: async (endpoint, params) => {
          assert.equal(params.IDIntegracion, undefined, "No debe forzar IDIntegracion si no se envió");
          return {
            TotalItems: 2,
            TotalPage: 1,
            Items: [
              { ID: 1, NumeroOrden: "FEN-10293", IDIntegracion: 25917, Total: 500, Estado: "Pendiente" },
              { ID: 2, NumeroOrden: "WOO-99999", IDIntegracion: 28778, Total: 800, Estado: "Pendiente" },
            ],
          };
        },
      };

      const result = await buscarOrdenesVenta.handler(
        { fecha_desde: "2026-09-01", fecha_hasta: "2026-10-01", filtro: "FEN-10293" },
        mockClient
      );

      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.datos.ordenes.length, 1);
      assert.equal(parsed.datos.ordenes[0].numero_orden, "FEN-10293");
      assert.equal(parsed.datos.ordenes[0].id_integracion, 25917);
    });

    it("Ronda 8: buscar_ordenes_venta hidrata items e id_integracion desde /ordenesVenta detail", async () => {
      const mockClient = {
        get: async (endpoint, params) => {
          if (endpoint === "/ordenesVenta/search") {
            return {
              TotalItems: 1,
              TotalPage: 1,
              Items: [
                {
                  ID: 44744310,
                  NumeroOrden: "39104",
                  IDVentaIntegracion: "39104",
                  Estado: "Finalizada",
                  IDComprobante: 182765963,
                  Origen: "Ecommerce",
                  Items: [], // Vacío en búsqueda inicial de listado
                },
              ],
            };
          }
          if (endpoint === "/ordenesVenta" && params?.id === 44744310) {
            return {
              ID: 44744310,
              IDIntegracion: 28778,
              Items: [
                { Id: 99, Codigo: "HEZ-DET-1", Concepto: "Item Detallado", Cantidad: 3, PrecioUnitario: 1500 },
              ],
            };
          }
          return null;
        },
      };

      const result = await buscarOrdenesVenta.handler(
        { fecha_desde: "2026-09-01", fecha_hasta: "2026-10-01", id_integracion: 28778, filtro: "39104" },
        mockClient
      );

      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.datos.ordenes.length, 1);
      const ord = parsed.datos.ordenes[0];
      assert.equal(ord.id_integracion, 28778);
      assert.equal(ord.items_cantidad, 1);
      assert.equal(ord.items[0].sku, "HEZ-DET-1");
      assert.equal(ord.items[0].nombre, "Item Detallado");
    });
  });

  describe("Paginación por Tramos y Blindaje contra Cotizaciones en Alto Volumen (MEJ-17)", () => {
    it("chunkedDateGet particiona rangos > 7 días en tramos de 7 días y concatena registros", async () => {
      const client = new ContabiliumClient();
      const llamadas = [];

      // Interceptar paginatedGet para verificar los tramos generados
      client.paginatedGet = async (endpoint, params, maxPages) => {
        llamadas.push({ endpoint, fechaDesde: params.fechaDesde, fechaHasta: params.fechaHasta, maxPages });
        return {
          items: [
            { Id: llamadas.length, FechaEmision: `${params.fechaDesde}T10:00:00`, TipoFc: "FCA", Total: 1000 },
          ],
          truncado: false,
          paginasLeidas: 1,
          totalRegistros: 1,
        };
      };

      const res = await client.chunkedDateGet("/comprobantes/search", {}, "2026-09-01", "2026-09-30", {
        chunkDays: 7,
        maxPagesPerChunk: 15,
        maxTotalPages: 50,
      });

      // 30 días con chunks de 7 días genera 5 tramos:
      // 1: 01 al 07 (7 días)
      // 2: 08 al 14 (7 días)
      // 3: 15 al 21 (7 días)
      // 4: 22 al 28 (7 días)
      // 5: 29 al 30 (2 días)
      assert.equal(llamadas.length, 5);
      assert.equal(llamadas[0].fechaDesde, "2026-09-01");
      assert.equal(llamadas[0].fechaHasta, "2026-09-07");
      assert.equal(llamadas[1].fechaDesde, "2026-09-08");
      assert.equal(llamadas[1].fechaHasta, "2026-09-14");
      assert.equal(llamadas[4].fechaDesde, "2026-09-29");
      assert.equal(llamadas[4].fechaHasta, "2026-09-30");

      assert.equal(res.items.length, 5);
      assert.equal(res.truncado, false);
      assert.equal(res.paginasLeidas, 5);
    });

    it("resumen_ventas procesa 30 días sin truncamiento usando chunkedDateGet", async () => {
      // Simula el escenario crítico de automation_restv1_ar_RI:
      // Cuenta con 75% cotizaciones que con paginación tradicional truncaba en el día 16
      const mockClient = {
        chunkedDateGet: async (endpoint, params, desde, hasta) => {
          // Devuelve comprobantes de los días 01 al 30 sin truncar
          const items = [
            { Id: 1, TipoFc: "COT", Total: 500, FechaEmision: "2026-09-05", RazonSocial: "Cliente 1" },
            { Id: 2, TipoFc: "FCA", Total: 10000, FechaEmision: "2026-09-05", RazonSocial: "Cliente 1" },
            { Id: 3, TipoFc: "COT", Total: 500, FechaEmision: "2026-09-20", RazonSocial: "Cliente 2" },
            { Id: 4, TipoFc: "FCB", Total: 15000, FechaEmision: "2026-09-20", RazonSocial: "Cliente 2" },
            { Id: 5, TipoFc: "FCA", Total: 20000, FechaEmision: "2026-09-29", RazonSocial: "Cliente 3" },
          ];
          return { items, truncado: false, paginasLeidas: 5, totalRegistros: 5 };
        },
      };

      const result = await resumenVentas.handler(
        { fecha_desde: "2026-09-01", fecha_hasta: "2026-09-30", agrupar_por: "mes" },
        mockClient
      );

      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.truncado, false);
      assert.equal(parsed.datos.totales_generales.cotizaciones_excluidas, 2);
      assert.equal(parsed.datos.totales_generales.cantidad_facturas, 3);
      assert.equal(parsed.datos.totales_generales.total_neto, 45000);
      assert.match(parsed.resumen, /Ventas netas del período: \$ 45\.000,00/);
    });
  });

  describe("Resolución de Nombres Comerciales de Productos (BUG-04)", () => {
    it("stock_por_deposito resuelve nombres comerciales desde /conceptos/search cuando el inventario solo devuelve SKU", async () => {
      const mockClient = {
        get: async (endpoint, params) => {
          if (endpoint === "/inventarios/getDepositos") {
            return [{ Id: 1, Nombre: "CENTRAL", Activo: true }];
          }
          if (endpoint === "/conceptos/search") {
            if (params?.filtro === "CB-1767810439004-742581") {
              return {
                Items: [
                  { Codigo: "CB-1767810439004-742581", Nombre: "COMBO QA", Concepto: "COMBO QA" },
                ],
              };
            }
          }
          return null;
        },
        paginatedGet: async (endpoint) => {
          if (endpoint === "/inventarios/getStockByDeposito") {
            return {
              items: [
                { Codigo: "CB-1767810439004-742581", StockActual: 15, StockReservado: 0 },
              ],
              truncado: false,
              paginasLeidas: 1,
              totalRegistros: 1,
            };
          }
          return { items: [], truncado: false, paginasLeidas: 0, totalRegistros: 0 };
        },
      };

      const result = await stockPorDeposito.handler(
        { deposito_id: 1, top: 10 },
        mockClient
      );

      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.datos.length, 1);
      assert.equal(parsed.datos[0].codigo, "CB-1767810439004-742581");
      // Resuelto exitosamente a su nombre comercial en lugar de quedar como el código SKU en bruto
      assert.equal(parsed.datos[0].producto, "COMBO QA");
      assert.equal(parsed.datos[0].disponible, 15);
    });
  });

  describe("modificar_concepto (Edición y Actualización de Conceptos)", () => {
    it("modifica precio de un concepto por ID y calcula automáticamente precio_final con IVA", async () => {
      let putLlamado = null;
      const mockConcepto = {
        Id: 10535931,
        Nombre: "ZAPATILLAS RUNNING",
        Codigo: "SKU-ZAP-01",
        Tipo: "Producto",
        Estado: "Activo",
        Precio: 10000,
        PrecioFinal: 12100,
        Iva: 21,
        CostoInterno: 6000,
        Rentabilidad: 40,
        Stock: 50,
        StockMinimo: 5,
        IdRubro: "12",
      };

      const mockClient = {
        clientId: "empresa@test.com",
        cache: new Map([["/conceptos/search?filtro=zap", { test: 1 }]]),
        get: async (endpoint, params) => {
          if (endpoint === "/conceptos" && params?.id === 10535931) {
            return mockConcepto;
          }
          return null;
        },
        put: async (endpoint, body) => {
          putLlamado = { endpoint, body };
          return { ok: true };
        },
      };

      const res = await modificarConcepto.handler(
        { id: 10535931, precio: 15000 },
        mockClient
      );

      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.datos.id, 10535931);
      assert.equal(parsed.datos.precio, 15000);
      assert.equal(parsed.datos.precio_final, 18150); // 15000 * 1.21
      assert.equal(putLlamado.endpoint, "/conceptos?id=10535931");
      assert.equal(putLlamado.body.Precio, 15000);
      assert.equal(putLlamado.body.PrecioFinal, 18150);
      // Tipo y Estado normalizados a formato backend Contabilium
      assert.equal(putLlamado.body.Tipo, "P");
      assert.equal(putLlamado.body.Estado, "A");
      // Mantiene campos no modificados
      assert.equal(putLlamado.body.Nombre, "ZAPATILLAS RUNNING");
      assert.equal(putLlamado.body.Codigo, "SKU-ZAP-01");
      assert.equal(putLlamado.body.CostoInterno, 6000);
      // Invalida caché de conceptos
      assert.equal(mockClient.cache.size, 0);
    });

    it("modifica concepto por SKU (codigo), actualiza nombre, costo interno y desactiva estado", async () => {
      let putLlamado = null;
      const mockConcepto = {
        Id: 4400,
        Nombre: "REMERON OVERSIZE",
        Codigo: "REM-OVER-01",
        Tipo: "P",
        Estado: "A",
        Precio: 8000,
        PrecioFinal: 9680,
        Iva: 21,
        CostoInterno: 4000,
      };

      const mockClient = {
        clientId: "empresa@test.com",
        get: async (endpoint, params) => {
          if (endpoint === "/conceptos/getByCodigo" && params?.codigo === "REM-OVER-01") {
            return mockConcepto;
          }
          return null;
        },
        put: async (endpoint, body) => {
          putLlamado = { endpoint, body };
          return { ok: true };
        },
      };

      const res = await modificarConcepto.handler(
        {
          codigo: "REM-OVER-01",
          nombre: "REMERON OVERSIZE VERANO",
          costo_interno: 4500,
          estado: "Inactivo",
        },
        mockClient
      );

      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.datos.nombre, "REMERON OVERSIZE VERANO");
      assert.equal(parsed.datos.costo_interno, 4500);
      assert.equal(parsed.datos.estado, "Inactivo");
      assert.equal(putLlamado.body.Estado, "I");
      assert.equal(putLlamado.body.Nombre, "REMERON OVERSIZE VERANO");
      assert.equal(putLlamado.body.CostoInterno, 4500);
      assert.equal(putLlamado.body.Precio, 8000); // preservado
    });

    it("falla con mensaje descriptivo si no se envía ni id ni codigo", async () => {
      const mockClient = { clientId: "test@test.com" };
      await assert.rejects(
        async () => {
          await modificarConcepto.handler({ nombre: "Nuevo" }, mockClient);
        },
        /Debe especificar el 'id' numérico o el 'codigo'/
      );
    });

    it("falla con mensaje amigable si el concepto no existe en Contabilium", async () => {
      const mockClient = {
        clientId: "test@test.com",
        get: async () => null,
      };
      await assert.rejects(
        async () => {
          await modificarConcepto.handler({ codigo: "SKU-INEXISTENTE", precio: 100 }, mockClient);
        },
        /No se encontró ningún concepto in Contabilium|No se encontró ningún concepto en Contabilium con código SKU 'SKU-INEXISTENTE'/
      );
    });

    it("retorna mensaje sin cambios si los valores enviados coinciden con los registrados", async () => {
      let putEjecutado = false;
      const mockConcepto = {
        Id: 50,
        Nombre: "MOUSE INALAMBRICO",
        Codigo: "MOUSE-01",
        Tipo: "P",
        Estado: "A",
        Precio: 2000,
        Iva: 21,
      };

      const mockClient = {
        get: async () => mockConcepto,
        put: async () => {
          putEjecutado = true;
        },
      };

      const res = await modificarConcepto.handler(
        { id: 50, nombre: "MOUSE INALAMBRICO", precio: 2000 },
        mockClient
      );

      const parsed = JSON.parse(res.content[0].text);
      assert.match(parsed.resumen, /No se realizaron cambios/);
      assert.equal(putEjecutado, false);
    });

    it("respeta el control de acceso por cuenta cuando se define lista blanca", async () => {
      const prevEnv = process.env.MODIFICAR_CONCEPTO_ALLOWED_ACCOUNTS;
      try {
        process.env.MODIFICAR_CONCEPTO_ALLOWED_ACCOUNTS = "permitida@test.com,otra@test.com";

        // Cuenta no autorizada
        const clientNoAuth = { clientId: "bloqueada@test.com" };
        await assert.rejects(
          async () => {
            await modificarConcepto.handler({ id: 1, precio: 10 }, clientNoAuth);
          },
          /no tiene permisos habilitados para modificar conceptos/
        );

        // Cuenta autorizada
        const clientAuth = {
          clientId: "permitida@test.com",
          get: async () => ({ Id: 1, Codigo: "SKU-1", Nombre: "Prod 1", Tipo: "P", Estado: "A", Precio: 5, Iva: 21 }),
          put: async () => ({ ok: true }),
        };
        const res = await modificarConcepto.handler({ id: 1, precio: 10 }, clientAuth);
        const parsed = JSON.parse(res.content[0].text);
        assert.equal(parsed.datos.precio, 10);
      } finally {
        if (prevEnv !== undefined) {
          process.env.MODIFICAR_CONCEPTO_ALLOWED_ACCOUNTS = prevEnv;
        } else {
          delete process.env.MODIFICAR_CONCEPTO_ALLOWED_ACCOUNTS;
        }
      }
    });
  });

  describe("modificar_stock_concepto (Reemplazo y Modificación de Stock por SKU o ID)", () => {
    it("reemplaza stock de un producto por SKU con depósito y precio unitario opcional", async () => {
      let postLlamado = null;
      const mockConcepto = {
        Id: 201,
        Codigo: "SKU-PELOTA-01",
        Nombre: "PELOTA DE FUTBOL",
        Tipo: "P",
        Estado: "A",
      };

      const mockClient = {
        clientId: "empresa@test.com",
        cache: new Map([["/inventarios/getStockBySKU?codigo=SKU-PELOTA-01", { dummy: 1 }]]),
        get: async (endpoint, params) => {
          if (endpoint === "/conceptos/getByCodigo" && params?.codigo === "SKU-PELOTA-01") {
            return mockConcepto;
          }
          if (endpoint === "/inventarios/getDepositos") {
            return [
              { Id: 1, Nombre: "Depósito Central", Activo: true },
              { Id: 2, Nombre: "Depósito Sucursal", Activo: true },
            ];
          }
          if (endpoint === "/inventarios/getStockBySKU" && params?.codigo === "SKU-PELOTA-01") {
            return {
              stock: [
                { Id: 2, StockActual: 8, StockReservado: 0 },
              ],
            };
          }
          return null;
        },
        post: async (endpoint, body, params) => {
          postLlamado = { endpoint, body, params };
          return { ok: true };
        },
      };

      const res = await modificarStockConcepto.handler(
        {
          codigo: "SKU-PELOTA-01",
          cantidad: 30,
          id_deposito: 2,
          precio_unitario: 12000,
        },
        mockClient
      );

      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.datos.codigo, "SKU-PELOTA-01");
      assert.equal(parsed.datos.id_deposito, 2);
      assert.equal(parsed.datos.deposito, "Depósito Sucursal");
      assert.equal(parsed.datos.stock_anterior, 8);
      assert.equal(parsed.datos.stock_nuevo, 30);
      assert.equal(parsed.datos.diferencia, 22);
      assert.equal(parsed.datos.precio_unitario, 12000);

      assert.equal(postLlamado.endpoint, "/inventarios/actualizar");
      assert.equal(postLlamado.params.Codigo, "SKU-PELOTA-01");
      assert.equal(postLlamado.params.Cantidad, 30);
      assert.equal(postLlamado.params.IDDeposito, 2);
      assert.equal(postLlamado.params.PrecioUnitario, 12000);
      // Invalida caché
      assert.equal(mockClient.cache.size, 0);
    });

    it("reemplaza stock de un producto por ID resolviendo depósito activo por defecto", async () => {
      let postLlamado = null;
      const mockConcepto = {
        Id: 505,
        Codigo: "SKU-GUANTES-01",
        Nombre: "GUANTES DE ARQUERO",
        Tipo: "P",
        Estado: "A",
      };

      const mockClient = {
        clientId: "empresa@test.com",
        get: async (endpoint, params) => {
          if (endpoint === "/conceptos" && params?.id === 505) {
            return mockConcepto;
          }
          if (endpoint === "/inventarios/getDepositos") {
            return [
              { Id: 10, Nombre: "Depósito Mayorista", Activo: true },
            ];
          }
          if (endpoint === "/inventarios/getStockBySKU") {
            return {
              stock: [
                { Id: 10, StockActual: 15, StockReservado: 2 },
              ],
            };
          }
          return null;
        },
        post: async (endpoint, body, params) => {
          postLlamado = { endpoint, body, params };
          return { ok: true };
        },
      };

      const res = await modificarStockConcepto.handler(
        {
          id: 505,
          cantidad: 5,
        },
        mockClient
      );

      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.datos.id, 505);
      assert.equal(parsed.datos.codigo, "SKU-GUANTES-01");
      assert.equal(parsed.datos.id_deposito, 10);
      assert.equal(parsed.datos.deposito, "Depósito Mayorista");
      assert.equal(parsed.datos.stock_anterior, 15);
      assert.equal(parsed.datos.stock_nuevo, 5);
      assert.equal(parsed.datos.diferencia, -10);

      // Usa endpoint actualizar con Codigo resuelto
      assert.equal(postLlamado.endpoint, "/inventarios/actualizar");
      assert.equal(postLlamado.params.Codigo, "SKU-GUANTES-01");
      assert.equal(postLlamado.params.Cantidad, 5);
      assert.equal(postLlamado.params.IDDeposito, 10);
    });

    it("falla con mensaje descriptivo si no se envía ni codigo ni id", async () => {
      const mockClient = { clientId: "test@test.com" };
      await assert.rejects(
        async () => {
          await modificarStockConcepto.handler({ cantidad: 10 }, mockClient);
        },
        /Debe especificar el 'codigo' \(SKU\) o el 'id' numérico/
      );
    });

    it("falla con mensaje amigable si el producto no existe en Contabilium", async () => {
      const mockClient = {
        clientId: "test@test.com",
        get: async () => null,
      };
      await assert.rejects(
        async () => {
          await modificarStockConcepto.handler({ codigo: "SKU-FANTASMA", cantidad: 10 }, mockClient);
        },
        /No se encontró ningún producto con código SKU 'SKU-FANTASMA'/
      );
    });

    it("respeta el control de acceso por cuenta cuando se define lista blanca", async () => {
      const prevEnv = process.env.MODIFICAR_STOCK_ALLOWED_ACCOUNTS;
      try {
        process.env.MODIFICAR_STOCK_ALLOWED_ACCOUNTS = "autorizada@empresa.com";

        // Cuenta no autorizada
        const clientNoAuth = { clientId: "otra@empresa.com" };
        await assert.rejects(
          async () => {
            await modificarStockConcepto.handler({ id: 10, cantidad: 5 }, clientNoAuth);
          },
          /no tiene permisos habilitados para modificar el stock de conceptos/
        );

        // Cuenta autorizada
        const clientAuth = {
          clientId: "autorizada@empresa.com",
          get: async (endpoint) => {
            if (endpoint === "/conceptos") return { Id: 10, Codigo: "SKU-10", Nombre: "Prod 10" };
            if (endpoint === "/inventarios/getDepositos") return [{ Id: 1, Nombre: "Central", Activo: true }];
            return null;
          },
          post: async () => ({ ok: true }),
        };
        const res = await modificarStockConcepto.handler({ id: 10, cantidad: 5 }, clientAuth);
        const parsed = JSON.parse(res.content[0].text);
        assert.equal(parsed.datos.stock_nuevo, 5);
      } finally {
        if (prevEnv !== undefined) {
          process.env.MODIFICAR_STOCK_ALLOWED_ACCOUNTS = prevEnv;
        } else {
          delete process.env.MODIFICAR_STOCK_ALLOWED_ACCOUNTS;
        }
      }
    });
  });

  describe("enviar_venta (Envío y actualización de órdenes de venta e-commerce vía /notificador/ecommerce)", () => {
    it("envía una orden de venta completa, normaliza condición de venta, agrega costo_envio y descuento_general e invalida caché", async () => {
      let postLlamado = null;
      const mockClient = {
        clientId: "tienda@empresa.com",
        country: "AR",
        cache: new Map([["/ordenesVenta/search?page=1", { dummy: 1 }]]),
        get: async (endpoint) => {
          if (endpoint === "/usuarios/condicionesVenta") {
            return [{ Nombre: "MercadoPago" }, { Nombre: "Contado" }];
          }
          return [];
        },
        post: async (endpoint, body) => {
          postLlamado = { endpoint, body };
          return "48834596";
        },
      };

      const res = await enviarVenta.handler(
        {
          id_venta_integracion: "FEN-10500",
          id_integracion: 27341,
          estado_integracion: "Aceptado",
          condicion_venta: "mercado pago", // Con espacio y minúsculas -> debe normalizarse a 'MercadoPago'
          fecha_emision: "2026-10-20",
          observaciones: "Pedido web #10500",
          cliente: {
            nombre: "Juan",
            apellido: "Pérez",
            documento: "20-12345678-6", // 11 dígitos -> infiere CUIT
            email: "juan@ejemplo.com",
            telefono: "1122334455",
            direccion: "Av. Corrientes 1234",
            ciudad: "CABA",
            provincia: "Buenos Aires",
            codigo_postal: "1043",
          },
          items: [
            {
              codigo: "420",
              concepto: "Producto de ejemplo",
              cantidad: 2,
              precio_unitario: 15000,
              bonificacion: 0,
              iva: 21,
            },
          ],
          costo_envio: 1500,
          descuento_general: 1000,
        },
        mockClient
      );

      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.datos.id_orden, 48834596);
      assert.equal(parsed.datos.id_venta_integracion, "FEN-10500");
      assert.equal(parsed.datos.id_integracion, 27341);
      assert.equal(parsed.datos.condicion_venta, "MercadoPago");
      assert.equal(parsed.datos.cliente.tipo_documento, "CUIT");
      assert.equal(parsed.datos.cliente.documento, "20123456786");
      assert.equal(parsed.datos.items_cantidad, 3);
      assert.equal(parsed.datos.total_estimado, 30500); // (2 * 15000) + 1500 - 1000

      assert.equal(postLlamado.endpoint, "/notificador/ecommerce");
      assert.equal(postLlamado.body.IDVentaIntegracion, "FEN-10500");
      assert.equal(postLlamado.body.IDIntegracion, 27341);
      assert.equal(postLlamado.body.CondicionVenta, "MercadoPago");
      assert.equal(postLlamado.body.Items.length, 3);
      assert.equal(postLlamado.body.Items[1].Codigo, "CDE");
      assert.equal(postLlamado.body.Items[1].Concepto, "Envío");
      assert.equal(postLlamado.body.Items[2].Concepto, "Descuento general");
      assert.equal(postLlamado.body.Items[2].PrecioUnitario, -1000);
      assert.equal(mockClient.cache.size, 0);
    });

    it("normaliza automáticamente la frase reservada 'Costo de envío' a 'Envío'", async () => {
      let postBody = null;
      const mockClient = {
        country: "AR",
        get: async () => [],
        post: async (_ep, body) => {
          postBody = body;
          return 99001;
        },
      };

      const res = await enviarVenta.handler(
        {
          id_venta_integracion: 88,
          id_integracion: 100,
          cliente: { nombre: "Maria", apellido: "Gomez", documento: "35123456" },
          items: [
            { codigo: "P1", concepto: "Remera", cantidad: 1, precio_unitario: 10000 },
            { codigo: "CDE", concepto: "Costo de envío", cantidad: 1, precio_unitario: 500 },
          ],
        },
        mockClient
      );

      const parsed = JSON.parse(res.content[0].text);
      assert.equal(postBody.Items[1].Concepto, "Envío");
      assert.ok(parsed.advertencias.some((a) => a.includes("frase reservada")));
    });

    it("lanza error descriptivo cuando /notificador/ecommerce devuelve código -3 o -1", async () => {
      const mockClientErr3 = {
        get: async () => [],
        post: async () => "-3",
      };

      await assert.rejects(
        async () => {
          await enviarVenta.handler(
            {
              id_venta_integracion: 1,
              id_integracion: 999999,
              cliente: { nombre: "Test" },
              items: [{ codigo: "1", concepto: "Item", cantidad: 1, precio_unitario: 100 }],
            },
            mockClientErr3
          );
        },
        /Código -3.*IDIntegracion/
      );

      const mockClientErr1 = {
        get: async () => [],
        post: async () => -1,
      };

      await assert.rejects(
        async () => {
          await enviarVenta.handler(
            {
              id_venta_integracion: 1,
              id_integracion: 27341,
              cliente: { nombre: "Test" },
              items: [{ codigo: "1", concepto: "Item", cantidad: 1, precio_unitario: 100 }],
            },
            mockClientErr1
          );
        },
        /Código -1/
      );
    });

    it("autodetecta id_integracion cuando la cuenta tiene una única integración activa", async () => {
      let postBody = null;
      const mockClient = {
        _knownIntegrations: new Set([27341]),
        get: async () => [],
        post: async (_ep, body) => {
          postBody = body;
          return 55555;
        },
      };

      const res = await enviarVenta.handler(
        {
          id_venta_integracion: "AUTO-1",
          cliente: { nombre: "Carlos" },
          items: [{ codigo: "SKU1", concepto: "Prod 1", cantidad: 1, precio_unitario: 5000 }],
        },
        mockClient
      );

      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.datos.id_integracion, 27341);
      assert.equal(postBody.IDIntegracion, 27341);
      assert.equal(postBody.IDInventario, undefined);
      assert.equal(parsed.datos.deposito.origen, "configuracion_integracion");
    });

    it("resuelve el depósito por nombre (deposito: 'Secundario') e inyecta IDInventario en el payload", async () => {
      let postBody = null;
      const mockClient = {
        get: async (endpoint) => {
          if (endpoint === "/inventarios/getDepositos") {
            return [
              { Id: 31293, Nombre: "Depósito Principal", Activo: true },
              { Id: 40549, Nombre: "Depósito Secundario Norte", Activo: true },
            ];
          }
          return [];
        },
        post: async (_ep, body) => {
          postBody = body;
          return 77701;
        },
      };

      const res = await enviarVenta.handler(
        {
          id_venta_integracion: "ORD-DEP-1",
          id_integracion: 27341,
          deposito: "secundario", // Búsqueda parcial sin tildes/mayúsculas
          cliente: { nombre: "Lucía" },
          items: [{ codigo: "SKU-A", concepto: "Producto A", cantidad: 1, precio_unitario: 12000 }],
        },
        mockClient
      );

      const parsed = JSON.parse(res.content[0].text);
      assert.equal(postBody.IDInventario, 40549);
      assert.equal(parsed.datos.deposito.id, 40549);
      assert.equal(parsed.datos.deposito.nombre, "Depósito Secundario Norte");
      assert.equal(parsed.datos.deposito.origen, "indicado_en_orden");
    });

    it("falla con mensaje claro listando los depósitos disponibles si el nombre de depósito no existe", async () => {
      const mockClient = {
        get: async (endpoint) => {
          if (endpoint === "/inventarios/getDepositos") {
            return [
              { Id: 31293, Nombre: "Principal", Activo: true },
              { Id: 40549, Nombre: "Sucursal Sur", Activo: true },
            ];
          }
          return [];
        },
        post: async () => 1,
      };

      await assert.rejects(
        async () => {
          await enviarVenta.handler(
            {
              id_venta_integracion: "ORD-DEP-ERR",
              id_integracion: 27341,
              deposito: "Deposito Fantasma",
              cliente: { nombre: "Lucía" },
              items: [{ codigo: "SKU-A", concepto: "Producto A", cantidad: 1, precio_unitario: 12000 }],
            },
            mockClient
          );
        },
        /No se encontró ningún depósito en la cuenta que coincida con 'Deposito Fantasma'\. Depósitos disponibles: 'Principal' \(ID 31293\), 'Sucursal Sur' \(ID 40549\)/
      );
    });

    it("respeta el control de acceso por cuenta cuando se configura ENVIAR_VENTA_ALLOWED_ACCOUNTS", async () => {
      const prevEnv = process.env.ENVIAR_VENTA_ALLOWED_ACCOUNTS;
      try {
        process.env.ENVIAR_VENTA_ALLOWED_ACCOUNTS = "autorizada@empresa.com";

        const clientNoAuth = { clientId: "bloqueada@empresa.com" };
        await assert.rejects(
          async () => {
            await enviarVenta.handler(
              {
                id_venta_integracion: 10,
                id_integracion: 1,
                cliente: { nombre: "Test" },
                items: [{ codigo: "1", concepto: "Item", cantidad: 1, precio_unitario: 100 }],
              },
              clientNoAuth
            );
          },
          /no tiene permisos habilitados para enviar órdenes de venta/
        );
      } finally {
        if (prevEnv !== undefined) {
          process.env.ENVIAR_VENTA_ALLOWED_ACCOUNTS = prevEnv;
        } else {
          delete process.env.ENVIAR_VENTA_ALLOWED_ACCOUNTS;
        }
      }
    });

    it("que_puedo_consultar explica cómo funciona enviar_venta y qué parámetros espera cuando se consulta por la tool", async () => {
      const mockClient = {
        ambiente: "QA / Pruebas",
        get: async (path) => {
          if (path === "/usuarios/obtenerinfo") {
            return { RazonSocial: "Demo S.A.", CUIT: "30712345678" };
          }
          if (path === "/inventarios/getDepositos") {
            return [
              { Id: 31293, Nombre: "Depósito Central", Activo: true },
              { Id: 40549, Nombre: "Sucursal Norte", Activo: true },
            ];
          }
          return null;
        },
      };

      const res = await quePuedoConsultar.handler({ tool: "enviar_venta" }, mockClient);
      const parsed = JSON.parse(res.content[0].text);

      assert.ok(parsed.datos.detalle_tool_consultada);
      assert.equal(parsed.datos.detalle_tool_consultada.nombre, "enviar_venta");
      assert.ok(Array.isArray(parsed.datos.detalle_tool_consultada.como_funciona));
      assert.ok(
        parsed.datos.detalle_tool_consultada.como_funciona.some((line) =>
          line.includes("IDInventario") && line.includes("deposito")
        )
      );
      assert.ok(parsed.datos.detalle_tool_consultada.que_espera.parametros_obligatorios.id_venta_integracion);
      assert.ok(parsed.datos.detalle_tool_consultada.que_espera.parametros_obligatorios.condicion_venta);
      assert.ok(parsed.datos.detalle_tool_consultada.que_espera.parametros_obligatorios.cliente);
      assert.ok(parsed.datos.detalle_tool_consultada.que_espera.parametros_obligatorios.items);
      assert.ok(parsed.datos.detalle_tool_consultada.que_espera.parametros_opcionales.deposito);
      assert.ok(parsed.datos.detalle_tool_consultada.que_espera.parametros_opcionales.id_deposito);
      assert.deepEqual(parsed.datos.detalle_tool_consultada.depositos_activos_en_cuenta, [
        "Depósito Central",
        "Sucursal Norte",
      ]);
      assert.match(parsed.resumen, /Guía detallada de la tool 'enviar_venta'/);
    });
  });

  describe("emular_facturacion (Simulador Dry-Run para integradores de API)", () => {
    it("simula facturación en modo Dry-Run, determina Factura A según Matriz AFIP y devuelve contratos JSON sin hacer POST", async () => {
      let postInvocado = false;
      const mockClient = {
        country: "AR",
        get: async (endpoint) => {
          if (endpoint === "/usuarios/obtenerinfo") {
            return { RazonSocial: "Mi Empresa RI S.A.", CondicionIVA: "RI", TieneFE: true };
          }
          if (endpoint === "/clientes/search") {
            return {
              Items: [
                {
                  Id: 778,
                  RazonSocial: "Cliente Corporativo S.R.L.",
                  NroDoc: "20123456786",
                  TipoDoc: "CUIT",
                  CondicionIva: "RI",
                },
              ],
            };
          }
          if (endpoint === "/puntosdeventa/search") {
            return [{ Id: 4, Nombre: "PV Electrónico 0004", Activo: true }];
          }
          if (endpoint === "/usuarios/condicionesVenta") {
            return [{ Nombre: "MercadoPago" }, { Nombre: "Cuenta Corriente" }];
          }
          if (endpoint === "/conceptos/getByCodigo") {
            return { Id: 901, Codigo: "CASCO-01", Nombre: "Casco Seguridad" };
          }
          return null;
        },
        post: async () => {
          postInvocado = true;
        },
      };

      const res = await emularFacturacion.handler(
        {
          id_cliente: 778,
          cliente_documento: "20-12345678-6",
          condicion_venta: "mercado pago", // Debe normalizarse a 'MercadoPago' y advertir C2
          items: [
            {
              codigo: "CASCO-01",
              concepto: "Casco Seguridad",
              cantidad: 2,
              precio_unitario: 10000,
              iva: 21,
            },
          ],
          nro_orden_ecommerce: "ORD-900",
          id_integracion: 27341,
        },
        mockClient
      );

      const parsed = JSON.parse(res.content[0].text);
      assert.equal(postInvocado, false, "Jamás debe emitir un POST en modo Dry-Run");
      assert.equal(parsed.datos.modo, "SIMULACION_DRY_RUN_SIN_IMPACTO_FISCAL");
      assert.equal(parsed.datos.estado_simulacion, "LISTO_PARA_INTEGRAR");
      assert.equal(parsed.datos.determinacion_fiscal_afip.tipo_factura_resultante, "FA");
      assert.equal(parsed.datos.totales_calculados.subtotal_neto, 20000);
      assert.equal(parsed.datos.totales_calculados.total_iva, 4200);
      assert.equal(parsed.datos.totales_calculados.total_comprobante, 24200);
      assert.ok(parsed.advertencias.some((a) => a.includes("Error C2")));

      const contratos = parsed.datos.contratos_api_listos_para_usar;
      assert.equal(contratos.opcion_1_flujo_seguro_en_dos_pasos.paso_1_crear_borrador.payload_json.TipoFc, "FA");
      assert.equal(contratos.opcion_1_flujo_seguro_en_dos_pasos.paso_1_crear_borrador.payload_json.CondicionVenta, "MercadoPago");
      assert.equal(contratos.opcion_1_flujo_seguro_en_dos_pasos.paso_1_crear_borrador.payload_json.PuntoVenta, 4);
      assert.match(contratos.opcion_3_facturar_orden_ecommerce.endpoint, /nro=ORD-900&idIntegracion=27341/);
    });

    it("detecta errores de validación (TipoFc incompatible con AFIP, envío de CUIL en RI y descalce de pagos)", async () => {
      const mockClient = {
        country: "AR",
        get: async (endpoint) => {
          if (endpoint === "/usuarios/obtenerinfo") {
            return { RazonSocial: "Emisor RI", CondicionIVA: "RI", TieneFE: true };
          }
          if (endpoint === "/clientes/search") {
            return {
              Items: [{ Id: 50, RazonSocial: "Receptor RI", NroDoc: "20123456786", CondicionIva: "RI" }],
            };
          }
          return [];
        },
      };

      const res = await emularFacturacion.handler(
        {
          id_cliente: 50,
          cliente_documento: "20123456786",
          cliente_tipo_documento: "CUIL",
          cliente_condicion_iva: "RI",
          tipo_factura: "FB", // Incompatible: RI a RI exige FA
          items: [{ concepto: "Servicio", cantidad: 1, precio_unitario: 10000, iva: 21 }],
          pagos: [{ forma_de_pago: "Efectivo", importe: 5000 }], // Descalzado (total es 12100)
        },
        mockClient
      );

      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.datos.estado_simulacion, "ERRORES_DE_VALIDACION_DETECTADOS");
      const codigosError = parsed.datos.errores_detectados.map((e) => e.codigo);
      assert.ok(codigosError.includes("TIPO_DOCUMENTO_CUIL_FUERZA_CF_C9"));
      assert.ok(codigosError.includes("TIPO_FACTURA_INCOMPATIBLE_AFIP"));
      assert.ok(codigosError.includes("DESCALCE_IMPORTE_PAGOS"));
    });
  });

});
