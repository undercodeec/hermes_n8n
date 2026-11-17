# Bitácora de desarrollo · Hermes CRM móvil

Este registro distingue código, validación, publicación Git, instalación y despliegue. No incluir nombres o mensajes de clientes, capturas con información personal, credenciales, tokens, direcciones privadas ni valores de archivos de entorno.

## 17/11/2026 — Plan y prototipo G0

**Objetivo:** explorar la experiencia móvil para operadores internos en Android e iOS, sin usar el CRM productivo ni datos reales.

**Decisiones:** React Native + Expo + TypeScript; prototipo solo con datos ficticios en memoria; sin API, autenticación real, WhatsApp, SSE ni notificaciones. El propietario confirmó que el código se mantiene en `hermes-mobile/` dentro de `undercodeec/hermes_n8n`, como paquete independiente del backend y sin repositorio Git anidado.

**Entregado:** acceso de demostración, bandeja, conversación, respuesta ficticia en memoria y controles simulados de desconexión/reconexión. Cerrar la demo reinicia los datos ficticios. El interruptor no detecta conectividad real ni reconcilia con servidor.

**Validación:** en la carpeta incorporada se ejecutaron `npm ci`, `npm run check` (tipos y seis pruebas), `npx expo install --check` y `npx expo export --platform all`. El prototipo original también pasó 20/20 comprobaciones de Expo Doctor. Los bundles Android/iOS son compilaciones JavaScript, no APK/IPA firmados ni pruebas físicas en ambas plataformas.

**Git:** PR #25 integrado en la rama piloto; merge `9675cb895812d26e68be99fd92cffa13d907f9a2`. El pipeline de la rama piloto pasó. El backend productivo no se desplegó por este PR. El plan detallado se encuentra en [`../../hermes-backend/docs/crm-mobile-internal-development-plan-2026-11-12.md`](../../hermes-backend/docs/crm-mobile-internal-development-plan-2026-11-12.md).

## 17/11/2026 — Acceso visual alineado al CRM web

**Referencia revisada:** implementación local del login CRM de UnderCodeEC, `src/app/admin/crm/login/page.jsx` y `src/app/admin/crm/crm.css`. El diseño móvil del prototipo adapta el logotipo, tarjeta clara, «Acceso privado», correo/código y botón azul-violeta. La revisión fue de código local; no acredita que esa versión concreta del frontend web esté actualmente desplegada.

**Alcance:** los campos muestran valores ficticios no editables, la navegación entre pasos es simulada y no solicita ni verifica códigos. El símbolo Hermes también se preparó para el icono de una futura compilación propia. En Expo Go se mantiene el icono de Expo; no se ha creado ni instalado un APK o IPA propio.

**Validación:** `npm run check` (seis pruebas y tipos), `npx expo install --check` y exportación de bundles Android/iOS, correctos localmente. El PR #26 obtuvo CI aprobada. La interfaz se abrió con Expo Go en un dispositivo Android físico y el propietario confirmó que el nuevo diseño se veía correctamente. Esto no equivale a aprobación completa de UX, accesibilidad, seguridad o compatibilidad de dispositivos; no se realizó prueba física iOS.

**Incidencia resuelta:** Metro se había iniciado en modo CI con recarga desactivada y el teléfono seguía mostrando la versión anterior. Se reinició únicamente el servidor local de Expo con caché limpia y sin modo CI; después se abrió el proyecto de nuevo en el dispositivo. No fue un despliegue de backend.

**Estado Git:** cambios de esta etapa en el PR #26; consultar el estado y SHA efectivos del PR antes de afirmar integración. Una imagen, commit o PR no demuestran instalación en tienda ni despliegue productivo.

## 17/11/2026 — Inbox adaptado del CRM web

**Decisión:** por solicitud del propietario, la bandeja y el detalle deben conservar la identidad visual del CRM web, adaptando la interacción a una pantalla de teléfono. La referencia es una lectura estática local del JSX y CSS de `/admin/crm/inbox`, no una comparación de píxeles ni una certificación de la versión web desplegada.

**Prototipo:** lista con logo, búsqueda local, filtros de control y prioridad; detalle con cabecera, franja de atención humana, historial de ejemplo y compositor. La conversación abre en una pantalla propia y permite volver a la lista. Tomar/devolver control y agregar mensajes son operaciones ficticias en memoria, sin conectividad ni efecto en el CRM; escribir requiere control humano simulado y conexión simulada. El toggle de red es una simulación, no prueba de conectividad real. No se incluyen como capacidades reales paginación, adjuntos, asignación, permisos ni ventana Meta.

**Validación local:** `npm run check` pasó con 9 pruebas y typecheck; `npx expo install --check` y `npx expo export --platform all` pasaron. No se han certificado dispositivos físicos, accesibilidad, interfaz frente a Web real ni envío; solicitar revisión visual al propietario. El seguimiento Git corresponde al mismo PR de la interfaz; consultar su estado efectivo antes de afirmar integración.

## 17/11/2026 — Experiencia de mensajería móvil

Por solicitud del propietario, se ajustó el prototipo hacia una experiencia de mensajería familiar: encabezado de chats, búsqueda y filtros horizontales, avatares y contador de mensajes no leídos, detalle a pantalla completa y compositor redondeado. Se mantienen los colores y la identidad Hermes. Los nombres, mensajes y estados siguen siendo ficticios; no se muestran confirmaciones de entrega real. El filtro de no leídos solo afecta los ejemplos locales. Permanecen pendientes pruebas físicas adicionales, incluida la interacción con teclado y accesibilidad en Android/iOS.

**Aprobación de producto:** el propietario confirmó «aprovado diseño» tras revisar la vista móvil en el teléfono Android de prueba. La aprobación cubre la dirección visual del prototipo, no acredita pruebas completas de accesibilidad, todos los tamaños de pantalla, iOS ni funcionalidad real. El prototipo sigue usando datos ficticios y Expo Go.

**Validación del cambio:** `npm run check` aprobó typecheck y 9 pruebas; `npx expo export --platform all` generó bundles JavaScript para Android y iOS. CI de PR #26 aprobó sobre el cambio visual. La integración de este registro se verifica por el estado efectivo del PR; no implica APK/IPA, publicación de tienda ni despliegue de backend.

## Riesgos y siguientes puertas

1. Antes de usar datos reales: definir y verificar sesiones revocables por dispositivo, permisos por recurso, proyecciones, eventos autorizados y minimizados, y deduplicación/reconciliación de respuestas. El prototipo actual no implementa esos controles.
2. La auditoría `npm audit --omit=dev` informó 28 vulnerabilidades en el árbol de dependencias (2 moderadas, 26 altas) al 17/11/2026. Evaluar cada aviso y su aplicabilidad antes de distribuir; no ejecutar `npm audit fix --force` sin revisar compatibilidad. No se ha establecido explotación real ni se han resuelto todavía.
3. Aprobar la experiencia con operadores y probar accesibilidad, estados, reconexión, privacidad y rendimiento en dispositivos físicos Android e iOS. No introducir datos productivos en estas pruebas.
4. Para icono propio, bibliotecas nativas, firma y pruebas de capacidades no incluidas en Expo Go, evaluar una development build. Expo Go es una herramienta de previsualización, no el artefacto final. Cuotas, cuentas, costes y elegibilidad de Expo y Apple deben verificarse antes de contratar o distribuir; no se ha configurado firma ni cuenta de publicación.
5. Antes de instalar o distribuir builds firmados, definir destinatarios, canal y autorización específica. Publicación Git y CI no autorizan despliegue ni distribución.

## Formato para próximas entradas

Registrar fecha y zona horaria cuando sean relevantes, objetivo, cambios y decisión, archivos/PR/commit, comandos de validación y resultados, límites no comprobados, riesgos y siguiente paso. No marcar como completado algo no observado.
