# G1 · Acceso móvil con la identidad actual del CRM

**Fecha:** 17/11/2026. **Estado:** criterios G1 acordados y aprobados por la solicitud posterior «procede con las fases» para trabajo de desarrollo local; no autoriza cambios productivos, migraciones en bases reales, cuentas nuevas ni distribución. **Base Git de planificación:** rama piloto Hermes `a637ac635f1046369862b9f298f5de1551527887`, que integra el prototipo móvil y su diseño aprobado. Esa referencia Git no acredita un despliegue de backend nuevo. El último backend cuyo runtime se verificó en esta conversación fue `b044ea620e8b9b2bb5f6252d15534b359c42eee2`, imagen `sha256:4003d04037c7c3d28ff0b9c1da1554ea5151764bd4d3b9ab2762c681a3ebadbb`; no se comprobó nuevamente al redactar este plan.

## 1. Decisiones del propietario

1. La app debe admitir **el mismo operador y el mismo acceso que ya usa el CRM web**. En el código web revisado, el acceso consiste en correo autorizado y código temporal enviado por correo; no se pide crear una contraseña nueva. Confirmar el flujo y la configuración efectivos antes de implementar.
2. **Un solo usuario** en esta fase. No crear gestión de usuarios, pantallas de roles, asignaciones por agente ni un sistema nuevo de permisos. Mantener los controles de acceso actuales y proteger todas las rutas: una única identidad no convierte la API en pública. La escalabilidad significa no impedir una futura evolución, no construirla ahora.
3. Web y móvil pueden permanecer abiertos a la vez. Son sesiones independientes: cerrar o vencer una no debe cerrar la otra. **Decisión posterior del propietario:** permitir solo **un teléfono activo**; un nuevo login móvil revoca el teléfono anterior sin cerrar la web. La revocación remota del teléfono perdido puede hacerse desde la sesión web del operador.
4. La sesión móvil caduca tras **30 minutos sin actividad de uso**. Para volver se solicita un nuevo código al correo autorizado.
5. El propietario decidió **sin vencimiento máximo adicional**: mientras exista actividad válida, la sesión puede continuar. Esto incrementa la duración posible de una sesión robada; se acepta como decisión de producto para el diseño, no como sustituto de revisión de seguridad y revocación.

## 2. Lo observado y lo que falta

- El CRM web local revisado solicita y verifica un código de ocho dígitos en el backend de UnderCodeEC y canjea una prueba temporal en Hermes. No se asume que los endpoints ni la configuración del checkout local coincidan con producción hasta verificarlos. El acceso Hermes con contraseña también existe, pero no se identifica como el flujo del login web.
- El backend Hermes consultado en `b044ea62` expone `login`, `crm-proof` y `profile`; el JWT actual no representa por sí solo una sesión móvil con caducidad por inactividad ni logout por dispositivo. La configuración efectiva de expiración debe comprobarse por canales seguros, sin exponer secretos.
- En el código revisado, la protección de reutilización de la prueba y algunos límites/sesiones del proveedor de OTP están en memoria del proceso. No asumir que son compartidos entre réplicas ni que sobreviven reinicios. El canje actual puede reactivar/asignar privilegio al usuario; revisar su semántica antes de reutilizarlo y no crear un bypass de desactivación.
- La app G0 tiene pantallas simuladas; no solicita correos ni códigos reales, no autentica y no almacena credenciales. No reemplazar la simulación con llamadas reales hasta cerrar G1 y G2 en un ambiente aislado.

## 3. Experiencia deseada

1. Abrir app → pantalla aprobada del CRM → introducir **el correo de acceso existente** → recibir código → ingresar sus ocho dígitos como texto, incluidos ceros iniciales → bandeja.
2. Operación normal: interacción real del usuario en la app mantiene la sesión vigente. La UI informa estados de red y sesión sin exponer secretos.
3. Si transcurren 30 minutos sin actividad o se revoca la sesión: ocultar datos del CRM, limpiar credenciales y estado sensible controlado, ir al login y solicitar **un código nuevo**. No guardar ni enviar mensajes de forma automática al reingresar.
4. Al volver a primer plano, ocultar la información sensible mientras se confirma la sesión con el servidor. Con sesión vencida pedir código; sin conexión no mostrar datos protegidos en esta fase. Si es válida, refrescar datos autorizados. La interrupción por pasar a segundo plano **no equivale por sí sola** a un cierre si aún no han pasado 30 minutos.
5. Ofrecer cierre manual de la sesión móvil, sin cerrar la web. Biometría/PIN es opcional futuro y no sustituye el código al expirar.

## 4. Diseño propuesto para validar, no contrato implementado

**Identidad compartida:** reutilizar el mismo mecanismo OTP y correo autorizado; no copiar el secreto de firma ni el código OTP al repositorio/app. Definir con UnderCodeEC un contrato móvil explícito para solicitud, verificación y canje que preserve compatibilidad del navegador y no obligue al móvil a conservar dos tokens si no los necesita. Evitar usar directamente `crm-proof` actual sin revisar consumo único, reactivación y sesión.

**Sesión móvil separada:** backend emite una sesión identificable por identificador aleatorio opaco; almacenar en servidor su estado, último uso válido y revocación. Evaluar token de acceso corto y token de renovación rotatorio aleatorio; guardar solamente hash del token de renovación en servidor y secreto de sesión en Keychain/Keystore del dispositivo, sin logs, URL ni almacenamiento genérico. Validar la sesión en cada ruta móvil protegida; un JWT válido por sí solo no debe evitar el cierre por inactividad. Seleccionar tecnología de almacenamiento (PostgreSQL o Redis durable según arquitectura) en G1, con operación atómica y plan de recuperación; la persistencia y sus migraciones se proponen por separado para aprobación.

**Reloj y actividad:** el servidor calcula y hace cumplir el límite de 30 minutos utilizando su propio reloj. Registrar como actividad solo interacciones deliberadas del operador en primer plano, por operaciones autenticadas o una señal de actividad limitada en frecuencia. El cliente agrupa/señaliza esas interacciones; al vencer o fallar una comprobación del servidor no presenta contenido hasta reautenticar. Consultas automáticas, polling, latidos SSE, refrescos de token, notificaciones y trabajos en segundo plano **no** prolongan la sesión. Los toques locales no garantizan llegar al servidor sin red; en ese caso se bloquea el acceso hasta revalidar.

**Revocación y fallos:** logout marca sesión revocada e impide API, refresh y stream de esa sesión; la web sigue intacta. Un error transitorio no debe confundirse con expiración: mostrar estado bloqueado/sin conexión y reintentar validación cuando haya red; si el servidor confirma vencimiento, 401 de sesión revocada o si el estado no puede recuperarse, solicitar OTP nuevo. Definir rotación concurrente, pérdida de respuesta, robo/reutilización y fail-closed sin generar bucles ni reenvío de WhatsApp. Sin fecha máxima adicional, prever cierre remoto o procedimiento operativo para pérdida del teléfono; política de dispositivos concurrentes y responsable de recuperación quedan por decidir.

**Escalabilidad futura:** asociar sesión a la identidad existente mediante una relación interna, con controles genéricos y pruebas; evitar hardcodear su correo en la app. No introducir tablas de roles, interfaces de usuarios, multitenencia o gestión de agentes en esta fase. Cambios posteriores que requieran esos conceptos serán un proyecto aparte.

## 5. Trabajo y gates

| Etapa | Trabajo | Salida / criterio para continuar |
| --- | --- | --- |
| **G1-A Inventario** | Fijar commits y versiones efectivas del proveedor OTP, proxy web y Hermes; comparar respuestas y tiempos sin datos reales; confirmar que web y móvil conservarán el mismo operador. | Mapa de endpoints, códigos, ownership y diferencias entre código y runtime; no guardar OTP, proof ni valores de entorno. |
| **G1-B Contrato y amenazas** | Diseñar solicitud/verificación OTP, canje móvil, sesión, actividad, logout, bloqueo, límites y errores; decidir estado compartido y recuperación. | Documento revisado por backend, UnderCodeEC y seguridad; fixtures sintéticos y diagramas de flujo. Sin implementación productiva. |
| **G1-C Plan de pruebas y base de datos** | Definir pruebas de caducidad, carreras, revocación, pérdida de conexión, replay y compatibilidad web. Propuesta aditiva de esquema/índices si se requieren. | Aprobación específica de arquitectura/DB para migraciones, con rollback que no borre datos y estrategia expand/contract. |
| **G2 Backend en entorno aislado** | Implementar contrato aprobado en ambos sistemas si procede, manteniendo el login web; pruebas con bases/colas desechables y proveedor de correo simulado. | Suites, integración, seguridad y build aprobados; sin afectar web, IA o entregas existentes. |
| **G3 App en pruebas** | Conectar UI nativa a backend de prueba: OTP real simulado, sesión, inactividad, background/foreground y errores; sin servicios de producción. | Pruebas Android e iOS, sin guardar información sensible fuera de almacenamiento protegido. |
| **Liberación futura** | Revisar privacidad, dependencias, dispositivos, cuentas y canal; transición y rollback de sesiones. | Aprobación explícita por separado antes de instalar/distribuir o desplegar en VPS. |

## 6. Pruebas de aceptación mínimas

1. Mismo correo autorizado y OTP simulado: ingreso móvil correcto; correos no autorizados reciben respuesta que no filtra identidad; código inválido, consumido o vencido no permite ingreso y limita intentos.
2. Una sesión móvil sin actividad caduca a los 30 minutos según reloj del servidor. A los 29 minutos se mantiene válida; después del límite, cualquier llamada protegida y refresh fallan. Actividad deliberada válida reinicia el contador; polling, SSE, refresh y background no lo hacen.
3. Cambiar el reloj del teléfono no extiende sesión. Al volver del background, validar antes de revelar datos; con red caída mostrar estado bloqueado; si la sesión expiró exigir OTP nuevo.
4. Web y móvil pueden operar a la vez; cerrar o vencer una sesión móvil no cierra la web. Logout móvil invalida inmediatamente esa sesión y sus access tokens. Desactivar el operador no debe poder revertirse por un canje no autorizado.
5. Dos verificaciones simultáneas del mismo OTP/proof solo producen el resultado permitido, incluso con dos procesos; rotación concurrente, respuesta perdida, reinicio y replay no producen sesiones inesperadas ni dejan un token comprometido vigente.
6. No registrar correo, código, proof, tokens, contenido de mensajes ni credenciales en logs o analítica. Probar borrado de secretos controlados, caché, snapshots y reinicio con fixtures, en Android e iOS.
7. Probar el login web y los flujos Hermes existentes antes/después. No modificar el funcionamiento comercial ni enviar mensajes reales; comprobar que un timeout de respuesta nunca se reenvía automáticamente.

## 7. Decisiones pendientes y límites

- El propietario decidió **un teléfono móvil activo**; G2 debe demostrar que el ingreso simultáneo desde dos dispositivos no deja dos sesiones activas. Definir el responsable de revocación tras pérdida del teléfono, sin construir un panel de administración por defecto. G2 propone `POST /api/auth/mobile/revoke-all` desde la sesión **web** del operador configurado para revocar la sesión móvil sin afectar la web, sin exponer tokens móviles ni agregar roles. Probar el procedimiento con identidades sintéticas y documentar el canal operativo antes de distribuir; un logout local no permite revocar un teléfono perdido. Una intervención manual de DB debe seguir el procedimiento operativo aprobado, con verificación de objetivo, respaldo y auditoría; nunca borrar usuarios ni credenciales globales para ello.
- Definir destino, TTL, disponibilidad y limpieza del almacenamiento compartido para OTP/proofs/sesiones; fiabilidad del correo, límites por IP/operador y proxy que sanee la IP.
- Contrastar la sesión web Admin que usa un token separado: la app debe solicitar únicamente las capacidades que realmente necesita; no asumir que un JWT Hermes habilita endpoints Admin.
- La autenticación no resuelve por sí sola privacidad del Inbox, SSE, control humano o idempotencia. Con un solo usuario no hace falta un sistema nuevo de permisos, pero sí autenticación y exposición mínima antes de usar datos reales.
- No se verificaron runtime OTP, cuentas, dirección de servidores, envío real de correo, comportamiento de SO ni costes. No se ha ejecutado integración real ni se han hecho cambios en ambos backends o VPS.
