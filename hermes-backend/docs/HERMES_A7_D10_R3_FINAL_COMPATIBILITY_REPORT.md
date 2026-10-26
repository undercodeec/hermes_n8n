# HERMES 2.0 — A7-D10-R3: compatibilidad backend ↔ Nous A7-D8

**Dictamen: INCOMPLETA.** No se encontró una incompatibilidad del contrato HTTP entre el parche A7-D10-R1 y el agente A7-D8. El backend local separa ahora los insumos con los que A7-D8 deriva una sesión, incluso si varios clientes escriben el mismo saludo. Falta ejecutar la matriz de aislamiento contra el gateway A7-D8 real en una red aislada; el test del backend y el smoke anterior de un solo inbound no prueban que el agente no comparta estado. Este dictamen no habilita publicación ni activación.

## Identidades y alcance

- Base productiva A7-D4: `7f5d5b1cfc58eab6b7eb2d1ec3ce1e05307fa707`.
- Parche local auditado A7-D10-R1: commit `d91ad13b91a7681c9037137048b9c0e504683d24`, árbol `d613f3d4302655cc772a317815abab381f49fa50`.
- Agente A7-D8 según el informe VPS R2, corte 2026-10-26 18:47 UTC: commit `a251551a4b7dc187780193756d0747a1e3ea8e88`, imagen `sha256:403917d73eb19e9388ea5bf49a52da8b1282e092ec412637aa81ad930e4c7efe`. Bridge HAProxy `sha256:5961c68bc8a81c5124d0a98ab20f81b74717d6afe596e805977d9cf84c126222`.
- Fuente documental: `HERMES_A7_D10_R2_NOUS_AGENT_CONTRACT_EVIDENCE.md`, disponible localmente en `C:\Users\USUARIO\Downloads`, SHA-256 `2d0a4ee5412e0d4d093d94d22cd815d1fb89859a7f3c4402a48cc916c8c29f70`. El informe R2 verificó las imágenes, hashes de archivos y configuración del VPS; no pudo leer el commit Windows. Esta revisión sí leyó el commit Windows, pero no tuvo el código ejecutable A7-D8 ni hizo un POST al agente.

La comparación de Git desde A7-D4 muestra cambios en `nous-hermes.transport.ts` para corte y medición del piloto; `agent-output.validator.ts` no cambió. El payload HTTP conserva `model`, `messages` y `stream`; el cambio R3 añade un segundo mensaje `system` con ámbito técnico efímero. El informe VPS confirma que A7-D8 agrega los mensajes `system` al prompt usado para derivar la sesión.

## Comparación exacta del contrato

| Punto | Backend local | Evidencia A7-D8 | Resultado |
| --- | --- | --- | --- |
| Ruta, método y autenticación | `POST http://nous-hermes-api:8642/v1/chat/completions`; Bearer leído de archivo; JSON; sin `Origin` | Bridge permite esa ruta y método; gateway valida Bearer | Coincide |
| Modelo y solicitud | `model=hermes-agent`, `stream=false`; roles `system`, `user`, `assistant`; sin tools, `provider`, `response_format` ni cabeceras de sesión | Alias `hermes-agent` dirigido a `gemini-3.8-flash`; esos roles admitidos; `system` agregado al prompt | Coincide en campos usados. El segundo `system` requiere prueba de aislamiento real |
| Respuesta final | Exige HTTP 2xx, `choices[0].finish_reason=stop`, `message.content` JSON con `replyText` o `replyParts` de 1 a 6 partes; rechaza tools, razonamiento y secretos aparentes | A7-D8 emite `stop` completo; `length` o `error` pueden llegar con parcial | Coincide: el backend descarta parciales; no presenta texto incompleto como respuesta comercial |
| 429 | Con reserva normal por inbound, convierte 429 en diagnóstico y revisión; no reintenta una segunda inferencia | A7-D8 devuelve 429 por concurrencia, `Retry-After: 1`, y reserva internamente una sola llamada por run | Coincide con la política durable; `Retry-After` no autoriza duplicar un inbound reservado |
| Timeout y ambigüedad | Timeout de 45 s; fallo/resultado incierto bloquea el turno para revisión; ledger de entrega evita reenvío ambiguo a Meta | Bridge tiene timeout de 70 s; agente, una ejecución concurrente y una llamada presupuestada | Compatible en tiempo; una respuesta perdida tras 45 s sigue siendo ambigua y no se reintenta ciegamente |
| Presupuesto | Reserva PostgreSQL por inbound, límite diario y estimación configurable; corte antes de cola, HTTP y Meta | A7-D8: `max_calls=1`, entrada máxima 16 384 bytes UTF-8, cota estimada USD 0,1161216/run; salida máxima 4096 tokens | Controles independientes. La estimación local debe configurarse con cota conservadora; 12 000 caracteres de contexto no garantizan caber en 16 384 bytes UTF-8 |
| Recuperación | PostgreSQL conserva reserva y estado; BullMQ/ledger recuperan sin repetir un despacho incierto. Las partes Meta confirmadas permanecen confirmadas | A7-D8 no devuelve la reserva tras timeout ambiguo | Coincide con la regla de no duplicar operaciones |

El reporte VPS anterior observó un único smoke A7-D3-R3 con dos partes Meta confirmadas y sin duplicados. Esa observación no equivale a una prueba de aislamiento entre clientes ni a una ejecución del commit R3.

## Aislamiento de sesiones

El gateway A7-D8 deriva un identificador estable del prompt de sistema y del primer mensaje `user` cuando no recibe cabecera de sesión. Antes de R3, cuatro solicitudes del backend con el mismo saludo y estado aprobado podían producir exactamente esa misma pareja de textos; el test nuevo reprodujo la colisión (1 pareja distinta de 4). R3 añade a un segundo mensaje `system` un SHA-256 determinista de `[conversationId, inboundMessageId]`. Son IDs internos, sin teléfono, correo ni nombre. Cada inbound obtiene un ámbito distinto, incluso dentro de la misma conversación; el mismo inbound conserva su ámbito tras reiniciar el transporte. El backend sigue enviando el historial CRM autorizado en cada solicitud y no añade `X-Hermes-Session-Id`, `X-Hermes-Session-Key` ni `Idempotency-Key`. El primer mensaje `system`, del que sale `promptVersion`, permanece estable.

| Caso solicitado | Evidencia local R3 | Límite de la evidencia |
| --- | --- | --- |
| Dos clientes con «Hola, quiero información» | Distintas parejas prompt agregado/primer `user` al variar `conversationId` e inbound | Falta observar IDs y estado del gateway real |
| Conversaciones distintas del mismo número UnderCodeEC | El ámbito usa IDs de conversación e inbound, no el número | Falta prueba real de dos conversaciones del mismo número comercial |
| Un cliente con varios mensajes | Un inbound nuevo produce otro ámbito; el contexto CRM se vuelve a suministrar | Falta comprobar que A7-D8 no reutilice memoria entre ámbitos |
| Dos inbounds idénticos con IDs distintos | El test usa el mismo saludo e historial; los ámbitos difieren | Falta inspección del almacén de sesiones del agente |
| Reapertura de conversación existente | Mismo `conversationId` e inbound nuevo producen ámbito nuevo | Falta ejecutar reapertura con el gateway real |
| Reinicio del agente | Reiniciar el objeto transporte conserva el ámbito del mismo inbound | No se reinició A7-D8 ni se inspeccionó estado persistido |

**Prueba pendiente para cerrar el dictamen:** levantar la imagen A7-D8 indicada y el bridge en un entorno local desechable, sin egreso a Gemini/Meta y con proveedor de respuesta sintética. Ejercer los seis casos anteriores con sentinelas distintos en el historial aprobado de cada conversación; registrar IDs de sesión devueltos, claves del almacén de sesiones y respuestas saneadas. Exigir ámbito distinto para cada inbound diferente, ausencia de sentinelas ajenos en cada respuesta, continuidad solo del historial CRM suministrado, estabilidad en reintento del mismo inbound y ausencia de cruce después de reiniciar el agente. Comprobar también un cuerpo cercano al límite de 16 384 bytes UTF-8. Sin el código o imagen A7-D8 en este workspace, una simulación del hash de derivación no sustituye esa prueba.

## Regresión local y publicación

- Pruebas focales: 12 suites, 354 tests aprobados; el test de colisión falló antes del cambio y pasó después. Cubren asignación persistente, origen, opt-out, corte, handoff, cuotas, saturación, reserva, ledger, 429, timeout y reglas F3/learning.
- Integración aislada: PostgreSQL 18 y Redis 7.4 en puertos locales `55434` y `6388`; 25 migraciones aplicadas a base desechable; 3 suites, 15 tests aprobados para inbound, cola Nous y entrega automatizada. Fixture SQL de atribución ejecutado con tablas temporales y `ROLLBACK`.
- `npm run build`, ESLint focal y `prisma validate` aprobados. Ninguna prueba hizo inferencia facturable ni envío Meta real.
- Según R2, el VPS sigue en A7-D4 DARK, con Nous comercial ausente, F3 OFF y learning OFF. Esta revisión local no cambió esa configuración ni verificó de nuevo el VPS.

**Condiciones antes de publicar o desplegar DARK:** aprobar la prueba pendiente del gateway real; fijar y verificar `NOUS_PILOT_ESTIMATED_USD_PER_REQUEST` al menos a la cota operativa conservadora vigente o documentar otra base comprobada; revisar el tamaño UTF-8 del payload extremo; verificar `META_PHONE_NUMBER_ID`, umbrales y atención humana del entorno objetivo. Push, despliegue y activación comercial requieren autorización separada. **STOP: no push, no despliegue, no Nous activo, no WhatsApp/Meta, no inferencia facturable, no limpieza general de Docker.**
