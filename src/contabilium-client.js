/**
 * Cliente HTTP seguro y con control de tasa para la API Pública de Contabilium.
 * 
 * Cumple con todos los lineamientos transversales:
 * - Solo lectura (únicamente emite llamadas GET de negocio).
 * - Rate limiting del lado del servidor (Token Bucket a 2 req/s, máx 25 req/10s).
 * - Manejo de reintentos ante HTTP 429.
 * - Cache en memoria para catálogo (30 min) y búsquedas (5 min).
 * - Paginación controlada con tope de 20 páginas (1.000 registros).
 * - Mapeo de errores sin exponer HTML de Cloudflare ni credenciales.
 */

const COUNTRY_URLS = {
  AR: "https://rest.contabilium.com",
  CL: "https://rest.contabilium.cl",
  UY: "https://rest.contabilium.com.uy",
};

export class ContabiliumClient {
  constructor(credentials = {}) {
    this.clientId = (credentials.clientId || process.env.CONTABILIUM_CLIENT_ID || "").trim();
    this.clientSecret = (credentials.clientSecret || process.env.CONTABILIUM_CLIENT_SECRET || "").trim();
    this.country = (credentials.country || process.env.CONTABILIUM_COUNTRY || "AR").toUpperCase();
    this.baseUrl = (credentials.baseUrl || process.env.CONTABILIUM_BASE_URL || COUNTRY_URLS[this.country] || COUNTRY_URLS.AR).replace(/\/+$/, "");
    this.isParallel = Boolean(credentials.isParallel);

    // Estado del token OAuth2
    this.cachedToken = null;
    this.tokenExpiresAt = 0;

    // Token Bucket Rate Limiter (2 req/s, capacidad máxima 4 tokens para ráfagas)
    this.bucketCapacity = 4;
    this.bucketTokens = 4;
    this.refillRatePerMs = 2 / 1000; // 2 tokens por segundo
    this.lastRefill = Date.now();

    // Cache en memoria
    this.cache = new Map();
  }

  /**
   * Control de tasa mediante Token Bucket
   */
  async _waitForRateLimit() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.bucketTokens = Math.min(this.bucketCapacity, this.bucketTokens + elapsed * this.refillRatePerMs);
    this.lastRefill = now;

    if (this.bucketTokens >= 1) {
      this.bucketTokens -= 1;
      return;
    }

    const waitMs = Math.ceil((1 - this.bucketTokens) / this.refillRatePerMs);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    this.bucketTokens = 0;
    this.lastRefill = Date.now();
  }

  /**
   * Obtiene o renueva el Bearer Token OAuth2
   */
  async ensureValidToken(forceRefresh = false) {
    const now = Date.now();
    const bufferMs = 5 * 60 * 1000; // 5 minutos de margen

    if (!forceRefresh && this.cachedToken && now < this.tokenExpiresAt - bufferMs) {
      return this.cachedToken;
    }

    if (!this.clientId || !this.clientSecret) {
      throw new Error("Credenciales de Contabilium no configuradas. Verifica client_id y client_secret.");
    }

    const tokenUrl = `${this.baseUrl}/token`;
    const bodyParams = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: bodyParams.toString(),
    });

    if (!response.ok) {
      const errText = await response.text();
      if (response.status === 400 || response.status === 401) {
        throw new Error("Credenciales inválidas en Contabilium: verifica tu Email de API y tu API Key.");
      }
      throw new Error(`Error al autenticar con Contabilium (HTTP ${response.status}): ${errText}`);
    }

    const data = await response.json();
    if (!data.access_token) {
      throw new Error("Respuesta inválida de /token: no contiene access_token.");
    }

    this.cachedToken = data.access_token;
    const expiresIn = Number(data.expires_in) || 86399;
    this.tokenExpiresAt = Date.now() + expiresIn * 1000;
    return this.cachedToken;
  }

  /**
   * Lee desde la caché en memoria si la entrada está vigente
   */
  _getCache(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.value;
  }

  /**
   * Guarda en la caché en memoria con un TTL en segundos
   */
  _setCache(key, value, ttlSeconds) {
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  /**
   * Petición HTTP GET única con Bearer Token, Rate Limiting y Retry ante 429
   */
  async get(endpoint, params = null, ttlSeconds = 0) {
    // Si tiene caché habilitado, buscar primero
    const cacheKey = `${endpoint}?${new URLSearchParams(params || {}).toString()}`;
    if (ttlSeconds > 0) {
      const cached = this._getCache(cacheKey);
      if (cached) return cached;
    }

    await this._waitForRateLimit();
    const token = await this.ensureValidToken();

    let cleanEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
    if (!cleanEndpoint.startsWith("/api") && !cleanEndpoint.startsWith("/notificador")) {
      cleanEndpoint = `/api${cleanEndpoint}`;
    }

    const url = new URL(`${this.baseUrl}${cleanEndpoint}`);
    if (params && typeof params === "object") {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.append(key, String(value));
        }
      }
    }

    const executeCall = async (retryOn429 = true, retryOn401 = true) => {
      let res;
      try {
        res = await fetch(url.toString(), {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
        });
      } catch (netErr) {
        throw new Error(`Error de red al conectar con Contabilium: ${netErr.message}`);
      }

      if (res.status === 401 && retryOn401) {
        await this.ensureValidToken(true);
        return executeCall(retryOn429, false);
      }

      if (res.status === 429 && retryOn429) {
        console.error("[RateLimit] 429 detectado. Esperando 3 segundos para reintentar...");
        await new Promise((r) => setTimeout(r, 3000));
        return executeCall(false, retryOn401);
      }

      if (res.status === 403) {
        throw new Error("Acceso denegado (403): La cuenta no tiene plan con acceso a API o fue bloqueada por Cloudflare.");
      }

      if (res.status === 429) {
        throw new Error("Límite de peticiones alcanzado (429 Too Many Requests). Por favor espera un momento.");
      }

      const contentType = res.headers.get("content-type") || "";
      let data;
      if (contentType.includes("application/json")) {
        try {
          data = await res.json();
        } catch {
          data = await res.text();
        }
      } else {
        const rawText = await res.text();
        if (rawText.includes("<!DOCTYPE") || rawText.includes("<html")) {
          throw new Error("Error inesperado en el servicio de Contabilium (respuesta HTML no válida).");
        }
        data = rawText;
      }

      if (!res.ok) {
        throw new Error(`Error de API Contabilium (${res.status}): ${typeof data === "object" ? JSON.stringify(data) : data}`);
      }

      return data;
    };

    const result = await executeCall();

    if (ttlSeconds > 0) {
      this._setCache(cacheKey, result, ttlSeconds);
    }

    return result;
  }

  /**
   * Paginador seguro de hasta maxPages (tope de 20 páginas = 1.000 registros)
   */
  async paginatedGet(endpoint, baseParams = {}, maxPages = 20, ttlSeconds = 300) {
    const allItems = [];
    let isTruncated = false;
    let page = 1;

    while (page <= maxPages) {
      const params = { ...baseParams, page, pageSize: 50 };
      const res = await this.get(endpoint, params, ttlSeconds);

      let items = [];
      let totalPages = null;

      if (Array.isArray(res)) {
        items = res;
      } else if (res && typeof res === "object") {
        if (Array.isArray(res.Items)) {
          items = res.Items;
        } else if (Array.isArray(res.items)) {
          items = res.items;
        } else if (res.Items && typeof res.Items === "object") {
          // A veces la API devuelve un solo objeto si hay 1 resultado
          items = [res.Items];
        }

        if (res.TotalPage !== undefined) totalPages = Number(res.TotalPage);
        if (res.totalPage !== undefined) totalPages = Number(res.totalPage);
      }

      if (!items || items.length === 0) {
        break;
      }

      allItems.push(...items);

      if (totalPages !== null && page >= totalPages) {
        break;
      }

      if (items.length < 50) {
        break;
      }

      page++;
    }

    if (page > maxPages) {
      isTruncated = true;
    }

    return {
      items: allItems,
      truncado: isTruncated,
      paginasLeidas: page - 1,
      totalRegistros: allItems.length,
    };
  }
}
