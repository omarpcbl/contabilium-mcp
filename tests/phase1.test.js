import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as resumenVentas from "../src/tools/resumen_ventas.js";
import * as stockPorDeposito from "../src/tools/stock_por_deposito.js";
import * as cuentasPorCobrar from "../src/tools/cuentas_por_cobrar.js";
import * as buscarProductos from "../src/tools/buscar_productos.js";
import { registerContabiliumTools } from "../src/register-tools.js";

describe("Fase 1 — Verificación Automatizada de Tickets", () => {

  describe("resumen_ventas (BUG-01, BUG-05, MEJ-01, MEJ-04)", () => {
    it("resta correctamente notas de crédito y separa facturado bruto vs neto", async () => {
      // 12 facturas B que suman 243.578,58 y 3 NC que suman -7.260,00 (-2.420 c/u)
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

      // Verificación BUG-01 y MEJ-01
      assert.equal(totales.total_facturado_bruto, 243578.58, "El bruto facturado debe ser 243.578,58");
      assert.equal(totales.total_notas_credito, 7260.00, "El total de NC debe ser 7.260,00");
      assert.equal(totales.total_neto, 236318.58, "El neto debe ser 236.318,58 (facturas menos NC)");

      // Verificación BUG-05 y MEJ-04
      assert.equal(totales.cantidad_facturas, 12, "Debe haber exactamente 12 facturas de venta");
      assert.equal(totales.cantidad_notas_credito, 3, "Debe haber exactamente 3 notas de crédito");
      assert.equal(totales.cantidad_comprobantes, 15, "Comprobantes totales es 15");
      assert.equal(totales.ticket_promedio, 20298.22, "Ticket promedio debe ser 243578.58 / 12 = 20298.22");
      assert.equal(totales.clientes_unicos, 1, "Debe identificar 1 cliente único");

      // Verificación en el texto del resumen
      assert.match(parsed.resumen, /\$ 236\.318,58/, "El resumen debe contener el neto de 236.318,58");
      assert.match(parsed.resumen, /\$ 243\.578,58/, "El resumen debe contener el bruto facturado");
      assert.match(parsed.resumen, /Ticket promedio: \$ 20\.298,22/, "El resumen debe reportar el ticket promedio");
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

      assert.doesNotMatch(adv, /reservas activas comprometidas/i, "No debe acusar reservas activas comprometidas si stock_reservado es 0");
      assert.match(adv, /existencias físicas negativas sin reservas/i, "Debe advertir sobre stock físico negativo");
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
        StockActual: i - 25, // algunos negativos, otros positivos
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
      assert.equal(parsed.datos.length, 5, "Debe limitar exactamente al top 5");
      assert.equal(parsed.datos[0].disponible, -25, "El primero debe ser el de menor disponible (-25)");
      assert.match(parsed.resumen, /Se encontraron 50 producto\(s\)/, "El resumen debe reportar los 50 encontrados");
      assert.match(parsed.resumen, /mostrando los 5 principales/, "El resumen debe aclarar cuántos muestra");
      assert.equal(parsed.truncado, true, "Debe marcar truncado: true cuando hay más registros que el top");
    });
  });

  describe("cuentas_por_cobrar (BUG-08, MEJ-05)", () => {
    it("explicita el rango de fechas analizado y calcula antigüedad de deuda (Aging Report)", async () => {
      const hoy = new Date();
      const hace15Dias = new Date(hoy.getTime() - 15 * 86400000).toISOString().split("T")[0];
      const hace45Dias = new Date(hoy.getTime() - 45 * 86400000).toISOString().split("T")[0];
      const hace75Dias = new Date(hoy.getTime() - 75 * 86400000).toISOString().split("T")[0];
      const hace120Dias = new Date(hoy.getTime() - 120 * 86400000).toISOString().split("T")[0];
      const en10Dias = new Date(hoy.getTime() + 10 * 86400000).toISOString().split("T")[0];

      const mockItems = [
        { Id: 1, Numero: "A-0001", Saldo: 1000, FechaVencimiento: en10Dias, RazonSocial: "Cliente Alfa", IdCliente: 10 },
        { Id: 2, Numero: "A-0002", Saldo: 2000, FechaVencimiento: hace15Dias, RazonSocial: "Cliente Alfa", IdCliente: 10 },
        { Id: 3, Numero: "A-0003", Saldo: 3000, FechaVencimiento: hace45Dias, RazonSocial: "Cliente Beta", IdCliente: 20 },
        { Id: 4, Numero: "A-0004", Saldo: 4000, FechaVencimiento: hace75Dias, RazonSocial: "Cliente Beta", IdCliente: 20 },
        { Id: 5, Numero: "A-0005", Saldo: 5000, FechaVencimiento: hace120Dias, RazonSocial: "Cliente Gamma", IdCliente: 30 },
      ];

      let calls = 0;
      const mockClient = {
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

      // Verificación BUG-08
      assert.ok(totales.periodo_analizado.es_rango_por_defecto, "Debe marcar que usó rango por defecto");
      assert.match(parsed.resumen, /período analizado:/, "El resumen debe incluir las fechas analizadas");
      assert.ok(parsed.advertencias.some(a => a.includes("últimos 12 meses")), "Debe advertir sobre los últimos 12 meses");

      // Verificación MEJ-05 (Aging)
      assert.equal(totales.saldo_total, 15000, "Saldo total debe ser 15.000");
      assert.equal(totales.saldo_vencido, 14000, "Saldo vencido debe ser 14.000");
      assert.equal(totales.saldo_no_vencido, 1000, "Saldo corriente a vencer es 1.000");

      const aging = totales.antiguedad_deuda_general;
      assert.equal(aging.no_vencida, 1000, "Tramo no vencida: 1.000");
      assert.equal(aging.vencida_1_30, 2000, "Tramo 1 a 30 días: 2.000");
      assert.equal(aging.vencida_31_60, 3000, "Tramo 31 a 60 días: 3.000");
      assert.equal(aging.vencida_61_90, 4000, "Tramo 61 a 90 días: 4.000");
      assert.equal(aging.vencida_mas_90, 5000, "Tramo más de 90 días: 5.000");
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
      assert.doesNotMatch(advText, /API-1267/i, "No debe contener referencias a tickets internos como API-1267");
      assert.match(advText, /stock_total suma todos los depósitos/, "Mantiene la advertencia funcional");
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
            // Simulamos que al hacer get se obtiene el token
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
      assert.ok(authTool, "La tool contabilium_auth_status debe estar registrada");

      const response = await authTool({ ping: true });
      const parsed = JSON.parse(response.content[0].text);

      assert.equal(parsed.conexionEnVivo.conectado, true);
      assert.equal(parsed.token.activo, true, "El token debe figurar activo cuando el ping es exitoso");
      assert.ok(parsed.token.minutosRestantes > 50, "Debe reportar los minutos restantes");
    });
  });

});
