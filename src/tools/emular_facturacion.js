import { z } from "zod";
import { formatToolResponse, formatCurrency, parseAmount, validateTaxId } from "../utils.js";
import { itemSchema } from "./crear_borrador_factura.js";
import { pagoSchema } from "./emitir_factura_express.js";

export const schema = {
  id_cliente: z
    .number()
    .int()
    .optional()
    .describe("ID numérico del cliente en Contabilium (obtenido con buscar_clientes). Opcional si se provee cliente_documento."),
  cliente_documento: z
    .string()
    .optional()
    .describe("CUIT, DNI o RUT del cliente receptor para buscarlo en el padrón y validar su formato fiscal."),
  cliente_tipo_documento: z
    .enum(["CUIT", "CUIL", "DNI", "RUT", "CI", "OTRO"])
    .optional()
    .describe("Tipo de documento que planeás enviar en tu integración (útil para detectar el Error C9 si enviás CUIL para un Responsable Inscripto)."),
  cliente_condicion_iva: z
    .enum(["RI", "MO", "CF", "EX"])
    .optional()
    .describe("Condición de IVA del receptor ('RI' Responsable Inscripto, 'MO' Monotributista, 'CF' Consumidor Final, 'EX' Exento). Si se omite, se toma del padrón de Contabilium."),
  items: z
    .array(itemSchema)
    .min(1, "Debe incluir al menos un ítem para simular la factura.")
    .describe("Lista de ítems a facturar (código/SKU, concepto, cantidad, precio_unitario sin IVA, iva, bonificacion)."),
  tipo_factura: z
    .enum(["FA", "FB", "FC", "FM", "FCE"])
    .optional()
    .describe("Letra del comprobante que pensás enviar ('FA', 'FB', 'FC', etc.). Si se omite, el simulador calcula la letra correcta según AFIP; si se envía, valida si es fiscalmente compatible."),
  punto_venta: z
    .number()
    .int()
    .optional()
    .describe("ID o número del punto de venta en Contabilium. Si se omite, el simulador releva los puntos de venta activos de la cuenta."),
  condicion_venta: z
    .string()
    .default("Cuenta Corriente")
    .describe("Condición de venta (ej: 'Cuenta Corriente', 'Efectivo', 'MercadoPago', 'Transferencia'). Se valida contra el catálogo real de la cuenta."),
  id_deposito: z
    .number()
    .int()
    .optional()
    .describe("ID del depósito para validar existencia y disponibilidad de stock de los ítems."),
  tipo_concepto: z
    .number()
    .int()
    .min(1)
    .max(3)
    .default(1)
    .describe("1 = Productos, 2 = Servicios, 3 = Productos y Servicios (default 1)."),
  fecha_emision: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Formato debe ser YYYY-MM-DD")
    .optional()
    .describe("Fecha de emisión en formato YYYY-MM-DD (por defecto hoy)."),
  observaciones: z
    .string()
    .optional()
    .describe("Observaciones visibles en el comprobante."),
  pagos: z
    .array(pagoSchema)
    .optional()
    .describe("Pagos/cobranzas asociadas si querés simular el endpoint POST /api/comprobantes/emitirFECobrada."),
  nro_orden_ecommerce: z
    .string()
    .optional()
    .describe("Opcional: Número externo de orden (IdVentaIntegracion) si además querés simular la facturación de una orden vía GET /api/ordenesventa/emitirFE."),
  id_integracion: z
    .number()
    .int()
    .optional()
    .describe("Opcional: ID de la integración e-commerce asociada a nro_orden_ecommerce."),
};

/**
 * Normaliza condición de IVA a sigla estándar (RI, MO, CF, EX)
 */
function normalizeCondicionIva(raw) {
  if (!raw) return "CF";
  const u = String(raw).trim().toUpperCase();
  if (u === "RI" || u.includes("INSCRIPTO")) return "RI";
  if (u === "MO" || u === "MT" || u.includes("MONOTRIBUTO")) return "MO";
  if (u === "EX" || u.includes("EXENTO")) return "EX";
  return "CF";
}

export async function handler(args, client) {
  const {
    id_cliente,
    cliente_documento,
    cliente_tipo_documento,
    cliente_condicion_iva,
    items,
    tipo_factura,
    punto_venta,
    condicion_venta = "Cuenta Corriente",
    id_deposito,
    tipo_concepto = 1,
    fecha_emision,
    observaciones = "",
    pagos = [],
    nro_orden_ecommerce,
    id_integracion,
  } = args;

  const validacionesAprobadas = [];
  const erroresDetectados = [];
  const advertencias = [];
  const consejosIntegracion = [];

  // 1. Obtener información fiscal del emisor (cuenta conectada)
  let infoEmisor = null;
  try {
    infoEmisor = await client.get("/usuarios/obtenerinfo", null, 1800);
  } catch {
    // Continuar con defaults si el mock o la red no responde
  }

  const condicionIvaEmisor = normalizeCondicionIva(infoEmisor?.CondicionIVA || "RI");
  const razonSocialEmisor = infoEmisor?.RazonSocial || "Empresa Emisora";
  const tieneFE = infoEmisor?.TieneFE !== undefined ? Boolean(infoEmisor.TieneFE) : true;

  if (!tieneFE) {
    advertencias.push(
      "La cuenta conectada figura con TieneFE=false en /usuarios/obtenerinfo. Para emitir facturas electrónicas reales ante AFIP/ARCA deberá tener configurado el punto de venta electrónico."
    );
  }

  // 2. Validar y resolver Cliente Receptor
  let clienteEncontrado = null;
  try {
    const filtroBusqueda = cliente_documento || (id_cliente ? String(id_cliente) : "");
    const paramsClientes = filtroBusqueda ? { filtro: filtroBusqueda, pageSize: 50 } : { pageSize: 50 };
    const clientesRes = await client.get("/clientes/search", paramsClientes, 300);
    const lista = Array.isArray(clientesRes) ? clientesRes : (clientesRes?.Items || clientesRes?.items || []);

    if (id_cliente) {
      clienteEncontrado = lista.find((c) => Number(c.Id ?? c.id) === Number(id_cliente));
    }
    if (!clienteEncontrado && cliente_documento) {
      const cleanDoc = String(cliente_documento).replace(/[^0-9kK]/g, "");
      clienteEncontrado = lista.find(
        (c) => String(c.NroDoc || c.nroDoc || c.Documento || "").replace(/[^0-9kK]/g, "") === cleanDoc
      );
    }
  } catch {
    // Ignorar error de red en búsqueda de cliente
  }

  const idClienteFinal = clienteEncontrado ? Number(clienteEncontrado.Id ?? clienteEncontrado.id) : (id_cliente || null);
  const nombreCliente = clienteEncontrado
    ? (clienteEncontrado.RazonSocial || clienteEncontrado.NombreFantasia || `Cliente #${idClienteFinal}`)
    : (id_cliente ? `Cliente #${id_cliente} (No verificado en padrón)` : "Cliente Simulado");
  const docCliente = cliente_documento || clienteEncontrado?.NroDoc || clienteEncontrado?.nroDoc || clienteEncontrado?.Documento || "";
  const tipoDocCliente = (cliente_tipo_documento || clienteEncontrado?.TipoDoc || (String(docCliente).replace(/\D/g, "").length === 11 ? "CUIT" : "DNI")).toUpperCase();
  const condIvaReceptor = normalizeCondicionIva(
    cliente_condicion_iva || clienteEncontrado?.CondicionIva || clienteEncontrado?.condicionIva || (tipoDocCliente === "CUIT" ? "RI" : "CF")
  );

  if (clienteEncontrado) {
    validacionesAprobadas.push(
      `Cliente receptor verificado en padrón: '${nombreCliente}' (ID: ${idClienteFinal}, Condición IVA: ${condIvaReceptor}).`
    );
  } else if (!id_cliente) {
    erroresDetectados.push({
      codigo: "FALTA_ID_CLIENTE",
      campo: "IdCliente",
      detalle: "Los endpoints POST /api/comprobantes/crear y POST /api/comprobantes/emitirFECobrada exigen un 'IdCliente' numérico existente en Contabilium.",
      solucion: "Consultá primero GET /api/clientes/search?filtro={cuit_o_nombre} (o usá la tool 'buscar_clientes') para obtener el 'Id' numérico del cliente.",
    });
  } else {
    advertencias.push(
      `No se encontró el cliente con ID ${id_cliente} en la primera página del padrón. Asegurate de que el IdCliente exista en la cuenta antes de enviar el POST.`
    );
  }

  // Validar formato y dígito verificador del documento si fue provisto
  if (docCliente) {
    const taxCheck = validateTaxId(docCliente, client?.country || "AR");
    if (!taxCheck.valido) {
      erroresDetectados.push({
        codigo: "DOCUMENTO_FISCAL_INVALIDO",
        campo: "NroDoc / Documento",
        detalle: `El documento '${docCliente}' no supera la validación matemática (${taxCheck.motivo}). AFIP/ARCA rechazará la emisión del CAE.`,
        solucion: "Corregir el CUIT/DNI/RUT del cliente antes de solicitar autorización electrónica.",
      });
    } else {
      validacionesAprobadas.push(`Documento fiscal '${docCliente}' válido (${taxCheck.tipo}).`);
    }
  }

  // Detectar trampa clásica Error C9 (enviar CUIL para un Responsable Inscripto)
  if (tipoDocCliente === "CUIL" && condIvaReceptor === "RI") {
    erroresDetectados.push({
      codigo: "TIPO_DOCUMENTO_CUIL_FUERZA_CF_C9",
      campo: "TipoDocumento",
      detalle: "En integraciones e-commerce, enviar TipoDocumento='CUIL' fuerza internamente la condición 'Consumidor Final' y emite Factura B aunque el comprador sea Responsable Inscripto.",
      solucion: "Enviar siempre TipoDocumento='CUIT' cuando el comprador requiera Factura A.",
    });
  }

  // 3. Matriz Oficial AFIP: Cálculo y validación de TipoFc (FA, FB, FC)
  let tipoFcRecomendado = "FB";
  let explicacionMatrizAfip = "";

  if (condicionIvaEmisor === "MO" || condicionIvaEmisor === "EX") {
    tipoFcRecomendado = "FC";
    explicacionMatrizAfip = `Emisor es ${condicionIvaEmisor} -> corresponde siempre Factura C ('FC') sin discriminar IVA.`;
  } else if (condicionIvaEmisor === "RI") {
    if (condIvaReceptor === "RI" || condIvaReceptor === "MO") {
      tipoFcRecomendado = "FA";
      explicacionMatrizAfip = `Emisor es Responsable Inscripto y Receptor es ${condIvaReceptor} -> corresponde Factura A ('FA') con IVA discriminado (RG 5003 AFIP).`;
    } else {
      tipoFcRecomendado = "FB";
      explicacionMatrizAfip = `Emisor es Responsable Inscripto y Receptor es ${condIvaReceptor} -> corresponde Factura B ('FB').`;
    }
  }

  const tipoFcFinal = tipo_factura || tipoFcRecomendado;
  if (tipo_factura && tipo_factura !== tipoFcRecomendado && !(tipo_factura === "FCE" && tipoFcRecomendado === "FA") && !(tipo_factura === "FM" && tipoFcRecomendado === "FA")) {
    erroresDetectados.push({
      codigo: "TIPO_FACTURA_INCOMPATIBLE_AFIP",
      campo: "TipoFc",
      detalle: `Indicaste TipoFc='${tipo_factura}', pero para un emisor '${condicionIvaEmisor}' facturando a un receptor '${condIvaReceptor}' la matriz de AFIP exige '${tipoFcRecomendado}'.`,
      solucion: `Cambiar el campo 'TipoFc' a '${tipoFcRecomendado}' en el payload JSON.`,
    });
  } else {
    validacionesAprobadas.push(`Letra de comprobante validada: '${tipoFcFinal}' (${explicacionMatrizAfip}).`);
  }

  // 4. Validar Punto de Venta
  let idPuntoVentaFinal = punto_venta || 1;
  let puntosVentaCuenta = [];
  try {
    const pvs = await client.get("/puntosdeventa/search", null, 1800);
    if (Array.isArray(pvs)) {
      puntosVentaCuenta = pvs.filter((p) => p.Activo !== false);
    }
  } catch {
    // Continuar
  }

  if (puntosVentaCuenta.length > 0) {
    if (punto_venta) {
      const pvMatch = puntosVentaCuenta.find((p) => Number(p.Id) === Number(punto_venta) || Number(p.Numero) === Number(punto_venta));
      if (!pvMatch) {
        erroresDetectados.push({
          codigo: "PUNTO_VENTA_INEXISTENTE",
          campo: "PuntoVenta",
          detalle: `El punto de venta '${punto_venta}' no coincide con ningún punto de venta activo de la cuenta.`,
          solucion: `Usar uno de los puntos de venta activos: ${puntosVentaCuenta.map((p) => `ID ${p.Id} (${p.Nombre || p.Numero || "Activo"})`).join(", ")}.`,
        });
      } else {
        idPuntoVentaFinal = pvMatch.Id;
        validacionesAprobadas.push(`Punto de venta activo verificado: ID ${pvMatch.Id}.`);
      }
    } else {
      idPuntoVentaFinal = puntosVentaCuenta[0].Id;
      validacionesAprobadas.push(`Punto de venta autoseleccionado: ID ${idPuntoVentaFinal}.`);
    }
  }

  // 5. Validar Condición de Venta (Prevención Error C2)
  let condicionVentaFinal = condicion_venta;
  try {
    const conds = await client.get("/usuarios/condicionesVenta", null, 1800);
    if (Array.isArray(conds) && conds.length > 0) {
      const nombresOficiales = conds.map((c) => String(c.Nombre || c.nombre || c).trim()).filter(Boolean);
      const exactMatch = nombresOficiales.find((n) => n === condicion_venta);
      if (exactMatch) {
        validacionesAprobadas.push(`Condición de venta '${condicion_venta}' coincide exactamente con el catálogo de la cuenta.`);
      } else {
        const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, "");
        const fuzzyMatch = nombresOficiales.find((n) => norm(n) === norm(condicion_venta));
        if (fuzzyMatch) {
          advertencias.push(
            `Atención (Error C2 común en integraciones): enviaste '${condicion_venta}', pero en la cuenta está cargado como '${fuzzyMatch}'. En la API real el match es case-sensitive y sin espacios extra.`
          );
          condicionVentaFinal = fuzzyMatch;
        } else {
          erroresDetectados.push({
            codigo: "CONDICION_VENTA_INEXISTENTE_C2",
            campo: "CondicionVenta",
            detalle: `La condición de venta '${condicion_venta}' no existe en la cuenta.`,
            solucion: `Utilizar exactamente uno de los valores configurados en la cuenta: ${nombresOficiales.join(", ")}.`,
          });
        }
      }
    }
  } catch {
    // Continuar
  }

  // 6. Validar Ítems, SKUs en catálogo, Stock y calcular Totales
  let subtotalNeto = 0;
  let totalIva = 0;
  const itemsMapeados = [];
  const diagnosticoItems = [];

  for (const it of items) {
    const cant = parseAmount(it.cantidad);
    const precioUnit = parseAmount(it.precio_unitario);
    const bonif = parseAmount(it.bonificacion || 0);
    const alicuota = parseAmount(it.iva ?? 21);

    const netoItem = cant * precioUnit * (1 - bonif / 100);
    const ivaItem = condicionIvaEmisor === "MO" || condicionIvaEmisor === "EX" ? 0 : netoItem * (alicuota / 100);

    subtotalNeto += netoItem;
    totalIva += ivaItem;

    let idConceptoResuelto = it.id_concepto || null;
    let skuVerificado = false;
    let stockDisponible = null;

    if (it.codigo) {
      try {
        const prod = await client.get("/conceptos/getByCodigo", { codigo: it.codigo }, 300);
        if (prod && (prod.Id || prod.id)) {
          idConceptoResuelto = idConceptoResuelto || Number(prod.Id ?? prod.id);
          skuVerificado = true;
        } else {
          const searchRes = await client.get("/conceptos/search", { filtro: it.codigo }, 300);
          const list = Array.isArray(searchRes) ? searchRes : (searchRes?.Items || searchRes?.items || []);
          const exact = list.find((p) => String(p.Codigo || "").toLowerCase() === String(it.codigo).toLowerCase());
          if (exact) {
            idConceptoResuelto = idConceptoResuelto || Number(exact.Id ?? exact.id);
            skuVerificado = true;
          }
        }
      } catch {
        // Ignorar fallo de red
      }

      if (!skuVerificado) {
        advertencias.push(
          `El SKU '${it.codigo}' no se encontró en el catálogo de conceptos. Si vas a facturar por orden de venta (/ordenesventa/emitirFE), todos los SKUs deben existir previamente en Contabilium.`
        );
      }

      if (id_deposito) {
        try {
          const stockRes = await client.get("/inventarios/getStockBySKU", { codigo: it.codigo }, 120);
          if (stockRes && Array.isArray(stockRes.stock)) {
            const depEntry = stockRes.stock.find((s) => Number(s.Id) === Number(id_deposito));
            if (depEntry) {
              stockDisponible = Number(depEntry.StockActual || 0) - Number(depEntry.StockReservado || 0);
              if (stockDisponible < cant) {
                advertencias.push(
                  `Stock insuficiente para SKU '${it.codigo}' en depósito #${id_deposito}: solicitado ${cant}, disponible real ${stockDisponible}.`
                );
              }
            }
          }
        } catch {
          // Ignorar fallo de stock
        }
      }
    }

    itemsMapeados.push({
      IdConcepto: idConceptoResuelto,
      Concepto: it.concepto.trim(),
      Cantidad: cant,
      PrecioUnitario: precioUnit,
      Iva: alicuota,
      Bonificacion: bonif,
      Codigo: it.codigo || "",
    });

    diagnosticoItems.push({
      concepto: it.concepto.trim(),
      codigo: it.codigo || null,
      id_concepto_resuelto: idConceptoResuelto,
      sku_verificado_en_catalogo: skuVerificado,
      ...(stockDisponible !== null ? { stock_disponible_en_deposito: stockDisponible } : {}),
      cantidad: cant,
      precio_unitario_neto: precioUnit,
      bonificacion_pct: bonif,
      alicuota_iva_pct: alicuota,
      subtotal_neto: Math.round(netoItem * 100) / 100,
      importe_iva: Math.round(ivaItem * 100) / 100,
      subtotal_con_iva: Math.round((netoItem + ivaItem) * 100) / 100,
    });
  }

  subtotalNeto = Math.round(subtotalNeto * 100) / 100;
  totalIva = Math.round(totalIva * 100) / 100;
  const totalComprobante = Math.round((subtotalNeto + totalIva) * 100) / 100;

  // 7. Validar Pagos si se incluyeron
  const pagosMapeados = (pagos || []).map((p) => ({
    FormaDePago: p.forma_de_pago,
    Importe: parseAmount(p.importe),
    IdCaja: p.id_caja || null,
    IdBanco: p.id_banco || null,
    NroReferencia: p.nro_referencia || "",
  }));

  if (pagosMapeados.length > 0) {
    const sumaPagos = Math.round(pagosMapeados.reduce((acc, p) => acc + p.Importe, 0) * 100) / 100;
    if (Math.abs(sumaPagos - totalComprobante) > 0.05) {
      erroresDetectados.push({
        codigo: "DESCALCE_IMPORTE_PAGOS",
        campo: "Pagos",
        detalle: `La suma de los pagos informados (${formatCurrency(sumaPagos)}) no coincide con el total con IVA del comprobante (${formatCurrency(totalComprobante)}).`,
        solucion: `Ajustar el importe de los pagos a ${totalComprobante} o dejar 'Pagos: []' para emitir en Cuenta Corriente.`,
      });
    } else {
      validacionesAprobadas.push(`Suma de pagos verificada (${formatCurrency(sumaPagos)} coincide con el total del comprobante).`);
    }
  }

  const fechaHoy = new Date().toISOString().split("T")[0];
  const fechaEmisionEfectiva = fecha_emision || fechaHoy;
  const dVenc = new Date(fechaEmisionEfectiva + "T00:00:00Z");
  dVenc.setUTCDate(dVenc.getUTCDate() + 10);
  const fechaVencimientoEfectiva = dVenc.toISOString().split("T")[0];

  // 8. Armar los contratos HTTP de referencia listos para el integrador
  const payloadCrearBorrador = {
    IdCliente: idClienteFinal || 0,
    TipoFc: tipoFcFinal,
    PuntoVenta: idPuntoVentaFinal,
    Modo: "E",
    CondicionVenta: condicionVentaFinal,
    TipoConcepto: tipo_concepto,
    Inventario: id_deposito || 0,
    FechaEmision: `${fechaEmisionEfectiva}T00:00:00`,
    FechaVencimiento: `${fechaVencimientoEfectiva}T00:00:00`,
    Observaciones: observaciones,
    Items: itemsMapeados,
  };

  const payloadEmitirFECobrada = {
    IdCliente: idClienteFinal || 0,
    TipoFc: tipoFcFinal,
    PuntoVenta: idPuntoVentaFinal,
    Modo: "E",
    CondicionVenta: condicionVentaFinal,
    TipoConcepto: tipo_concepto,
    Inventario: id_deposito || 0,
    FechaEmision: `${fechaEmisionEfectiva}T00:00:00`,
    Observaciones: observaciones,
    Items: itemsMapeados,
    Pagos: pagosMapeados,
  };

  consejosIntegracion.push(
    "Si estás integrando un e-commerce o flujo de pedidos: NO uses POST /api/comprobantes/emitirFECobrada para facturar órdenes de venta porque deja la orden abierta (Error C1). Primero enviá la orden a POST /notificador/ecommerce, esperá 3 a 5 segundos y luego facturala con GET /api/ordenesventa/emitirFE?nro={IdVentaIntegracion}&idIntegracion={idIntegracion}.",
    "Si querés practicar guardando el comprobante en Contabilium sin enviarlo a AFIP, podés usar la tool 'crear_borrador_factura' (que llama a POST /api/comprobantes/crear y deja el comprobante en estado Borrador sin CAE)."
  );

  const guiaEndpoints = {
    opcion_1_flujo_seguro_en_dos_pasos: {
      descripcion: "Recomendado para ERPs y sistemas a medida: primero crea el borrador y luego solicita el CAE.",
      paso_1_crear_borrador: {
        metodo: "POST",
        endpoint: "/api/comprobantes/crear",
        payload_json: payloadCrearBorrador,
      },
      paso_2_autorizar_afip: {
        metodo: "GET",
        endpoint: "/api/comprobantes/emitirFE?id={idComprobanteDevueltoEnPaso1}",
      },
    },
    opcion_2_emision_directa_con_cobranza: {
      descripcion: "Para emitir y registrar el cobro en un único llamado (facturación directa sin orden de venta previa).",
      metodo: "POST",
      endpoint: "/api/comprobantes/emitirFECobrada",
      payload_json: payloadEmitirFECobrada,
    },
    ...(nro_orden_ecommerce
      ? {
          opcion_3_facturar_orden_ecommerce: {
            descripcion: "Flujo oficial para facturar una orden de venta previamente enviada por /notificador/ecommerce.",
            metodo: "GET",
            endpoint: `/api/ordenesventa/emitirFE?nro=${encodeURIComponent(nro_orden_ecommerce)}&idIntegracion=${id_integracion || "{idIntegracion}"}`,
            regla_oro: "En 'nro' enviá siempre el código externo de la orden (IdVentaIntegracion), NUNCA el ID interno numérico de Contabilium (Error C5).",
          },
        }
      : {}),
  };

  const estadoSimulacion = erroresDetectados.length === 0 ? "LISTO_PARA_INTEGRAR" : "ERRORES_DE_VALIDACION_DETECTADOS";

  const datos = {
    modo: "SIMULACION_DRY_RUN_SIN_IMPACTO_FISCAL",
    estado_simulacion: estadoSimulacion,
    emisor: {
      razon_social: razonSocialEmisor,
      condicion_iva: condicionIvaEmisor,
      tiene_fe_configurada: tieneFE,
    },
    receptor: {
      id_cliente: idClienteFinal,
      razon_social: nombreCliente,
      tipo_documento: tipoDocCliente,
      documento: docCliente || "No informado",
      condicion_iva: condIvaReceptor,
      verificado_en_padron: Boolean(clienteEncontrado),
    },
    determinacion_fiscal_afip: {
      tipo_factura_resultante: tipoFcFinal,
      tipo_factura_recomendado: tipoFcRecomendado,
      explicacion_matriz_afip: explicacionMatrizAfip,
    },
    totales_calculados: {
      subtotal_neto: subtotalNeto,
      subtotal_neto_formateado: formatCurrency(subtotalNeto),
      total_iva: totalIva,
      total_iva_formateado: formatCurrency(totalIva),
      total_comprobante: totalComprobante,
      total_comprobante_formateado: formatCurrency(totalComprobante),
    },
    items_diagnosticados: diagnosticoItems,
    validaciones_aprobadas: validacionesAprobadas,
    errores_detectados: erroresDetectados,
    contratos_api_listos_para_usar: guiaEndpoints,
    consejos_integracion: consejosIntegracion,
  };

  const resumen =
    erroresDetectados.length === 0
      ? `Simulación exitosa (Dry-Run sin emisión fiscal): corresponde ${tipoFcFinal} a '${nombreCliente}' por ${formatCurrency(totalComprobante)} (Neto: ${formatCurrency(subtotalNeto)} + IVA: ${formatCurrency(totalIva)}). Se generaron los payloads JSON validados para la API.`
      : `Simulación completada con ${erroresDetectados.length} error(es) que habrían fallado en la API real (${erroresDetectados.map((e) => e.codigo).join(", ")}). Revisá 'errores_detectados' y el payload corregido en 'contratos_api_listos_para_usar'.`;

  return formatToolResponse({
    datos,
    resumen,
    advertencias: [
      "SIMULACIÓN (DRY-RUN): Este llamado NO emitió ninguna factura ni modificó datos en Contabilium ni en AFIP.",
      ...advertencias,
    ],
    truncado: false,
  });
}
