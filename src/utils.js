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
  if (/^(NC[ABCEM]|NOTA DE CR[EÉ]DITO)\b/i.test(tipo) || (tipo.startsWith("NC") && !tipo.startsWith("NCT") && tipo.length <= 4)) {
    return { esFiscal: true, esVenta: false, esNC: true, tipoNormalizado: tipo };
  }

  // Facturas y Notas de Débito fiscales (suman)
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
 * Suma N días a una fecha (YYYY-MM-DD o Date) y devuelve string YYYY-MM-DD
 */
export function addDays(dateOrStr, days) {
  const d = typeof dateOrStr === "string" ? new Date(dateOrStr + "T00:00:00Z") : new Date(dateOrStr);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split("T")[0];
}

/**
 * Obtiene string YYYY-MM
 */
export function getYearMonth(dateStr) {
  if (!dateStr) return "Sin fecha";
  return dateStr.slice(0, 7);
}

const NOMBRES_MESES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"
];

/**
 * Convierte 'YYYY-MM' en una etiqueta legible como 'Julio 2026' (MEJ-15)
 */
export function formatYearMonthLabel(dateStr) {
  if (!dateStr || dateStr.length < 7) return dateStr || "Sin fecha";
  const year = dateStr.slice(0, 4);
  const monthIdx = parseInt(dateStr.slice(5, 7), 10) - 1;
  if (monthIdx >= 0 && monthIdx < 12) {
    return `${NOMBRES_MESES[monthIdx]} ${year}`;
  }
  return dateStr;
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
 * Convierte 'YYYY-Www' en una etiqueta legible como 'Semana 27 (29/06 al 05/07/2026)' (MEJ-15)
 */
export function formatIsoWeekLabel(isoWeekStr) {
  if (!isoWeekStr || !isoWeekStr.includes("-W")) return isoWeekStr || "Sin fecha";
  const parts = isoWeekStr.split("-W");
  const year = parseInt(parts[0], 10);
  const week = parseInt(parts[1], 10);
  if (isNaN(year) || isNaN(week)) return isoWeekStr;

  const simple = new Date(Date.UTC(year, 0, 4));
  const dayOfWeek = simple.getUTCDay() || 7;
  const mondayWeek1 = new Date(simple.getTime() - (dayOfWeek - 1) * 86400000);
  const startMonday = new Date(mondayWeek1.getTime() + (week - 1) * 7 * 86400000);
  const endSunday = new Date(startMonday.getTime() + 6 * 86400000);

  const fStart = `${String(startMonday.getUTCDate()).padStart(2, "0")}/${String(startMonday.getUTCMonth() + 1).padStart(2, "0")}`;
  const fEnd = `${String(endSunday.getUTCDate()).padStart(2, "0")}/${String(endSunday.getUTCMonth() + 1).padStart(2, "0")}/${endSunday.getUTCFullYear()}`;

  return `Semana ${week} (${fStart} al ${fEnd})`;
}

/**
 * Genera una barra visual tipográfica segura para dashboards (MEJ-16)
 * Ej: '████████░░ 80%'
 */
export function renderProgressBar(value, max, length = 10) {
  const v = parseAmount(value);
  const m = parseAmount(max);
  if (m <= 0 || v <= 0) return `${"░".repeat(length)} 0%`;
  const ratio = Math.min(1, Math.max(0, v / m));
  const filledCount = Math.round(ratio * length);
  const emptyCount = length - filledCount;
  const pct = Math.round(ratio * 100);
  return `${"█".repeat(filledCount)}${"░".repeat(emptyCount)} ${pct}%`;
}

/**
 * Valida formato y dígito verificador de identificación fiscal según el país (AR: CUIT/DNI, CL: RUT, UY: RUT/CI).
 */
export function validateTaxId(taxId, country = "AR") {
  if (!taxId) return { valido: false, motivo: "Identificación fiscal vacía" };
  const clean = String(taxId).replace(/[^0-9kK]/g, "");
  const c = String(country || "AR").toUpperCase();

  if (c === "AR") {
    // Si tiene 11 dígitos, es CUIT/CUIL -> validar con algoritmo módulo 11
    if (clean.length === 11) {
      const multipliers = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
      let sum = 0;
      for (let i = 0; i < 10; i++) {
        sum += parseInt(clean[i], 10) * multipliers[i];
      }
      let diff = 11 - (sum % 11);
      let verifier = diff === 11 ? 0 : diff === 10 ? 9 : diff;
      if (verifier === parseInt(clean[10], 10)) {
        return { valido: true, tipo: "CUIT", numero: clean };
      }
      return { valido: false, tipo: "CUIT", motivo: `Dígito verificador inválido para CUIT ${taxId}` };
    }
    // Si tiene 7 u 8 dígitos, es DNI
    if (clean.length === 7 || clean.length === 8) {
      return { valido: true, tipo: "DNI", numero: clean };
    }
    return { valido: false, motivo: `Longitud inválida para CUIT/DNI en Argentina (${clean.length} dígitos)` };
  }

  if (c === "CL") {
    // RUT chileno: mínimo 8 caracteres (7-8 dígitos + DV)
    if (clean.length < 8 || clean.length > 9) {
      return { valido: false, motivo: `Longitud inválida para RUT chileno (${clean.length} caracteres)` };
    }
    const cuerpo = clean.slice(0, -1);
    const dvIngresado = clean.slice(-1).toUpperCase();
    let suma = 0;
    let multiplo = 2;
    for (let i = cuerpo.length - 1; i >= 0; i--) {
      suma += parseInt(cuerpo[i], 10) * multiplo;
      multiplo = multiplo === 7 ? 2 : multiplo + 1;
    }
    const dvr = 11 - (suma % 11);
    const dvEsperado = dvr === 11 ? "0" : dvr === 10 ? "K" : String(dvr);
    if (dvIngresado === dvEsperado) {
      return { valido: true, tipo: "RUT", numero: clean };
    }
    return { valido: false, tipo: "RUT", motivo: `Dígito verificador inválido para RUT chileno ${taxId}` };
  }

  // Por defecto (UY u otros): validación básica de longitud
  if (clean.length >= 7) {
    return { valido: true, tipo: "TAX_ID", numero: clean };
  }
  return { valido: false, motivo: `Identificación fiscal no válida (${clean})` };
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

/**
 * Descubre los IDs de integraciones activas en la cuenta a partir de comprobantes recientes
 * o del cache en memoria del cliente.
 */
export async function getAccountIntegrations(client, fechaDesde, fechaHasta) {
  const integraciones = new Set();

  if (client?._knownIntegrations && client._knownIntegrations instanceof Set) {
    for (const id of client._knownIntegrations) {
      if (id !== undefined && id !== null && !isNaN(Number(id))) integraciones.add(Number(id));
    }
  }

  try {
    const compRes = await client.get("/comprobantes/search", { fechaDesde, fechaHasta, page: 1 }, 60);
    const items = Array.isArray(compRes) ? compRes : (compRes?.Items || compRes?.items || []);
    for (const c of items) {
      const idInt = c.IDIntegracion ?? c.IdIntegracion ?? c.idIntegracion;
      if (idInt !== undefined && idInt !== null && !isNaN(Number(idInt)) && Number(idInt) > 0) {
        integraciones.add(Number(idInt));
      }
    }
  } catch {
    // Continuar con las que tengamos
  }

  if (client) {
    if (!client._knownIntegrations) client._knownIntegrations = new Set();
    for (const id of integraciones) client._knownIntegrations.add(id);
  }

  return Array.from(integraciones);
}

