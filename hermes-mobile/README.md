# Hermes CRM · prototipo G0

Prototipo **sin conexión al CRM** para evaluar la navegación de una futura app interna Android/iOS. Se creó con Expo SDK 58, React Native y TypeScript. Vive en la carpeta `hermes-mobile/` del repositorio `undercodeec/hermes_n8n`; es un paquete independiente de `hermes-backend/` y no comparte código de ejecución ni configuración. El CRM web es otro repositorio.

## Alcance

- Acceso simulado con la identidad visual del CRM web: correo y código ficticios no editables, sin solicitud ni validación real; Inbox y chats **inventados**.
- Composición y respuesta **solo en memoria**: el botón no realiza solicitudes HTTP ni envía WhatsApp.
- Inbox y conversación adaptados a la interfaz web: búsqueda y filtros locales, y control humano simulado. No representan permisos, asignaciones o estados reales de WhatsApp.
- Interruptor de red simulado: bloquea redacción y vacía borradores al desconectar; aviso de reconciliación ficticia al volver al primer plano. No es detección real de red ni sincronización.
- Cierre de la demo limpia el estado en memoria. No hay sesiones, tokens, almacenamiento de mensajes, SSE, push, métricas, API ni permisos reales.

## Ejecutar en desarrollo

Desde `hermes-mobile/`, requisitos: Node compatible con Expo SDK 58, npm y Expo Go/dispositivo compatible o emulador. `npm ci`, después `npm start` y seguir instrucciones de Expo. `npm run typecheck` y `npm test` verifican tipos y transiciones sin arrancar servidor. No usar credenciales ni mensajes de clientes en este prototipo. En Windows no hay compilación iOS local; verificar en dispositivo iOS o infraestructura Mac autorizada.

## Puertas pendientes (no apto para operación)

Antes de conectar una API: contrato piloto verificado con usuarios sintéticos, sesiones revocables por dispositivo, alcance por recurso, proyecciones sin PII sobrante, SSE minimizado/autorizado e idempotencia para respuestas tras timeouts. Antes de distribución: QA físico en Android/iOS, privacidad de cachés y pantallas, accesibilidad, firmas/cuentas y autorización específica de publicación. Referencia: [`../hermes-backend/docs/crm-mobile-internal-development-plan-2026-11-12.md`](../hermes-backend/docs/crm-mobile-internal-development-plan-2026-11-12.md), adenda 17/11/2026.

**No** ejecutar contra producción ni distribuir a usuarios finales. El diseño y la accesibilidad necesitan evaluación con operadores y dispositivos reales.

La [bitácora de desarrollo](docs/bitacora-desarrollo.md) registra las decisiones, pruebas, riesgos y pendientes del prototipo.

El [plan G1 de acceso y sesión](docs/plan-g1-acceso-sesion-2026-11-17.md) documenta las decisiones del propietario para reutilizar el acceso actual de un solo operador y cerrar la sesión móvil tras 30 minutos de inactividad; es diseño, no implementación.

## G3 · Acceso en entorno aislado (opt-in)

La app sigue abriendo por defecto el prototipo G0 sin red. Con `EXPO_PUBLIC_MOBILE_AUTH_MODE=staging` y ambas URL HTTPS configuradas (`.env.example`), el acceso solicita el OTP al proveedor CRM de prueba y canjea una prueba temporal por una sesión móvil Hermes. El token de renovación se almacena mediante `expo-secure-store`; no se incluye ningún secreto en el bundle. Se bloquea la pantalla al pasar a segundo plano, volver sin red o no poder validar la sesión. Solo una interacción del operador en primer plano solicita prolongación de la sesión; el backend decide su expiración. Este modo **no muestra datos reales ni envía mensajes**: después del login se conserva el Inbox ficticio, claramente marcado. No apuntar estas URL a producción ni probar con cuentas reales hasta pasar revisión de seguridad, integración completa, validación en dispositivo y aprobación de liberación.

El cierre en staging bloquea de inmediato y confirma el borrado del refresh local antes de ofrecer un nuevo acceso. Intenta revocar mediante `POST /api/auth/mobile/logout-refresh` con el refresh actual leído de `expo-secure-store`: no necesita JWT, no llama a `validate()` y no rota el token. Solo `{revoked:true}` confirma revocación; sin red, con 401, respuesta ambigua o refresh en curso, la pantalla indica revocación remota no confirmada y remite a la gestión de sesiones web para revocar el dispositivo, **sin compartir ni transferir tokens**. Un refresh enviado cuyo resultado sea incierto se marca en almacenamiento protegido y se descarta sin reintentar el token anterior, incluso tras reiniciar la app; se necesita un nuevo OTP. Las pruebas usan respuestas y almacenamiento simulados, nunca servicios reales.

## G4 · Lectura de Inbox en integración (segundo opt-in)

Solo si `EXPO_PUBLIC_MOBILE_AUTH_MODE=staging` **y** `EXPO_PUBLIC_MOBILE_INBOX_MODE=read-only` están habilitados, la app monta un Inbox **de consulta real al servidor de integración configurado**, en lugar de chats ficticios. Requiere el contrato de backend `/api/mobile/inbox` G4 y los endpoints de autenticación G2; no desplegados en producción. La pantalla etiqueta claramente datos de prueba, no habilita compositor, media, handoff ni envíos de WhatsApp. Usa únicamente GET autenticados, memoria volátil, paginación por cursor y reconciliación desde página 1 al reabrir/volver a primer plano o tocar Actualizar. Al perder acceso/red bloquea y oculta la información; no conserva conversaciones en disco. La demo sin variables continúa siendo predeterminada. El cliente no consume SSE ni promete actualizaciones en segundo plano; la reconciliación inmediata al foreground y manual sigue disponible. Esta pantalla **no acredita** un recorrido probado contra los dos servicios ni validación iOS.
