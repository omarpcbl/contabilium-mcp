import { z } from "zod";
import { formatToolResponse, parseAmount, getTodayString, validateTaxId } from "../utils.js";

export const schema = {
  sintoma: z
    .enum([
      "orden_no_facturo",
      "letra_comprobante_incorrecta",
      "stock_no_actualiza",
      "devolucion_nc_borrador",
      "timeout_sincronizacion",
      "general",
    ])
    .default("general")
    .describe("Síntoma principal reportado por el partner o soporte."),
  referencia_externa: z.string().describe("Número o ID de la orden en la plataforma externa (IDVentaIntegracion, ej. 'FEN-10293', 'ORD-8821', '39104')."),
  id_integracion_enviado: z.number().int().optional().describe("ID de la integración enviado en la llamada (ej. 28778)."),
  parametro_nro: z.string().optional().describe("Valor exacto pasado en el parámetro 'nro' (ej. 'FEN-10293' o ID interno '28778')."),
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
  const {
    sintoma = "general",
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
  // 1. VALIDACIÓN DE DEPÓSITO (Si se especificó deposito_id)
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
  // 2. VALIDACIÓN DE CLIENTE Y FISCAL (Módulo 11 + Caso C9 y C11 verificado)
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

      // CASO C9 (API-1156): CUIL o DNI enviado para receptor que es Responsable Inscripto
      const tipoDoc = (tipo_documento_enviado || "").toUpperCase();
      const condicionDestino = (cliente.condicion_iva || clienteEnCuenta?.CondicionIva || "").toUpperCase();
      const esReceptorRI = condicionDestino.includes("RESPONSABLE INSCRIPTO") || condicionDestino === "RI";

      if ((tipoDoc === "CUIL" || tipoDoc === "DNI") || (tipoDoc !== "CUIT" && tipoDoc.length > 0 && esReceptorRI)) {
        if (esReceptorRI || tipoDoc === "CUIL") {
          erroresContrato.push({
            tipo: "ERROR_CONTRATO_PARTNER",
            codigo: "TIPO_DOCUMENTO_INCOMPATIBLE_C9",
            titulo: "TipoDocumento CUIL/DNI enviado para cliente Responsable Inscripto (Causa C9 / API-1156)",
            responsabilidad: "PARTNER",
            descripcion: `El partner envió TipoDocumento: '${tipo_documento_enviado || 'CUIL'}'. El padrón tributario resuelve el CUIL/DNI como Consumidor Final, emitiendo Factura B en lugar de la Factura A requerida por un Responsable Inscripto.`,
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
  // 3. VALIDACIÓN DE CATÁLOGO Y STOCK (Con verificación estricta de C15)
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
          evidencias.catalogo_auditado.push({ sku, existe: false });
          erroresBloqueantes.push({
            tipo: "BLOQUEO_CATALOGO",
            codigo: "SKU_INEXISTENTE",
            titulo: `SKU '${sku}' inexistente en el catálogo de Contabilium`,
            responsabilidad: "PARTNER_CATALOGO",
            descripcion: `El código SKU '${sku}' enviado en la orden no existe en Contabilium. No se pueden procesar órdenes con artículos no mapeados.`,
            accion_recomendada: `Dar de alta el SKU '${sku}' en Contabilium o mapear el producto en ${canal_origen || 'el canal de venta'}.`,
            severidad: "CRITICA",
          });
        }
      } catch (err) {
        advertencias.push(`Error al verificar SKU '${sku}': ${err.message}`);
      }
    }

    // Auditoría de Stock (Solo si el depósito es válido)
    if (depositoValido) {
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
            const stockConReservasRaw = stockData.StockConReservas !== undefined ? parseAmount(stockData.StockConReservas) : null;

            evidencias.stock_auditado.push({
              sku,
              deposito_id: deposito_id || "Todos / Consolidado",
              stock_actual: actual,
              stock_reservado: reservado,
              stock_disponible: disponible,
              cantidad_solicitada: it.cantidad,
            });
            datosVerificados.push(`Stock SKU '${sku}': Actual ${actual}, Reservado ${reservado}, Disponible ${disponible}`);

            // DEF-C15 (API-1256): VERIFICACIÓN ESTRICTA: Solo dispara si HAY reservas que superen al stock Y el valor reportado fue 0
            if (reservado > actual && stockConReservasRaw !== null && stockConReservasRaw === 0) {
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
  // 4. BÚSQUEDA DE LA ORDEN EN MÚLTIPLES INTEGRACIONES Y COMPROBANTES (C3, C7, C8)
  // ---------------------------------------------------------------------------
  let comprobanteEmitido = null;
  let borradorHuerfano = null;
  let ordenEncontradaEnOtraIntegracion = null;

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
      const matchRef = obs.includes(refUpper) || num.includes(refUpper) || (canal_origen && orig.includes(canal_origen.toUpperCase()) && obs.includes(refUpper));

      if (matchRef) {
        const isBorrador = (c.TipoFc || c.tipoFc || "").toUpperCase().includes("BORRADOR") || c.IdEstado === 0 || c.Estado === "Borrador";
        if (isBorrador) {
          borradorHuerfano = c;
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

        // C7: Chequeo de IDIntegracion en el comprobante encontrado
        const idIntComp = Number(c.IdIntegracion || c.idIntegracion);
        if (id_integracion_enviado && idIntComp && idIntComp !== Number(id_integracion_enviado)) {
          ordenEncontradaEnOtraIntegracion = idIntComp;
        }
      }
    }

    datosVerificados.push(`Búsqueda de comprobantes en ventana ${fechaDesde} al ${fechaHasta}: ${compList.length} registros revisados`);
  } catch (err) {
    advertencias.push(`No se pudo consultar comprobantes: ${err.message}`);
  }

  // CASO C3: Borrador huérfano vinculado a la orden
  if (borradorHuerfano && !comprobanteEmitido) {
    erroresBloqueantes.push({
      tipo: "BLOQUEO_FLUJO_ARCA",
      codigo: "BORRADOR_HUERFANO_ARCA_C3",
      titulo: "La orden tiene un borrador vinculado tras rechazo previo de ARCA (Causa C3)",
      responsabilidad: "CONTABILIUM_FLUJO",
      descripcion: `El error 'La orden de venta es inexistente' se debe a que un intento previo fue rechazado por ARCA, dejando el borrador #${borradorHuerfano.Id || borradorHuerfano.id} vinculado y retirando la orden de la cola de pendientes.`,
      accion_recomendada: "Eliminar el borrador huérfano desde el panel de comprobantes o autorizar el borrador directamente.",
      severidad: "CRITICA",
    });
  }

  // CASO C7: La orden existe en otra integración de la cuenta
  if (ordenEncontradaEnOtraIntegracion) {
    erroresContrato.push({
      tipo: "ERROR_CONTRATO_PARTNER",
      codigo: "ID_INTEGRACION_INCORRECTO_C7",
      titulo: `IDIntegracion incorrecto (Causa C7: enviado ${id_integracion_enviado}, real ${ordenEncontradaEnOtraIntegracion})`,
      responsabilidad: "PARTNER",
      descripcion: `La orden ${referencia_externa} existe en la cuenta pero está asociada a la integración ID ${ordenEncontradaEnOtraIntegracion}, mientras que la llamada se realizó con ID ${id_integracion_enviado}.`,
      accion_recomendada: `Cambiar el parámetro idIntegracion a ${ordenEncontradaEnOtraIntegracion} en la llamada del partner.`,
      severidad: "ALTA",
    });
  } else if (id_integracion_enviado) {
    evidencias.integraciones_consultadas.push(id_integracion_enviado);
  }

  // ---------------------------------------------------------------------------
  // 5. VALIDACIÓN DE CONTRATO (C1, C2, C5, C12)
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

  // CASO C2: Condición de venta
  if (condicion_venta) {
    try {
      const condList = await client.get("/opciones/condiciones-venta", null, 1800);
      if (Array.isArray(condList) && condList.length > 0) {
        const exactMatch = condList.some((c) => (c.Nombre || c.nombre || "").trim() === condicion_venta.trim());
        if (!exactMatch) {
          const similar = condList.find((c) => (c.Nombre || c.nombre || "").replace(/\s+/g, "").toLowerCase() === condicion_venta.replace(/\s+/g, "").toLowerCase());
          erroresContrato.push({
            tipo: "ERROR_CONTRATO_PARTNER",
            codigo: "CONDICION_VENTA_NO_COINCIDE_C2",
            titulo: "Discrepancia en nombre de Condición de Venta (Causa C2)",
            responsabilidad: "PARTNER",
            descripcion: `La condición de venta '${condicion_venta}' enviada por el partner no coincide exactamente con las de la cuenta.${similar ? ` Nombre exacto en Contabilium: '${similar.Nombre || similar.nombre}'.` : ""}`,
            accion_recomendada: similar ? `Enviar '${similar.Nombre || similar.nombre}' respetando mayúsculas y espacios.` : "Dar de alta la condición de venta en Contabilium.",
            severidad: "ALTA",
          });
        } else {
          datosVerificados.push(`Condición de venta '${condicion_venta}' coincide exactamente con la cuenta`);
        }
      }
    } catch {
      // Continuar
    }
  }

  // CASO C5: Parámetro nro confundido con ID interno
  if (parametro_nro !== undefined && parametro_nro !== null) {
    const isPurelyNumeric = /^\d{1,8}$/.test(String(parametro_nro).trim());
    const difiereDeReferencia = String(parametro_nro).trim() !== String(referencia_externa).trim();

    if (isPurelyNumeric && difiereDeReferencia) {
      erroresContrato.push({
        tipo: "ERROR_CONTRATO_PARTNER",
        codigo: "CONFUSION_PARAMETRO_NRO_C5",
        titulo: "Parámetro 'nro' con ID interno en vez de IDVentaIntegracion (Causa C5)",
        responsabilidad: "PARTNER",
        descripcion: `El parámetro 'nro' enviado ('${parametro_nro}') contiene un ID numérico interno de base de datos. El contrato real de ordenesventa/emitirFE espera el IDVentaIntegracion ('${referencia_externa}').`,
        accion_recomendada: `Pasar el IDVentaIntegracion ('${referencia_externa}') en el parámetro 'nro'.`,
        severidad: "ALTA",
      });
    }
  }

  // CASO C12: Código -3 o fecha inválida
  if (error_recibido) {
    const errText = String(error_recibido).toLowerCase();
    if (errText.includes("-3") || (errText.includes("fecha") && errText.includes("no es válida"))) {
      erroresContrato.push({
        tipo: "ERROR_CONTRATO_PARTNER",
        codigo: "TIPO_INTEGRACION_O_FECHA_INVALIDA_C12",
        titulo: "Código -3: Tipo de integración no compatible o formato de fecha erróneo (Causa C12)",
        responsabilidad: "PARTNER",
        descripcion: "El código de retorno -3 en /notificador/ecommerce se genera si el IDIntegracion corresponde a una pasarela nativa (ej. MercadoPago) en vez de e-commerce genérica, o si la fecha no cumple el formato 'AAAA-MM-DDThh-mm'.",
        accion_recomendada: "Verificar que el IDIntegracion corresponda a e-commerce y que la fecha de la venta use formato ISO con guiones (AAAA-MM-DDThh-mm).",
        severidad: "ALTA",
      });
    }
  }

  // CASO C6: Catch silencioso de 500 (Hezka) - SOLO SI SE DESCARTARON C3, C5, C7, C8 y no hay errores de contrato
  if (error_recibido && (error_recibido.includes("500") || error_recibido.toLowerCase().includes("inexistente"))) {
    const tieneC3 = erroresBloqueantes.some((e) => e.codigo === "BORRADOR_HUERFANO_ARCA_C3");
    const tieneC5 = erroresContrato.some((e) => e.codigo === "CONFUSION_PARAMETRO_NRO_C5");
    const tieneC7 = erroresContrato.some((e) => e.codigo === "ID_INTEGRACION_INCORRECTO_C7");

    if (!tieneC3 && !tieneC5 && !tieneC7 && !comprobanteEmitido && erroresBloqueantes.length === 0 && erroresContrato.length === 0) {
      const isHezka = (canal_origen || "").toLowerCase().includes("hezka") || (canal_origen || "").toLowerCase().includes("base");
      if (isHezka) {
        defectosConocidos.push({
          tipo: "DEFECTO_CONOCIDO_PRODUCTO",
          codigo: "DEF-C6",
          titulo: "Catch silencioso en backend ante error 500 sin traza en Grafana (Hezka / API-1145)",
          ticket_jira: "API-1145",
          responsabilidad: "CONTABILIUM",
          descripcion: "Defecto en backend: la orden existe previamente en la base de datos pero la llamada entra en un bloque catch sin log detallado en Grafana.",
          accion_recomendada: "Escalar a Desarrollo con fecha y número de orden exacto para revisión de base de datos primaria.",
          severidad: "ALTA",
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 6. PRIORIZACIÓN ESTRICTA DEL ESTADO GENERAL (Jerarquía Obligatoria)
  // ---------------------------------------------------------------------------
  let estado = "SIN_DIAGNOSTICO_CON_INFORMACION_DISPONIBLE";
  let resumen = "";
  const accionesRecomendadas = [];
  const datosFaltantesFase2 = [];

  const todasLasCausas = [...erroresBloqueantes, ...erroresContrato, ...defectosConocidos];

  if (erroresBloqueantes.length > 0) {
    // PRIORIDAD 1: Errores bloqueantes de datos (CUIT inválido, depósito inexistente, SKU inexistente, stock)
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
  } else if (comprobanteEmitido) {
    // PRIORIDAD 4: Comprobante ya emitido
    estado = "COMPROBANTE_YA_EMITIDO";
    resumen = `La orden ${referencia_externa} ya fue emitida previamente en Contabilium (Comprobante ${comprobanteEmitido.TipoFc || comprobanteEmitido.tipoFc} #${comprobanteEmitido.Numero || comprobanteEmitido.numero}, ID ${comprobanteEmitido.Id || comprobanteEmitido.id}).`;
    accionesRecomendadas.push("Verificar en el canal de venta si la orden ya registró el comprobante para evitar doble facturación.");
  } else {
    // PRIORIDAD 5: Sin diagnóstico con la información disponible (Leitex / Fase 2)
    estado = "SIN_DIAGNOSTICO_CON_INFORMACION_DISPONIBLE";
    
    // Descripción exacta de lo que SÍ y lo que NO se verificó (sin inventar afirmaciones)
    const verifTexto = datosVerificados.length > 0 ? `Verificaciones realizadas: ${datosVerificados.join("; ")}.` : "No se encontraron comprobantes previos en la ventana analizada.";
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
      tipo: comprobanteEmitido.TipoFc || comprobanteEmitido.tipoFc,
      fecha: (comprobanteEmitido.FechaEmision || comprobanteEmitido.fechaEmision || "").slice(0, 10),
      total: parseAmount(comprobanteEmitido.ImporteTotalNeto ?? comprobanteEmitido.Total ?? 0),
      saldo: parseAmount(comprobanteEmitido.Saldo ?? 0),
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
