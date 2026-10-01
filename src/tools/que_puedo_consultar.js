import { z } from "zod";
import { formatToolResponse } from "../utils.js";

export const schema = {
  categoria: z
    .enum(["todos", "ventas", "stock", "deuda", "diagnostico"])
    .default("todos")
    .describe("Área sobre la cual solicitar guía de preguntas y capacidades: todos, ventas, stock, deuda o diagnostico."),
};

export async function handler({ categoria = "todos" }, client) {
  let empresa = "Tu Empresa";
  let cuit = "";
  let depositos = [];

  try {
    const info = await client.get("/usuarios/obtenerinfo", null, 1800);
    if (info) {
      empresa = info.RazonSocial || info.NombreFantasia || empresa;
      cuit = info.CUIT || "";
    }
  } catch {
    // Si no está disponible, continuar con valores predeterminados
  }

  try {
    const depsRaw = await client.get("/inventarios/getDepositos", null, 1800);
    if (Array.isArray(depsRaw)) {
      depositos = depsRaw.filter((d) => d.Activo !== false).map((d) => d.Nombre || `Depósito ${d.Id}`);
    }
  } catch {
    // Continuar
  }

  const moduloVentas = {
    nombre: "Ventas y Facturación Comercial",
    tools: ["resumen_ventas", "listar_ventas"],
    capacidades: [
      "Totalizar ventas netas deduciendo notas de crédito automáticamente.",
      "Desglosar facturación bruta, NC y ticket promedio.",
      "Agrupar por día, semana, mes, cliente u origen de venta.",
      "Comparar variaciones porcentuales contra el período anterior.",
    ],
    preguntas_ejemplo: [
      "¿Cómo vienen las ventas netas de este mes comparadas con el mes anterior?",
      "Mostrame la curva de ventas diarias de los últimos 30 días.",
      "¿Cuáles son los 5 clientes con mayor volumen de compra en el año?",
    ],
  };

  const moduloStock = {
    nombre: "Inventario y Stock por Depósito",
    tools: ["stock_por_deposito", "buscar_productos", "listar_depositos"],
    capacidades: [
      "Consultar existencias físicas, reservas comprometidas y disponible real.",
      "Detectar sobreventas críticas y existencias físicas negativas.",
      "Buscar productos por SKU o nombre con su costo interno registrado.",
      ...(depositos.length > 0 ? [`Depósitos activos disponibles: ${depositos.slice(0, 3).join(", ")}.`] : []),
    ],
    preguntas_ejemplo: [
      "¿Qué productos están sin stock o con sobreventa en el depósito principal?",
      "Listame los 10 productos con menor disponible para reponer.",
      "Buscá el producto con código 'CASCO' y decime su precio y costo interno.",
    ],
  };

  const moduloDeuda = {
    nombre: "Cuentas por Cobrar y Cobranzas",
    tools: ["cuentas_por_cobrar", "buscar_clientes"],
    capacidades: [
      "Totalizar saldos deudores pendientes de cobro.",
      "Identificar deuda vencida y calcular días de mora.",
      "Generar reporte de antigüedad de saldos (0-30, 31-60, 61-90, >90 días).",
    ],
    preguntas_ejemplo: [
      "¿Quiénes son los clientes que más me deben y cuánto tienen vencido?",
      "Mostrame el reporte de antigüedad de deuda en tramos de 30 días.",
      "¿Tengo facturas vencidas a más de 90 días pendientes de cobrar?",
    ],
  };

  const moduloDiagnostico = {
    nombre: "Diagnóstico de Órdenes e Integraciones E-Commerce (OP-08)",
    tools: ["diagnosticar_orden"],
    capacidades: [
      "Diagnosticar órdenes de e-commerce (Fenicio, Base, Vestetic, Luna, etc.) para detectar por qué no se facturaron.",
      "Comprobar si el comprobante ya fue emitido previamente para evitar duplicados.",
      "Validar algoritmo fiscal de CUIT/DNI/RUT del comprador.",
      "Verificar existencia y estado activo de los SKUs en catálogo.",
      "Auditar stock disponible en depósito contra la cantidad solicitada.",
    ],
    preguntas_ejemplo: [
      "Diagnosticá por qué no facturó la orden 'FEN-10293' de Fenicio.",
      "Chequeá si los SKUs 'REM-01' y 'PANT-02' tienen stock disponible para la orden 4810.",
    ],
  };

  const limites = [
    "Rango máximo: hasta 92 días por consulta individual de comprobantes (para períodos anuales, consultar mes por mes).",
    "Paginación segura: tope de 20 páginas (1.000 comprobantes) para garantizar respuestas rápidas y prevenir timeouts.",
    "Filtro fiscal: se excluyen automáticamente cotizaciones (COT/NCT), presupuestos y comprobantes no fiscales.",
    "Solo lectura: esta integración está diseñada exclusivamente para dashboards y consultas analíticas de gestión (la facturación no está habilitada).",
  ];

  let modulos = [];
  let preguntasSugeridas = [];

  if (categoria === "todos" || categoria === "ventas") {
    modulos.push(moduloVentas);
    preguntasSugeridas.push(...moduloVentas.preguntas_ejemplo.slice(0, 2));
  }
  if (categoria === "todos" || categoria === "stock") {
    modulos.push(moduloStock);
    preguntasSugeridas.push(...moduloStock.preguntas_ejemplo.slice(0, 2));
  }
  if (categoria === "todos" || categoria === "deuda") {
    modulos.push(moduloDeuda);
    preguntasSugeridas.push(...moduloDeuda.preguntas_ejemplo.slice(0, 2));
  }
  if (categoria === "todos" || categoria === "diagnostico") {
    modulos.push(moduloDiagnostico);
    preguntasSugeridas.push(...moduloDiagnostico.preguntas_ejemplo.slice(0, 2));
  }

  const datos = {
    cuenta_conectada: {
      empresa,
      cuit: cuit || "No informado",
      ambiente: client?.ambiente || "Producción",
    },
    modulos,
    limites_del_servicio: limites,
    preguntas_sugeridas_para_iniciar: preguntasSugeridas,
  };

  const resumen = `Guía de asistencia para ${empresa}. Tenés habilitados 3 módulos de gestión: Ventas, Inventario y Cuentas por Cobrar. Elegí una de las preguntas sugeridas para comenzar.`;

  return formatToolResponse({
    datos,
    resumen,
    advertencias: ["La integración opera exclusivamente en modo lectura analítica."],
    truncado: false,
  });
}
