import { z } from "zod";
import { formatToolResponse } from "../utils.js";

export const schema = {
  texto: z.string().min(2, "El texto de búsqueda debe tener al menos 2 caracteres.").describe("Nombre, razón social o CUIT del proveedor."),
  limite: z.number().int().min(1).max(50).default(10).describe("Límite de proveedores a retornar (máx. 50)."),
};

export async function handler({ texto, limite }, client) {
  const query = texto.trim().toLowerCase();

  // Llamada a la API de proveedores
  const res = await client.get("/proveedores/search", { pageSize: 50, filtro: texto.trim() }, 300);

  let items = [];
  if (Array.isArray(res)) {
    items = res;
  } else if (res && Array.isArray(res.Items)) {
    items = res.Items;
  } else if (res && Array.isArray(res.items)) {
    items = res.items;
  }

  const matches = items.filter((p) => {
    const razonSocial = (p.RazonSocial || p.razonSocial || "").toLowerCase();
    const nombreFantasia = (p.NombreFantasia || p.nombreFantasia || "").toLowerCase();
    const doc = String(p.NroDoc || p.nroDoc || p.Documento || "");
    const email = (p.Email || p.email || "").toLowerCase();
    return razonSocial.includes(query) || nombreFantasia.includes(query) || doc.includes(query) || email.includes(query);
  });

  const sliced = matches.slice(0, limite);

  const datos = sliced.map((p) => ({
    id: p.Id ?? p.id,
    razon_social: p.RazonSocial || p.NombreFantasia || "Sin razón social",
    tipo_documento: p.TipoDoc || p.tipoDoc || "CUIT",
    documento: p.NroDoc || p.nroDoc || p.Documento || "",
    email: p.Email || p.email || "",
    telefono: p.Telefono || p.telefono || "",
    domicilio: p.Domicilio || p.domicilio || "",
  }));

  const resumen = `Se encontraron ${datos.length} proveedor(es) que coinciden con "${texto}".`;

  return formatToolResponse({
    datos,
    resumen,
    advertencias: [],
    truncado: matches.length > limite,
  });
}
