import { z } from "zod";
import { formatToolResponse, parseAmount, getTodayString, validateTaxId } from "../utils.js";

/**
 * Catálogo Canónico de Defectos Conocidos y Limitaciones del Producto (Auditoría C6, C11, C13, C15, C16, C17, C18).
 * Se consultan antes de diagnosticar para no culpar al partner de fallas conocidas de Contabilium.
 */
const DEFECTOS_CONOCIDOS = [
  {
    codigo: "DEF-C11",
    titulo: "Alta automática de clientes con CUIT asigna 'Consumidor Final'",
    ticket: "API-1278",
    responsabilidad: "CONTABILIUM",
    aplica: ({ cliente, tipo_documento_enviado }) => {
      const doc = cliente?.cuit_o_dni || "";
      const isCuit = doc.replace(/\D/g, "").length === 11 || (tipo_documento_enviado || "").toUpperCase() === "CUIT";
      const cond = (cliente?.condicion_iva || "").toLowerCase();
      return isCuit && (cond.includes("consumidor final") || cond.includes("cf"));
    },
    explicacion: "Defecto en el servicio de alta automática de clientes: cuando una orden crea un cliente nuevo con CUIT válido, Contabilium le asigna por defecto 'Consumidor Final' en lugar de Responsable Inscripto/Monotributo, forzando la emisión de Factura B errónea.",
    accion_soporte: "Corregir manualmente la condición fiscal en la ficha del cliente en Contabilium y refacturar con Nota de Crédito.",
  },
  {
    codigo: "DEF-C15",
    titulo: "StockConReservas truncado en 0 ante sobreventas en vez de devolver saldo negativo",
    ticket: "API-1256",
    responsabilidad: "CONTABILIUM",
    aplica: ({ stock_actual, stock_reservado, stock_reportado }) => {
      return stock_reservado > stock_actual && parseAmount(stock_reportado) === 0;
    },
    explicacion: "Defecto en endpoint /conceptos/getByCodigo y /notificador/ecommerce: la propiedad StockConReservas trunca en 0 cuando las reservas superan el stock físico disponible en vez de reportar el valor negativo real, lo que induce sobreventas en la tienda online.",
    accion_soporte: "Alinear stock físico en depósito o consultar disponibilidad mediante /inventarios/getStockBySKU.",
  },
  {
    codigo: "DEF-C17",
    titulo: "NC automática de MercadoLibre rechazada por correlatividad de fecha en ARCA",
    ticket: "API-1151",
    responsabilidad: "EXTERNA_ARCA_CONTABILIUM",
    aplica: ({ canal_origen, error_recibido, fecha_aproximada }) => {
      const isMeli = (canal_origen || "").toLowerCase().includes("mercadolibre") || (canal_origen || "").toLowerCase().includes("meli");
      const err = (error_recibido || "").toLowerCase();
      return isMeli && (err.includes("fecha") || err.includes("correlatividad") || err.includes("arca") || err.includes("afip") || err.includes("borrador"));
    },
    explicacion: "Las Notas de Crédito automáticas de devoluciones en MercadoLibre se generan con la fecha original de la venta. Si ya se emitieron comprobantes posteriores en el mismo Punto de Venta, ARCA rechaza la autorización por correlatividad temporal y la NC queda huérfana en estado borrador.",
    accion_soporte: "Emitir manualmente la Nota de Crédito desde el panel de comprobantes asignando la fecha del día actual.",
  },
  {
    codigo: "DEF-C13",
    titulo: "Incidente histórico en servicio de notificaciones salientes (Eventos no enviados pre-25/8)",
    ticket: "API-1206, 1261",
    responsabilidad: "CONTABILIUM",
    aplica: ({ fecha_aproximada, canal_origen }) => {
      if (!fecha_aproximada) return false;
      const isLuna = (canal_origen || "").toLowerCase().includes("luna");
      return isLuna && fecha_aproximada < "2026-08-25";
    },
    explicacion: "Falla documentada en el microservicio de notificaciones salientes corregida el 25/8/2026. Los cambios de precio/stock ocurridos en esa ventana temporal quedaron sin enviar al partner.",
    accion_soporte: "Guardar o modificar levemente los productos afectados en Contabilium para forzar el reenvío del evento al webhook.",
  },
  {
    codigo: "DEF-C16",
    titulo: "Canal de venta vacío por arquitectura unificada de Producteca",
    ticket: "API-1239",
    responsabilidad: "INTEGRADOR_PRODUCTECA",
    aplica: ({ canal_origen }) => {
      return (canal_origen || "").toLowerCase().includes("producteca");
    },
    explicacion: "Producteca utiliza un único IDIntegracion para todos sus canales y marketplaces asociados, omitiendo el campo Canal en el payload estándar. El nombre del canal suele viajar dentro del campo Observaciones.",
    accion_soporte: "Configurar el lector para extraer el canal de venta secundario desde el texto de Observaciones.",
  },
  {
    codigo: "DEF-C18",
    titulo: "Degradación y timeout 504 por consulta de lotes masivos de catálogo (>500 ítems)",
    ticket: "API-1123",
    responsabilidad: "CONTABILIUM_LIMITACION",
    aplica: ({ error_recibido }) => {
      const err = (error_recibido || "").toLowerCase();
      return err.includes("504") || err.includes("gateway timeout") || err.includes("tiempo de espera");
    },
    explicacion: "Los endpoints de sincronización de e-commerce degradan su tiempo de respuesta por encima de 500 ítems por página, provocando timeout 504 en Cloudflare.",
    accion_soporte: "Configurar la paginación del partner en lotes máximos de 100 a 200 productos por petición.",
  },
  {
    codigo: "DEF-C6",
    titulo: "Catch silencioso en backend ante error 500 sin traza en Grafana (Hezka)",
    ticket: "API-1145",
    responsabilidad: "CONTABILIUM",
    aplica: ({ canal_origen, error_recibido }) => {
      const isHezka = (canal_origen || "").toLowerCase().includes("hezka") || (canal_origen || "").toLowerCase().includes("base");
      const err = (error_recibido || "").toLowerCase();
      return isHezka && (err.includes("500") || err.includes("inexistente"));
    },
    explicacion: "Defecto conocido bajo investigación en backend: ciertas órdenes existentes entran en un bloque catch no instrumentado en Grafana que retorna error 500 o 'inexistente' a pesar de reintentos con backoff.",
    accion_soporte: "Escalar a Desarrollo con fecha y número de orden exacto para revisión de base de datos primaria.",
  }
];

export const schema = {
  referencia_externa: z.string().describe("Número o ID de la orden en la plataforma externa (ej. 'FEN-10293', 'ORD-8821', '39104')."),
  id_integracion_enviado: z.number().int().optional().describe("ID de la integración enviado en la llamada (ej. 28778)."),
  parametro_nro: z.string().optional().describe("Valor exacto pasado en el parámetro 'nro' (ej. 'FEN-10293' o ID numérico interno '2741')."),
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
  }).optional().describe("Datos del cliente comprador para validar consistencia fiscal."),
  items: z.array(z.object({
    sku: z.string().describe("Código SKU del producto."),
    cantidad: z.number().positive().describe("Cantidad solicitada."),
    precio_unitario: z.number().optional().describe("Precio unitario enviado en la orden."),
  })).optional().describe("Listado de ítems de la orden para verificar catálogo y stock."),
  deposito_id: z.number().int().optional().describe("ID del depósito asignado a la integración para descontar stock."),
};

export async function handler(args, client) {
  const {
    referencia_externa,
    id_integracion_enviado,
    parametro_nro,
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

  const refUpper = (referencia_externa || "").trim().toUpperCase();
  const causasDetectadas = [];
  const advertencias = [];
  const evidencias = {
    orden_buscada: referencia_externa,
    integraciones_consultadas: [],
    comprobantes_relacionados: [],
    borradores_asociados: [],
    catalogo_auditado: [],
    stock_auditado: [],
  };

  // ---------------------------------------------------------------------------
  // PASO 0: Consulta de Defectos Conocidos (Known Product Issues)
  // ---------------------------------------------------------------------------
  for (const def of DEFECTOS_CONOCIDOS) {
    if (def.aplica({ cliente, tipo_documento_enviado, canal_origen, error_recibido, fecha_aproximada })) {
      causasDetectadas.push({
        tipo: "DEFECTO_CONOCIDO_PRODUCTO",
        codigo: def.codigo,
        titulo: def.titulo,
        ticket_jira: def.ticket,
        responsabilidad: def.responsabilidad,
        descripcion: def.explicacion,
        accion_recomendada: def.accion_soporte,
        severidad: "ALTA",
      });
    }
  }

  // ---------------------------------------------------------------------------
  // PASO 1: Validación de Contrato y Reglas de Integración (C1, C2, C5, C12)
  // ---------------------------------------------------------------------------
  // C1: Uso de emitirFECobrada en lugar de ordenesventa/emitirFE
  if (endpoint_utilizado) {
    const epClean = endpoint_utilizado.toLowerCase().replace(/^\/+/, "");
    if (epClean.includes("comprobantes/emitirfecobrada")) {
      causasDetectadas.push({
        tipo: "ERROR_CONTRATO_PARTNER",
        codigo: "ENDPOINT_INCORRECTO_C1",
        titulo: "Uso de comprobantes/emitirFECobrada en lugar de ordenesventa/emitirFE",
        responsabilidad: "PARTNER",
        descripcion: "El partner invocó 'comprobantes/emitirFECobrada', el cual genera una factura suelta pero NO actualiza el estado de la orden de venta en Contabilium (la orden queda pendiente de facturar).",
        accion_recomendada: "Cambiar la llamada en la integración al endpoint 'ordenesventa/emitirFE' para vincular la factura a la orden.",
        severidad: "CRITICA",
      });
    }
  }

  // C2: Validación de Condición de Venta exacta
  if (condicion_venta) {
    try {
      const condList = await client.get("/opciones/condiciones-venta", null, 1800);
      if (Array.isArray(condList) && condList.length > 0) {
        const exactMatch = condList.some((c) => (c.Nombre || c.nombre || "").trim() === condicion_venta.trim());
        if (!exactMatch) {
          const similar = condList.find((c) => (c.Nombre || c.nombre || "").replace(/\s+/g, "").toLowerCase() === condicion_venta.replace(/\s+/g, "").toLowerCase());
          causasDetectadas.push({
            tipo: "ERROR_CONTRATO_PARTNER",
            codigo: "CONDICION_VENTA_NO_COINCIDE_C2",
            titulo: "Discrepancia en nombre de Condición de Venta",
            responsabilidad: "PARTNER",
            descripcion: `La condición de venta '${condicion_venta}' enviada por el partner no coincide de forma exacta con las configuradas en la cuenta.${similar ? ` Nombre exacto en Contabilium: '${similar.Nombre || similar.nombre}'.` : ""}`,
            accion_recomendada: similar ? `Enviar '${similar.Nombre || similar.nombre}' con exacta coincidencia de caracteres y espacios.` : "Dar de alta la condición de venta en la configuración de la cuenta.",
            severidad: "ALTA",
          });
        }
      }
    } catch {
      // Si el endpoint de opciones no responde, continuar
    }
  }

  // C12: Código -3 o fecha inválida por tipo de integración
  if (error_recibido) {
    const errText = String(error_recibido).toLowerCase();
    if (errText.includes("-3") || (errText.includes("fecha") && errText.includes("no es válida"))) {
      causasDetectadas.push({
        tipo: "ERROR_CONTRATO_PARTNER",
        codigo: "TIPO_INTEGRACION_O_FECHA_INVALIDA_C12",
        titulo: "Código -3: Tipo de integración no compatible o formato de fecha erróneo",
        responsabilidad: "PARTNER",
        descripcion: "El código de retorno -3 en /notificador/ecommerce suele ocurrir si el IDIntegracion corresponde a una integración nativa de pasarela (ej. MercadoPago) en vez de un e-commerce genérico, o si la fecha no cumple el formato 'AAAA-MM-DDThh-mm'.",
        accion_recomendada: "Verificar que el IDIntegracion sea de tipo e-commerce y que la fecha de la venta use formato ISO con guiones (AAAA-MM-DDThh-mm).",
        severidad: "ALTA",
      });
    }
  }

  // C5: Confusión de parámetro 'nro' (ID interno vs IDVentaIntegracion)
  if (parametro_nro) {
    const isPurelyNumeric = /^\d{1,8}$/.test(String(parametro_nro).trim());
    if (isPurelyNumeric && referencia_externa && String(parametro_nro).trim() !== String(referencia_externa).trim()) {
      causasDetectadas.push({
        tipo: "ERROR_CONTRATO_PARTNER",
        codigo: "CONFUSION_PARAMETRO_NRO_C5",
        titulo: "Parámetro 'nro' con ID interno en vez de IDVentaIntegracion",
        responsabilidad: "PARTNER_INDUCIDO_POR_DOCS",
        descripcion: `El parámetro 'nro' enviado ('${parametro_nro}') parece ser un ID secuencial interno de base de datos. El contrato real del endpoint ordenesventa/emitirFE espera el IDVentaIntegracion ('${referencia_externa}').`,
        accion_recomendada: `Pasar el IDVentaIntegracion ('${referencia_externa}') en el parámetro 'nro'.`,
        severidad: "ALTA",
      });
    }
  }

  // ---------------------------------------------------------------------------
  // PASO 2: Desambiguación de Orden Inexistente y Comprobantes Previos (C3, C7, C8)
  // ---------------------------------------------------------------------------
  let fechaHasta = fecha_aproximada || getTodayString(client.country);
  const d = new Date(fechaHasta);
  d.setDate(d.getDate() - 30);
  const fechaDesde = d.toISOString().split("T")[0];

  try {
    const compRes = await client.get("/comprobantes/search", { fechaDesde, fechaHasta, pageSize: 50 }, 60);
    let compList = [];
    if (Array.isArray(compRes)) compList = compRes;
    else if (compRes?.Items && Array.isArray(compRes.Items)) compList = compRes.Items;
    else if (compRes?.items && Array.isArray(compRes.items)) compList = compRes.items;

    for (const c of compList) {
      const obs = String(c.Observaciones || c.observaciones || "").toUpperCase();
      const num = String(c.Numero || c.numero || "").toUpperCase();
      const orig = String(c.Origen || c.Canal || "").toUpperCase();

      if (obs.includes(refUpper) || num.includes(refUpper) || (canal_origen && orig.includes(canal_origen.toUpperCase()) && obs.includes(refUpper))) {
        const isBorrador = (c.TipoFc || c.tipoFc || "").toUpperCase().includes("BORRADOR") || c.IdEstado === 0 || c.Estado === "Borrador";
        
        if (isBorrador) {
          // C3: Borrador huérfano vinculado a la orden
          evidencias.borradores_asociados.push({
            id: c.Id || c.id,
            tipo: c.TipoFc || c.tipoFc,
            fecha: (c.FechaEmision || c.fechaEmision || "").slice(0, 10),
            motivo: c.ErrorAFIP || c.Observaciones || "Rechazo previo",
          });
          causasDetectadas.push({
            tipo: "ORDEN_BLOQUEADA_POR_BORRADOR_C3",
            codigo: "BORRADOR_HUERFANO_ARCA_C3",
            titulo: "La orden tiene un borrador vinculado tras rechazo previo de ARCA",
            responsabilidad: "CONTABILIUM_FLUJO",
            descripcion: `El error 'La orden de venta es inexistente' se debe a que un intento previo fue rechazado por ARCA, dejando el borrador #${c.Id || c.id} vinculado y sacando la orden de la cola de pendientes.`,
            accion_recomendada: "Eliminar el borrador huérfano desde el panel de comprobantes o autorizar el borrador directamente en lugar de volver a llamar a emitirFE.",
            severidad: "CRITICA",
          });
        } else {
          // C8 o éxito previo: la factura ya existe emitida
          evidencias.comprobantes_relacionados.push({
            id: c.Id || c.id,
            numero: c.Numero || c.numero,
            tipo: c.TipoFc || c.tipoFc,
            fecha: (c.FechaEmision || c.fechaEmision || "").slice(0, 10),
            total: parseAmount(c.ImporteTotalNeto ?? c.Total ?? 0),
            saldo: parseAmount(c.Saldo ?? 0),
          });
          advertencias.push(`La orden ${referencia_externa} ya cuenta con el comprobante fiscal emitido ${c.TipoFc || c.tipoFc} #${c.Numero || c.numero} (ID ${c.Id || c.id}).`);
        }
      }
    }
  } catch (err) {
    advertencias.push(`No se pudo verificar comprobantes previos: ${err.message}`);
  }

  // C7: Búsqueda de la orden en múltiples integraciones de la cuenta
  if (id_integracion_enviado !== undefined) {
    evidencias.integraciones_consultadas.push(id_integracion_enviado);
    // Si el error fue "inexistente" y se envió un id_integracion, advertir sobre C7
    if (error_recibido && String(error_recibido).toLowerCase().includes("inexistente")) {
      advertencias.push(`Se debe verificar si la orden ${referencia_externa} pertenece a otra integración configurada en la cuenta distinta de ID ${id_integracion_enviado} (Causa C7).`);
    }
  }

  // ---------------------------------------------------------------------------
  // PASO 3: Validación Fiscal y Determinación de Letra (C9, C10)
  // ---------------------------------------------------------------------------
  if (cliente) {
    if (cliente.cuit_o_dni) {
      const taxVal = validateTaxId(cliente.cuit_o_dni, client.country);
      if (!taxVal.valido) {
        causasDetectadas.push({
          tipo: "BLOQUEO_FISCAL",
          codigo: "CLIENTE_DOCUMENTO_INVALIDO",
          titulo: "Identificación fiscal inválida ante la autoridad tributaria",
          responsabilidad: "PARTNER_DATOS",
          descripcion: `El documento fiscal '${cliente.cuit_o_dni}' del comprador es inválido: ${taxVal.motivo}. La AFIP/autoridad fiscal rechazará la autorización del CAE.`,
          accion_recomendada: "Corregir el CUIT/RUT del comprador en el pedido del e-commerce antes de intentar facturar.",
          severidad: "CRITICA",
        });
      }

      // C9: Factura B a RI por enviar TipoDocumento = DNI/CUIL
      const tipoDoc = (tipo_documento_enviado || "").toUpperCase();
      const condIva = (cliente.condicion_iva || "").toUpperCase();
      if ((tipoDoc === "DNI" || tipoDoc === "CUIL") && (condIva.includes("RI") || condIva.includes("RESPONSABLE INSCRIPTO"))) {
        causasDetectadas.push({
          tipo: "ERROR_CONTRATO_PARTNER",
          codigo: "TIPO_DOCUMENTO_INCOMPATIBLE_C9",
          titulo: "Envío de DNI/CUIL para cliente Responsable Inscripto (Emite Factura B en vez de A)",
          responsabilidad: "PARTNER",
          descripcion: "El partner envió TipoDocumento: DNI/CUIL. Ante DNI/CUIL el padrón resuelve como Consumidor Final, emitiendo Factura B en lugar de Factura A requerida por el receptor RI.",
          accion_recomendada: "Enviar TipoDocumento: CUIT y el número de CUIT del comprador en el payload de la orden.",
          severidad: "ALTA",
        });
      }

      // Buscar si el cliente ya existe
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
          evidencias.cliente_en_cuenta = {
            id: foundCli.Id || foundCli.id,
            razon_social: foundCli.RazonSocial || foundCli.razonSocial,
            condicion_iva: foundCli.CondicionIva || foundCli.condicionIva,
          };
          // C10: Colisión con ficha existente en MercadoLibre
          if (canal_origen && canal_origen.toLowerCase().includes("mercadolibre") && cliente.condicion_iva && foundCli.CondicionIva && cliente.condicion_iva !== foundCli.CondicionIva) {
            advertencias.push(`El cliente ya existía en Contabilium con condición '${foundCli.CondicionIva}', distinta a la enviada en la orden actual ('${cliente.condicion_iva}'). Prevalece la ficha previa (Causa C10).`);
          }
        }
      } catch {
        // Continuar
      }
    }
  }

  // ---------------------------------------------------------------------------
  // PASO 4: Validación de Catálogo y Stock (Catálogo base & C15)
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

          if (!isActivo) {
            causasDetectadas.push({
              tipo: "BLOQUEO_CATALOGO",
              codigo: "SKU_INACTIVO",
              titulo: `Producto SKU '${sku}' inactivo en Contabilium`,
              responsabilidad: "CONTABILIUM_CATALOGO",
              descripcion: `El producto '${sku}' (${exactProduct.Nombre || exactProduct.nombre}) está inactivo o deshabilitado en el maestro de artículos de Contabilium.`,
              accion_recomendada: "Reactivar el producto desde el módulo de Conceptos.",
              severidad: "ALTA",
            });
          }

          productosEncontrados.set(skuUpper, exactProduct);
        } else {
          evidencias.catalogo_auditado.push({ sku, existe: false });
          causasDetectadas.push({
            tipo: "BLOQUEO_CATALOGO",
            codigo: "SKU_INEXISTENTE",
            titulo: `SKU '${sku}' inexistente en el catálogo de Contabilium`,
            responsabilidad: "PARTNER_CATALOGO",
            descripcion: `El código SKU '${sku}' enviado en la orden no existe en Contabilium. La integración no puede crear órdenes ni comprobantes con artículos no mapeados.`,
            accion_recomendada: `Dar de alta el SKU '${sku}' en Contabilium o mapear el producto en ${canal_origen || 'la plataforma externa'}.`,
            severidad: "CRITICA",
          });
        }
      } catch (err) {
        advertencias.push(`Error al verificar SKU '${sku}': ${err.message}`);
      }
    }

    // Auditoría de Stock
    for (const it of items) {
      const sku = (it.sku || "").trim();
      const skuUpper = sku.toUpperCase();
      const prod = productosEncontrados.get(skuUpper);
      if (!prod) continue;

      try {
        const stockData = await client.get("/inventarios/getStockBySKU", { codigo: sku }, 180);
        if (stockData && typeof stockData === "object") {
          const actual = parseAmount(stockData.StockActual ?? stockData.stockActual ?? 0);
          const reservado = parseAmount(stockData.StockReservado ?? stockData.stockReservado ?? 0);
          const disponible = actual - reservado;

          evidencias.stock_auditado.push({
            sku,
            deposito_id: deposito_id || "Todos",
            stock_actual: actual,
            stock_reservado: reservado,
            stock_disponible: disponible,
            cantidad_solicitada: it.cantidad,
          });

          // Chequeo de C15
          if (reservado > actual && parseAmount(stockData.StockConReservas) === 0) {
            causasDetectadas.push({
              tipo: "DEFECTO_CONOCIDO_PRODUCTO",
              codigo: "DEF-C15",
              titulo: "StockConReservas truncado en 0 por sobreventa en backend",
              ticket_jira: "API-1256",
              responsabilidad: "CONTABILIUM",
              descripcion: `Para el SKU '${sku}', las reservas (${reservado}) superan el stock físico (${actual}), pero el endpoint devolvió 0 induciendo sobreventa en la web.`,
              accion_recomendada: "Ajustar existencias físicas en el depósito para saldar las reservas.",
              severidad: "ALTA",
            });
          }

          if (disponible < it.cantidad) {
            causasDetectadas.push({
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

  // ---------------------------------------------------------------------------
  // PASO 5: Síntesis de Veredicto y Regla de Evidencia Estricta (C14 / Fase 2)
  // ---------------------------------------------------------------------------
  let estado = "SIN_DIAGNOSTICO_CON_INFORMACION_DISPONIBLE";
  let resumen = "";
  const accionesRecomendadas = [];
  const datosFaltantesFase2 = [];

  const comprobanteEmitido = evidencias.comprobantes_relacionados.find((c) => !c.tipo.toUpperCase().includes("BORRADOR"));

  if (comprobanteEmitido) {
    estado = "COMPROBANTE_YA_EMITIDO";
    resumen = `La orden ${referencia_externa} ya fue emitida previamente en Contabilium (Comprobante ${comprobanteEmitido.tipo} #${comprobanteEmitido.numero}, ID ${comprobanteEmitido.id}).`;
    accionesRecomendadas.push("Verificar en el canal de venta si la orden ya registró el comprobante para evitar doble facturación.");
  } else if (causasDetectadas.length > 0) {
    const hayDefectos = causasDetectadas.some((c) => c.tipo === "DEFECTO_CONOCIDO_PRODUCTO");
    const hayContrato = causasDetectadas.some((c) => c.tipo === "ERROR_CONTRATO_PARTNER");
    const hayBloqueo = causasDetectadas.some((c) => c.tipo.includes("BLOQUE") || c.severidad === "CRITICA");

    if (hayDefectos) estado = "DEFECTO_CONOCIDO_PRODUCTO";
    else if (hayContrato) estado = "ERROR_CONTRATO_PARTNER";
    else if (hayBloqueo) estado = "BLOQUEANTE_DETECTADO";
    else estado = "CAUSA_DETERMINADA";

    resumen = `Se identificaron ${causasDetectadas.length} causa(s) documentada(s) para la orden ${referencia_externa}: ${causasDetectadas.map((c) => c.titulo).join("; ")}.`;
    for (const c of causasDetectadas) {
      if (c.accion_recomendada) accionesRecomendadas.push(c.accion_recomendada);
    }
  } else {
    // -------------------------------------------------------------------------
    // REGLA DE ORO DE AUDITORÍA: Jamás culpar al partner sin evidencia (Leitex/C14)
    // Se responde explícitamente a soporte que no se detectaron errores locales
    // y se detalla la telemetría de Fase 2 requerida para concluir.
    // -------------------------------------------------------------------------
    estado = "SIN_DIAGNOSTICO_CON_INFORMACION_DISPONIBLE";
    resumen = `Con la información disponible en Contabilium no se detectaron errores ni una causa concluyente local para la orden ${referencia_externa} (datos de cliente, SKUs y stock se encuentran correctos). Se requiere telemetría de infraestructura (Fase 2) para determinar la causa raíz.`;

    datosFaltantesFase2.push("Request HTTP crudo enviado por el partner (headers, endpoint exacto y payload JSON).");
    datosFaltantesFase2.push("Verificación en logs de nginx (access_rest.contabilium.log en Grafana) filtrado por IDIntegracion para confirmar si la llamada llegó a Contabilium.");
    datosFaltantesFase2.push("Logs del servicio de notificaciones salientes / RabbitMQ para confirmar si salieron los callbacks y si el partner invocó /getInfoForEcommerce (Caso C14).");

    accionesRecomendadas.push("No asumir error del partner sin evidencia de logs: solicitar al partner el timestamp y código HTTP retornado, y revisar en Grafana si hubo arribo de la petición.");
  }

  const checks = {
    comprobante_previo: comprobanteEmitido ? {
      encontrado: true,
      id: comprobanteEmitido.id,
      numero: comprobanteEmitido.numero,
      tipo: comprobanteEmitido.tipo,
      fecha: comprobanteEmitido.fecha,
      total: comprobanteEmitido.total,
      saldo: comprobanteEmitido.saldo,
    } : { encontrado: false },
    validacion_cliente: evidencias.cliente_en_cuenta,
    validacion_catalogo: evidencias.catalogo_auditado,
    validacion_stock: evidencias.stock_auditado,
  };

  const datos = {
    referencia_externa,
    canal_origen: canal_origen || "Sin especificar",
    estado,
    causas_detectadas: causasDetectadas,
    bloqueantes: causasDetectadas.filter((c) => c.severidad === "CRITICA" || c.severidad === "ALTA"),
    evidencias,
    checks,
    advertencias,
    datos_faltantes_fase_2: datosFaltantesFase2,
    acciones_recomendadas: [...new Set(accionesRecomendadas)],
  };

  return formatToolResponse({
    datos,
    resumen,
    advertencias: advertencias.concat(causasDetectadas.map((c) => `${c.codigo}: ${c.descripcion}`)),
    truncado: false,
  });
}
