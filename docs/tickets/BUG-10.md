# Ticket BUG-10: `contabilium_auth_status` informa token inactivo con la conexión activa

- **ID:** BUG-10
- **Tool:** `contabilium_auth_status`
- **Severidad:** Bajo
- **Fase:** Fase 1 (Quick Win)
- **Estado:** FINALIZADO
- **Fecha de resolución:** 30/09/2026

## Descripción del Problema
Al ejecutar `contabilium_auth_status` con `ping=true`, la respuesta reportaba:
`token.activo: false` y `minutosRestantes: 0` junto con `conexionEnVivo.conectado: true`.

## Causa Raíz
En `src/register-tools.js`, el estado del objeto `token` se computaba evaluando `client.cachedToken` *antes* de ejecutar el bloque de validación en vivo (`ping`). Al iniciar el servidor en frío, el token en memoria aún no había sido solicitado; luego, la llamada del ping a `/usuarios/obtenerinfo` realizaba la autenticación exitosa, generando la discrepancia en el payload.

## Solución Implementada
Se aseguró la resolución del token antes de la construcción del bloque de respuesta, o si `ping=true` se evalúa luego de la consulta en vivo:
```javascript
if (ping) {
  const info = await client.get("/usuarios/obtenerinfo");
  conexionEnVivo = { conectado: true, ... };
} else {
  await client.ensureValidToken().catch(() => {});
}

// Ahora el token en memoria refleja el estado real
token: {
  activo: Boolean(client.cachedToken && Date.now() < client.tokenExpiresAt),
  minutosRestantes: client.cachedToken ? Math.max(0, Math.round((client.tokenExpiresAt - Date.now()) / 60000)) : 0,
}
```

## Pruebas de Verificación
- Suite: `tests/phase1.test.js`
- Test: "contabilium_auth_status reporta token.activo true cuando la conexión en vivo es exitosa (BUG-10)"
- Resultado: Coherencia total entre conectividad en vivo y vigencia del Bearer token.
