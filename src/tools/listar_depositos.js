import { formatToolResponse } from "../utils.js";

export const schema = {};

export async function handler(_params, client) {
  // Caché de 30 minutos (1800 segundos) para catálogo de depósitos
  const res = await client.get("/inventarios/getDepositos", null, 1800);

  let items = [];
  if (Array.isArray(res)) {
    items = res;
  } else if (res && Array.isArray(res.Items)) {
    items = res.Items;
  }

  const datos = items
    .filter((d) => d.Activo !== false)
    .map((d) => ({
      id: d.Id ?? d.id,
      nombre: d.Nombre || d.nombre || "Sin nombre",
    }));

  const resumen = `Se encontraron ${datos.length} depósito(s) activos.`;

  return formatToolResponse({
    datos,
    resumen,
    advertencias: [],
    truncado: false,
  });
}
