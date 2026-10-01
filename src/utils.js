/**
 * Utilidades generales para Contabilium MCP
 */

/**
 * Normaliza importes provenientes de la API de Contabilium.
 * Soporta números y strings con formato latino ("40.460,11", "$ 1.234,56", etc.)
 */
export function parseAmount(val) {
  if (val === null || val === undefined || val === "") return 0;
  if (typeof val === "number") return isNaN(val) ? 0 : val;

  let str = String(val).trim();
  // Remover símbolo de moneda y espacios
  str = str.replace(/[^0-9.,-]/g, "");

  // Si tiene puntos y comas (ej. 40.460,11): remover puntos y cambiar coma por punto
  if (str.includes(".") && str.includes(",")) {
    str = str.replace(/\./g, "").replace(",", ".");
  } else if (str.includes(",")) {
    // Si solo tiene comas (ej. 460,11)
    str = str.replace(",", ".");
  }

  const num = parseFloat(str);
  return isNaN(num) ? 0 : Math.round(num * 100) / 100;
}

/**
 * Formatea un número a string con separadores de miles y decimales
 */
export function formatCurrency(num, symbol = "$") {
  const n = parseAmount(num);
  const parts = n.toFixed(2).split(".");
  const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${symbol} ${intPart},${parts[1]}`;
}

/**
 * Obtiene la fecha actual en formato YYYY-MM-DD según la zona horaria del país (BUG-14)
 */
export function getTodayString(country = "AR") {
  const c = String(country || "AR").toUpperCase();
  const timeZone = c === "CL" ? "America/Santiago" : c === "UY" ? "America/Montevideo" : "America/Argentina/Buenos_Aires";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * Validador y clasificador de lista blanca para comprobantes fiscales de venta y deuda (BUG-11).
 * Excluye explícitamente cotizaciones (COT, NCT), presupuestos, remitos y tipos inválidos (-1, 0, XXX, FAKE).
 */
export function classifyFiscalInvoice(tipoRaw) {
  if (tipoRaw === null || tipoRaw === undefined) {
    return { esFiscal: false, esVenta: false, esNC: false, tipoNormalizado: "DESCONOCIDO", motivo: "tipo_nulo" };
  }

  const tipo = String(tipoRaw).trim().toUpperCase();

  // Exclusiones explícitas de tipos no fiscales y basura
  if (
    /^(COT|NCT|PRE|REM|PED|PRESUPUESTO|COTIZACION|REMITO|PEDIDO)\b/i.test(tipo) ||
    tipo.startsWith("COT") ||
    tipo.startsWith("NCT") ||
    tipo === "-1" ||
    tipo === "0" ||
    tipo === "XXX" ||
    tipo === "FAKE" ||
    tipo.includes("FAKE") ||
    tipo.includes("XXX")
  ) {
    return { esFiscal: false, esVenta: false, esNC: false, tipoNormalizado: tipo, motivo: "cotizacion_o_no_fiscal" };
  }

  // Notas de Crédito fiscales (restan)
  // Ejemplos: NCA, NCB, NCC, NCE, NCM, NOTA DE CREDITO A, etc. (excluyendo NCT que ya fue descartado arriba)
  if (/^(NC[ABCEM]|NOTA DE CR[EÉ]DITO)\b/i.test(tipo) || (tipo.startsWith("NC") && !tipo.startsWith("NCT") && tipo.length <= 4)) {
    return { esFiscal: true, esVenta: false, esNC: true, tipoNormalizado: tipo };
  }

  // Facturas y Notas de Débito fiscales (suman)
  // Ejemplos: FCA, FCB, FCC, FCE, FCM, NDA, NDB, NDC, NDE, NDM, FACTURA A, NOTA DE DEBITO B, etc.
  if (
    /^(FC[ABCEM]|ND[ABCEM]|FACTURA|NOTA DE D[EÉ]BITO)\b/i.test(tipo) ||
    (tipo.startsWith("FC") && tipo.length <= 4) ||
    (tipo.startsWith("ND") && tipo.length <= 4)
  ) {
    return { esFiscal: true, esVenta: true, esNC: false, tipoNormalizado: tipo };
  }

  // Cualquier otro tipo que no encaje en la lista blanca fiscal
  return { esFiscal: false, esVenta: false, esNC: false, tipoNormalizado: tipo, motivo: "tipo_no_reconocido" };
}

/**
 * Calcula la diferencia en días entre dos fechas (YYYY-MM-DD)
 */
export function diffDays(dateFromStr, dateToStr) {
  const d1 = new Date(dateFromStr + "T00:00:00Z");
  const d2 = new Date(dateToStr + "T00:00:00Z");
  const diffTime = Math.abs(d2.getTime() - d1.getTime());
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

/**
 * Resta N días a una fecha (YYYY-MM-DD o Date) y devuelve string YYYY-MM-DD
 */
export function subDays(dateOrStr, days) {
  const d = typeof dateOrStr === "string" ? new Date(dateOrStr + "T00:00:00Z") : new Date(dateOrStr);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().split("T")[0];
}

/**
 * Obtiene string YYYY-MM
 */
export function getYearMonth(dateStr) {
  if (!dateStr) return "Sin fecha";
  return dateStr.slice(0, 7);
}

/**
 * Obtiene semana del año (YYYY-Www)
 */
export function getIsoWeek(dateStr) {
  if (!dateStr) return "Sin fecha";
  const d = new Date(dateStr.slice(0, 10) + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

/**
 * Empaqueta la respuesta canónica obligatoria para todas las tools:
 * { datos, resumen, advertencias, truncado }
 */
export function formatToolResponse({ datos, resumen, advertencias = [], truncado = false }) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            datos,
            resumen,
            advertencias,
            truncado,
          },
          null,
          2
        ),
      },
    ],
  };
}
