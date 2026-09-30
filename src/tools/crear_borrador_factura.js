import { z } from "zod";
import { formatToolResponse, formatCurrency, parseAmount } from "../utils.js";

export const itemSchema = z.object({
  id_concepto: z.number().int().optional().describe("ID del producto/servicio en catálogo (opcional si es concepto libre)."),
  concepto: z.string().min(1, "El concepto no puede estar vacío.").describe("Descripción del ítem en la factura."),
  cantidad: z.number().positive("La cantidad debe ser mayor a 0.").describe("Cantidad a facturar."),
  precio_unitario: z.number().describe("Precio unitario neto sin IVA (o precio final si el emisor es Monotributo)."),
  iva: z.number().default(21).describe("Alícuota de IVA: 21, 10.5, 0, 27, 5, 2.5 (por defecto 21)."),
  codigo: z.string().optional().describe("Código SKU del producto (opcional)."),
  bonificacion: z.number().min(0).max(100).default(0).describe("Porcentaje de descuento o bonificación por ítem (opcional)."),
});

export const schema = {
  id_cliente: z.number().int().describe("ID del cliente en Contabilium (obtenido mediante buscar_clientes)."),
  items: z.array(itemSchema).min(1, "Debe incluir al menos un ítem a facturar.").describe("Lista de ítems a incluir en la factura."),
  tipo_factura: z.enum(["FA", "FB", "FC", "FM", "FCE"]).optional().describe("Tipo de comprobante: FA (Factura A), FB (Factura B), FC (Factura C), etc. Si se omite, se precalcula automáticamente aplicando la matriz oficial de AFIP según la condición del emisor y receptor."),
  punto_venta: z.number().int().optional().describe("ID del punto de venta en Contabilium. Si se omite, se asigna el primer punto de venta electrónico activo."),
  condicion_venta: z.string().default("Cuenta Corriente").describe("Condición de venta (ej: 'Cuenta Corriente', 'Contado', 'Transferencia'). Por defecto: 'Cuenta Corriente'."),
  id_deposito: z.number().int().optional().describe("ID del depósito para descontar stock (opcional, si se omite usa el depósito central)."),
  tipo_concepto: z.number().int().min(1).max(3).default(1).describe("1 = Productos, 2 = Servicios, 3 = Productos y Servicios (por defecto 1)."),
  fecha_emision: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato debe ser YYYY-MM-DD").optional().describe("Fecha de emisión YYYY-MM-DD (por defecto hoy)."),
  observaciones: z.string().optional().describe("Observaciones o notas visibles al pie del comprobante."),
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
  } = args;

  // 1. Obtener datos de la empresa emisora (con caché)
  const infoEmisor = await client.get("/usuarios/obtenerinfo", null, 1800);
  const condicionIvaEmisor = (infoEmisor?.CondicionIVA || "RI").toUpperCase();

  // 2. Obtener datos del cliente para validar condición fiscal
  let clienteNombre = `Cliente #${id_cliente}`;
  let condicionIvaReceptor = "CF";
  let clienteCuit = "";

  try {
    const clientesRes = await client.get("/clientes/search", { pageSize: 50 }, 300);
    const lista = Array.isArray(clientesRes) ? clientesRes : (clientesRes?.Items || clientesRes?.items || []);
    const match = lista.find((c) => (c.Id ?? c.id) === id_cliente);
    if (match) {
      clienteNombre = match.RazonSocial || match.NombreFantasia || clienteNombre;
      condicionIvaReceptor = (match.CondicionIva || match.condicionIva || match.TipoDoc === "CUIT" ? "RI" : "CF").toUpperCase();
      clienteCuit = match.NroDoc || match.nroDoc || match.Documento || "";
    }
  } catch {
    // Si falla la búsqueda de cliente, continuar con defaults
  }

  // 3. Precalculo de TipoFc según la Matriz Oficial de AFIP
  let tipoFc = args.tipo_factura;
  let motivoTipoFc = "Indicado por el usuario";

  if (!tipoFc) {
    if (condicionIvaEmisor === "MO" || condicionIvaEmisor === "EX") {
      tipoFc = "FC";
      motivoTipoFc = "Precalculado: Emisor es Monotributista/Exento (AFIP)";
    } else if (condicionIvaEmisor === "RI") {
      if (condicionIvaReceptor === "RI" || condicionIvaReceptor === "MO") {
        tipoFc = "FA";
        motivoTipoFc = "Precalculado s/ RG 5003 AFIP: Receptor es Responsable Inscripto o Monotributista";
      } else {
        tipoFc = "FB";
        motivoTipoFc = "Precalculado: Receptor es Consumidor Final o Exento (AFIP)";
      }
    } else {
      tipoFc = "FB";
      motivoTipoFc = "Precalculado por defecto";
    }
  }

  // 4. Resolver Punto de Venta si no se especificó
  let idPuntoVenta = args.punto_venta;
  let nombrePuntoVenta = "Default";

  if (!idPuntoVenta) {
    try {
      const pvs = await client.get("/puntosdeventa/search", null, 1800);
      const listaPvs = Array.isArray(pvs) ? pvs : [];
      const activo = listaPvs.find((p) => p.Activo !== false);
      if (activo) {
        idPuntoVenta = activo.Id;
        nombrePuntoVenta = activo.Nombre || `Punto ${activo.Id}`;
      } else {
        idPuntoVenta = 1;
      }
    } catch {
      idPuntoVenta = 1;
    }
  }

  // 5. Cálculo exacto de Totales e Impuestos
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

  subtotalNeto = Math.round(subtotalNeto * 100) / 100;
  totalIva = Math.round(totalIva * 100) / 100;
  const totalFactura = Math.round((subtotalNeto + totalIva) * 100) / 100;

  const fechaHoy = new Date().toISOString().split("T")[0];
  const fechaEmisionEfectiva = fecha_emision || fechaHoy;
  const dVenc = new Date(fechaEmisionEfectiva + "T00:00:00Z");
  dVenc.setUTCDate(dVenc.getUTCDate() + 10);
  const fechaVencimientoEfectiva = dVenc.toISOString().split("T")[0];

  // 6. Enviar a /api/comprobantes/crear (Fase 1: Solo borrador)
  const payloadCrear = {
    IdCliente: id_cliente,
    TipoFc: tipoFc,
    PuntoVenta: idPuntoVenta,
    Modo: "E",
    CondicionVenta: condicion_venta,
    TipoConcepto: tipo_concepto,
    Inventario: id_deposito,
    FechaEmision: `${fechaEmisionEfectiva}T00:00:00`,
    FechaVencimiento: `${fechaVencimientoEfectiva}T00:00:00`,
    Observaciones: observaciones,
    Items: itemsMapeados,
  };

  const resCrear = await client.post("/comprobantes/crear", payloadCrear);
  const idComprobante = typeof resCrear === "number" ? resCrear : Number(resCrear?.id || resCrear);

  const preview = {
    id_comprobante: idComprobante,
    estado: "BORRADOR_GUARDADO",
    tipo_factura: tipoFc,
    motivo_tipo_factura: motivoTipoFc,
    cliente: {
      id: id_cliente,
      razon_social: clienteNombre,
      documento: clienteCuit,
      condicion_iva: condicionIvaReceptor,
    },
    punto_venta: {
      id: idPuntoVenta,
      nombre: nombrePuntoVenta,
    },
    condicion_venta: condicion_venta,
    fecha_emision: fechaEmisionEfectiva,
    totales: {
      subtotal_neto: subtotalNeto,
      subtotal_neto_formateado: formatCurrency(subtotalNeto),
      iva: totalIva,
      iva_formateado: formatCurrency(totalIva),
      total: totalFactura,
      total_formateado: formatCurrency(totalFactura),
    },
    items: itemsMapeados.map((it) => ({
      concepto: it.Concepto,
      cantidad: it.Cantidad,
      precio_unitario: it.PrecioUnitario,
      iva: `${it.Iva}%`,
      subtotal: Math.round(it.Cantidad * it.PrecioUnitario * (1 - it.Bonificacion / 100) * 100) / 100,
    })),
  };

  const resumen = `Borrador #${idComprobante} creado con éxito (${tipoFc} a ${clienteNombre} por ${formatCurrency(totalFactura)}). No tiene validez fiscal aún.`;

  return formatToolResponse({
    datos: preview,
    resumen,
    advertencias: [
      `El comprobante #${idComprobante} está guardado en Contabilium como BORRADOR sin CAE.`,
      "Muestra este preview al usuario y solicita confirmación explícita antes de llamar a 'autorizar_factura_electronica'.",
    ],
    truncado: false,
  });
}
