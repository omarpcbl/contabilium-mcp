import { z } from "zod";
import { formatToolResponse, parseAmount, getTodayString, validateTaxId } from "../utils.js";

export const schema = {
  referencia_externa: z.string().describe("Número o ID de la orden en la plataforma externa (ej. 'FEN-10293', 'ORD-8821', '39104')."),
  canal_origen: z.string().optional().describe("Plataforma o integrador externo (ej. 'Fenicio', 'Base', 'Vestetic', 'Luna', 'MercadoLibre', 'WooCommerce')."),
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
    canal_origen,
    fecha_aproximada,
    cliente,
    items = [],
    deposito_id,
  } = args;

  const refUpper = (referencia_externa || "").trim().toUpperCase();
  const bloqueantes = [];
  const advertencias = [];
  const detalleChecks = {
    comprobante_previo: null,
    validacion_cliente: null,
    validacion_catalogo: [],
    validacion_stock: [],
  };

  // 1. Chequeo de Comprobante Previo (Evitar dobles facturaciones)
  let fechaHasta = fecha_aproximada || getTodayString(client.country);
  // Buscar en una ventana de 30 días hacia atrás
  const d = new Date(fechaHasta);
  d.setDate(d.getDate() - 30);
  const fechaDesde = d.toISOString().split("T")[0];

  try {
    const compRes = await client.get("/comprobantes/search", {
      fechaDesde,
      fechaHasta,
      pageSize: 50,
    }, 60);

    let compList = [];
    if (Array.isArray(compRes)) {
      compList = compRes;
    } else if (compRes && Array.isArray(compRes.Items)) {
      compList = compRes.Items;
    } else if (compRes && Array.isArray(compRes.items)) {
      compList = compRes.items;
    }

    const matchComp = compList.find((c) => {
      const obs = String(c.Observaciones || c.observaciones || "").toUpperCase();
      const num = String(c.Numero || c.numero || "").toUpperCase();
      const orig = String(c.Origen || c.Canal || "").toUpperCase();
      return obs.includes(refUpper) || num.includes(refUpper) || (canal_origen && orig.includes(canal_origen.toUpperCase()) && obs.includes(refUpper));
    });

    if (matchComp) {
      detalleChecks.comprobante_previo = {
        encontrado: true,
        id: matchComp.Id || matchComp.id,
        numero: matchComp.Numero || matchComp.numero,
        tipo: matchComp.TipoFc || matchComp.tipoFc,
        fecha: (matchComp.FechaEmision || matchComp.fechaEmision || "").slice(0, 10),
        cliente: matchComp.RazonSocial || matchComp.razonSocial,
        total: parseAmount(matchComp.ImporteTotalNeto ?? matchComp.Total ?? 0),
        saldo: parseAmount(matchComp.Saldo ?? 0),
      };
      advertencias.push(`La orden ${referencia_externa} ya se encuentra registrada como comprobante ${detalleChecks.comprobante_previo.tipo} #${detalleChecks.comprobante_previo.numero} (ID ${detalleChecks.comprobante_previo.id}).`);
    } else {
      detalleChecks.comprobante_previo = { encontrado: false };
    }
  } catch (err) {
    advertencias.push(`No se pudo verificar comprobantes previos: ${err.message}`);
  }

  // 2. Validación Fiscal del Cliente
  if (cliente) {
    const checkCli = {
      cuit_o_dni: cliente.cuit_o_dni || null,
      valido_fiscalmente: true,
      registrado_en_cuenta: false,
      detalle: null,
    };

    if (cliente.cuit_o_dni) {
      const taxVal = validateTaxId(cliente.cuit_o_dni, client.country);
      if (!taxVal.valido) {
        checkCli.valido_fiscalmente = false;
        bloqueantes.push({
          codigo: "CLIENTE_DOCUMENTO_INVALIDO",
          descripcion: `El CUIT/DNI/RUT '${cliente.cuit_o_dni}' del comprador es inválido: ${taxVal.motivo}. La AFIP/autoridad fiscal rechazará la factura electrónica.`,
          severidad: "CRITICA",
        });
      }

      // Buscar si el cliente ya existe en la base de Contabilium
      try {
        const cSearch = await client.get("/clientes/search", { filtro: cliente.cuit_o_dni.trim() }, 180);
        let cliItems = [];
        if (Array.isArray(cSearch)) cliItems = cSearch;
        else if (cSearch && Array.isArray(cSearch.Items)) cliItems = cSearch.Items;
        else if (cSearch && Array.isArray(cSearch.items)) cliItems = cSearch.items;

        const foundCli = cliItems.find((c) => {
          const doc = String(c.NroDoc || c.nroDoc || c.Cuit || "").replace(/[^0-9]/g, "");
          const target = String(cliente.cuit_o_dni).replace(/[^0-9]/g, "");
          return doc === target && target.length > 0;
        });

        if (foundCli) {
          checkCli.registrado_en_cuenta = true;
          checkCli.id_cliente = foundCli.Id || foundCli.id;
          checkCli.razon_social = foundCli.RazonSocial || foundCli.razonSocial;
          checkCli.condicion_iva = foundCli.CondicionIva || foundCli.condicionIva;
        } else {
          advertencias.push(`El cliente con documento '${cliente.cuit_o_dni}' no existe en Contabilium. Se creará al emitir si la integración tiene 'Crear cliente' habilitado.`);
        }
      } catch (err) {
        advertencias.push(`No se pudo verificar la existencia previa del cliente: ${err.message}`);
      }
    } else {
      advertencias.push("La orden no incluye CUIT/DNI. Si el importe supera el tope fiscal de Consumidor Final, la emisión será rechazada por AFIP.");
    }
    detalleChecks.validacion_cliente = checkCli;
  }

  // 3. Validación de Catálogo (SKUs)
  const productosEncontrados = new Map();
  if (items.length > 0) {
    for (const it of items) {
      const sku = (it.sku || "").trim();
      const skuUpper = sku.toUpperCase();
      const checkSku = {
        sku,
        cantidad_solicitada: it.cantidad,
        existe_en_catalogo: false,
        activo: false,
        id_concepto: null,
        nombre: null,
      };

      try {
        const pSearch = await client.get("/conceptos/search", { filtro: sku }, 300);
        let pItems = [];
        if (Array.isArray(pSearch)) pItems = pSearch;
        else if (pSearch && Array.isArray(pSearch.Items)) pItems = pSearch.Items;
        else if (pSearch && Array.isArray(pSearch.items)) pItems = pSearch.items;

        const exactProduct = pItems.find((p) => {
          const cod = String(p.Codigo || p.codigo || "").trim().toUpperCase();
          return cod === skuUpper;
        });

        if (exactProduct) {
          checkSku.existe_en_catalogo = true;
          checkSku.id_concepto = exactProduct.Id || exactProduct.id;
          checkSku.nombre = exactProduct.Nombre || exactProduct.nombre;
          const estado = exactProduct.Estado || exactProduct.estado;
          const activo = exactProduct.Activo ?? exactProduct.activo ?? true;
          checkSku.activo = estado !== "I" && activo !== false;

          if (!checkSku.activo) {
            bloqueantes.push({
              codigo: "SKU_INACTIVO",
              descripcion: `El producto '${sku}' (${checkSku.nombre}) está inactivo o deshabilitado en Contabilium. La orden no se puede procesar.`,
              severidad: "ALTA",
            });
          }

          productosEncontrados.set(skuUpper, exactProduct);
        } else {
          bloqueantes.push({
            codigo: "SKU_INEXISTENTE",
            descripcion: `El código SKU '${sku}' no existe en el catálogo de Contabilium. El partner no puede sincronizar ni facturar ítems desconocidos.`,
            severidad: "CRITICA",
          });
        }
      } catch (err) {
        advertencias.push(`Error al verificar SKU '${sku}': ${err.message}`);
      }

      detalleChecks.validacion_catalogo.push(checkSku);
    }
  }

  // 4. Validación de Stock por Depósito
  if (items.length > 0) {
    for (const it of items) {
      const sku = (it.sku || "").trim();
      const skuUpper = sku.toUpperCase();
      const prod = productosEncontrados.get(skuUpper);

      if (!prod) continue; // Si no existe en catálogo, ya fue reportado en bloqueantes

      const checkStock = {
        sku,
        deposito_id: deposito_id || "Todos / Principal",
        cantidad_solicitada: it.cantidad,
        stock_actual: 0,
        stock_reservado: 0,
        stock_disponible: 0,
        suficiente: true,
      };

      try {
        const stockData = await client.get("/inventarios/getStockBySKU", { codigo: sku }, 180);
        if (stockData && typeof stockData === "object") {
          const actual = parseAmount(stockData.StockActual ?? stockData.stockActual ?? 0);
          const reservado = parseAmount(stockData.StockReservado ?? stockData.stockReservado ?? 0);
          const disponible = actual - reservado;

          checkStock.stock_actual = actual;
          checkStock.stock_reservado = reservado;
          checkStock.stock_disponible = disponible;

          if (disponible < it.cantidad) {
            checkStock.suficiente = false;
            bloqueantes.push({
              codigo: "STOCK_INSUFICIENTE",
              descripcion: `Stock insuficiente para SKU '${sku}': solicitado ${it.cantidad}, disponible ${disponible} (Actual: ${actual}, Reservado: ${reservado}).`,
              severidad: "ALTA",
            });
          }
        }
      } catch (err) {
        advertencias.push(`No se pudo verificar el stock para el SKU '${sku}': ${err.message}`);
      }

      detalleChecks.validacion_stock.push(checkStock);
    }
  }

  // 5. Síntesis y Veredicto
  let estadoGeneral = "APTO_PARA_FACTURAR";
  let diagnosticoResumen = "";
  const accionesRecomendadas = [];

  if (detalleChecks.comprobante_previo?.encontrado) {
    estadoGeneral = "COMPROBANTE_YA_EMITIDO";
    diagnosticoResumen = `La orden ${referencia_externa} ya fue emitida previamente en Contabilium (Comprobante #${detalleChecks.comprobante_previo.numero}).`;
    accionesRecomendadas.push("Verificar en el canal externo si la orden ya tiene asignado el comprobante para evitar facturación duplicada.");
  } else if (bloqueantes.length > 0) {
    estadoGeneral = "BLOQUEANTE_DETECTADO";
    diagnosticoResumen = `Se encontraron ${bloqueantes.length} problema(s) bloqueante(s) en los datos de la orden que impiden su emisión.`;
    
    for (const b of bloqueantes) {
      if (b.codigo === "SKU_INEXISTENTE") {
        accionesRecomendadas.push(`Dar de alta el SKU correspondiente en Contabilium o mapearlo en ${canal_origen || 'el e-commerce'}.`);
      } else if (b.codigo === "SKU_INACTIVO") {
        accionesRecomendadas.push("Reactivar el producto inactivo en el módulo de conceptos.");
      } else if (b.codigo === "STOCK_INSUFICIENTE") {
        accionesRecomendadas.push("Ajustar el stock o ingresar mercadería en el depósito asignado a la integración.");
      } else if (b.codigo === "CLIENTE_DOCUMENTO_INVALIDO") {
        accionesRecomendadas.push("Corregir el CUIT/RUT del comprador en el pedido del e-commerce antes de reintentar.");
      }
    }
  } else if (advertencias.length > 0) {
    estadoGeneral = "APTO_CON_ADVERTENCIAS";
    diagnosticoResumen = `La orden ${referencia_externa} es procesable en Contabilium pero tiene advertencias menores.`;
  } else {
    estadoGeneral = "APTO_REVISAR_INTEGRACION_EXTERNA";
    diagnosticoResumen = `Todos los datos de la orden ${referencia_externa} son válidos en Contabilium (cliente, SKUs y stock disponibles). Si la orden no impactó, el bloqueo está en el webhook, cola o credenciales de la integración (${canal_origen || 'partner externo'}).`;
    accionesRecomendadas.push(`Revisar los logs del middleware o webhook de ${canal_origen || 'la integración'} para confirmar si la llamada HTTP llegó a enviarse a Contabilium.`);
  }

  const datos = {
    referencia_externa,
    canal_origen: canal_origen || "Sin especificar",
    estado: estadoGeneral,
    bloqueantes,
    advertencias,
    acciones_recomendadas: [...new Set(accionesRecomendadas)],
    checks: detalleChecks,
  };

  return formatToolResponse({
    datos,
    resumen: diagnosticoResumen,
    advertencias: advertencias.concat(bloqueantes.map((b) => b.descripcion)),
    truncado: false,
  });
}
