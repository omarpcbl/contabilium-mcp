import { z } from "zod";
import { formatToolResponse } from "../utils.js";

export const schema = {
  id_comprobante: z.number().int().describe("ID del comprobante emitido en Contabilium."),
};

export async function handler({ id_comprobante }, client) {
  // 1. Obtener datos del comprobante para verificar estado y número
  const info = await client.get("/comprobantes/getById", { id: id_comprobante });

  const numero = info?.Numero || info?.numero || `ID ${id_comprobante}`;
  const cae = info?.Cae || info?.cae || info?.CAE || "";
  const estadoFiscal = cae ? "Emitido con CAE" : "Borrador sin CAE";

  // URL del PDF en la API
  const pdfApiUrl = `${client.baseUrl}/api/comprobantes/obtenerPdf?id=${id_comprobante}`;

  const datos = {
    id_comprobante,
    numero_comprobante: numero,
    estado_fiscal: estadoFiscal,
    cae: cae || null,
    api_pdf_url: pdfApiUrl,
  };

  const resumen = `Comprobante #${id_comprobante} (${numero} - ${estadoFiscal}).`;

  return formatToolResponse({
    datos,
    resumen,
    advertencias: cae ? [] : ["El comprobante aún no posee CAE ante AFIP."],
    truncado: false,
  });
}
