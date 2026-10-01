import { z } from "zod";
import { formatToolResponse, parseAmount, getTodayString, validateTaxId } from "../utils.js";

export const schema = {
  sintoma: z
    .string()
    .optional()
    .default("general")
    .describe("Síntoma principal reportado por el partner o soporte (ej: 'orden_no_facturo', 'inexistente', 'letra_comprobante_incorrecta', 'error 500', 'stock_no_actualiza', etc.)."),
  referencia_externa: z.string().describe("Número o ID de la orden en la plataforma externa (IDVentaIntegracion, ej. 'FEN-10293', 'ORD-8821', '39104')."),
  id_integracion_enviado: z.number().int().optional().describe("ID de la integración enviado en la llamada (ej. 28778)."),
  parametro_nro: z.string().optional().describe("Valor exacto pasado en el parámetro 'nro' (ej. 'FEN-10293' o ID interno '28778')."),
  nro: z.union([z.string(), z.number()]).optional().describe("Alias alternativo del parámetro 'nro'."),
  canal_origen: z.string().optional().describe("Plataforma o integrador externo (ej. 'Fenicio', 'Base', 'Hezka', 'Vestetic', 'Luna', 'MercadoLibre', 'Producteca')."),
  endpoint_utilizado: z.string().optional().describe("Endpoint HTTP invocado por el partner (ej. 'ordenesventa/emitirFE', 'comprobantes/emitirFECobrada')."),
  condicion_venta: z.string().optional().describe("Nombre de la condición de venta enviada (ej. 'Mercado Pago', 'Contado')."),
  tipo_documento_enviado: z.string().optional().describe("Tipo de documento enviado en el request (ej. 'DNI', 'CUIL', 'CUIT', 'RUT')."),
  error_recibido: z.string().optional().describe("Mensaje de error, código o status retornado (ej. 'La orden de venta es inexistente', '-3', '500', '504')."),
  fecha_aproximada: z.string().optional().describe("Fecha aproximada de la compra (YYYY-MM-DD) para acotar la búsqueda."),
  cliente: z.object({
    cuit_o_dni: z.string().optional().describe("CUIT, DNI o RUT del comprador."),
    razon_social: z.string().optional().describe("Nombre o razón social del cliente."),
    condicion_iva: z.string().optional().describe("Condición frente al IVA (ej: 'RI', 'Monotributo', 'Exento', 'Consumidor Final')."),
    email: z.string().optional().describe("Email del comprador."),
    creado_por_orden: z.boolean().optional().describe("Si el cliente fue dado de alta automáticamente por esta orden."),
  }).optional().describe("Datos del cliente comprador para validar consistencia fiscal."),
  items: z.array(z.object({
    sku: z.string().describe("Código SKU del producto."),
    cantidad: z.number().positive().describe("Cantidad solicitada."),
    precio_unitario: z.number().optional().describe("Precio unitario enviado en la orden."),
  })).optional().describe("Listado de ítems de la orden para verificar catálogo y stock."),
  deposito_id: z.number().int().optional().describe("ID del depósito asignado a la integración para descontar stock."),
};

export async function handler(args, client) {
  let {
    sintoma = "general",
    referencia_externa,
    id_integracion_enviado,
    canal_origen,
    endpoint_utilizado,
    condicion_venta,
    tipo_documento_enviado,
    error_recibido,
    fecha_aproximada,
    cliente,
    items = [],
    deposito_id,
  } = args;

  const rawNro = args.parametro_nro !== undefined && args.parametro_nro !== null
    ? String(args.parametro_nro).trim()
    : args.nro !== undefined && args.nro !== null
    ? String(args.nro).trim()
    : null;

  const refUpper = (referencia_externa || "").trim().toUpperCase();
  const erroresBloqueantes = [];
  const erroresContrato = [];
  const defectosConocidos = [];
  const advertencias = [];
  const datosVerificados = [];
  const datosNoVerificados = [];
  const evidencias = {
    orden_buscada: referencia_externa,
    integraciones_consultadas: [],
    comprobantes_relacionados: [],
    borradores_asociados: [],
    catalogo_auditado: [],
    stock_auditado: [],
    deposito_auditado: null,
  };

  // ---------------------------------------------------------------------------
  // 1. BÚSQUEDA CENTRALIZADA DE LA ORDEN EN TODAS LAS INTEGRACIONES (C3, C7, C8)
  // Se busca la orden y sus comprobantes ANTES de cualquier otra regla.
  // ---------------------------------------------------------------------------
  let comprobanteEmitido = null;
  let borradorHuerfano = null;
  let ordenEncontradaEnOtraIntegracion = null;
  let ordenEncontradaEnBase = false;
  let ordenEncontrada = null;

  let fechaHasta = fecha_aproximada || getTodayString(client.country);
  const d = new Date(fechaHasta);
  d.setDate(d.getDate() - 30);
  const fechaDesde = d.toISOString().split("T")[0];

  if (id_integracion_enviado !== undefined && id_integracion_enviado !== null) {
    evidencias.integraciones_consultadas.push(Number(id_integracion_enviado));
  }

  // 1.1 Búsqueda en /ordenesVenta/search (sin forzar integración para descubrir C7)
  try {
    const ordRes = await client.get("/ordenesVenta/search", { fechaDesde, fechaHasta, filtro: referencia_externa }, 60);
    let ordList = [];
    if (Array.isArray(ordRes)) ordList = ordRes;
    else if (ordRes?.Items && Array.isArray(ordRes.Items)) ordList = ordRes.Items;
    else if (ordRes?.items && Array.isArray(ordRes.items)) ordList = ordRes.items;

    // Si también se pasó nro y es distinto de la referencia, buscar también con ese valor
    if (rawNro && rawNro.toLowerCase() !== referencia_externa.toLowerCase()) {
      try {
        const ordNroRes = await client.get("/ordenesVenta/search", { fechaDesde, fechaHasta, filtro: rawNro }, 60);
        const extraOrd = Array.isArray(ordNroRes) ? ordNroRes : (ordNroRes?.Items || ordNroRes?.items || []);
        for (const item of extraOrd) {
          if (!ordList.some((existing) => (existing.ID || existing.Id) === (item.ID || item.Id))) {
            ordList.push(item);
          }
        }
      } catch {
        // Continuar
      }
    }

    // Registrar todas las integraciones observadas en la cuenta
    for (const o of ordList) {
      const rawInt = o.IDIntegracion ?? o.IdIntegracion ?? o.idIntegracion;
      if (rawInt !== undefined && rawInt !== null && !isNaN(Number(rawInt))) {
        evidencias.integraciones_consultadas.push(Number(rawInt));
      }
    }

    // Identificar la orden coincidente
    ordenEncontrada = ordList.find((o) => {
      const numOrd = String(o.NumeroOrden || o.numeroOrden || o.IDVentaIntegracion || o.IdVentaIntegracion || o.idVentaIntegracion || o.Numero || o.numero || "").trim().toUpperCase();
      const idOrd = String(o.ID || o.Id || o.id || "").trim();
      return numOrd === refUpper || numOrd.includes(refUpper) || (rawNro && numOrd === rawNro.toUpperCase()) || idOrd === refUpper;
    });

    if (ordenEncontrada) {
      ordenEncontradaEnBase = true;
      const rawIdIntOrd = ordenEncontrada.IDIntegracion ?? ordenEncontrada.IdIntegracion ?? ordenEncontrada.idIntegracion;
      const idIntOrd = (rawIdIntOrd !== undefined && rawIdIntOrd !== null && !isNaN(Number(rawIdIntOrd))) ? Number(rawIdIntOrd) : null;
      if (idIntOrd) evidencias.integraciones_consultadas.push(idIntOrd);

      // C7: Orden registrada bajo un IDIntegracion distinto al enviado por el partner
      if (id_integracion_enviado !== undefined && id_integracion_enviado !== null && idIntOrd && idIntOrd !== Number(id_integracion_enviado)) {
        ordenEncontradaEnOtraIntegracion = idIntOrd;
      }

      // Lectura de IDComprobante y Estado de la orden
      const rawIdCompOrd = ordenEncontrada.IDComprobante ?? ordenEncontrada.IdComprobante ?? ordenEncontrada.idComprobante ?? ordenEncontrada.IDFactura;
      const numIdCompOrd = (rawIdCompOrd !== undefined && rawIdCompOrd !== null && !isNaN(Number(rawIdCompOrd))) ? Number(rawIdCompOrd) : 0;
      const estadoOrd = String(ordenEncontrada.Estado || ordenEncontrada.estado || "").trim();

      evidencias.orden_encontrada = {
        id: ordenEncontrada.ID || ordenEncontrada.Id,
        id_venta_integracion: ordenEncontrada.NumeroOrden || ordenEncontrada.IDVentaIntegracion || ordenEncontrada.IdVentaIntegracion || referencia_externa,
        id_integracion: idIntOrd,
        id_comprobante: numIdCompOrd || null,
        estado: estadoOrd || "Pendiente",
        comprador: ordenEncontrada.Comprador || ordenEncontrada.NombreCliente || ordenEncontrada.RazonSocial || null,
        documento: ordenEncontrada.NroDocumento || ordenEncontrada.NroDoc || ordenEncontrada.Cuit || null,
      };

      const esEstadoBorrador = estadoOrd.toLowerCase().includes("borrador");
      if (esEstadoBorrador) {
        borradorHuerfano = {
          id: numIdCompOrd || (ordenEncontrada.ID || ordenEncontrada.Id),
          tipo: "Borrador",
          fecha: (ordenEncontrada.FechaCreacion || ordenEncontrada.fechaCreacion || "").slice(0, 10),
          motivo: ordenEncontrada.Observaciones || "Rechazo previo de ARCA",
        };
        evidencias.borradores_asociados.push(borradorHuerfano);
      } else if (numIdCompOrd > 0 || ["finalizada", "facturada", "emitida"].includes(estadoOrd.toLowerCase())) {
        comprobanteEmitido = {
          id: numIdCompOrd || (ordenEncontrada.ID || ordenEncontrada.Id),
          numero: ordenEncontrada.Numero || `Comprobante ID ${numIdCompOrd}`,
          tipo: "Factura",
          fecha: (ordenEncontrada.FechaCreacion || ordenEncontrada.fechaCreacion || "").slice(0, 10),
          total: parseAmount(ordenEncontrada.Total || ordenEncontrada.total || 0),
        };
        evidencias.comprobantes_relacionados.push(comprobanteEmitido);
      }
    }
  } catch (err) {
    advertencias.push(`No se pudo consultar órdenes de venta: ${err.message}`);
  }

  // 1.2 Búsqueda en /comprobantes/search (por referencia externa o nro)
  try {
    const compRes = await client.get("/comprobantes/search", { fechaDesde, fechaHasta, filtro: referencia_externa }, 60);
    let compList = [];
    if (Array.isArray(compRes)) compList = compRes;
    else if (compRes?.Items && Array.isArray(compRes.Items)) compList = compRes.Items;
    else if (compRes?.items && Array.isArray(compRes.items)) compList = compRes.items;

    if (rawNro && rawNro.toLowerCase() !== referencia_externa.toLowerCase()) {
      try {
        const nroRes = await client.get("/comprobantes/search", { fechaDesde, fechaHasta, filtro: rawNro }, 60);
        const extraItems = Array.isArray(nroRes) ? nroRes : (nroRes?.Items || nroRes?.items || []);
        for (const item of extraItems) {
          if (!compList.some((existing) => existing.Id === item.Id)) {
            compList.push(item);
          }
        }
      } catch {
        // Continuar
      }
    }

    for (const c of compList) {
      const obs = String(c.Observaciones || c.observaciones || "").toUpperCase();
      const num = String(c.Numero || c.numero || "").toUpperCase();
      const orig = String(c.Origen || c.Canal || "").toUpperCase();
      const idVentaIntComp = String(c.IDVentaIntegracion || c.IdVentaIntegracion || c.RefExterna || "").toUpperCase();
      const idIntComp = Number(c.IDIntegracion || c.IdIntegracion || c.idIntegracion);
      if (idIntComp) evidencias.integraciones_consultadas.push(idIntComp);

      const matchRef = obs.includes(refUpper) || num.includes(refUpper) || idVentaIntComp.includes(refUpper) || (canal_origen && orig.includes(canal_origen.toUpperCase()) && obs.includes(refUpper));

      if (matchRef) {
        ordenEncontradaEnBase = true;
        const isBorrador = (c.TipoFc || c.tipoFc || "").toUpperCase().includes("BORRADOR") || c.IdEstado === 0 || c.Estado === "Borrador";
        if (isBorrador) {
          borradorHuerfano = c;
          comprobanteEmitido = null;
          evidencias.borradores_asociados.push({
            id: c.Id || c.id,
            tipo: c.TipoFc || c.tipoFc,
            fecha: (c.FechaEmision || c.fechaEmision || "").slice(0, 10),
            motivo: c.ErrorAFIP || c.Observaciones || "Rechazo previo",
          });
        } else {
          comprobanteEmitido = c;
          evidencias.comprobantes_relacionados.push({
            id: c.Id || c.id,
            numero: c.Numero || c.numero,
            tipo: c.TipoFc || c.tipoFc,
            fecha: (c.FechaEmision || c.fechaEmision || "").slice(0, 10),
            total: parseAmount(c.ImporteTotalNeto ?? c.Total ?? 0),
            saldo: parseAmount(c.Saldo ?? 0),
          });
        }

        if (id_integracion_enviado && idIntComp && idIntComp !== Number(id_integracion_enviado)) {
          ordenEncontradaEnOtraIntegracion = idIntComp;
        }
      }
    }

    evidencias.integraciones_consultadas = [...new Set(evidencias.integraciones_consultadas)];

    if (ordenEncontradaEnBase) {
      datosVerificados.push(`Orden o comprobante localizado en base de datos de Contabilium ('${referencia_externa}')`);
    } else {
      datosVerificados.push(`Búsqueda de orden y comprobantes en ventana ${fechaDesde} al ${fechaHasta}: sin coincidencias`);
    }
  } catch (err) {
    advertencias.push(`No se pudo consultar comprobantes: ${err.message}`);
  }

  // 1.3 Hidratación de datos del cliente e ítems desde la orden real si no fueron provistos
  if (ordenEncontrada) {
    if (!cliente && (ordenEncontrada.Comprador || ordenEncontrada.NroDocumento || ordenEncontrada.cuit)) {
      cliente = {
        razon_social: ordenEncontrada.Comprador || ordenEncontrada.NombreCliente || ordenEncontrada.RazonSocial,
        cuit_o_dni: ordenEncontrada.NroDocumento || ordenEncontrada.NroDoc || ordenEncontrada.cuit,
        condicion_iva: ordenEncontrada.CondicionIva || ordenEncontrada.condicionIva,
      };
      if (!tipo_documento_enviado && ordenEncontrada.TipoDocumento) {
        tipo_documento_enviado = ordenEncontrada.TipoDocumento;
      }
    }

    const rawOrdItems = Array.isArray(ordenEncontrada.Items) ? ordenEncontrada.Items : Array.isArray(ordenEncontrada.items) ? ordenEncontrada.items : [];
    if (items.length === 0 && rawOrdItems.length > 0) {
      items = rawOrdItems.map((it) => ({
        sku: it.Codigo || it.codigo || it.Sku || it.sku || "",
        cantidad: Number(it.Cantidad || it.cantidad || 1),
        precio_unitario: parseAmount(it.PrecioUnitario || it.precioUnitario || it.Precio || it.precio || 0),
      }));
    }
  }

  // ---------------------------------------------------------------------------
  // 2. EVALUACIÓN INMEDIATA DE ESTADO Y COMPROBANTE DE LA ORDEN (C3, C7, C8)
  // Reglas determinísticas basadas en la orden real antes de especular con datos
  // ---------------------------------------------------------------------------

  // CASO C3: Borrador huérfano vinculado a la orden tras rechazo previo de ARCA
  if (borradorHuerfano) {
    comprobanteEmitido = null;
    const borradorId = borradorHuerfano.Id || borradorHuerfano.id;
    erroresBloqueantes.push({
      tipo: "BLOQUEO_FLUJO_ARCA",
      codigo: "BORRADOR_HUERFANO_ARCA_C3",
      titulo: "La orden tiene un borrador vinculado tras rechazo previo de ARCA (Causa C3)",
      responsabilidad: "CONTABILIUM_FLUJO",
      descripcion: `El error 'La orden de venta es inexistente' se debe a que un intento previo fue rechazado por ARCA, dejando el borrador #${borradorId} vinculado y retirando la orden de la cola de pendientes.`,
      accion_recomendada: `Eliminar el borrador #${borradorId} desde el panel de comprobantes o autorizar el borrador directamente para destrabar la orden.`,
      severidad: "CRITICA",
    });
  } else if (comprobanteEmitido) {
    const errText = String(error_recibido || "").toLowerCase();
    const sintomaText = String(sintoma || "").toLowerCase();
    const esCaso500oTimeout = errText.includes("500") || errText.includes("timeout") || errText.includes("504") || sintomaText.includes("500") || sintomaText.includes("timeout");

    erroresBloqueantes.push({
      tipo: "COMPROBANTE_PREVIO_EMITIDO",
      codigo: esCaso500oTimeout ? "ORDEN_YA_FACTURADA_ASINCRONA_C8" : "COMPROBANTE_YA_EMITIDO_PREVIO",
      titulo: esCaso500oTimeout
        ? `Orden facturada asíncronamente en backend tras timeout o error 500 (Causa C8)`
        : `La orden ya fue emitida previamente en Contabilium`,
      responsabilidad: "PARTNER_REINTENTO_ASINCRONO",
      descripcion: `La orden '${referencia_externa}' ya posee un comprobante fiscal emitido (ID ${comprobanteEmitido.Id || comprobanteEmitido.id}, ${comprobanteEmitido.Numero || comprobanteEmitido.numero || ''}). ${esCaso500oTimeout ? "Si el partner recibió un error 500 o timeout 504 al llamar a emitirFE, la orden se autorizó en ARCA y se guardó de forma diferida. " : ""}Reintentar la llamada a emitirFE provocará rechazo o doble facturación.`,
      accion_recomendada: `No reintentar la emisión. La orden se encuentra emitida bajo el comprobante #${comprobanteEmitido.Numero || comprobanteEmitido.numero || comprobanteEmitido.id}.`,
      severidad: "CRITICA",
    });
  }

  // CASO C7: Orden cargada en otra integración
  if (ordenEncontradaEnOtraIntegracion) {
    erroresContrato.push({
      tipo: "ERROR_CONTRATO_PARTNER",
      codigo: "ID_INTEGRACION_INCORRECTO_C7",
      titulo: `IDIntegracion incorrecto (Causa C7: enviado ${id_integracion_enviado}, real ${ordenEncontradaEnOtraIntegracion})`,
      responsabilidad: "PARTNER",
      descripcion: `La orden '${referencia_externa}' existe en Contabilium pero está asociada a la integración ID ${ordenEncontradaEnOtraIntegracion}, mientras que la llamada se realizó con ID ${id_integracion_enviado}. Contabilium busca la orden exclusivamente dentro de la integración especificada, por lo que responde 'La orden de venta es inexistente'.`,
      accion_recomendada: `Cambiar el parámetro idIntegracion a ${ordenEncontradaEnOtraIntegracion} en la llamada del partner a /ordenesventa/emitirFE.`,
      severidad: "ALTA",
    });
  } else if (id_integracion_enviado && !ordenEncontradaEnBase && !comprobanteEmitido) {
    advertencias.push(
      `No se encontró la orden bajo la integración ID ${id_integracion_enviado}. Si la tienda cuenta con múltiples integraciones activas, verifique si la orden ingresó bajo otro idIntegracion (Causa C7).`
    );
  }

  // ---------------------------------------------------------------------------
  // 3. VALIDACIÓN DE DEPÓSITO (Si se especificó deposito_id)
  // ---------------------------------------------------------------------------
  let depositoValido = true;
  if (deposito_id !== undefined && deposito_id !== null) {
    try {
      const depositosRaw = await client.get("/inventarios/getDepositos", null, 1800);
      let listaDeps = [];
      if (Array.isArray(depositosRaw)) listaDeps = depositosRaw;
      else if (depositosRaw?.Items && Array.isArray(depositosRaw.Items)) listaDeps = depositosRaw.Items;

      const depEncontrado = listaDeps.find((d) => Number(d.Id) === Number(deposito_id));
      if (depEncontrado) {
        evidencias.deposito_auditado = { id: deposito_id, nombre: depEncontrado.Nombre, activo: depEncontrado.Activo !== false };
        datosVerificados.push(`Depósito ID ${deposito_id} existe ('${depEncontrado.Nombre}')`);
      } else {
        depositoValido = false;
        evidencias.deposito_auditado = { id: deposito_id, existe: false };
        erroresBloqueantes.push({
          tipo: "BLOQUEO_DATOS",
          codigo: "DEPOSITO_INEXISTENTE",
          titulo: `Depósito ID ${deposito_id} no existe en la cuenta`,
          responsabilidad: "PARTNER_CONFIGURACION",
          descripcion: `El depósito ID ${deposito_id} enviado en la orden no existe en el catálogo de depósitos de la cuenta de Contabilium. No se puede consultar stock ni asignar comprobantes a depósitos inexistentes.`,
          accion_recomendada: "Configurar un ID de depósito válido de la cuenta en la integración.",
          severidad: "CRITICA",
        });
      }
    } catch (err) {
      advertencias.push(`No se pudo verificar la existencia del depósito ID ${deposito_id}: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // 4. VALIDACIÓN DE CLIENTE Y FISCAL (Módulo 11 + Caso C9 y C11 verificado)
  // ---------------------------------------------------------------------------
  let clienteEnCuenta = null;
  if (cliente) {
    if (cliente.cuit_o_dni) {
      const taxVal = validateTaxId(cliente.cuit_o_dni, client.country);
      if (!taxVal.valido) {
        erroresBloqueantes.push({
          tipo: "BLOQUEO_FISCAL",
          codigo: "CLIENTE_DOCUMENTO_INVALIDO",
          titulo: "Identificación fiscal inválida ante la autoridad tributaria",
          responsabilidad: "PARTNER_DATOS",
          descripcion: `El documento fiscal '${cliente.cuit_o_dni}' del comprador es inválido: ${taxVal.motivo}. La AFIP/autoridad fiscal rechazará la autorización del CAE.`,
          accion_recomendada: "Corregir el CUIT/RUT del comprador en el pedido del e-commerce antes de intentar facturar.",
          severidad: "CRITICA",
        });
      } else {
        datosVerificados.push(`Documento fiscal '${cliente.cuit_o_dni}' válido (${taxVal.tipo})`);
      }

      // Buscar si el cliente ya existe en la base de Contabilium
      try {
        const cSearch = await client.get("/clientes/search", { filtro: cliente.cuit_o_dni.trim() }, 180);
        let cliItems = [];
        if (Array.isArray(cSearch)) cliItems = cSearch;
        else if (cSearch?.Items && Array.isArray(cSearch.Items)) cliItems = cSearch.Items;
        else if (cSearch?.items && Array.isArray(cSearch.items)) cliItems = cSearch.items;

        const foundCli = cliItems.find((c) => {
          const doc = String(c.NroDoc || c.nroDoc || c.Cuit || "").replace(/\D/g, "");
          const target = String(cliente.cuit_o_dni).replace(/\D/g, "");
          return doc === target && target.length > 0;
        });

        if (foundCli) {
          clienteEnCuenta = foundCli;
          evidencias.cliente_en_cuenta = {
            id: foundCli.Id || foundCli.id,
            razon_social: foundCli.RazonSocial || foundCli.razonSocial,
            condicion_iva: foundCli.CondicionIva || foundCli.condicionIva,
          };
          datosVerificados.push(`Cliente registrado previamente en la cuenta: ${foundCli.RazonSocial} (${foundCli.CondicionIva || 'Sin IVA definido'})`);
        }
      } catch {
        // Continuar
      }

      // CASO C9 (API-1156): CUIL o DNI enviado para receptor
      const tipoDoc = (tipo_documento_enviado || "").toUpperCase();
      const condicionDestino = (cliente.condicion_iva || clienteEnCuenta?.CondicionIva || "").toUpperCase();
      const esReceptorRI = condicionDestino.includes("RESPONSABLE INSCRIPTO") || condicionDestino === "RI";

      if ((tipoDoc === "CUIL" || tipoDoc === "DNI") || (tipoDoc !== "CUIT" && tipoDoc.length > 0 && esReceptorRI)) {
        if (esReceptorRI || tipoDoc === "CUIL") {
          let tituloC9;
          let descC9;

          if (esReceptorRI) {
            tituloC9 = "TipoDocumento CUIL/DNI enviado para cliente Responsable Inscripto (Causa C9 / API-1156)";
            descC9 = `El partner envió TipoDocumento: '${tipo_documento_enviado || 'CUIL'}' para un cliente con condición Responsable Inscripto. El padrón tributario de AFIP resuelve CUIL/DNI forzando Consumidor Final, emitiendo Factura B en lugar de la Factura A requerida por un Responsable Inscripto.`;
          } else {
            tituloC9 = "TipoDocumento 'CUIL' fuerza condición de Consumidor Final y emisión de Factura B (Causa C9 / API-1156)";
            descC9 = `El partner envió TipoDocumento: '${tipo_documento_enviado || 'CUIL'}'. En Contabilium, el envío de CUIL/DNI fuerza automáticamente la emisión de Factura B como Consumidor Final. Si el comprador requiere Factura A (Responsable Inscripto), el payload debe enviar 'TipoDocumento: CUIT' y el CUIT correspondiente.`;
          }

          erroresContrato.push({
            tipo: "ERROR_CONTRATO_PARTNER",
            codigo: "TIPO_DOCUMENTO_INCOMPATIBLE_C9",
            titulo: tituloC9,
            responsabilidad: "PARTNER",
            descripcion: descC9,
            accion_recomendada: "Enviar 'TipoDocumento: CUIT' y el CUIT de facturación en el payload de la orden.",
            severidad: "ALTA",
          });
        }
      }

      // DEF-C11 (API-1278): Alta automática con CUIT asigna Consumidor Final (SOLO si se cumplen las condiciones verificadas)
      const docClean = cliente.cuit_o_dni.replace(/\D/g, "");
      const esCuitReal = docClean.length === 11 && (tipo_documento_enviado || "CUIT").toUpperCase() === "CUIT";
      const esAltaAutomatica = cliente.creado_por_orden === true || (!clienteEnCuenta && cliente.condicion_iva?.toLowerCase().includes("consumidor final"));
      const condicionAsignadaCF = (cliente.condicion_iva || "").toLowerCase().includes("consumidor final");

      if (esCuitReal && esAltaAutomatica && condicionAsignadaCF && !clienteEnCuenta) {
        defectosConocidos.push({
          tipo: "DEFECTO_CONOCIDO_PRODUCTO",
          codigo: "DEF-C11",
          titulo: "Alta automática de clientes con CUIT asigna 'Consumidor Final'",
          ticket_jira: "API-1278",
          responsabilidad: "CONTABILIUM",
          descripcion: "Defecto comprobado en el backend de Contabilium: el alta automática de clientes con CUIT asignó la condición 'Consumidor Final' en lugar de la condición fiscal real de AFIP, emitiendo Factura B.",
          accion_recomendada: "Modificar manualmente la condición fiscal en la ficha del cliente en Contabilium y refacturar con Nota de Crédito.",
          severidad: "ALTA",
        });
      }
    }
  } else {
    datosNoVerificados.push("Datos fiscales del cliente (no provistos en la consulta)");
  }

  // ---------------------------------------------------------------------------
  // 5. VALIDACIÓN DE CATÁLOGO Y STOCK (Con verificación estricta de C15)
  // ---------------------------------------------------------------------------
  const productosEncontrados = new Map();
  if (items.length > 0) {
    for (const it of items) {
      const sku = (it.sku || "").trim();
      const skuUpper = sku.toUpperCase();

      try {
        const pSearch = await client.get("/conceptos/search", { filtro: sku }, 300);
        let pItems = [];
        if (Array.isArray(pSearch)) pItems = pSearch;
        else if (pSearch?.Items && Array.isArray(pSearch.Items)) pItems = pSearch.Items;
        else if (pSearch?.items && Array.isArray(pSearch.items)) pItems = pSearch.items;

        const exactProduct = pItems.find((p) => String(p.Codigo || p.codigo || "").trim().toUpperCase() === skuUpper);

        if (exactProduct) {
          const estado = exactProduct.Estado || exactProduct.estado;
          const activo = exactProduct.Activo ?? exactProduct.activo ?? true;
          const isActivo = estado !== "I" && activo !== false;

          evidencias.catalogo_auditado.push({
            sku,
            id: exactProduct.Id || exactProduct.id,
            nombre: exactProduct.Nombre || exactProduct.nombre,
            activo: isActivo,
          });
          datosVerificados.push(`SKU '${sku}' existe en catálogo ('${exactProduct.Nombre}')`);

          if (!isActivo) {
            erroresBloqueantes.push({
              tipo: "BLOQUEO_CATALOGO",
              codigo: "SKU_INACTIVO",
              titulo: `Producto SKU '${sku}' inactivo en Contabilium`,
              responsabilidad: "CONTABILIUM_CATALOGO",
              descripcion: `El producto '${sku}' (${exactProduct.Nombre || exactProduct.nombre}) está inactivo en el maestro de artículos de Contabilium.`,
              accion_recomendada: "Reactivar el producto desde el módulo de Conceptos.",
              severidad: "ALTA",
            });
          }

          productosEncontrados.set(skuUpper, exactProduct);
        } else {
          erroresBloqueantes.push({
            tipo: "BLOQUEO_CATALOGO",
            codigo: "SKU_INEXISTENTE",
            titulo: `Producto SKU '${sku}' no existe en catálogo de Contabilium`,
            responsabilidad: "PARTNER_CATALOGO",
            descripcion: `El SKU '${sku}' enviado en la orden no existe en el catálogo de productos de Contabilium. La orden no se puede facturar sin que todos sus productos estén dados de alta.`,
            accion_recomendada: "Dar de alta el SKU en Contabilium o sincronizar catálogo con la tienda.",
            severidad: "CRITICA",
          });
        }
      } catch (err) {
        advertencias.push(`No se pudo verificar el SKU '${sku}': ${err.message}`);
      }

      // Validar stock si el depósito es válido
      if (depositoValido) {
        try {
          const stockParams = { codigo: sku };
          if (deposito_id) stockParams.idDeposito = deposito_id;

          const stockRes = await client.get("/inventarios/getStockBySKU", stockParams, 60);
          if (stockRes) {
            let stockData = stockRes;
            if (Array.isArray(stockRes)) {
              if (deposito_id) {
                stockData = stockRes.find((s) => Number(s.IdDeposito || s.idDeposito) === Number(deposito_id)) || stockRes[0];
              } else {
                stockData = stockRes[0];
              }
            }

            const actual = parseAmount(stockData.StockActual ?? stockData.stockActual ?? 0);
            const reservado = parseAmount(stockData.StockReservado ?? stockData.stockReservado ?? 0);
            const disponible = actual - reservado;

            evidencias.stock_auditado.push({
              sku,
              stock_actual: actual,
              stock_reservado: reservado,
              disponible,
              stock_con_reservas_api: stockData.StockConReservas ?? stockData.stockConReservas ?? null,
            });

            // REGLA ESTRICTA C15: Exige que haya reservas activas, que superen el stock y que StockConReservas sea 0
            const stockConReservasRaw = stockData.StockConReservas ?? stockData.stockConReservas;
            const tieneSobreventaReal = reservado > 0 && reservado > actual;
            const truncadoEnCero = stockConReservasRaw !== undefined && parseAmount(stockConReservasRaw) === 0;

            if (tieneSobreventaReal && truncadoEnCero) {
              defectosConocidos.push({
                tipo: "DEFECTO_CONOCIDO_PRODUCTO",
                codigo: "DEF-C15",
                titulo: "StockConReservas truncado en 0 por sobreventa en backend",
                ticket_jira: "API-1256",
                responsabilidad: "CONTABILIUM",
                descripcion: `Para el SKU '${sku}', las reservas (${reservado}) superan el stock físico (${actual}), pero el endpoint devolvió 0 en StockConReservas en vez del saldo negativo, induciendo sobreventa.`,
                accion_recomendada: "Ajustar stock físico en depósito o sincronizar stock disponible neto.",
                severidad: "ALTA",
              });
            }

            if (disponible < it.cantidad) {
              erroresBloqueantes.push({
                tipo: "BLOQUEO_STOCK",
                codigo: "STOCK_INSUFICIENTE",
                titulo: `Stock insuficiente para SKU '${sku}'`,
                responsabilidad: "OPERACIONES_STOCK",
                descripcion: `Stock insuficiente para '${sku}': solicitado ${it.cantidad}, disponible ${disponible} (Físico: ${actual}, Reservas: ${reservado}).`,
                accion_recomendada: "Ingresar mercadería o ajustar stock en el depósito asignado a la integración.",
                severidad: "ALTA",
              });
            }
          }
        } catch (err) {
          advertencias.push(`No se pudo verificar el stock para '${sku}': ${err.message}`);
        }
      }
    }
  } else {
    datosNoVerificados.push("SKUs e ítems de la orden (no provistos en la consulta)");
  }

  // ---------------------------------------------------------------------------
  // 6. VALIDACIÓN DE CONTRATO (C1, C2, C5, C12)
  // ---------------------------------------------------------------------------
  // CASO C1: Endpoint emitirFECobrada
  if (endpoint_utilizado) {
    const ep = endpoint_utilizado.toLowerCase().replace(/^\/+/, "");
    if (ep.includes("comprobantes/emitirfecobrada")) {
      erroresContrato.push({
        tipo: "ERROR_CONTRATO_PARTNER",
        codigo: "ENDPOINT_INCORRECTO_C1",
        titulo: "Uso de comprobantes/emitirFECobrada en vez de ordenesventa/emitirFE (Causa C1)",
        responsabilidad: "PARTNER",
        descripcion: "El partner invocó 'comprobantes/emitirFECobrada', que genera una factura suelta pero no pasa la orden de venta al estado 'Facturada'.",
        accion_recomendada: "Cambiar la invocación al endpoint 'ordenesventa/emitirFE'.",
        severidad: "CRITICA",
      });
    }
  }

  // CASO C2: Condición de venta consultando /usuarios/condicionesVenta
  if (condicion_venta) {
    try {
      const condList = await client.get("/usuarios/condicionesVenta", null, 1800);
      let listaCond = [];
      if (Array.isArray(condList)) listaCond = condList;
      else if (condList?.Items && Array.isArray(condList.Items)) listaCond = condList.Items;
      else if (condList?.items && Array.isArray(condList.items)) listaCond = condList.items;

      if (listaCond.length > 0) {
        const exactMatch = listaCond.some((c) => (c.Nombre || c.nombre || "").trim() === condicion_venta.trim());
        if (!exactMatch) {
          const similar = listaCond.find((c) => (c.Nombre || c.nombre || "").replace(/\s+/g, "").toLowerCase() === condicion_venta.replace(/\s+/g, "").toLowerCase());
          const nombresDisponibles = listaCond.map((c) => `'${c.Nombre || c.nombre}'`).join(", ");

          erroresContrato.push({
            tipo: "ERROR_CONTRATO_PARTNER",
            codigo: "CONDICION_VENTA_NO_COINCIDE_C2",
            titulo: "Discrepancia en nombre de Condición de Venta (Causa C2)",
            responsabilidad: "PARTNER",
            descripcion: `La condición de venta '${condicion_venta}' enviada por el partner no coincide exactamente con las configuradas en la cuenta de Contabilium.${similar ? ` Nombre exacto configurado: '${similar.Nombre || similar.nombre}'.` : ` Opciones disponibles: ${nombresDisponibles}.`}`,
            accion_recomendada: similar ? `Cambiar el valor a '${similar.Nombre || similar.nombre}' (respetando espacios y mayúsculas).` : `Dar de alta la condición de venta en Contabilium o usar una existente: ${nombresDisponibles}.`,
            severidad: "ALTA",
          });
        } else {
          datosVerificados.push(`Condición de venta '${condicion_venta}' coincide exactamente con la cuenta`);
        }
      }
    } catch (err) {
      advertencias.push(`No se pudo validar la condición de venta: ${err.message}`);
    }
  }

  // CASO C5: Confusión en parámetro nro (IDVentaIntegracion vs ID interno)
  if (rawNro && rawNro.toLowerCase() !== referencia_externa.toLowerCase()) {
    erroresContrato.push({
      tipo: "ERROR_CONTRATO_PARTNER",
      codigo: "CONFUSION_PARAMETRO_NRO_C5",
      titulo: "Parámetro 'nro' enviado difiere de la referencia externa de la orden (Causa C5)",
      responsabilidad: "PARTNER",
      descripcion: `El parámetro 'nro' enviado ('${rawNro}') difiere de la referencia externa de la orden ('${referencia_externa}'). El contrato de ordenesventa/emitirFE espera el IDVentaIntegracion ('${referencia_externa}') en el parámetro 'nro'. Enviar un ID interno u otro valor provoca que Contabilium busque una orden que no existe y devuelva el error 'La orden de venta es inexistente'.`,
      accion_recomendada: `Enviar nro: '${referencia_externa}' (el IDVentaIntegracion / referencia externa) en la invocación a ordenesventa/emitirFE.`,
      severidad: "ALTA",
    });
  }

  // CASO C12: Código -3 retornado
  if (error_recibido && error_recibido.includes("-3")) {
    erroresContrato.push({
      tipo: "ERROR_CONTRATO_PARTNER",
      codigo: "TIPO_INTEGRACION_O_FECHA_INVALIDA_C12",
      titulo: "Código de error -3 en /notificador/ecommerce (Causa C12)",
      responsabilidad: "PARTNER",
      descripcion: "El código -3 suele documentarse como 'la fecha no es válida', pero en integraciones personalizadas ocurre cuando el tipo de integración no admite ese payload o la integración fue deshabilitada.",
      accion_recomendada: "Verificar el tipo de integración configurado para el canal y contrastar el formato de fechas con la documentación técnica.",
      severidad: "ALTA",
    });
  }

  // ---------------------------------------------------------------------------
  // 7. DEFECTO CONOCIDO C6 (Catch silencioso de 500)
  // REGLA ESTRICTA: C6 SOLO PUEDE DISPARARSE DESPUÉS DE BUSCAR LA ORDEN Y
  // DESCARTAR C3, C5, C7 Y C8, Y REQUIERE QUE LA ORDEN HAYA SIDO LOCALIZADA.
  // ---------------------------------------------------------------------------
  const tieneC3 = erroresBloqueantes.some((e) => e.codigo === "BORRADOR_HUERFANO_ARCA_C3");
  const tieneC5 = erroresContrato.some((e) => e.codigo === "CONFUSION_PARAMETRO_NRO_C5");
  const tieneC7 = erroresContrato.some((e) => e.codigo === "ID_INTEGRACION_INCORRECTO_C7");

  if (ordenEncontradaEnBase && !tieneC3 && !tieneC5 && !tieneC7 && !comprobanteEmitido) {
    const errText = String(error_recibido || "").toLowerCase();
    if (errText.includes("500") || (errText.includes("inexistente") && ((canal_origen || "").toLowerCase().includes("hezka") || (canal_origen || "").toLowerCase().includes("base")))) {
      defectosConocidos.push({
        tipo: "DEFECTO_CONOCIDO_PRODUCTO",
        codigo: "DEF-C6",
        titulo: "Catch silencioso en backend ante error 500 sin traza en Grafana (Hezka / API-1145)",
        ticket_jira: "API-1145",
        responsabilidad: "CONTABILIUM",
        descripcion: `Para la orden '${referencia_externa}', la orden fue confirmada en la base de datos de la cuenta pero la llamada a emitirFE falló debido a un bloque catch silencioso en el backend sin traza en Grafana.`,
        accion_recomendada: "Escalar a Desarrollo con número de orden y fecha para revisión de base de datos primaria.",
        severidad: "ALTA",
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 8. PRIORIZACIÓN ESTRICTA DEL ESTADO GENERAL (Jerarquía Obligatoria)
  // ---------------------------------------------------------------------------
  let estado = "SIN_DIAGNOSTICO_CON_INFORMACION_DISPONIBLE";
  let resumen = "";
  const accionesRecomendadas = [];
  const datosFaltantesFase2 = [];

  const todasLasCausas = [...erroresBloqueantes, ...erroresContrato, ...defectosConocidos];

  if (comprobanteEmitido && !borradorHuerfano) {
    // Si la orden ya está facturada (C8 o comprobante emitido previo), es un hallazgo concluyente
    estado = "COMPROBANTE_YA_EMITIDO";
    resumen = `La orden ${referencia_externa} ya fue emitida previamente en Contabilium (Comprobante ${comprobanteEmitido.tipo || comprobanteEmitido.TipoFc || 'Factura'} #${comprobanteEmitido.numero || comprobanteEmitido.Numero || comprobanteEmitido.id}). No se debe reintentar la emisión.`;
    accionesRecomendadas.push("Verificar en el canal de venta si la orden ya registró el comprobante para evitar doble facturación.");
  } else if (erroresBloqueantes.length > 0) {
    // PRIORIDAD 1: Errores bloqueantes de datos (CUIT inválido, depósito inexistente, SKU inexistente, stock, borrador C3)
    estado = "BLOQUEANTE_DETECTADO";
    resumen = `Se detectaron ${erroresBloqueantes.length} problema(s) bloqueante(s) de datos: ${erroresBloqueantes.map((e) => e.titulo).join("; ")}.`;
  } else if (erroresContrato.length > 0) {
    // PRIORIDAD 2: Errores de contrato del partner (C1, C2, C5, C7, C9, C12)
    estado = "ERROR_CONTRATO_PARTNER";
    resumen = `Se identificaron ${erroresContrato.length} error(es) de contrato en la llamada del partner: ${erroresContrato.map((e) => e.titulo).join("; ")}.`;
  } else if (defectosConocidos.length > 0) {
    // PRIORIDAD 3: Defectos conocidos de Contabilium (solo si verificados)
    estado = "DEFECTO_CONOCIDO_PRODUCTO";
    resumen = `Se identificó un defecto o limitación conocida de Contabilium: ${defectosConocidos.map((e) => e.titulo).join("; ")}.`;
  } else {
    // PRIORIDAD 4: Sin diagnóstico con la información disponible (Leitex / Fase 2)
    estado = "SIN_DIAGNOSTICO_CON_INFORMACION_DISPONIBLE";
    
    // Descripción exacta de lo que SÍ y lo que NO se verificó (sin inventar afirmaciones)
    const verifTexto = datosVerificados.length > 0 ? `Verificaciones realizadas: ${datosVerificados.join("; ")}.` : "No se encontraron órdenes ni comprobantes previos en la ventana analizada.";
    const faltanTexto = datosNoVerificados.length > 0 ? ` No provistos en la consulta: ${datosNoVerificados.join(", ")}.` : "";
    
    resumen = `Con la información disponible en Contabilium no se detectaron errores locales ni una causa concluyente para la orden ${referencia_externa}. ${verifTexto}${faltanTexto} Se requiere telemetría de infraestructura (Fase 2) para determinar la causa raíz.`;

    datosFaltantesFase2.push("Request HTTP crudo enviado por el partner (headers, endpoint exacto y payload JSON).");
    datosFaltantesFase2.push("Verificación en logs de nginx (access_rest.contabilium.log en Grafana) filtrado por IDIntegracion para confirmar si la llamada llegó a Contabilium.");
    datosFaltantesFase2.push("Logs del servicio de notificaciones salientes / RabbitMQ para confirmar si salieron los callbacks y si el partner invocó /getInfoForEcommerce (Caso C14).");

    accionesRecomendadas.push("No asumir error del partner sin evidencia de logs: solicitar al partner el timestamp y código HTTP retornado, y revisar en Grafana si hubo arribo de la petición.");
  }

  for (const c of todasLasCausas) {
    if (c.accion_recomendada) accionesRecomendadas.push(c.accion_recomendada);
  }

  const checks = {
    comprobante_previo: comprobanteEmitido ? {
      encontrado: true,
      id: comprobanteEmitido.Id || comprobanteEmitido.id,
      numero: comprobanteEmitido.Numero || comprobanteEmitido.numero,
      tipo: comprobanteEmitido.TipoFc || comprobanteEmitido.tipoFc || comprobanteEmitido.tipo,
      fecha: (comprobanteEmitido.FechaEmision || comprobanteEmitido.fechaEmision || comprobanteEmitido.fecha || "").slice(0, 10),
      total: parseAmount(comprobanteEmitido.ImporteTotalNeto ?? comprobanteEmitido.Total ?? comprobanteEmitido.total ?? 0),
      saldo: parseAmount(comprobanteEmitido.Saldo ?? comprobanteEmitido.saldo ?? 0),
    } : { encontrado: false },
    validacion_cliente: evidencias.cliente_en_cuenta,
    validacion_catalogo: evidencias.catalogo_auditado,
    validacion_stock: evidencias.stock_auditado,
    validacion_deposito: evidencias.deposito_auditado,
  };

  const datos = {
    sintoma,
    referencia_externa,
    canal_origen: canal_origen || "Sin especificar",
    estado,
    causas_detectadas: todasLasCausas,
    bloqueantes: erroresBloqueantes,
    errores_contrato: erroresContrato,
    defectos_conocidos: defectosConocidos,
    evidencias,
    checks,
    datos_verificados: datosVerificados,
    datos_no_verificados: datosNoVerificados,
    advertencias,
    datos_faltantes_fase_2: datosFaltantesFase2,
    acciones_recomendadas: [...new Set(accionesRecomendadas)],
  };

  return formatToolResponse({
    datos,
    resumen,
    advertencias: advertencias.concat(todasLasCausas.map((c) => `${c.codigo}: ${c.descripcion}`)),
    truncado: false,
  });
}
