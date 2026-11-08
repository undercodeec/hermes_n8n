# Hermes 2.0 — A7-BF17-R1: diagnóstico de inbox y recuperación operativa

**Dictamen:** `HERMES_A7_BF17_R1_ROOT_CAUSE_CONFIRMED`
**Estado documental:** `DOCS_SYNC_PENDING`
**Corte de métricas:** 2026-11-07 16:48:36 UTC. Las demás lecturas de solo lectura se hicieron durante este diagnóstico.
**Alcance:** consultas de solo lectura a GitHub, Docker, PostgreSQL, Redis y archivos operativos de la VPS. No hubo despliegue, reinicio, entrega Meta, reintento manual, backup, restauración ni escritura productiva.

## 1. Fuentes y precedencia

El HEAD remoto del [PR documental #16](https://github.com/undercodeec/hermes_n8n/pull/16) seguía en `c064cb927741b6bd1049eb98bc9071dcdd2c1252` durante la investigación. Se leyeron en GitHub el [preflight A7-BF17](HERMES_A7_BF17_PRODUCTION_PREFLIGHT_2026-11-07.md) y el [índice](INDICE-Y-PRECEDENCIA-DOCUMENTAL-2026-11-07.md). Para el comportamiento ejecutado se descargó por HTTPS el commit `88e9712fd6e16a730fcfd00acee10a25e84a429b`, coincidente con la revisión OCI y la etiqueta de `hermes-app`. El estado de la VPS prevalece sobre los informes anteriores.

El contenedor continúa sirviendo `ghcr.io/undercodeec/hermes-backend@sha256:f669a608d0739fdfbdd687d83c0617208cd24be715365a4e10dae34241c3b730`. La imagen A7-BF16 `sha256:959e80a4a6cfd8d65a33e38f7d52f9366a70a2b4fd8c526727cfa4955dce676b` sigue sin desplegar. Esta incidencia precede a la corrección Black Friday del PR #15; ese PR y la imagen publicada no se alteraron.

## 2. INC-01 — estado y causa raíz confirmada

| Lectura | Resultado |
| --- | --- |
| Inbox | 374 `COMPLETED`; 1 `FAILED` de tipo `MESSAGE`, creado el 3/11 a las 20:06:42 UTC. |
| Evento fallido | 5.276 intentos; `outcome=processing_error`; última actualización a las 16:48:33 UTC. Huella saneada del ID: `md5=88d452aca80d0e586fc4c2d36545abee`. |
| Errores de log que contienen `WebhookService` y `trim` desde el arranque del contenedor el 5/11 | 5.460 apariciones: 814 el 5/11, 2.748 el 6/11 y 1.898 hasta el corte del 7/11. Dos apariciones corresponden aproximadamente a un intento: error con stack y aviso del scanner. No equivalen a 5.460 intentos. |
| Frecuencia y otras colas | 110–112 apariciones por hora completa reciente; BullMQ `nous-hermes-inference`: 0 en espera, activos, retrasados y fallidos. Ledger de entregas: 0 `PREPARED`, 0 `AMBIGUOUS`, 85 `CONFIRMED`, 4 `SUPPRESSED`; 0 claims vigentes. |

El stack trace del proceso servido termina en `normalizeWhatsAppId` (`phone-normalizer.js:25`), llamado por `WebhookService.upsertContact` (`webhook.service.js:520`) desde `processIncomingMessage` (`webhook.service.js:353`). La excepción exacta es `TypeError: Cannot read properties of undefined (reading 'trim')`. En el código fuente del commit servido, `upsertContact()` pasa `metaContact.wa_id` a `normalizeWhatsAppId()`, cuyo primer paso es `value.trim()` sin validar el tipo.

La inspección minimizada del único payload `FAILED` demuestra que `message.from` y `contact.wa_id` **no existen**. El objeto `message` contiene `from_user_id`, `id`, `referral`, `text`, `timestamp` y `type`; `contact` contiene `profile` y `user_id`. Los dos identificadores alternativos son cadenas iguales entre sí, pero no tienen formato E.164. `message.id`, `text.body`, `phoneNumberId` y `profile.name` son cadenas. La clave del inbox coincide con `message:` más el ID almacenado. No se extrajeron valores personales ni contenido del mensaje.

La ruta de aceptación firma el callback antes de guardar eventos, pero no valida la forma de `message` y `contact`. Busca un contacto cuyo `wa_id` iguale `message.from`; para este evento, la comparación de dos campos ausentes puede seleccionar el contacto de forma incompatible. Aunque la estructura está guardada como JSON, el cast a `MetaWebhookMessage` no la valida en runtime. La estructura almacenada es **incompatible con el contrato de WhatsApp de este servicio**. No se ha probado si provino de una variante legítima del proveedor, una integración histórica u otra fuente; tampoco hay una correspondencia segura entre los identificadores alternativos y un número WhatsApp. La ausencia de esos campos, junto al stack exacto, confirma la causa del error actual.

### Reintentos y efectos

`scan()` se ejecuta cada cinco segundos. Selecciona `FAILED` cuyo `leaseUntil` venció y `PROCESSING` abandonados, toma un claim condicional por `id` y estado, incrementa `attempts`, y asigna un lease de cinco minutos. Ante cualquier excepción, registra `processing_error`, vuelve a `FAILED` y fija el siguiente lease con `min(60 s, 5 s × (attempts previos + 1))`. No hay límite de intentos ni clasificación de errores permanentes. Con 5.276 intentos, el retraso nominal es 60 segundos más hasta cinco segundos de espera por el scanner; los logs confirman la repetición. Este mecanismo explica el ciclo, pero no es la causa inicial: el campo ausente sí lo es.

En este evento, `message.findUnique({wamid})` no encontró mensaje: la consulta agregada devolvió **0 mensajes** y **0 entregas** ligados a su ID. La excepción ocurre antes de la llamada Prisma de `upsertContact`; por tanto, en la ruta actual de este evento no se crean contactos, conversaciones, leads ni atribuciones, no se detectan comprobantes, no se invoca IA y no se prepara ni envía respuesta. Sí se escriben repetidamente estado/contador del inbox y logs, con consumo de CPU, I/O y atención operativa. No se puede extrapolar esta ausencia de efectos a otros payloads o a un fallo posterior al guardado de mensajes.

Hay otra ruta que exige cuidado: si falla después de persistir un mensaje, el siguiente intento entra por `alreadyProcessed`; la atribución y la detección de comprobantes pueden repetirse y, con `resumeCommercial=true`, la ruta comercial puede continuar. La unicidad de `eventKey` y `wamid`, y el ledger de entregas, reducen duplicados, pero las pruebas deben cubrir efectos externos y estado comercial. Además, `scan()` marca `COMPLETED` el caso `missing_contact`; un payload inválido no debe clasificarse como procesado por esa vía.

La revisión focalizada de auxiliares encontró un lock y clave única por `inboundMessageId` en `AdvertisingService.claimReference`, un registro único de comprobante por `messageId` en `PaymentsService.detectProof`, lock por contacto en `LeadsService.findOrCreateForConversation`, `jobId` derivado del mensaje en `AutoReplyService.enqueue`, y `operationKey` única con `upsert` en `AutomatedDeliveryService.prepareBatch`. Son controles de idempotencia de almacenamiento; la seguridad de una recuperación tras efectos externos debe demostrarse con pruebas, especialmente alrededor de entregas Meta y cambios comerciales.

### Corrección propuesta para Codex Local, PR independiente

1. En `hermes-backend/src/webhook/webhook.service.ts`, validar antes de cualquier efecto que `payload` y `message` son objetos, que `message.id` y `message.from` son cadenas no vacías, y que `contact.wa_id` es una cadena compatible con el remitente. Validar `profile.name` como cadena opcional y los campos de texto/medios usados aguas abajo según el tipo. No convertir `from_user_id`/`user_id` en `wa_id` por conjetura. En `hermes-backend/src/campaigns/phone-normalizer.ts`, aceptar `unknown` y devolver un error tipificado o `null` antes de `.trim()`; revisar las demás normalizaciones de entradas externas que se ejecutan en esta ruta.
2. Distinguir en código los resultados `PERMANENT_INVALID_PAYLOAD` y `RETRYABLE_PROCESSING_ERROR`/`RETRYABLE_ATTRIBUTION_ERROR`. Conservar el JSON y la clave del evento. Para un payload permanentemente inválido, dejarlo en `FAILED` con `outcome` tipificado y `leaseUntil=NULL`, emitir métrica/alerta y exigir revisión humana. `scan()` solo debe reclamar fallos recuperables y leases `PROCESSING` vencidos; no se debe marcar `COMPLETED`, borrar el payload, resetear intentos ni aplicar un límite ciego. Un fallo transitorio conserva backoff, trazabilidad y recuperación de lease.
3. Validar la estructura también al aceptar un webhook firmado y guardar los eventos accionables inválidos con clave estable para su cuarentena; no responder `OK` tras descartarlos silenciosamente. Si falta un ID apto para la clave, usar una huella determinista del evento firmado con control de colisiones y conservar el payload. Coordinar la clasificación con el esquema y la monitorización existentes; preferir un cambio pequeño y explícito de códigos de `outcome` si basta, o una migración independiente si un estado adicional resulta imprescindible.
4. Revisar las rutas tras un mensaje ya persistido para que la atribución, los comprobantes, el encolado y las entregas sean idempotentes frente a recuperación de lease. Mantener la comparación por `claimToken` en la transición final. Ninguna excepción permanente debe convertirse en éxito.

**Archivos a revisar:** `src/webhook/webhook.service.ts`, `src/webhook/dto/meta-webhook.dto.ts`, `src/campaigns/phone-normalizer.ts` y pruebas de webhook/inbox. Revisar `AdvertisingService`, `PaymentsService`, `AutoReplyService` y `AutomatedDeliveryService` únicamente para verificar idempotencia de la ruta reanudada. No incluir el PR #15 ni alterar la imagen A7-BF16.

**Regresiones necesarias en entorno aislado:** payload exacto reproducido solo por tipos y campos ficticios; `from`/`wa_id` ausentes, nulos, numéricos, vacíos y no E.164; contacto alternativo sin `wa_id`; mensajes WhatsApp válidos; fallo transitorio con backoff y recuperación tras vencimiento; reinicio durante `PROCESSING`; concurrencia de scanners; deduplicación por `eventKey`/`wamid`; fallo después de persistir el mensaje; atribución/comprobante; handoff, IA y ledger sin entregas duplicadas. Afirmar `FAILED` permanente con payload intacto y sin nuevos intentos, y `COMPLETED` solo tras procesamiento real. Ejecutar pruebas y gates del repositorio antes de crear una imagen nueva.

**Evento existente:** conservarlo. Antes de cualquier intervención, confirmar identidad, hash/forma del payload, contador, lease y ausencia de trabajo en vuelo. En un entorno aislado, ensayar la nueva clasificación sobre una copia saneada. Tras aprobación de la corrección y de una operación productiva separada, permitir que el worker corregido clasifique condicionalmente este registro como fallo permanente sin entrega, o efectuar una transacción operatoria equivalente con guardas `id`/`claimToken`/estado/lease y auditoría. Para intentar procesarlo realmente se necesita verificar por una fuente autorizada el canal y el identificador WhatsApp; los campos alternativos actuales no bastan. Si esa identidad no se obtiene, mantener el evento en cuarentena y derivarlo a revisión humana. Si se obtiene, diseñar un reproceso único con idempotencia comprobada y observación del ledger; no reinyectar el webhook a ciegas.

## 3. BACKUP-01 — estado y ensayo posterior

PostgreSQL responde como **16.14**. La base actual ocupa aproximadamente **13 MB**, contiene 43 tablas públicas y registra 27 migraciones aplicadas sin fallidas/pendientes; su volumen de datos está en `/var/lib/docker/volumes/hermes-backend_hermes_pgdata/_data`. El volumen Compose `hermes-backend_hermes_backups` existe en `/var/lib/docker/volumes/hermes-backend_hermes_backups/_data` y estaba vacío al corte. La tabla de artefactos de backup tiene 0 filas. El catálogo privado del 25/10 registra un `pg_dump custom` de 232.088 bytes, SHA-256 y 335 entradas de `pg_restore --list`, con `restore_tested=false`. El archivo y su catálogo aún existen; sus SHA-256 coinciden con los registrados. Esto verifica integridad de esos archivos, no restaurabilidad ni actualidad. Un gate del 5/11 declara `current_backup_created=false` e `isolated_restore_executed=false`. Hay un procedimiento histórico de restauración y scripts de respaldo en evidencia privada, pero no prueba de restauración, copia externa vigente, agenda operativa ni retención aprobada. El disco mostraba unos **19 GiB libres**; es una estimación preliminar, no reserva de capacidad.

**Estado:** `BACKUP_RESTORE_NOT_VERIFIED`.

**Procedimiento posterior sujeto a autorización:**

1. Designar responsable, ventana, ubicación privada y destino externo aprobado; fijar retención, acceso y cifrado. Medir nuevamente base, espacio y capacidad del destino. Exigir volumen y credenciales de prueba independientes.
2. Con cliente PostgreSQL 16, generar `pg_dump --format=custom --no-owner --no-acl` de la base productiva hacia archivo temporal exclusivo en directorio `0700`, archivo `0600`, sin contraseña en argumentos ni logs. No usar el volumen productivo como destino de restauración. Guardar ID, hora, versión, tamaño y resultado del proceso.
3. Calcular SHA-256, verificarlo sobre la copia protegida y comprobar `pg_restore --list`; conservar al menos una copia externa conforme a la política aprobada. No considerar el listado una restauración satisfactoria.
4. Levantar un PostgreSQL 16 compatible en red y volumen separados, sin puertos públicos, sin aplicación conectada y con credenciales nuevas. Confirmar identidad del destino y ausencia de rutas hacia la base productiva antes de ejecutar `pg_restore --exit-on-error --no-owner --no-acl` contra esa base aislada.
5. Comprobar que `pg_restore` sale 0 y que no hay objetos fallidos; contrastar esquema, 27 migraciones, tablas, conteos agregados, claves foráneas, relaciones de contacto/conversación/mensaje, inbox, ledger, catálogo y checksums del dump. Registrar PASS/FAIL con fecha, hash, versión y responsable. No copiar valores personales al acta.
6. Conservar dump y evidencia según retención aprobada. Destruir el PostgreSQL temporal solo tras verificar por ID que no es producción y que la evidencia necesaria está protegida. Cualquier recuperación de producción sería una autorización distinta.

## 4. STATE-01 — Compose y reconciliación posterior

`current.json` coincide con Docker en imagen, commit, ID del contenedor, proyecto `hermes-backend`, servicio `app`, directorio de proyecto y archivo `/etc/hermes-crm/compose.env`. Sus 22 archivos `compose_paths.files` son exactamente el prefijo de los **23** de la etiqueta `com.docker.compose.project.config_files` del contenedor. Falta al final:

`/root/evidence/hermes-backend-production-deploy-retry-20261105/candidate.app.override.yml`

La cadena exacta es la lista actual de `current.json` **en el mismo orden**, seguida de ese override. Los 23 archivos existen. Se renderizó Compose en memoria con `BACKEND_GIT_COMMIT` interpolado desde el registro, proyecto, `env_file` y directorio efectivos; el render de 22 frente al de 23 archivos difiere solo en `services.app.image` y `services.app.environment.BACKEND_GIT_COMMIT`. El render completo coincide con imagen y revisión OCI del contenedor. Los 117 valores de entorno declarados por Compose coinciden con el entorno efectivo; Docker añade tres valores de imagen. Los flags Nous y aprendizaje siguen iguales al preflight: `gemini_direct`, piloto `nous_hermes`, comercial/operaciones `true`, presupuesto `MONITOR_ONLY`, inbound abierto `false` y aprendizaje F3/F4 desactivado. Renderizar únicamente los 22 archivos seleccionaría una imagen anterior.

Orden completo registrado en la etiqueta efectiva de Docker:

```text
01 /var/www/releases/hermes-20261017-f3-guard-99a5ec56/hermes-backend/docker-compose.yml
02 /root/evidence/lf19k-b-20261023/candidate.image.yml
03 /root/evidence/lf20r-d1-dark-20261024/dark.image.yml
04 /root/evidence/lf20r-w1-watchdog-f3-20261024/neutral.app.override.yml
05 /root/evidence/lf20r-a4-dark-20261025/candidate.app.override.yml
06 /root/evidence/lf20r-a6-d3-dark-20261025/candidate.a6.app.override.yml
07 /root/evidence/hermes-a7-d2-20261025/candidate.a7.app.override.yml
08 /root/evidence/hermes-a7-d6-20261026/candidate.a7d4.app.override.yml
09 /root/evidence/hermes-a7-d10-r6-20261026/candidate.a7d10.app.override.yml
10 /root/evidence/hermes-a7-d14-g5-20261027/candidate.app.override.yml
11 /root/evidence/hermes-a7-d19-20261028/candidate.app.override.yml
12 /root/evidence/hermes-a7-d20-20261028/activation.app.override.yml
13 /root/evidence/hermes-a7-d20-20261028/dark.app.override.yml
14 /root/evidence/hermes-a7-d20-retry-20261028/activation.app.override.yml
15 /root/evidence/hermes-a7-d27-20261029/candidate.app.override.yml
16 /root/evidence/hermes-audio-inbox-20261029/candidate.app.override.yml
17 /root/evidence/hermes-audio-fallback-20261029/candidate.app.override.yml
18 /root/evidence/hermes-black-friday-catalog-recovery-20261030/candidate.app.override.yml
19 /root/evidence/hermes-crm-promotions-20261030/candidate.app.override.yml
20 /root/evidence/hermes-black-friday-meta-ads-vps-20261031/candidate.app.override.yml
21 /root/evidence/hermes-nous-es-ec-final-20261031/candidate.app.override.yml
22 /root/evidence/hermes-black-friday-release-20261102/candidate.app.override.yml
23 /root/evidence/hermes-backend-production-deploy-retry-20261105/candidate.app.override.yml
```

**Procedimiento posterior sujeto a autorización:** bajo lock de release y sin operación concurrente, preservar una copia privada íntegra de `current.json` con hash; reconfirmar etiqueta, ID, digest, OCI y flags; verificar existencia, hash y orden de los 23 archivos y el `env_file`; renderizar en memoria ambas cadenas y comparar una proyección saneada de todos los servicios, redes, volúmenes y entorno sin publicar secretos; comprobar que el render completo reproduce el runtime. Actualizar solo `compose_paths.files` y metadatos de fecha/responsable autorizados mediante reemplazo atómico; releer y volver a verificar. No ejecutar `docker compose up`, no sustituir imagen, no cambiar flags Nous.

## 5. Riesgos y prioridades

| Problema | Severidad / probabilidad | Mensajes / duplicados | Comercio y privacidad | Dependencia / reversibilidad |
| --- | --- | --- | --- | --- |
| INC-01 | **Alta / impacto actual confirmado.** El ciclo continúa y un mensaje sigue sin procesar. | Riesgo alto de atención perdida para ese evento; duplicado de respuesta observado: ninguno. La ruta reanudada de otros fallos requiere pruebas. | Atención comercial potencialmente interrumpida para el remitente; consumo sostenido de recursos. El payload retenido exige acceso mínimo. | Corregir código, probar idempotencia e identificar canal; cuarentena reversible si se preserva evento y auditoría. |
| BACKUP-01 | **Alta / impacto condicionado a recuperación.** No hay ensayo real. | Una pérdida de datos sin copia restaurable podría afectar mensajes y relaciones; no hay pérdida observada por esta causa. | Continuidad comercial y privacidad dependen de almacenamiento protegido. | Destino externo, retención, recursos aislados y autorización; restauración de prueba reversible sin tocar producción. |
| STATE-01 | **Alta antes de un cambio / probabilidad concreta si se usa la lista incompleta.** | Un `up` posterior podría seleccionar imagen antigua y alterar el tratamiento de mensajes. | Posible interrupción y drift funcional; render completo contiene secretos y no debe publicarse. | Reconciliar metadatos con lock y comparación; reversible desde copia previa. |

La prioridad inmediata es corregir y contener de forma autorizada el reintento permanente; el evento sigue sin atención y el contador crece. No se observó corrupción ni entrega duplicada. No se ejecutó contención productiva en esta fase.

## 6. Siguientes autorizaciones y límites

Codex Local debe preparar un PR **independiente** con la corrección del inbox y pruebas; luego se determinará si hace falta una nueva imagen. La A7-BF16 publicada permanece inmutable y no debe asumirse como candidata final tras una corrección adicional. Por separado se requieren autorización operativa para clasificar/recuperar el evento, para crear backup y ensayar restauración aislada, y para reconciliar `current.json`. No se solicita todavía autorización de despliegue A7-BF18.

Este Markdown y la actualización del índice se prepararon en un directorio de exportación protegido. Codex Local debe recuperar **solo los dos archivos saneados** por SSH/SFTP de solo lectura, revisar el diff y publicarlos en el PR #16 manteniéndolo como borrador. No modificar `main`, la rama piloto ni informes históricos. `DOCS_SYNCED` exige verificar el nuevo contenido en GitHub; hasta entonces `DOCS_SYNC_PENDING`.