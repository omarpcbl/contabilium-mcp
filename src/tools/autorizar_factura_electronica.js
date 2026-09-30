import { z } from "zod";
import { formatToolResponse, formatCurrency } from "../utils.js";

export const schema = {
  id_comprobante: z.number().int().describe("ID del comprobante en borrador a emitir electrónicamente ante el fisco (obtenido de crear_borrador_factura)."),
};

export async function handler({ id_comprobante }, client) {
  // Llamada a GET /api/comprobantes/emitirFE?id={id_comprobante}
  const res = await client.get("/comprobantes/emitirFE", { id: id_comprobante });

  const id = res?.ID ?? res?.id ?? id_comprobante;
  const cae = res?.CAE ?? res?.cae ?? "";
  const numero = res?.Numero ?? res?.numero ?? "";
  const fechaCae = res?.FechaCAE ?? res?.fechaCAE ?? null;
  const linkPublico = res?.LinkPublico ?? res?.linkPublico ?? "";
  const total = Number(res?.Total ?? res?.total ?? 0);
  const obsAfip = res?.ObservacionesAFIP ?? res?.observacionesAFIP ?? "";
  const fiscalUrl = res?.FiscalUrl ?? res?.fiscalUrl ?? "";

  const exitoFiscal = Boolean(cae && cae.trim().length > 0);

  if (!exitoFiscal) {
    const errorMsg = res?.Error || res?.error || res?.Description || "El fisco rechazó la emisión del comprobante.";
    throw new Error(`Fallo de autorización fiscal en AFIP/SII: ${errorMsg}`);
  }

  const datos = {
    id_comprobante: id,
    cae: cae,
    numero_comprobante: numero,
    fecha_vto_cae: fechaCae,
    total: total,
    total_formateado: formatCurrency(total),
    link_pdf: linkPublico,
    observaciones_afip: obsAfip,
    fiscal_url: fiscalUrl,
  };

  const resumen = `¡Factura emitida con éxito! Número: ${numero} | CAE: ${cae} | Total: ${formatCurrency(total)}. Link PDF disponible.`;

  return formatToolResponse({
    datos,
    resumen,
    advertencias: obsAfip ? [`Observaciones del fisco: ${obsAfip}`] : [],
    truncado: false,
  });
}
