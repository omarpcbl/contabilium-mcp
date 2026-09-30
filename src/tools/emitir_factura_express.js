import { z } from "zod";
import { formatToolResponse, formatCurrency, parseAmount } from "../utils.js";
import { itemSchema } from "./crear_borrador_factura.js";

export const pagoSchema = z.object({
  forma_de_pago: z.string().describe("Forma de pago (ej: 'Efectivo', 'Transferencia', 'Cheque', 'Tarjeta de Débito', 'Tarjeta de Crédito')."),
  importe: z.number().positive("El importe cobrado debe ser mayor a 0.").describe("Monto cobrado con esta forma de pago."),
  id_caja: z.number().int().optional().describe("ID de la caja en Contabilium (opcional)."),
  id_banco: z.number().int().optional().describe("ID de la cuenta bancaria en Contabilium (opcional)."),
  nro_referencia: z.string().optional().describe("Número de comprobante, cupón o transferencia (opcional)."),
});

export const schema = {
  id_cliente: z.number().int().describe("ID del cliente en Contabilium."),
  items: z.array(itemSchema).min(1).describe("Lista de ítems a facturar."),
  tipo_factura: z.enum(["FA", "FB", "FC", "FM", "FCE"]).optional().describe("Tipo de comprobante (opcional, si se omite se precalcula s/ AFIP)."),
  punto_venta: z.number().int().optional().describe("ID del punto de venta en Contabilium (opcional)."),
  condicion_venta: z.string().default("Cuenta Corriente").describe("Condición de venta (default: 'Cuenta Corriente')."),
  id_deposito: z.number().int().optional().describe("ID del depósito para descontar stock (opcional)."),
  tipo_concepto: z.number().int().min(1).max(3).default(1).describe("1 = Productos, 2 = Servicios, 3 = Ambos."),
  fecha_emision: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Fecha YYYY-MM-DD."),
  observaciones: z.string().optional().describe("Observaciones visibles en el comprobante."),
  pagos: z.array(pagoSchema).optional().describe("Cobranzas asociadas a la factura (opcional). Si se omite, queda como cuenta corriente con saldo pendiente."),
};

export async function handler(args, client) {
  const {
    id_cliente,
    items,
    condicion_venta = "Cuenta Corriente",
    id_deposito = 0,
    tipo_concepto = 1,
    fecha_emision,
    observaciones = "",
    pagos = [],
  } = args;

  // 1. Precalculo de TipoFc si no fue provisto
  let tipoFc = args.tipo_factura;
  if (!tipoFc) {
    try {
      const infoEmisor = await client.get("/usuarios/obtenerinfo", null, 1800);
      const condEmisor = (infoEmisor?.CondicionIVA || "RI").toUpperCase();

      if (condEmisor === "MO" || condEmisor === "EX") {
        tipoFc = "FC";
      } else {
        const clientesRes = await client.get("/clientes/search", { pageSize: 50 }, 300);
        const lista = Array.isArray(clientesRes) ? clientesRes : (clientesRes?.Items || clientesRes?.items || []);
        const match = lista.find((c) => (c.Id ?? c.id) === id_cliente);
        const condCliente = (match?.CondicionIva || match?.condicionIva || (match?.TipoDoc === "CUIT" ? "RI" : "CF")).toUpperCase();

        tipoFc = condCliente === "RI" || condCliente === "MO" ? "FA" : "FB";
      }
    } catch {
      tipoFc = "FB";
    }
  }

  // 2. Resolver Punto de Venta si no fue provisto
  let idPuntoVenta = args.punto_venta;
  if (!idPuntoVenta) {
    try {
      const pvs = await client.get("/puntosdeventa/search", null, 1800);
      const listaPvs = Array.isArray(pvs) ? pvs : [];
      const activo = listaPvs.find((p) => p.Activo !== false);
      idPuntoVenta = activo ? activo.Id : 1;
    } catch {
      idPuntoVenta = 1;
    }
  }

  // 3. Mapear ítems y calcular totales
  let subtotalNeto = 0;
  let totalIva = 0;

  const itemsMapeados = items.map((it) => {
    const cant = parseAmount(it.cantidad);
    const precioUnit = parseAmount(it.precio_unitario);
    const bonif = parseAmount(it.bonificacion || 0);
    const alicuota = parseAmount(it.iva ?? 21);

    const netoItem = cant * precioUnit * (1 - bonif / 100);
    const ivaItem = netoItem * (alicuota / 100);

    subtotalNeto += netoItem;
    totalIva += ivaItem;

    return {
      IdConcepto: it.id_concepto || null,
      Concepto: it.concepto.trim(),
      Cantidad: cant,
      PrecioUnitario: precioUnit,
      Iva: alicuota,
      Bonificacion: bonif,
      Codigo: it.codigo || "",
    };
  });

  const totalComprobante = Math.round((subtotalNeto + totalIva) * 100) / 100;
  const fechaHoy = new Date().toISOString().split("T")[0];
  const fechaEmisionEfectiva = fecha_emision || fechaHoy;

  // 4. Mapear pagos si fueron provistos
  const pagosMapeados = (pagos || []).map((p) => ({
    FormaDePago: p.forma_de_pago,
    Importe: parseAmount(p.importe),
    IdCaja: p.id_caja || null,
    IdBanco: p.id_banco || null,
    NroReferencia: p.nro_referencia || "",
  }));

  const payload = {
    IdCliente: id_cliente,
    TipoFc: tipoFc,
    PuntoVenta: idPuntoVenta,
    Modo: "E",
    CondicionVenta: condicion_venta,
    TipoConcepto: tipo_concepto,
    Inventario: id_deposito,
    FechaEmision: `${fechaEmisionEfectiva}T00:00:00`,
    Observaciones: observaciones,
    Items: itemsMapeados,
    Pagos: pagosMapeados,
  };

  // 5. Llamada a POST /api/comprobantes/emitirFECobrada
  const res = await client.post("/comprobantes/emitirFECobrada", payload);

  const idComprobante = res?.idComprobante || 0;
  const cae = res?.cae || "";
  const numero = res?.numero || "";
  const errores = res?.errores || "";
  const linkPublico = res?.url || "";
  const fechaVto = res?.fechaVto || null;

  const exitoFiscal = Boolean(cae && cae.trim().length > 0);

  if (!exitoFiscal) {
    return formatToolResponse({
      datos: {
        id_comprobante: idComprobante,
        estado: "BORRADOR_SIN_CAE",
        errores_fisco: errores,
        total: totalComprobante,
      },
      resumen: `ADVERTENCIA: El comprobante #${idComprobante} se guardó pero NO fue autorizado por el fisco. Detalle: ${errores}`,
      advertencias: [errores || "No se obtuvo CAE de AFIP/SII."],
      truncado: false,
    });
  }

  const datos = {
    id_comprobante: idComprobante,
    estado: "EMITIDA_CON_CAE",
    cae: cae,
    numero_comprobante: numero,
    fecha_vto_cae: fechaVto,
    total: totalComprobante,
    total_formateado: formatCurrency(totalComprobante),
    link_pdf: linkPublico,
  };

  let resumen = `Factura Express emitida con éxito. Número: ${numero} | CAE: ${cae} | Total: ${formatCurrency(totalComprobante)}.`;
  const advertencias = [];

  if (errores && errores.includes("error en el pago")) {
    advertencias.push(`La factura fue emitida por el fisco, pero hubo una advertencia en la cobranza: ${errores}`);
  }

  return formatToolResponse({
    datos,
    resumen,
    advertencias,
    truncado: false,
  });
}
