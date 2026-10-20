import { z } from "zod";
import { formatToolResponse } from "../utils.js";
import { isToolAllowed } from "../register-tools.js";

export const schema = {
  categoria: z
    .enum(["todos", "ventas", "stock", "deuda", "diagnostico"])
    .default("todos")
    .describe("Área sobre la cual solicitar guía de preguntas y capacidades: todos, ventas, stock, deuda o diagnostico."),
  tool: z
    .string()
    .optional()
    .describe(
      "Nombre de una tool específica sobre la cual consultar cómo funciona internamente y qué parámetros espera (ej: 'emular_facturacion', 'crear_borrador_factura', 'enviar_venta', 'buscar_ordenes_venta', 'diagnosticar_orden', 'modificar_concepto', 'modificar_stock_concepto', 'resumen_ventas', 'listar_ventas', 'stock_por_deposito', 'cuentas_por_cobrar', 'buscar_clientes', 'buscar_productos', 'buscar_proveedores', 'listar_depositos')."
    ),
};

const GUIA_DETALLADA_TOOLS = {
  emular_facturacion: {
    nombre: "emular_facturacion",
    modulo: "Ventas, Órdenes y Facturación Comercial",
    proposito: "Simulador Dry-Run 100% libre de riesgo fiscal: valida cliente, CUIT/DNI/RUT, letra del comprobante según Matriz AFIP (FA/FB/FC), punto de venta, condición de venta, SKUs y stock, y genera los payloads JSON exactos para integrar con la API.",
    como_funciona: [
      "No emite facturas ni crea registros en Contabilium ni en AFIP/ARCA (operación de solo lectura y validación en vivo).",
      "Cruza la condición de IVA de la empresa emisora (/usuarios/obtenerinfo) contra la del cliente receptor (/clientes/search) aplicando la Matriz Oficial de AFIP (RG 5003) para determinar si corresponde Factura A ('FA'), Factura B ('FB') o Factura C ('FC').",
      "Detecta errores frecuentes de integración antes de que ocurran en producción: envío de CUIL esperando Factura A (Error C9), condición de venta con diferencias de espacios o mayúsculas (Error C2), punto de venta inactivo, SKUs inexistentes o descalce en la suma de pagos.",
      "Devuelve los contratos HTTP y payloads JSON listos para copiar y pegar en POST /api/comprobantes/crear (borrador), POST /api/comprobantes/emitirFECobrada (emisión directa) y GET /api/ordenesventa/emitirFE (facturación de orden e-commerce).",
    ],
    que_espera: {
      parametros_obligatorios: {
        items: "Array (mínimo 1 ítem) con { concepto, cantidad, precio_unitario (neto sin IVA), iva (default 21), codigo (SKU opcional), bonificacion (default 0) }.",
      },
      parametros_opcionales: {
        id_cliente: "Number. ID numérico del cliente en Contabilium.",
        cliente_documento: "String. CUIT, DNI o RUT del cliente receptor para buscarlo en padrón y validar su dígito verificador.",
        cliente_tipo_documento: "Enum: 'CUIT' | 'CUIL' | 'DNI' | 'RUT' | 'CI' | 'OTRO'.",
        cliente_condicion_iva: "Enum: 'RI' | 'MO' | 'CF' | 'EX'.",
        tipo_factura: "Enum: 'FA' | 'FB' | 'FC' | 'FM' | 'FCE'. Si se envía, valida si es compatible según AFIP.",
        punto_venta: "Number. ID del punto de venta a validar.",
        condicion_venta: "String (default 'Cuenta Corriente'). Se contrasta contra /usuarios/condicionesVenta.",
        id_deposito: "Number. ID del depósito para auditar stock disponible de los SKUs.",
        pagos: "Array opcional de pagos { forma_de_pago, importe, id_caja, id_banco, nro_referencia }.",
        nro_orden_ecommerce: "String. Código externo de la orden (IdVentaIntegracion) si querés simular GET /api/ordenesventa/emitirFE.",
        id_integracion: "Number. ID de la integración e-commerce.",
      },
    },
    ejemplo_uso: {
      cliente_documento: "20-12345678-6",
      cliente_tipo_documento: "CUIT",
      condicion_venta: "MercadoPago",
      items: [
        {
          codigo: "CASCO-01",
          concepto: "Casco de seguridad",
          cantidad: 2,
          precio_unitario: 15000,
          iva: 21,
        },
      ],
    },
  },
  crear_borrador_factura: {
    nombre: "crear_borrador_factura",
    modulo: "Ventas, Órdenes y Facturación Comercial",
    proposito: "Guarda un borrador de factura en Contabilium mediante POST /api/comprobantes/crear sin validez fiscal ni llamada a AFIP/ARCA.",
    como_funciona: [
      "Precalcula automáticamente la letra del comprobante (FA, FB, FC) según la condición de IVA del emisor y del cliente receptor.",
      "Selecciona el primer punto de venta activo si no se especifica 'punto_venta', calcula subtotales netos e IVA y graba el comprobante en estado BORRADOR (sin CAE).",
      "Ideal para practicar la creación de comprobantes en Contabilium o dejar preparada una factura para que un usuario humano la revise y autorice desde la web.",
    ],
    que_espera: {
      parametros_obligatorios: {
        id_cliente: "Number (entero). ID del cliente en Contabilium (obtenido con 'buscar_clientes').",
        items: "Array (mínimo 1 ítem) con { concepto, cantidad, precio_unitario, iva (default 21), codigo (opcional), id_concepto (opcional), bonificacion (default 0) }.",
      },
      parametros_opcionales: {
        tipo_factura: "Enum: 'FA' | 'FB' | 'FC' | 'FM' | 'FCE'.",
        punto_venta: "Number. ID del punto de venta.",
        condicion_venta: "String (default 'Cuenta Corriente').",
        id_deposito: "Number. ID del depósito.",
        tipo_concepto: "Number (1 = Productos, 2 = Servicios, 3 = Ambos; default 1).",
        fecha_emision: "String (YYYY-MM-DD).",
        observaciones: "String.",
      },
    },
  },
  enviar_venta: {
    nombre: "enviar_venta",
    modulo: "Ventas, Órdenes y Facturación Comercial",
    proposito: "Envía (crea o actualiza) una orden de venta e-commerce en Contabilium mediante POST /notificador/ecommerce sin emitir factura electrónica fiscal.",
    como_funciona: [
      "Upsert automático: si el número de orden ('id_venta_integracion') no existe para esa integración, crea una nueva orden de venta; si ya existe (y aún no fue procesada/facturada), actualiza sus datos e ítems.",
      "Resolución de Depósito / Inventario ('IDInventario'): podés enviar el depósito simplemente por su nombre en 'deposito' (ej: 'Depósito Central' o 'Sucursal Norte') o por su ID numérico en 'id_deposito'. La tool busca el depósito contra los depósitos activos de la cuenta (/inventarios/getDepositos, ignorando mayúsculas y tildes) e inyecta su 'IDInventario' en el payload. Si NO se envía ni 'deposito' ni 'id_deposito', la tool omite 'IDInventario' y Contabilium asigna automáticamente el depósito de reserva configurado por defecto en la integración ('idInventarioReserva').",
      "Autodescubrimiento de Integración: si omitís 'id_integracion' y la cuenta tiene una única integración e-commerce activa, la tool la detecta y utiliza automáticamente.",
      "Validación de Condición de Venta (prevención Error C2): valida y normaliza automáticamente 'condicion_venta' contra el catálogo oficial de la cuenta (/usuarios/condicionesVenta). Por ejemplo, si enviás 'efectivo' o 'mercadopago', lo normaliza al nombre exacto ('Efectivo', 'MercadoPago').",
      "Validación Fiscal del Comprador: infiere el tipo de documento ('CUIT', 'DNI', 'RUT', 'CI') si no se indica, valida el dígito verificador y alerta si se envía 'CUIL' (no admitido en este endpoint, sugiriendo usar 'CUIT' o 'DNI').",
      "Protección de Frase Reservada en Envíos: si algún ítem se llama 'Costo de envío', lo renombra automáticamente a 'Envío' para evitar que Contabilium sobreescriba su importe a $0,00. Además permite informar 'costo_envio' y 'descuento_general' como parámetros directos.",
      "Control por Cuenta: verifica si la cuenta conectada tiene permisos para enviar órdenes (configurable mediante ENVIAR_VENTA_ALLOWED_ACCOUNTS).",
    ],
    que_espera: {
      parametros_obligatorios: {
        id_venta_integracion: "String. Identificador o código único de la orden en la plataforma externa (ej: 'ORD-10025', 'ML-998877').",
        condicion_venta: "String. Condición de venta válida en la cuenta (ej: 'Efectivo', 'Cuenta Corriente', 'MercadoPago', 'Transferencia').",
        cliente: {
          nombre: "String (obligatorio). Nombre o Razón Social del comprador.",
          apellido: "String (opcional). Apellido del comprador.",
          tipo_documento: "Enum opcional: 'CUIT' | 'DNI' | 'RUT' | 'CI' | 'OTRO'. Si se omite, se infiere según el número.",
          documento: "String (opcional, default '11111111'). Número de documento o CUIT/RUT.",
          condicion_iva: "Enum opcional (default 'CF'): 'CF' (Consumidor Final), 'RI' (Responsable Inscripto), 'MO' (Monotributista), 'EX' (Exento).",
          email: "String (opcional, default 'sin-email@ejemplo.com'). Correo electrónico.",
          telefono: "String (opcional).",
          domicilio: "String (opcional, default 'Sin especificar'). Calle y altura.",
          piso_dpto: "String (opcional).",
          cp: "String (opcional, default '1000'). Código postal.",
          provincia: "String (opcional, default 'CABA'). Provincia o estado.",
          ciudad: "String (opcional, default 'CABA'). Ciudad o localidad.",
          observaciones: "String (opcional).",
        },
        items: "Array (mínimo 1 ítem). Cada ítem espera: { codigo (SKU del producto, obligatorio), concepto (descripción, opcional si se informa código), cantidad (number > 0, obligatorio), precio_unitario (number >= 0, obligatorio, sin IVA), iva (porcentaje ej: 21, 10.5, 0; default 21), bonificacion (% de descuento de línea 0-100, default 0) }.",
      },
      parametros_opcionales: {
        id_integracion: "Number (entero positivo). ID de la integración en Contabilium. Opcional si la cuenta posee una única integración activa.",
        deposito: "String. Nombre del depósito o inventario donde impacta la orden (ej: 'Depósito Central'). Se resuelve automáticamente a su IDInventario. Si se omite junto con 'id_deposito', Contabilium usa el depósito configurado en la integración.",
        id_deposito: "Number (entero positivo). ID numérico del depósito/inventario (alternativa directa a 'deposito').",
        estado_integracion: "Enum: 'Pendiente' | 'Aceptada' | 'Aceptado' | 'Cancelada' | 'Cancelado' (default 'Aceptada').",
        costo_envio: "Number (>= 0). Monto neto de envío sin IVA; agrega automáticamente una línea segura bajo el concepto 'Envío'.",
        iva_envio: "Number (0 a 100, default 21). Porcentaje de IVA aplicable al costo de envío.",
        descuento_general: "Number (>= 0). Monto neto sin IVA de descuento global; agrega automáticamente un ítem negativo con SKU 'DESC-GEN'.",
        iva_descuento: "Number (0 a 100, default 21). Porcentaje de IVA del descuento general.",
        moneda: "Enum: 'ARS' | 'USD' | 'UYU' | 'CLP' (default 'ARS').",
        valor_cotizacion: "Number (> 0, default 1). Tipo de cambio de la operación.",
        lista_precio: "Number (entero positivo). ID de la lista de precios a aplicar.",
        etiqueta: "String. Etiqueta o tag identificador de la orden.",
        observaciones: "String. Observaciones generales del pedido.",
        fecha_creacion: "String. Fecha de creación en formato YYYY-MM-DD o ISO.",
      },
    },
    ejemplo_uso: {
      id_venta_integracion: "PED-2026-001",
      deposito: "Depósito Central",
      condicion_venta: "MercadoPago",
      cliente: {
        nombre: "Juan",
        apellido: "Pérez",
        tipo_documento: "DNI",
        documento: "30123456",
        condicion_iva: "CF",
        email: "juan.perez@ejemplo.com",
      },
      items: [
        {
          codigo: "CASCO-01",
          concepto: "Casco de seguridad",
          cantidad: 2,
          precio_unitario: 15000,
          iva: 21,
          bonificacion: 0,
        },
      ],
      costo_envio: 3500,
    },
  },
  buscar_ordenes_venta: {
    nombre: "buscar_ordenes_venta",
    modulo: "Ventas, Órdenes y Facturación Comercial",
    proposito: "Busca y lista órdenes de venta e-commerce o preventas por rango de fechas, filtro (número de orden, referencia externa o cliente) e ID de integración.",
    como_funciona: [
      "Consulta el endpoint de órdenes de venta con paginación segura y filtra por fechas (máximo 92 días por consulta).",
      "Permite buscar una orden puntual por su código externo, número interno o nombre del cliente mediante el parámetro 'filtro'.",
      "Devuelve el estado de la orden, depósito asociado, totales, comprobante fiscal vinculado (si ya fue facturada) y el detalle de ítems.",
    ],
    que_espera: {
      parametros_obligatorios: {},
      parametros_opcionales: {
        filtro: "String. Número de orden, referencia de integración o nombre/CUIT del cliente.",
        id_integracion: "Number. ID de la integración e-commerce en Contabilium.",
        fecha_desde: "String (YYYY-MM-DD). Fecha inicial (por defecto, últimos 30 días).",
        fecha_hasta: "String (YYYY-MM-DD). Fecha final (máximo 92 días desde fecha_desde).",
      },
    },
  },
  diagnosticar_orden: {
    nombre: "diagnosticar_orden",
    modulo: "Diagnóstico de Órdenes e Integraciones E-Commerce (OP-08)",
    proposito: "Audita por qué una orden de e-commerce no se facturó o rechazó, validando duplicados, datos fiscales del comprador, condición de venta, existencia de SKUs y stock en depósito.",
    como_funciona: [
      "Ejecuta una batería de chequeos en cascada (C1 a C9): verifica si el comprobante ya fue emitido previamente, valida el algoritmo fiscal de CUIT/DNI/RUT, comprueba que la condición de venta exista en la cuenta, verifica que cada SKU exista y esté activo en el catálogo, y audita el stock disponible en el depósito.",
      "Entrega un diagnóstico estructurado con la causa raíz exacta y los pasos recomendados para destrabar la orden.",
    ],
    que_espera: {
      parametros_obligatorios: {
        orden_id: "String. Identificador o número de la orden a diagnosticar.",
      },
      parametros_opcionales: {
        integracion: "String. Nombre de la plataforma de e-commerce (ej: 'Fenicio', 'MercadoLibre', 'TiendaNube', 'WooCommerce').",
        id_integracion: "Number. ID numérico de la integración en Contabilium.",
        cliente_documento: "String. CUIT/DNI/RUT del comprador para validar formato y dígito verificador.",
        tipo_documento: "String ('CUIT', 'CUIL', 'DNI', 'RUT').",
        condicion_venta: "String. Condición de venta enviada en la orden para contrastar contra el catálogo.",
        skus: "Array de objetos { sku, cantidad, precio } o lista de SKUs para verificar existencia y stock.",
        id_deposito: "Number. ID del depósito donde auditar disponibilidad de stock.",
      },
    },
  },
  modificar_concepto: {
    nombre: "modificar_concepto",
    modulo: "Inventario, Catálogo y Stock por Depósito",
    proposito: "Actualiza atributos de un producto o servicio existente en el catálogo (precio, costo interno, IVA, nombre, descripción, estado, SKU, código de barras) sin crear conceptos nuevos.",
    como_funciona: [
      "Localiza el concepto existente por su 'id' o 'codigo' (SKU) y fusiona los campos actuales con los cambios solicitados para no perder configuraciones previas.",
      "Verifica permisos de la cuenta (MODIFICAR_CONCEPTO_ALLOWED_ACCOUNTS) y ejecuta PUT sobre el concepto en Contabilium.",
    ],
    que_espera: {
      parametros_obligatorios: {
        identificador: "Debe informarse al menos 'id' (ID numérico del concepto) o 'codigo' (SKU exacto del producto).",
        cambio: "Al menos un atributo a modificar: 'precio', 'costo_interno', 'iva', 'nombre', 'descripcion', 'estado' ('Activo'/'Inactivo'), 'codigo_barras', 'nuevo_codigo', etc.",
      },
      parametros_opcionales: {
        id: "Number. ID interno del concepto en Contabilium.",
        codigo: "String. SKU actual del producto.",
        precio: "Number (>= 0). Nuevo precio de venta neto.",
        costo_interno: "Number (>= 0). Nuevo costo interno / de reposición.",
        iva: "Number. Nueva alícuota de IVA (ej: 21, 10.5, 0).",
        nombre: "String. Nuevo nombre del concepto.",
        descripcion: "String. Nueva descripción.",
        estado: "Enum ('Activo' | 'Inactivo').",
      },
    },
  },
  modificar_stock_concepto: {
    nombre: "modificar_stock_concepto",
    modulo: "Inventario, Catálogo y Stock por Depósito",
    proposito: "Reemplaza o ajusta el stock físico de un producto en un depósito específico identificándolo por SKU o ID.",
    como_funciona: [
      "Busca el producto por 'sku' o 'id_concepto', resuelve el depósito objetivo (o toma el depósito activo principal si no se especifica) y actualiza la cantidad física en ese depósito.",
    ],
    que_espera: {
      parametros_obligatorios: {
        identificador: "Debe enviarse 'sku' (código del producto) o 'id_concepto' (ID numérico).",
        cantidad: "Number. Nueva cantidad física total a establecer en el depósito.",
      },
      parametros_opcionales: {
        id_deposito: "Number. ID del depósito donde impactar el stock (si se omite, usa el depósito principal).",
        precio: "Number. Opcionalmente permite actualizar el precio en la misma operación.",
      },
    },
  },
  resumen_ventas: {
    nombre: "resumen_ventas",
    modulo: "Ventas, Órdenes y Facturación Comercial",
    proposito: "Totaliza ventas netas (descontando notas de crédito), facturación bruta, cantidad de comprobantes y ticket promedio en un rango de hasta 92 días.",
    como_funciona: [
      "Descarga los comprobantes fiscales del período, excluye cotizaciones/presupuestos no fiscales, resta las Notas de Crédito y agrupa resultados por día, semana, mes, cliente u origen.",
      "Si 'comparar_con_periodo_anterior' es true, calcula automáticamente la variación porcentual contra el período inmediato anterior.",
    ],
    que_espera: {
      parametros_obligatorios: {
        fecha_desde: "String (YYYY-MM-DD). Fecha inicial.",
        fecha_hasta: "String (YYYY-MM-DD). Fecha final (máx 92 días).",
      },
      parametros_opcionales: {
        agrupar_por: "Enum: 'dia' | 'semana' | 'mes' | 'cliente' | 'origen'.",
        comparar_con_periodo_anterior: "Boolean (default false).",
        incluir_iva: "Boolean (default true).",
      },
    },
  },
  listar_ventas: {
    nombre: "listar_ventas",
    modulo: "Ventas, Órdenes y Facturación Comercial",
    proposito: "Lista comprobantes de venta emitidos (facturas, notas de crédito, notas de débito) con su estado, cliente e importes.",
    como_funciona: [
      "Filtra comprobantes emitidos en un rango de hasta 92 días, excluyendo cotizaciones y presupuestos, con soporte de filtro por cliente o estado.",
    ],
    que_espera: {
      parametros_obligatorios: {
        fecha_desde: "String (YYYY-MM-DD).",
        fecha_hasta: "String (YYYY-MM-DD).",
      },
      parametros_opcionales: {
        cliente: "String. Nombre, razón social, CUIT o ID del cliente.",
        tipo_comprobante: "Enum: 'todos' | 'facturas' | 'notas_credito' | 'notas_debito'.",
        estado: "Enum: 'todos' | 'pendientes' | 'cobradas' | 'vencidas'.",
      },
    },
  },
  stock_por_deposito: {
    nombre: "stock_por_deposito",
    modulo: "Inventario, Catálogo y Stock por Depósito",
    proposito: "Audita existencias físicas, stock reservado y stock disponible real por depósito.",
    como_funciona: [
      "Consulta el inventario de uno o todos los depósitos activos, calcula el disponible real (físico menos reservado) y detecta sobreventas o quiebres de stock.",
    ],
    que_espera: {
      parametros_obligatorios: {},
      parametros_opcionales: {
        deposito: "String o Number. Nombre o ID del depósito a consultar.",
        sku: "String. Código o nombre del producto para filtrar.",
        filtro: "Enum: 'todos' | 'con_stock' | 'sin_stock' | 'bajo_minimo'.",
        orden: "Enum: 'menor_disponible' | 'mayor_disponible' | 'alfabetico'.",
        top: "Number (default 50). Cantidad máxima de productos a devolver.",
      },
    },
  },
  cuentas_por_cobrar: {
    nombre: "cuentas_por_cobrar",
    modulo: "Cuentas por Cobrar y Cobranzas",
    proposito: "Analiza saldos pendientes de cobro, mora y antigüedad de deuda (Aging 0-30, 31-60, 61-90 y >90 días).",
    como_funciona: [
      "Recorre los comprobantes con saldo pendiente, calcula los días de atraso desde la fecha de vencimiento y agrupa la deuda por cliente y por tramo de antigüedad.",
    ],
    que_espera: {
      parametros_obligatorios: {},
      parametros_opcionales: {
        cliente: "String. Filtro por nombre, CUIT o ID de cliente.",
        solo_vencidas: "Boolean (default false). Si es true, solo incluye facturas cuyo vencimiento ya operó.",
        fecha_desde: "String (YYYY-MM-DD).",
        fecha_hasta: "String (YYYY-MM-DD).",
      },
    },
  },
  buscar_clientes: {
    nombre: "buscar_clientes",
    modulo: "Cuentas por Cobrar y Cobranzas",
    proposito: "Busca clientes en el padrón por nombre, razón social, código o CUIT/DNI.",
    como_funciona: ["Consulta el padrón de clientes de Contabilium y devuelve ID interno, razón social, documento, condición de IVA y datos de contacto."],
    que_espera: {
      parametros_obligatorios: { filtro: "String. Texto a buscar (nombre, razón social o documento/CUIT)." },
      parametros_opcionales: { pagina: "Number (default 1)." },
    },
  },
  buscar_productos: {
    nombre: "buscar_productos",
    modulo: "Inventario, Catálogo y Stock por Depósito",
    proposito: "Busca conceptos/productos en el catálogo por SKU o nombre, devolviendo precio, stock consolidado y costo interno.",
    como_funciona: ["Filtra el catálogo de conceptos y expone precio neto, precio final con IVA, alícuota de IVA, stock total, costo_interno y proveedor."],
    que_espera: {
      parametros_obligatorios: { filtro: "String. SKU o nombre del producto a buscar." },
      parametros_opcionales: { incluir_inactivos: "Boolean (default false)." },
    },
  },
  buscar_proveedores: {
    nombre: "buscar_proveedores",
    modulo: "Inventario, Catálogo y Stock por Depósito",
    proposito: "Busca proveedores registrados por nombre, razón social o CUIT.",
    como_funciona: ["Consulta el padrón de proveedores de la cuenta y devuelve sus datos identificatorios y de contacto."],
    que_espera: {
      parametros_obligatorios: { filtro: "String. Nombre, razón social o CUIT del proveedor." },
      parametros_opcionales: {},
    },
  },
  listar_depositos: {
    nombre: "listar_depositos",
    modulo: "Inventario, Catálogo y Stock por Depósito",
    proposito: "Lista todos los depósitos (inventarios) de la cuenta con su ID numérico, nombre y estado activo/inactivo.",
    como_funciona: ["Consulta /inventarios/getDepositos y devuelve el listado completo de depósitos para conocer sus nombres e IDs."],
    que_espera: {
      parametros_obligatorios: {},
      parametros_opcionales: { solo_activos: "Boolean (default true)." },
    },
  },
};

export async function handler({ categoria = "todos", tool } = {}, client) {
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
    nombre: "Ventas, Órdenes y Facturación Comercial",
    tools: ["resumen_ventas", "listar_ventas", "buscar_ordenes_venta", "enviar_venta", "emular_facturacion", "crear_borrador_factura"].filter(isToolAllowed),
    capacidades: [
      "Totalizar ventas netas deduciendo notas de crédito automáticamente.",
      "Desglosar facturación bruta, NC y ticket promedio.",
      "Agrupar por día, semana, mes, cliente u origen de venta.",
      "Consultar órdenes de venta e-commerce y preventas por número de orden o integración.",
      "Enviar (crear o actualizar) órdenes de venta e-commerce con comprador, ítems, costo de envío y descuentos.",
      "Simular facturación en modo Dry-Run ('emular_facturacion') validando Matriz AFIP (FA/FB/FC), CUIT, punto de venta y generando los payloads JSON exactos para integrar con la API.",
      "Crear borradores de factura ('crear_borrador_factura') en Contabilium sin validez fiscal ni llamada a AFIP.",
      "Comparar variaciones porcentuales contra el período anterior.",
    ],
    preguntas_ejemplo: [
      "¿Cómo vienen las ventas netas de este mes comparadas con el mes anterior?",
      "Simulá cómo quedaría el JSON para facturarle 2 cascos a CUIT 20-12345678-6 con MercadoPago.",
      "Buscá la orden de venta 2000018479202700 de la integración 27341.",
      "Enviá una venta para la integración 27341 con orden 'PED-105' a nombre de Juan Pérez.",
      "Mostrame la curva de ventas diarias de los últimos 30 días.",
      "¿Cuáles son los 5 clientes con mayor volumen de compra en el año?",
    ],
  };

  const moduloStock = {
    nombre: "Inventario, Catálogo y Stock por Depósito",
    tools: ["stock_por_deposito", "buscar_productos", "listar_depositos", "modificar_concepto", "modificar_stock_concepto"].filter(isToolAllowed),
    capacidades: [
      "Consultar existencias físicas, reservas comprometidas y disponible real.",
      "Detectar sobreventas críticas y existencias físicas negativas.",
      "Buscar productos por SKU o nombre con su costo interno registrado.",
      "Modificar precio, costo interno, alícuota de IVA, descripción o estado de conceptos existentes (sin crear nuevos).",
      "Modificar o reemplazar el stock físico de un producto en un depósito por SKU o por ID.",
      ...(depositos.length > 0 ? [`Depósitos activos disponibles: ${depositos.slice(0, 3).join(", ")}.`] : []),
    ],
    preguntas_ejemplo: [
      "¿Qué productos están sin stock o con sobreventa en el depósito principal?",
      "Listame los 10 productos con menor disponible para reponer.",
      "Buscá el producto con código 'CASCO' y decime su precio y costo interno.",
      "Cambiá el precio del producto 'CASCO-01' a $ 15.000.",
      "Ajustá el stock del SKU 'REM-01' a 25 unidades en el depósito central.",
    ],
  };

  const moduloDeuda = {
    nombre: "Cuentas por Cobrar y Cobranzas",
    tools: ["cuentas_por_cobrar", "buscar_clientes"].filter(isToolAllowed),
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
    tools: ["diagnosticar_orden"].filter(isToolAllowed),
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
    "Protección fiscal: la emisión directa ante AFIP con CAE está deshabilitada; podés usar 'emular_facturacion' (Dry-Run) o 'crear_borrador_factura' (borrador sin CAE) para practicar e integrar con la API.",
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

  const catalogoActivo = Object.fromEntries(
    Object.entries(GUIA_DETALLADA_TOOLS).filter(([key]) => isToolAllowed(key))
  );

  let detalleToolConsultada = null;
  if (tool && typeof tool === "string" && tool.trim()) {
    const normalizedKey = tool
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[\s-]+/g, "_");

    const foundTool =
      GUIA_DETALLADA_TOOLS[normalizedKey] ||
      Object.values(GUIA_DETALLADA_TOOLS).find(
        (t) =>
          t.nombre.includes(normalizedKey) ||
          normalizedKey.includes(t.nombre)
      );

    if (foundTool) {
      const habilitada = isToolAllowed(foundTool.nombre);
      detalleToolConsultada = {
        ...foundTool,
        habilitada_actualmente: habilitada,
        ...(habilitada
          ? {}
          : {
              aviso_estado: `La tool '${foundTool.nombre}' se encuentra actualmente deshabilitada por configuración (NOT_ALLOWED_TOOLS).`,
            }),
        ...(depositos.length > 0 ? { depositos_activos_en_cuenta: depositos } : {}),
      };
    } else {
      detalleToolConsultada = {
        tool_solicitada: tool,
        error: `No se encontró una tool llamada '${tool}'.`,
        tools_disponibles: Object.keys(catalogoActivo),
      };
    }
  }

  const datos = {
    cuenta_conectada: {
      empresa,
      cuit: cuit || "No informado",
      ambiente: client?.ambiente || "Producción",
      ...(depositos.length > 0 ? { depositos_activos: depositos } : {}),
    },
    ...(detalleToolConsultada ? { detalle_tool_consultada: detalleToolConsultada } : {}),
    modulos,
    catalogo_tools: catalogoActivo,
    limites_del_servicio: limites,
    preguntas_sugeridas_para_iniciar: preguntasSugeridas,
  };

  const resumen = detalleToolConsultada && detalleToolConsultada.nombre
    ? `Guía detallada de la tool '${detalleToolConsultada.nombre}': ${detalleToolConsultada.proposito} Consultá 'detalle_tool_consultada.como_funciona' y 'detalle_tool_consultada.que_espera' para ver el detalle de parámetros obligatorios y opcionales.`
    : `Guía de asistencia para ${empresa}. Tenés habilitados 3 módulos de gestión: Ventas, Inventario y Cuentas por Cobrar. Elegí una de las preguntas sugeridas para comenzar.`;

  return formatToolResponse({
    datos,
    resumen,
    advertencias: ["La integración opera exclusivamente en modo lectura analítica."],
    truncado: false,
  });
}
