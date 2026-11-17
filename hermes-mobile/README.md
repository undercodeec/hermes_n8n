# Hermes CRM · prototipo G0

Prototipo **sin conexión al CRM** para evaluar la navegación de una futura app interna Android/iOS. Se creó con Expo SDK 58, React Native y TypeScript. Vive en la carpeta `hermes-mobile/` del repositorio `undercodeec/hermes_n8n`; es un paquete independiente de `hermes-backend/` y no comparte código de ejecución ni configuración. El CRM web es otro repositorio.

## Alcance

- Acceso simulado sin formulario de credenciales; Inbox y chats **inventados**.
- Composición y respuesta **solo en memoria**: el botón no realiza solicitudes HTTP ni envía WhatsApp.
- Interruptor de red simulado: bloquea redacción y vacía borradores al desconectar; aviso de reconciliación ficticia al volver al primer plano. No es detección real de red ni sincronización.
- Cierre de la demo limpia el estado en memoria. No hay sesiones, tokens, almacenamiento de mensajes, SSE, push, métricas, API ni permisos reales.

## Ejecutar en desarrollo

Desde `hermes-mobile/`, requisitos: Node compatible con Expo SDK 58, npm y Expo Go/dispositivo compatible o emulador. `npm ci`, después `npm start` y seguir instrucciones de Expo. `npm run typecheck` y `npm test` verifican tipos y transiciones sin arrancar servidor. No usar credenciales ni mensajes de clientes en este prototipo. En Windows no hay compilación iOS local; verificar en dispositivo iOS o infraestructura Mac autorizada.

## Puertas pendientes (no apto para operación)

Antes de conectar una API: contrato piloto verificado con usuarios sintéticos, sesiones revocables por dispositivo, alcance por recurso, proyecciones sin PII sobrante, SSE minimizado/autorizado e idempotencia para respuestas tras timeouts. Antes de distribución: QA físico en Android/iOS, privacidad de cachés y pantallas, accesibilidad, firmas/cuentas y autorización específica de publicación. Referencia: [`../hermes-backend/docs/crm-mobile-internal-development-plan-2026-11-12.md`](../hermes-backend/docs/crm-mobile-internal-development-plan-2026-11-12.md), adenda 17/11/2026.

**No** ejecutar contra producción ni distribuir a usuarios finales. El diseño y la accesibilidad necesitan evaluación con operadores y dispositivos reales.
