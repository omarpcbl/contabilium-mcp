import { z } from "zod";
import {
  formatToolResponse,
  formatCurrency,
  parseAmount,
  getTodayString,
  validateTaxId,
  getAccountIntegrations,
  subDays,
} from "../utils.js";

/**
 * Control de acceso por cuenta para envío/creación de órdenes de venta e-commerce.
 * Por defecto está habilitado públicamente para todas las cuentas ("público hoy").
 * Permite restringir el acceso configurando la variable de entorno:
 * ENVIAR_VENTA_ALLOWED_ACCOUNTS=cuenta1@empresa.com,cuenta2@empresa.com
 * O reutiliza MODIFICAR_CONCEPTO_ALLOWED_ACCOUNTS / CONCEPTO_WRITE_ALLOWED_ACCOUNTS si existen.
 */
export function isAccountAllowedToSendOrders(client) {
  const allowed =
    process.env.ENVIAR_VENTA_ALLOWED_ACCOUNTS ||
    process.env.MODIFICAR_CONCEPTO_ALLOWED_ACCOUNTS ||
    process.env.CONCEPTO_WRITE_ALLOWED_ACCOUNTS;

  if (!allowed || allowed.trim() === "" || allowed.trim() === "*") {
    return { permitido: true };
  }

  const allowedList = allowed
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const accountId = String(client?.clientId || "").toLowerCase();

  const isAllowed = allowedList.some((entry) => accountId.includes(entry));
  if (isAllowed) {
    return { permitido: true };
  }

  return {
    permitido: false,
    motivo: `La cuenta conectada (${client?.clientId || "anónima"}) no tiene permisos habilitados para enviar órdenes de venta.`,
  };
}

const PAISES_DEFAULT = {
  AR: "Argentina",
  CL: "Chile",
  UY: "Uruguay",
};

export const clienteVentaSchema = z.object({
  nombre: z
    .string()
    .min(1, "El nombre del cliente no puede estar vacío.")
    .describe("Nombre del cliente comprador (o Razón Social si no se divide en apellido)."),
  apellido: z
    .string()
    .optional()
    .default("")
    .describe("Apellido del comprador (opcional)."),
  tipo_documento: z
    .string()
    .optional()
    .describe("Tipo de documento: 'DNI', 'CUIT', 'RUT', 'CI', etc. Si se omite, se infiere automáticamente según la longitud del documento y el país."),
  documento: z
    .string()
    .optional()
    .default("")
    .describe("Número de documento fiscal del comprador (DNI, CUIT, RUT, etc.)."),
  email: z
    .string()
    .optional()
    .default("")
    .describe("Correo electrónico del cliente (opcional)."),
  telefono: z
    .string()
    .optional()
    .default("")
    .describe("Teléfono de contacto del cliente (opcional)."),
  direccion: z
    .string()
    .optional()
    .default("")
    .describe("Primera línea de dirección: calle y número (LineaDireccion1, opcional)."),
  direccion_2: z
    .string()
    .optional()
    .default("")
    .describe("Segunda línea de dirección: piso, depto, entre calles (LineaDireccion2, opcional)."),
  ciudad: z
    .string()
    .optional()
    .default("")
    .describe("Ciudad o localidad de la dirección (opcional)."),
  provincia: z
    .string()
    .optional()
    .default("Buenos Aires")
    .describe("Provincia o región del comprador (por defecto 'Buenos Aires')."),
  pais: z
    .string()
    .optional()
    .describe("País de la dirección (por defecto según el país de la cuenta: Argentina, Chile o Uruguay)."),
  codigo_postal: z
    .string()
    .optional()
    .default("")
    .describe("Código postal de la dirección (opcional)."),
});

export const itemVentaSchema = z.object({
  codigo: z
    .string()
    .optional()
    .default("")
    .describe("Código SKU del producto o concepto en Contabilium (ej: '420', 'SKU-01'). Puede ir vacío en ítems de descuento general."),
  concepto: z
    .string()
    .min(1, "La descripción del concepto no puede estar vacía.")
    .describe("Nombre o descripción del ítem. Nota: si se envía la frase reservada 'Costo de envío', se normaliza automáticamente a 'Envío'."),
  cantidad: z
    .number()
    .positive("La cantidad debe ser mayor a 0.")
    .default(1)
    .describe("Cantidad de unidades del ítem (debe ser mayor a 0)."),
  precio_unitario: z
    .number()
    .describe("Precio unitario del ítem (positivo para productos/envíos, o negativo para descuentos globales)."),
  bonificacion: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .default(0)
    .describe("Porcentaje de bonificación o descuento sobre el ítem (0 a 100, por defecto 0)."),
  iva: z
    .number()
    .nonnegative()
    .optional()
    .describe("Alícuota de IVA del ítem (opcional, ej: 21, 10.5, 0). Si se omite, Contabilium toma el IVA configurado en la integración."),
});

export const schema = {
  id_venta_integracion: z
    .union([z.string(), z.number()])
    .describe("ID o número único de la venta en el canal/integración externa (IDVentaIntegracion, ej: 6, '0008', 'FEN-10293'). Si ya existe una orden con este ID y el mismo id_integracion, Contabilium la actualiza."),
  id_integracion: z
    .number()
    .int()
    .positive("El ID de integración debe ser un entero positivo.")
    .optional()
    .describe("ID numérico de la integración e-commerce en Contabilium (IDIntegracion, ej: 27341). Si se omite y la cuenta posee una única integración activa, se selecciona automáticamente."),
  estado_integracion: z
    .string()
    .optional()
    .default("Aceptado")
    .describe("Estado de la orden (IDEstadoIntegracion). Valores permitidos por el backend: 'Aceptado' / 'Aceptada', 'Pendiente', 'Cancelado' / 'Cancelada'. Por defecto: 'Aceptado'."),
  condicion_venta: z
    .string()
    .optional()
    .describe("Condición de venta configurada en Contabilium (ej: 'MercadoPago', 'Contado', 'Cuenta Corriente'). Se valida y normaliza automáticamente contra el catálogo de la cuenta."),
  fecha_emision: z
    .string()
    .optional()
    .describe("Fecha de emisión de la venta en formato YYYY-MM-DD o YYYY-MM-DDThh:mm (por defecto la fecha actual del país)."),
  observaciones: z
    .string()
    .optional()
    .default("")
    .describe("Observaciones o notas del pedido (ej: 'Nro de pedido ecommerce 104')."),
  deposito: z
    .union([z.string(), z.number()])
    .optional()
    .describe("Nombre del depósito/inventario (ej: 'Principal', 'Central', 'Sucursal') o su ID numérico. Si se envía un nombre, se resuelve automáticamente a su IDInventario; si se omite, Contabilium usa el depósito configurado por defecto en la integración."),
  id_deposito: z
    .number()
    .int()
    .positive("El ID de depósito debe ser un entero positivo.")
    .optional()
    .describe("Alias opcional para indicar directamente el ID numérico del depósito/inventario (IDInventario)."),
  cliente: clienteVentaSchema.describe("Datos del cliente comprador de la orden."),
  items: z
    .array(itemVentaSchema)
    .min(1, "Debe incluir al menos un ítem en la venta.")
    .describe("Lista de ítems que componen la orden de venta."),
  costo_envio: z
    .number()
    .nonnegative("El costo de envío no puede ser negativo.")
    .optional()
    .describe("Costo de envío opcional a anexar como ítem ('Envío', código 'CDE')."),
  descuento_general: z
    .number()
    .nonnegative("El descuento general debe indicarse como monto positivo a descontar.")
    .optional()
    .describe("Monto de descuento global opcional a restar de la venta (se agrega como ítem 'Descuento general' con importe negativo)."),
};

export async function handler(args, client) {
  // 1. Verificar control de acceso por cuenta
  const checkAcceso = isAccountAllowedToSendOrders(client);
  if (!checkAcceso.permitido) {
    throw new Error(checkAcceso.motivo);
  }

  const {
    id_venta_integracion,
    id_integracion,
    estado_integracion = "Aceptado",
    condicion_venta,
    fecha_emision,
    observaciones = "",
    deposito,
    id_deposito,
    cliente,
    items,
    costo_envio,
    descuento_general,
  } = args;

  if (
    id_venta_integracion === undefined ||
    id_venta_integracion === null ||
    String(id_venta_integracion).trim() === ""
  ) {
    throw new Error("Debe especificar 'id_venta_integracion' (identificador único del pedido/venta en la integración).");
  }

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("La venta debe incluir al menos un ítem en 'items'.");
  }

  const advertencias = [];
  const country = (client?.country || "AR").toUpperCase();
  const fechaHoy = getTodayString(country);

  // 2. Resolver IDIntegracion si no fue especificado explícitamente
  let idIntegracionEfectivo = id_integracion ? Number(id_integracion) : null;

  if (!idIntegracionEfectivo) {
    const hace30Dias = subDays(fechaHoy, 30);
    const integracionesDetectadas = await getAccountIntegrations(client, hace30Dias, fechaHoy);

    if (integracionesDetectadas.length === 1) {
      idIntegracionEfectivo = integracionesDetectadas[0];
      advertencias.push(
        `No se especificó 'id_integracion'; se utilizó automáticamente la única integración activa detectada en la cuenta (${idIntegracionEfectivo}).`
      );
    } else if (integracionesDetectadas.length > 1) {
      throw new Error(
        `Debe especificar el parámetro 'id_integracion'. Se detectaron múltiples integraciones activas en la cuenta: ${integracionesDetectadas.join(", ")}.`
      );
    } else {
      throw new Error(
        "Debe especificar el parámetro 'id_integracion' (ID numérico de la integración e-commerce en Contabilium, visible en Ventas > Integraciones)."
      );
    }
  }

  // 3. Validar y normalizar CondicionVenta contra las condiciones configuradas en la cuenta (previene Error C2)
  let condicionVentaEfectiva = condicion_venta ? String(condicion_venta).trim() : "";

  try {
    const condRes = await client.get("/usuarios/condicionesVenta", null, 1800);
    const listaCond = Array.isArray(condRes)
      ? condRes
      : Array.isArray(condRes?.Items)
      ? condRes.Items
      : Array.isArray(condRes?.items)
      ? condRes.items
      : [];

    if (listaCond.length > 0) {
      const nombresConfigurados = listaCond
        .map((c) => String(c.Nombre || c.nombre || "").trim())
        .filter(Boolean);

      if (condicionVentaEfectiva) {
        const matchExacto = nombresConfigurados.find((n) => n === condicionVentaEfectiva);
        if (!matchExacto) {
          const normTarget = condicionVentaEfectiva.replace(/\s+/g, "").toLowerCase();
          const matchSimilar = nombresConfigurados.find(
            (n) => n.replace(/\s+/g, "").toLowerCase() === normTarget
          );
          if (matchSimilar) {
            advertencias.push(
              `Se normalizó la condición de venta de '${condicionVentaEfectiva}' a '${matchSimilar}' para coincidir exactamente con la configuración de la cuenta (evita bloqueo C2 al facturar).`
            );
            condicionVentaEfectiva = matchSimilar;
          } else {
            advertencias.push(
              `La condición de venta '${condicionVentaEfectiva}' no coincide con las registradas en la cuenta (${nombresConfigurados.join(", ")}). Esto podría causar el error 'La condición de venta no coincide' (C2) al intentar facturar la orden.`
            );
          }
        }
      } else {
        condicionVentaEfectiva =
          nombresConfigurados.find((n) => n.toLowerCase() === "contado") ||
          nombresConfigurados.find((n) => n.toLowerCase() === "mercadopago") ||
          nombresConfigurados.find((n) => n.toLowerCase() === "cuenta corriente") ||
          nombresConfigurados[0];
      }
    }
  } catch {
    // Si no se puede consultar condicionesVenta, continuar con el valor provisto o default
  }

  if (!condicionVentaEfectiva) {
    condicionVentaEfectiva = "Contado";
  }

  // 3b. Resolver Depósito / Inventario (por nombre o por ID numérico) si fue especificado
  // En el backend de Contabilium (NotificadorIntegracionController + OrdenVentaCommon):
  // - Si NO se envía IDInventario (o es 0), Contabilium usa ObtenerIDInventarioReserva (el depósito 'idInventarioReserva' configurado en la integración, o el depósito con PorDefectoReservas=true).
  // - Si SÍ se envía IDInventario > 0, pisa el depósito por defecto de la integración y reserva stock en ese depósito específico.
  let idInventarioEfectivo = null;
  let nombreDepositoEfectivo = null;
  const rawDepositoInput =
    id_deposito !== undefined && id_deposito !== null
      ? id_deposito
      : deposito !== undefined && deposito !== null && String(deposito).trim() !== ""
      ? deposito
      : null;

  if (rawDepositoInput !== null) {
    const normalizeText = (str) =>
      String(str || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim()
        .toLowerCase();

    const inputStr = String(rawDepositoInput).trim();
    const isNumericInput = /^\d+$/.test(inputStr);
    const inputNum = isNumericInput ? Number(inputStr) : null;
    const inputNorm = normalizeText(inputStr);

    let listaDeps = [];
    try {
      const depsRaw = await client.get("/inventarios/getDepositos", null, 1800);
      listaDeps = Array.isArray(depsRaw)
        ? depsRaw
        : Array.isArray(depsRaw?.Items)
        ? depsRaw.Items
        : Array.isArray(depsRaw?.items)
        ? depsRaw.items
        : [];
    } catch {
      // Si falla la consulta de catálogo de depósitos y el usuario pasó un ID numérico, permitir su uso directo
      if (isNumericInput && inputNum > 0) {
        idInventarioEfectivo = inputNum;
        nombreDepositoEfectivo = `Depósito #${inputNum}`;
      } else {
        throw new Error(
          `No se pudo consultar el listado de depósitos de Contabilium para resolver el nombre '${inputStr}'. Intentá nuevamente o indicá 'id_deposito' numérico.`
        );
      }
    }

    if (idInventarioEfectivo === null) {
      const depositosActivos = listaDeps.filter((d) => d.Activo !== false && d.activo !== false);
      const universoBusqueda = depositosActivos.length > 0 ? depositosActivos : listaDeps;

      let matchDep = null;

      if (isNumericInput) {
        matchDep = listaDeps.find((d) => Number(d.Id ?? d.id ?? d.IDInventario) === inputNum);
      } else {
        // 1) Coincidencia exacta por nombre (sin tildes ni distinción de mayúsculas)
        matchDep = universoBusqueda.find(
          (d) => normalizeText(d.Nombre || d.nombre || d.Codigo || "") === inputNorm
        );

        // 2) Coincidencia parcial única si el usuario escribió parte del nombre (ej: "Central" -> "Depósito Central")
        if (!matchDep) {
          const parciales = universoBusqueda.filter((d) => {
            const nom = normalizeText(d.Nombre || d.nombre || d.Codigo || "");
            return nom.includes(inputNorm) || inputNorm.includes(nom);
          });
          if (parciales.length === 1) {
            matchDep = parciales[0];
          } else if (parciales.length > 1) {
            const opciones = parciales
              .map((d) => `'${d.Nombre || d.nombre}' (ID ${d.Id ?? d.id})`)
              .join(", ");
            throw new Error(
              `El nombre de depósito '${inputStr}' coincide parcialmente con múltiples depósitos: ${opciones}. Por favor especificá el nombre exacto o su ID.`
            );
          }
        }
      }

      if (!matchDep) {
        const disponiblesStr =
          universoBusqueda.length > 0
            ? universoBusqueda
                .map((d) => `'${d.Nombre || d.nombre}' (ID ${d.Id ?? d.id})`)
                .join(", ")
            : "ninguno";
        throw new Error(
          `No se encontró ningún depósito en la cuenta que coincida con '${inputStr}'. Depósitos disponibles: ${disponiblesStr}.`
        );
      }

      idInventarioEfectivo = Number(matchDep.Id ?? matchDep.id ?? matchDep.IDInventario);
      nombreDepositoEfectivo = String(matchDep.Nombre || matchDep.nombre || `Depósito #${idInventarioEfectivo}`).trim();

      if (matchDep.Activo === false || matchDep.activo === false) {
        advertencias.push(
          `El depósito seleccionado '${nombreDepositoEfectivo}' (ID ${idInventarioEfectivo}) figura como inactivo en Contabilium.`
        );
      }
    }
  }

  // 4. Normalizar y validar datos del Cliente (previene Error C9 y documentos inválidos)
  const docRaw = String(cliente?.documento || "").trim();
  const docClean = docRaw.replace(/[^0-9kK]/g, "");

  let tipoDocEfectivo = cliente?.tipo_documento ? String(cliente.tipo_documento).trim().toUpperCase() : "";
  if (!tipoDocEfectivo) {
    if (country === "CL") {
      tipoDocEfectivo = "RUT";
    } else if (country === "UY") {
      tipoDocEfectivo = docClean.length >= 11 ? "RUT" : "CI";
    } else {
      tipoDocEfectivo = docClean.length === 11 ? "CUIT" : "DNI";
    }
  }

  if (tipoDocEfectivo === "CUIL") {
    advertencias.push(
      "Advertencia fiscal (Causa C9): Se envió TipoDocumento 'CUIL'. En Contabilium, 'CUIL' fuerza la condición Consumidor Final (Factura B). Si el comprador es Responsable Inscripto y requiere Factura A, enviá TipoDocumento 'CUIT'."
    );
  }

  if (docClean.length > 0) {
    const valTax = validateTaxId(docClean, country);
    if (!valTax.valido) {
      advertencias.push(
        `Advertencia sobre documento del comprador ('${docRaw}'): ${valTax.motivo}. La orden se enviará, pero AFIP/SII podría rechazar la posterior emisión de factura electrónica.`
      );
    }
  }

  const clientePayload = {
    Nombre: String(cliente?.nombre || "Consumidor Final").trim(),
    Apellido: String(cliente?.apellido || "").trim(),
    TipoDocumento: tipoDocEfectivo,
    Documento: docClean,
    Email: String(cliente?.email || "").trim(),
    Telefono: String(cliente?.telefono || "").trim(),
    LineaDireccion1: String(cliente?.direccion || "").trim(),
    LineaDireccion2: String(cliente?.direccion_2 || "").trim(),
    Ciudad: String(cliente?.ciudad || "").trim(),
    Provincia: String(cliente?.provincia ?? "Buenos Aires").trim(),
    Pais: String(cliente?.pais || PAISES_DEFAULT[country] || "Argentina").trim(),
    CodigoPostal: String(cliente?.codigo_postal || "").trim(),
  };

  // 5. Normalizar ítems, frase reservada "Costo de envío", costo_envio y descuento_general
  const itemsMapeados = [];
  let totalEstimado = 0;

  for (const it of items) {
    const cantidad = parseAmount(it.cantidad ?? 1);
    const precioUnitario = parseAmount(it.precio_unitario);
    const bonificacion = parseAmount(it.bonificacion ?? 0);
    const codigo = String(it.codigo || "").trim();
    let concepto = String(it.concepto || "").trim();

    if (cantidad <= 0) {
      throw new Error(`La cantidad del ítem '${concepto}' debe ser mayor a 0.`);
    }

    // Regla oficial de Contabilium: "Costo de envío" está reservado y no se reconoce si se envía como Concepto
    if (/^costo\s+de\s+env[ií]o$/i.test(concepto)) {
      advertencias.push(
        `El concepto '${concepto}' es una frase reservada en Contabilium que el endpoint ignora; se normalizó automáticamente a 'Envío'.`
      );
      concepto = "Envío";
    }

    const itemObj = {
      Cantidad: cantidad,
      Codigo: codigo,
      Concepto: concepto,
      PrecioUnitario: precioUnitario,
      Bonificacion: bonificacion,
    };

    if (it.iva !== undefined && it.iva !== null) {
      itemObj.Iva = parseAmount(it.iva);
    }

    itemsMapeados.push(itemObj);
    totalEstimado += cantidad * precioUnitario * (1 - bonificacion / 100);
  }

  // Agregar costo_envio si fue indicado por parámetro dedicado
  if (costo_envio !== undefined && costo_envio !== null && parseAmount(costo_envio) > 0) {
    const montoEnvio = parseAmount(costo_envio);
    itemsMapeados.push({
      Cantidad: 1,
      Codigo: "CDE",
      Concepto: "Envío",
      PrecioUnitario: montoEnvio,
      Bonificacion: 0,
    });
    totalEstimado += montoEnvio;
  }

  // Agregar descuento_general si fue indicado por parámetro dedicado
  if (descuento_general !== undefined && descuento_general !== null && parseAmount(descuento_general) > 0) {
    const montoDescuento = Math.abs(parseAmount(descuento_general));
    itemsMapeados.push({
      Cantidad: 1,
      Codigo: "",
      Concepto: "Descuento general",
      PrecioUnitario: -montoDescuento,
      Bonificacion: 0,
    });
    totalEstimado -= montoDescuento;
  }

  totalEstimado = Math.round(totalEstimado * 100) / 100;
  const fechaEmisionEfectiva = fecha_emision ? String(fecha_emision).trim() : fechaHoy;

  // Preservar tipo numérico si id_venta_integracion fue enviado como número
  const idVentaPayload =
    typeof id_venta_integracion === "number"
      ? id_venta_integracion
      : String(id_venta_integracion).trim();

  const payload = {
    Cliente: clientePayload,
    IDVentaIntegracion: idVentaPayload,
    IDEstadoIntegracion: String(estado_integracion || "Aceptado").trim(),
    IDIntegracion: idIntegracionEfectivo,
    CondicionVenta: condicionVentaEfectiva,
    FechaEmision: fechaEmisionEfectiva,
    Observaciones: String(observaciones || "").trim(),
    ...(idInventarioEfectivo ? { IDInventario: idInventarioEfectivo } : {}),
    Items: itemsMapeados,
  };

  // 6. Invocar POST /notificador/ecommerce
  const rawRes = await client.post("/notificador/ecommerce", payload);

  // Analizar respuesta de /notificador/ecommerce (devuelve HTTP 200 con ID numérico o códigos de error -1, -2, -3, -4, -99)
  const rawStr =
    typeof rawRes === "object" && rawRes !== null
      ? String(rawRes.ID ?? rawRes.Id ?? rawRes.id ?? JSON.stringify(rawRes)).trim()
      : String(rawRes ?? "").trim();

  const parsedNum = Number(rawStr);

  if (!isNaN(parsedNum) && parsedNum <= 0) {
    if (parsedNum === -3) {
      throw new Error(
        `Error de Contabilium al enviar la venta (Código -3): El IDIntegracion (${idIntegracionEfectivo}) no existe en la cuenta o el cuerpo de la petición es inválido.`
      );
    }
    if (parsedNum === -2) {
      throw new Error(
        `Error de Contabilium al enviar la venta (Código -2): La integración #${idIntegracionEfectivo} no pertenece a una integración tipo 'Ecommerce' activa o la orden '${idVentaPayload}' ya posee un comprobante emitido.`
      );
    }
    if (parsedNum === -1) {
      throw new Error(
        "Error de Contabilium al enviar la venta (Código -1): El total de los ítems o la cantidad no es válida (la suma de ítems debe ser mayor a 0)."
      );
    }
    if (parsedNum === -4) {
      throw new Error(
        "Error de Contabilium al enviar la venta (Código -4): El campo 'id_venta_integracion' no puede ser vacío ni '0'."
      );
    }
    if (parsedNum === -99) {
      throw new Error(
        "Error interno en Contabilium al procesar la venta (Código -99): Verificá que 'estado_integracion' sea 'Aceptado', 'Pendiente' o 'Cancelado' y que los datos enviados sean válidos."
      );
    }
    throw new Error(
      `Error de Contabilium al enviar la venta en /notificador/ecommerce (Código ${parsedNum}).`
    );
  }

  const idOrdenCreada = !isNaN(parsedNum) && parsedNum > 0 ? parsedNum : rawRes;

  // 7. Registrar la integración en memoria e invalidar caché de órdenes de venta
  if (client) {
    if (!client._knownIntegrations) client._knownIntegrations = new Set();
    client._knownIntegrations.add(idIntegracionEfectivo);

    if (client.cache && typeof client.cache.keys === "function") {
      for (const key of client.cache.keys()) {
        if (key.includes("/ordenesVenta") || key.includes("/ordenesventa")) {
          client.cache.delete(key);
        }
      }
    }
  }

  const nombreCompletoCliente = [clientePayload.Nombre, clientePayload.Apellido]
    .filter(Boolean)
    .join(" ");

  const depositoTextoResumen = idInventarioEfectivo
    ? ` | Depósito: ${nombreDepositoEfectivo} (#${idInventarioEfectivo})`
    : "";

  const resumen = `Orden de venta enviada exitosamente a Contabilium (ID interno: #${idOrdenCreada} | Orden externa: ${idVentaPayload} | Integración: ${idIntegracionEfectivo}${depositoTextoResumen} | Cliente: ${nombreCompletoCliente} | Total estimado: ${formatCurrency(totalEstimado)}).`;

  return formatToolResponse({
    datos: {
      id_orden: idOrdenCreada,
      id_venta_integracion: idVentaPayload,
      id_integracion: idIntegracionEfectivo,
      estado_integracion: payload.IDEstadoIntegracion,
      condicion_venta: condicionVentaEfectiva,
      deposito: idInventarioEfectivo
        ? {
            id: idInventarioEfectivo,
            nombre: nombreDepositoEfectivo,
            origen: "indicado_en_orden",
          }
        : {
            id: null,
            nombre: "Por defecto de la integración (idInventarioReserva)",
            origen: "configuracion_integracion",
          },
      fecha_emision: fechaEmisionEfectiva,
      observaciones: payload.Observaciones,
      cliente: {
        nombre: clientePayload.Nombre,
        apellido: clientePayload.Apellido,
        tipo_documento: clientePayload.TipoDocumento,
        documento: clientePayload.Documento,
        email: clientePayload.Email,
        provincia: clientePayload.Provincia,
        pais: clientePayload.Pais,
      },
      items_cantidad: itemsMapeados.length,
      items: itemsMapeados.map((it) => ({
        codigo: it.Codigo,
        concepto: it.Concepto,
        cantidad: it.Cantidad,
        precio_unitario: it.PrecioUnitario,
        bonificacion: it.Bonificacion,
        ...(it.Iva !== undefined ? { iva: it.Iva } : {}),
        subtotal: Math.round(it.Cantidad * it.PrecioUnitario * (1 - (it.Bonificacion || 0) / 100) * 100) / 100,
      })),
      total_estimado: totalEstimado,
      total_formateado: formatCurrency(totalEstimado),
    },
    resumen,
    advertencias: [
      ...advertencias,
      "La orden fue registrada en el módulo de Órdenes de Venta (no emite factura fiscal ante AFIP/ARCA por sí sola).",
      "Si necesitás modificar esta orden más adelante, volvé a enviarla respetando el mismo 'id_venta_integracion' e 'id_integracion'.",
    ],
    truncado: false,
  });
}
