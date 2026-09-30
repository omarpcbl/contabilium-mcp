import { z } from "zod";
import { formatToolResponse } from "../utils.js";

export const schema = {
  texto: z.string().min(2, "El texto de búsqueda debe tener al menos 2 caracteres.").describe("Nombre, razón social o número de documento (CUIT/DNI) del cliente."),
  limite: z.number().int().min(1).max(50).default(10).describe("Límite de resultados a devolver (máx. 50)."),
};

export async function handler({ texto, limite }, client) {
  const query = texto.trim().toLowerCase();

  // Llamada a la API de clientes (con pageSize 50)
  const res = await client.get("/clientes/search", { pageSize: 50, filtro: texto.trim() }, 300);

  let items = [];
  if (Array.isArray(res)) {
    items = res;
  } else if (res && Array.isArray(res.Items)) {
    items = res.Items;
  } else if (res && Array.isArray(res.items)) {
    items = res.items;
  }

  // Filtrado flexible por razón social, nombre de fantasía o documento
  const matches = items.filter((c) => {
    const razonSocial = (c.RazonSocial || c.razonSocial || "").toLowerCase();
    const nombreFantasia = (c.NombreFantasia || c.nombreFantasia || "").toLowerCase();
    const doc = String(c.NroDoc || c.nroDoc || c.Documento || "");
    const email = (c.Email || c.email || "").toLowerCase();
    return razonSocial.includes(query) || nombreFantasia.includes(query) || doc.includes(query) || email.includes(query);
  });

  const sliced = matches.slice(0, limite);

  const datos = sliced.map((c) => ({
    id: c.Id ?? c.id,
    razon_social: c.RazonSocial || c.NombreFantasia || "Sin razón social",
    tipo_documento: c.TipoDoc || c.tipoDoc || "DNI",
    documento: c.NroDoc || c.nroDoc || c.Documento || "",
    email: c.Email || c.email || "",
    id_lista_precio: c.IdListaPrecio ?? c.idListaPrecio ?? null,
  }));

  const resumen = `Se encontraron ${datos.length} cliente(s) que coinciden con "${texto}".`;

  return formatToolResponse({
    datos,
    resumen,
    advertencias: [],
    truncado: matches.length > limite,
  });
}
