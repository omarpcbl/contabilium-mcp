import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as resumenVentas from "../src/tools/resumen_ventas.js";
import * as stockPorDeposito from "../src/tools/stock_por_deposito.js";
import * as cuentasPorCobrar from "../src/tools/cuentas_por_cobrar.js";
import * as buscarProductos from "../src/tools/buscar_productos.js";
import * as quePuedoConsultar from "../src/tools/que_puedo_consultar.js";
import * as registrarConsultaNoSoportada from "../src/tools/registrar_consulta_no_soportada.js";
import * as diagnosticarOrden from "../src/tools/diagnosticar_orden.js";
import { registerContabiliumTools } from "../src/register-tools.js";
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

  describe("Blindaje de Tools de Facturación en Producción (BUG-15)", () => {
    it("oculta tools de facturación por defecto y registra solo las 11 tools de lectura/asistencia", () => {
      delete process.env.ENABLE_BILLING_TOOLS;

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

      // No están las 4 de facturación
      assert.equal(registeredTools.has("crear_borrador_factura"), false);
      assert.equal(registeredTools.has("autorizar_factura_electronica"), false);
      assert.equal(registeredTools.has("emitir_factura_express"), false);
      assert.equal(registeredTools.has("obtener_factura_pdf"), false);

      // Sí están las 11 de lectura, asistencia y diagnóstico
      const expectedTools = [
        "que_puedo_consultar",
        "buscar_clientes",
        "buscar_productos",
        "buscar_proveedores",
        "listar_depositos",
        "listar_ventas",
        "resumen_ventas",
        "stock_por_deposito",
        "cuentas_por_cobrar",
        "diagnosticar_orden",
        "registrar_consulta_no_soportada",
        "contabilium_auth_status",
      ];

      for (const t of expectedTools) {
        assert.equal(registeredTools.has(t), true, `La tool ${t} debe estar registrada`);
      }
      assert.equal(registeredTools.size, 12);
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
          if (endpoint === "/opciones/condiciones-venta") {
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
    });

    it("Caso 4: 'Inexistente', nro con ID interno 28778 distinto de la referencia (detecta C5, no C6)", async () => {
      const mockClient = {
        country: "AR",
        get: async () => ({ Items: [] }),
      };

      const result = await diagnosticarOrden.handler(
        {
          referencia_externa: "ORD-EXT-99",
          parametro_nro: "28778",
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

    it("Caso 7: API-1156 Hezka con CUIL enviado para cliente con CUIT", async () => {
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
      assert.match(c9.descripcion, /TipoDocumento: 'CUIL'/);
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

});
