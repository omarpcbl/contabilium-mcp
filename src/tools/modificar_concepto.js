import { z } from "zod";
import { formatToolResponse, parseAmount } from "../utils.js";

/**
 * Validador de control de acceso por cuenta para modificación de conceptos.
 * Por defecto está habilitado públicamente para todas las cuentas ("público hoy").
 * Permite restringir el acceso configurando la variable de entorno:
 * MODIFICAR_CONCEPTO_ALLOWED_ACCOUNTS=email1@dominio.com,email2@dominio.com
 */
export function isAccountAllowedToModifyConcepts(client) {
  const allowed = process.env.MODIFICAR_CONCEPTO_ALLOWED_ACCOUNTS || process.env.CONCEPTO_WRITE_ALLOWED_ACCOUNTS;
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
    motivo: `La cuenta conectada (${client?.clientId || "anónima"}) no tiene permisos habilitados para modificar conceptos.`,
  };
}

export const schema = {
  id: z
    .number()
    .int()
    .positive("El ID debe ser un entero positivo.")
    .optional()
    .describe("ID numérico único del concepto en Contabilium (opcional si se provee codigo)."),
  codigo: z
    .string()
    .optional()
    .describe("Código SKU del concepto a buscar/modificar. Si se provee nuevo_codigo, este campo identifica el concepto original a modificar."),
  nuevo_codigo: z
    .string()
    .optional()
    .describe("Nuevo código SKU a asignar al concepto (opcional)."),
  nombre: z
    .string()
    .optional()
    .describe("Nuevo nombre o descripción comercial del concepto (opcional)."),
  precio: z
    .number()
    .nonnegative("El precio no puede ser negativo.")
    .optional()
    .describe("Nuevo precio de venta neto sin IVA (opcional)."),
  precio_final: z
    .number()
    .nonnegative("El precio final no puede ser negativo.")
    .optional()
    .describe("Nuevo precio final con IVA incluido (opcional)."),
  costo_interno: z
    .number()
    .nonnegative("El costo interno no puede ser negativo.")
    .optional()
    .describe("Nuevo costo interno de compra / reposición habitual (opcional)."),
  iva: z
    .number()
    .nonnegative("La alícuota de IVA no puede ser negativa.")
    .optional()
    .describe("Nueva alícuota de IVA: 21, 10.5, 0, 27, 5, 2.5, etc. (opcional)."),
  rentabilidad: z
    .number()
    .optional()
    .describe("Porcentaje de margen de rentabilidad (opcional)."),
  descripcion: z
    .string()
    .optional()
    .describe("Nueva descripción detallada del producto o servicio (opcional)."),
  estado: z
    .enum(["A", "I", "Activo", "Inactivo"])
    .optional()
    .describe("Estado del concepto: 'A' o 'Activo' para activo, 'I' o 'Inactivo' para pausado/inactivo (opcional)."),
  id_rubro: z
    .union([z.number().int(), z.string()])
    .optional()
    .describe("ID del rubro o categoría comercial en Contabilium (opcional)."),
  id_subrubro: z
    .union([z.number().int(), z.string()])
    .optional()
    .describe("ID del subrubro (opcional)."),
  id_proveedor: z
    .number()
    .int()
    .optional()
    .describe("ID del proveedor habitual asignado (opcional)."),
  codigo_barras: z
    .string()
    .optional()
    .describe("Código de barras del producto (EAN/UPC) (opcional)."),
  codigo_proveedor: z
    .string()
    .optional()
    .describe("Código del ítem según el proveedor (opcional)."),
  observaciones: z
    .string()
    .optional()
    .describe("Observaciones o notas internas (opcional)."),
};

export async function handler(args, client) {
  // 1. Verificar control de acceso por cuenta
  const checkAcceso = isAccountAllowedToModifyConcepts(client);
  if (!checkAcceso.permitido) {
    throw new Error(checkAcceso.motivo);
  }

  const { id, codigo } = args;
  if (!id && (!codigo || !codigo.trim())) {
    throw new Error("Debe especificar el 'id' numérico o el 'codigo' (SKU) del concepto a modificar.");
  }

  // 2. Obtener el concepto actual desde Contabilium (Fetch-Merge-Patch)
  let current = null;

  if (id) {
    try {
      const res = await client.get("/conceptos", { id });
      if (Array.isArray(res) && res.length > 0) {
        current = res.find((c) => Number(c.Id ?? c.id ?? c.IDConcepto) === Number(id)) || res[0];
      } else if (res && typeof res === "object" && !res.Items && !res.items) {
        current = res;
      }
    } catch {
      // Fallback a search si /conceptos?id no devuelve
    }

    if (!current) {
      try {
        const searchRes = await client.get("/conceptos/search", { pageSize: 50, filtro: String(id) });
        const list = Array.isArray(searchRes) ? searchRes : (searchRes?.Items || searchRes?.items || []);
        current = list.find((c) => Number(c.Id ?? c.id ?? c.IDConcepto) === Number(id));
      } catch {
        // Continuar
      }
    }
  }

  if (!current && codigo) {
    const skuTarget = codigo.trim();
    try {
      const resByCod = await client.get("/conceptos/getByCodigo", { codigo: skuTarget });
      if (resByCod && typeof resByCod === "object") {
        current = resByCod;
      }
    } catch {
      // Fallback a search
    }

    if (!current) {
      try {
        const searchRes = await client.get("/conceptos/search", { pageSize: 50, filtro: skuTarget });
        const list = Array.isArray(searchRes) ? searchRes : (searchRes?.Items || searchRes?.items || []);
        current = list.find((c) => String(c.Codigo || c.codigo || "").trim().toLowerCase() === skuTarget.toLowerCase());
      } catch {
        // Continuar
      }
    }
  }

  if (!current) {
    throw new Error(
      `No se encontró ningún concepto en Contabilium con ${id ? `ID #${id}` : `código SKU '${codigo}'`}. Podés verificar el catálogo usando 'buscar_productos'.`
    );
  }

  // 3. Normalizar datos existentes del concepto
  const idConcepto = Number(current.Id ?? current.id ?? current.IDConcepto ?? id);
  const codigoActual = String(current.Codigo || current.codigo || "").trim();
  const nombreActual = String(current.Nombre || current.nombre || "").trim();

  // Tipo: P, S o C (la API devuelve 'Producto' pero exige 'P' en PUT)
  let tipoNorm = "P";
  const rawTipo = String(current.Tipo || current.tipo || "P").toUpperCase();
  if (rawTipo.startsWith("S") || rawTipo === "2") {
    tipoNorm = "S";
  } else if (rawTipo.startsWith("C") || rawTipo === "3") {
    tipoNorm = "C";
  } else {
    tipoNorm = "P";
  }

  // Estado: A o I (la API devuelve 'Activo' pero exige 'A' en PUT)
  let estadoNorm = "A";
  const rawEstado = String(current.Estado || current.estado || "A").toUpperCase();
  if (rawEstado.startsWith("I")) {
    estadoNorm = "I";
  } else {
    estadoNorm = "A";
  }

  const ivaActual = parseAmount(current.Iva ?? current.iva ?? 21);
  const precioActual = parseAmount(current.Precio ?? current.precio ?? 0);
  const precioFinalActual = parseAmount(current.PrecioFinal ?? current.precioFinal ?? 0);
  const costoInternoActual = parseAmount(current.CostoInterno ?? current.costoInterno ?? 0);
  const rentabilidadActual = parseAmount(current.Rentabilidad ?? current.rentabilidad ?? 0);
  const stockActual = parseAmount(current.Stock ?? current.stock ?? 0);
  const stockMinimoActual = Number(current.StockMinimo ?? current.stockMinimo ?? 0);
  const idRubroActual = current.IdRubro ?? current.idRubro ?? "";
  const idSubrubroActual = current.IdSubrubro ?? current.idSubrubro ?? "";
  const idProveedorActual = current.IDProveedor ?? current.IdProveedor ?? current.idProveedor ?? null;
  const codigoBarrasActual = String(current.CodigoBarras || current.codigoBarras || "");
  const codigoProveedorActual = String(current.CodigoProveedor || current.codigoProveedor || "");
  const codigoOemActual = String(current.CodigoOem || current.codigoOem || "");
  const descripcionActual = String(current.Descripcion || current.descripcion || "");
  const observacionesActual = String(current.Observaciones || current.observaciones || "");
  const idMonedaActual = Number(current.IDMoneda || current.idMoneda || 1);
  const itemsCombo = current.Items || current.items || null;

  // 4. Aplicar cambios solicitados
  const cambios = [];

  let nuevoCodigo = codigoActual;
  if (args.nuevo_codigo !== undefined && args.nuevo_codigo.trim() !== "") {
    nuevoCodigo = args.nuevo_codigo.trim();
    if (nuevoCodigo !== codigoActual) {
      cambios.push({ campo: "codigo", anterior: codigoActual, nuevo: nuevoCodigo });
    }
  } else if (id && args.codigo && args.codigo.trim() !== "" && args.codigo.trim() !== codigoActual) {
    nuevoCodigo = args.codigo.trim();
    cambios.push({ campo: "codigo", anterior: codigoActual, nuevo: nuevoCodigo });
  }

  let nuevoNombre = nombreActual;
  if (args.nombre !== undefined && args.nombre.trim() !== "") {
    nuevoNombre = args.nombre.trim();
    if (nuevoNombre !== nombreActual) {
      cambios.push({ campo: "nombre", anterior: nombreActual, nuevo: nuevoNombre });
    }
  }

  let nuevoIva = ivaActual;
  if (args.iva !== undefined) {
    nuevoIva = parseAmount(args.iva);
    if (nuevoIva !== ivaActual) {
      cambios.push({ campo: "iva", anterior: ivaActual, nuevo: nuevoIva });
    }
  }

  let nuevoPrecio = precioActual;
  let nuevoPrecioFinal = precioFinalActual || Math.round(precioActual * (1 + ivaActual / 100) * 100) / 100;

  if (args.precio !== undefined) {
    nuevoPrecio = parseAmount(args.precio);
    if (nuevoPrecio !== precioActual) {
      cambios.push({ campo: "precio", anterior: precioActual, nuevo: nuevoPrecio });
      if (args.precio_final === undefined) {
        nuevoPrecioFinal = Math.round(nuevoPrecio * (1 + nuevoIva / 100) * 100) / 100;
        cambios.push({ campo: "precio_final (calculado con IVA)", anterior: precioFinalActual, nuevo: nuevoPrecioFinal });
      }
    }
  }

  if (args.precio_final !== undefined) {
    nuevoPrecioFinal = parseAmount(args.precio_final);
    if (nuevoPrecioFinal !== precioFinalActual) {
      cambios.push({ campo: "precio_final", anterior: precioFinalActual, nuevo: nuevoPrecioFinal });
      if (args.precio === undefined) {
        nuevoPrecio = Math.round((nuevoPrecioFinal / (1 + nuevoIva / 100)) * 100) / 100;
        if (nuevoPrecio !== precioActual) {
          cambios.push({ campo: "precio (neto calculado sin IVA)", anterior: precioActual, nuevo: nuevoPrecio });
        }
      }
    }
  }

  if (args.iva !== undefined && nuevoIva !== ivaActual && args.precio === undefined && args.precio_final === undefined) {
    nuevoPrecioFinal = Math.round(nuevoPrecio * (1 + nuevoIva / 100) * 100) / 100;
    if (nuevoPrecioFinal !== precioFinalActual) {
      cambios.push({ campo: "precio_final (recalculado con nuevo IVA)", anterior: precioFinalActual, nuevo: nuevoPrecioFinal });
    }
  }

  let nuevoCostoInterno = costoInternoActual;
  if (args.costo_interno !== undefined) {
    nuevoCostoInterno = parseAmount(args.costo_interno);
    if (nuevoCostoInterno !== costoInternoActual) {
      cambios.push({ campo: "costo_interno", anterior: costoInternoActual, nuevo: nuevoCostoInterno });
    }
  }

  let nuevaRentabilidad = rentabilidadActual;
  if (args.rentabilidad !== undefined) {
    nuevaRentabilidad = parseAmount(args.rentabilidad);
    if (nuevaRentabilidad !== rentabilidadActual) {
      cambios.push({ campo: "rentabilidad", anterior: rentabilidadActual, nuevo: nuevaRentabilidad });
    }
  }

  let nuevoEstado = estadoNorm;
  if (args.estado !== undefined) {
    const rawE = String(args.estado).toUpperCase();
    nuevoEstado = rawE.startsWith("I") ? "I" : "A";
    const strAnterior = estadoNorm === "A" ? "Activo" : "Inactivo";
    const strNuevo = nuevoEstado === "A" ? "Activo" : "Inactivo";
    if (nuevoEstado !== estadoNorm) {
      cambios.push({ campo: "estado", anterior: strAnterior, nuevo: strNuevo });
    }
  }

  let nuevaDescripcion = descripcionActual;
  if (args.descripcion !== undefined) {
    nuevaDescripcion = args.descripcion;
    if (nuevaDescripcion !== descripcionActual) {
      cambios.push({ campo: "descripcion", anterior: descripcionActual, nuevo: nuevaDescripcion });
    }
  }

  let nuevoCodigoBarras = codigoBarrasActual;
  if (args.codigo_barras !== undefined) {
    nuevoCodigoBarras = args.codigo_barras.trim();
    if (nuevoCodigoBarras !== codigoBarrasActual) {
      cambios.push({ campo: "codigo_barras", anterior: codigoBarrasActual, nuevo: nuevoCodigoBarras });
    }
  }

  let nuevoCodigoProveedor = codigoProveedorActual;
  if (args.codigo_proveedor !== undefined) {
    nuevoCodigoProveedor = args.codigo_proveedor.trim();
    if (nuevoCodigoProveedor !== codigoProveedorActual) {
      cambios.push({ campo: "codigo_proveedor", anterior: codigoProveedorActual, nuevo: nuevoCodigoProveedor });
    }
  }

  let nuevoIdRubro = idRubroActual;
  if (args.id_rubro !== undefined) {
    nuevoIdRubro = String(args.id_rubro);
    if (nuevoIdRubro !== String(idRubroActual)) {
      cambios.push({ campo: "id_rubro", anterior: idRubroActual, nuevo: nuevoIdRubro });
    }
  }

  let nuevoIdSubrubro = idSubrubroActual;
  if (args.id_subrubro !== undefined) {
    nuevoIdSubrubro = String(args.id_subrubro);
    if (nuevoIdSubrubro !== String(idSubrubroActual)) {
      cambios.push({ campo: "id_subrubro", anterior: idSubrubroActual, nuevo: nuevoIdSubrubro });
    }
  }

  let nuevoIdProveedor = idProveedorActual;
  if (args.id_proveedor !== undefined) {
    nuevoIdProveedor = Number(args.id_proveedor) || null;
    if (nuevoIdProveedor !== idProveedorActual) {
      cambios.push({ campo: "id_proveedor", anterior: idProveedorActual, nuevo: nuevoIdProveedor });
    }
  }

  let nuevasObservaciones = observacionesActual;
  if (args.observaciones !== undefined) {
    nuevasObservaciones = args.observaciones;
    if (nuevasObservaciones !== observacionesActual) {
      cambios.push({ campo: "observaciones", anterior: observacionesActual, nuevo: nuevasObservaciones });
    }
  }

  if (cambios.length === 0) {
    return formatToolResponse({
      datos: { id: idConcepto, codigo: codigoActual, nombre: nombreActual },
      resumen: `No se realizaron cambios en el concepto "${nombreActual}" (${codigoActual}) porque los valores enviados coinciden con los ya registrados.`,
      advertencias: ["No se enviaron modificaciones pendientes de aplicar."],
    });
  }

  // 5. Armar el payload completo para PUT /api/conceptos?id={id}
  const payloadPut = {
    Id: idConcepto,
    Nombre: nuevoNombre,
    Codigo: nuevoCodigo,
    Tipo: tipoNorm,
    Estado: nuevoEstado,
    Precio: nuevoPrecio,
    PrecioFinal: nuevoPrecioFinal,
    Iva: nuevoIva,
    CostoInterno: nuevoCostoInterno,
    Rentabilidad: nuevaRentabilidad,
    Stock: stockActual,
    StockMinimo: stockMinimoActual,
    IdRubro: String(nuevoIdRubro || ""),
    IdSubrubro: String(nuevoIdSubrubro || ""),
    IDProveedor: nuevoIdProveedor ? Number(nuevoIdProveedor) : null,
    CodigoBarras: nuevoCodigoBarras,
    CodigoProveedor: nuevoCodigoProveedor,
    CodigoOem: codigoOemActual,
    Descripcion: nuevaDescripcion,
    Observaciones: nuevasObservaciones,
    IDMoneda: idMonedaActual,
    Items: itemsCombo,
  };

  // 6. Enviar PUT a Contabilium
  await client.put(`/conceptos?id=${idConcepto}`, payloadPut);

  // 7. Invalidar entradas de conceptos en la caché del cliente para reflejar los cambios
  if (client.cache && typeof client.cache.keys === "function") {
    for (const key of client.cache.keys()) {
      if (key.includes("/conceptos")) {
        client.cache.delete(key);
      }
    }
  }

  const detalleCambios = cambios.map((c) => `${c.campo}: ${c.anterior} -> ${c.nuevo}`).join(", ");
  const resumen = `Concepto "${nuevoNombre}" (${nuevoCodigo}, ID #${idConcepto}) modificado exitosamente. Modificaciones: ${detalleCambios}.`;

  return formatToolResponse({
    datos: {
      id: idConcepto,
      codigo: nuevoCodigo,
      nombre: nuevoNombre,
      tipo: tipoNorm === "P" ? "Producto" : tipoNorm === "S" ? "Servicio" : "Combo",
      estado: nuevoEstado === "A" ? "Activo" : "Inactivo",
      precio: nuevoPrecio,
      precio_final: nuevoPrecioFinal,
      iva: nuevoIva,
      costo_interno: nuevoCostoInterno,
      rentabilidad: nuevaRentabilidad,
      id_rubro: nuevoIdRubro,
      cambios_aplicados: cambios,
    },
    resumen,
    advertencias: [
      "La modificación de conceptos impacta de inmediato en el catálogo comercial de Contabilium.",
      "El stock físico no se actualiza mediante esta tool; para ajustar stock o movimientos use los endpoints de inventario.",
    ],
  });
}
