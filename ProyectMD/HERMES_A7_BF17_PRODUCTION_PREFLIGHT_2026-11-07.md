# Hermes 2.0 — A7-BF17: preflight productivo de solo lectura

**Dictamen:** `HERMES_A7_BF17_PRODUCTION_BLOCKED`

**Estado documental:** `DOCS_SYNC_PENDING`

**Corte:** 2026-11-07 16:23:38 UTC. Las lecturas se realizaron entre 16:17 y 16:23 UTC.
**Alcance:** inspección de VPS, GitHub y GHCR. Sin despliegue, pull, migraciones, escrituras en PostgreSQL o Redis, cambios comerciales ni mensajes reales.

## 1. Fuentes y precedencia

Se contrastó el runtime de Docker con `current.json`, el informe productivo del 5/11 resumido en el [PR documental #14](https://github.com/undercodeec/hermes_n8n/pull/14), el [informe A7-BF16](HERMES_A7_BF16_GHCR_PUBLICATION_REPORT_2026-11-07.md), el [informe A7-BF15](HERMES_A7_BF15_MERGE_REPORT_2026-11-07.md), el [PR #15](https://github.com/undercodeec/hermes_n8n/pull/15), el [PR #16](https://github.com/undercodeec/hermes_n8n/pull/16) y los manifiestos GHCR. El estado efectivo de Docker prevalece sobre las referencias históricas. Los informes A7-D27 y R6 no se usan para inferir la imagen actual ni el rollback.

La rama piloto remota continúa en `49a7f6adf3776e81fae9675f66b12ad48271dcf3`; GitHub confirma el tree `0498f5bf38b4645858bf67fce42017f0c6ec1572` y el PR #15 fusionado. El run [#42389504813](https://github.com/undercodeec/hermes_n8n/actions/runs/42389504813) terminó `success`.

## 2. Identidad productiva y candidata

| Concepto | Resultado del corte |
| --- | --- |
| Servicio servido | `hermes-app`, proyecto Compose `hermes-backend`, servicio `app`; contenedor creado el 5/11 a las 16:52:17 UTC, en ejecución, 0 reinicios. |
| Commit y revisión OCI efectivos | `88e9712fd6e16a730fcfd00acee10a25e84a429b`. |
| Imagen efectiva | `ghcr.io/undercodeec/hermes-backend@sha256:f669a608d0739fdfbdd687d83c0617208cd24be715365a4e10dae34241c3b730`. Coinciden ID local, referencia del contenedor, etiqueta OCI y `current.json`. |
| Candidata A7-BF16 | `ghcr.io/undercodeec/hermes-backend@sha256:959e80a4a6cfd8d65a33e38f7d52f9366a70a2b4fd8c526727cfa4955dce676b`; commit/revisión OCI `49a7f6adf3776e81fae9675f66b12ad48271dcf3`, `linux/amd64`. |
| Rollback natural de A7-BF18 | La imagen efectiva `f669a608…`, conservada localmente y resoluble en GHCR. No es la antigua referencia `5efdd8b8…` del informe del 5/11. |

La consulta remota del índice OCI candidato resolvió el manifiesto ejecutable `linux/amd64` `sha256:9757308ffe89ed2624911e3aee9a9cdcd56700758409ad06414ee7ad1f6d0347`. Su configuración remota contiene la revisión autorizada, `docker-entrypoint.sh` y `node dist/main.js`. No se descargaron capas a la VPS ni se ejecutó la candidata.

**Diferencia Compose:** `current.json` coincide con el contenedor en imagen, commit e ID, pero su lista `compose_paths.files` omite el último override del despliegue del 5/11. Renderizar solo esa lista elegiría la imagen anterior `5efdd8b8…`; añadir el override que figura en la etiqueta del contenedor elige correctamente `f669a608…`. La comparación de ambos renders mostró cambios únicamente en `services.app.image` y `services.app.environment.BACKEND_GIT_COMMIT`. El render se capturó en memoria y solo se emitieron campos operativos permitidos; no se imprimió la configuración completa. El procedimiento futuro debe reconciliar esta lista antes de cualquier `up`.

No se observó reemplazo de `hermes-app` posterior al 5/11. Hay actividad de entregas e inbox posterior a esa fecha; eso no constituye un nuevo despliegue.

## 3. Infraestructura, migraciones y recursos

Los siete contenedores productivos observados están en ejecución. PostgreSQL, Redis, n8n, agente Nous, bridge y egress informan `healthy`; `hermes-app` no tiene healthcheck Docker, pero `/api/docs` devolvió HTTP 200. Todos registran 0 reinicios en el contenedor actual. PostgreSQL responde como 16.14. Redis respondió `PONG`, con 0 conexiones rechazadas y 0 claves desalojadas. La lectura puntual de recursos mostró aproximadamente 19 GiB libres en disco, 2.2 GiB de memoria disponible y 1.5 GiB de swap libre. Docker ocupa 15.1 GB en imágenes y 5.96 GB en caché de build. El manifiesto candidato declara aproximadamente 417 MB de capas comprimidas; el espacio observado permite conservar la imagen actual y añadir la candidata, sujeto a comprobación inmediata antes del cambio. No se ejecutó limpieza.

La tabla Prisma contiene **27 migraciones aplicadas, 0 fallidas y 0 pendientes** frente a las 27 rutas de migración presentes en el tree candidato. La última aplicada es `20261029200000_black_friday_landing_80` (30/10). El PR #15 no altera esquema, migraciones, Dockerfile, dependencias, controladores ni contratos de API. Esto respalda compatibilidad preliminar con PostgreSQL y frontend CRM; no sustituye una comprobación de arranque o integración tras el despliegue.

## 4. Colas, WhatsApp e idempotencia

La inspección de 10 nombres de cola BullMQ encontró **0 en espera, 0 activos y 0 retrasados**. `nous-hermes-inference` tiene 0 en todas esas categorías y 0 fallidos. Se observó 1 trabajo fallido histórico en `conversation-learning-reviews`; no se reintentó. No hay indicio de congestión BullMQ en este instante.

El ledger contiene **0 `PREPARED`, 0 `AMBIGUOUS`, 85 `CONFIRMED` y 4 `SUPPRESSED`**; una confirmación se creó en las 24 horas previas. No había claims de entrega vigentes. No aparecieron grupos duplicados por `wamid` ni por pareja `operationKey`/parte. Existen índices únicos para `operationKey`, `wamid`, `outboundMessageId` y la combinación de mensaje fuente, tipo y parte; esto acredita controles de idempotencia en esquema y ausencia de duplicados observables en esas claves, no una prueba absoluta de entregas físicas.

**Bloqueo operativo prioritario:** el inbox Meta contiene 374 eventos `COMPLETED` y 1 evento `FAILED` de tipo `MESSAGE`, creado el 3/11, todavía con lease vigente y **5.253 intentos** al corte. En los logs de `hermes-app` se contaron aproximadamente **5.414** apariciones de `WebhookService` junto a `trim` desde el 5/11: 814 el 5/11, 2.748 el 6/11 y 1.852 hasta las 16:23 UTC del 7/11. La frecuencia reciente fue de unos 110–114 eventos por hora; la última aparición fue a las **16:23:38 UTC**. El contador aumentó durante esta auditoría. El evento puede estar en ciclo de reclamación/reintento aun cuando BullMQ muestre 0 activos; reemplazar la app en ese estado exige resolver o contener el ciclo y comprobar que no hay trabajo en vuelo. No se atribuye el error a la corrección Black Friday: antecede al candidato y su causa requiere diagnóstico separado. No se leyó contenido de mensajes, no se invocaron webhooks ni se reintentaron entregas.

## 5. Nous y conversaciones

El entorno efectivo del contenedor coincide con los flags funcionales de `current.json`: `HERMES_CONVERSATION_ENGINE=gemini_direct`, `HERMES_PILOT_NEW_CONVERSATION_ENGINE=nous_hermes`, `NOUS_PILOT_COMMERCIAL_ENABLED=true`, `NOUS_PILOT_OPERATIONS_ENABLED=true` y `NOUS_PILOT_BUDGET_MODE=MONITOR_ONLY`. Los flags `LEARNING_RETRIEVAL_ENABLED`, `LEARNING_REVIEW_ENABLED`, `LEARNING_SHADOW_ENABLED`, `LEARNING_SUMMARY_ENABLED` y `F3_CANARY_RUN_GUARD_ENABLED` están en `false`; `NOUS_HERMES_OPEN_INBOUND_TEST=false`. No se cambió ningún valor.

Doce conversaciones tienen `pilotEngine=nous_hermes` persistido: ocho activas y cuatro entregadas a humano. Tres conversaciones antiguas no tienen ese metadato; dos están activas y una entregada a humano. Para las conversaciones sin pin explícito se debe conservar el fallback `gemini_direct` durante el cambio; la evidencia no permite afirmar un pin individual para ellas. STOP, handoff y recuperación quedan cubiertos por pruebas aisladas de A7-BF15 y por el esquema/ledger, pero no por un smoke real de esta fase. El límite técnico de una o dos partes F3 usado por la respuesta WhatsApp es distinto de habilitar aprendizaje F3/F4: los flags de aprendizaje permanecen apagados.

## 6. CRM comercial de solo lectura

Existe una única promoción con ID `commercial-price-landing-black-friday-80-global-v1`: activa, vigente desde el 30/10 y sin fecha de fin registrada; `market=NULL` representa GLOBAL en la lógica de selección, moneda USD, precio **80.00**, `policyVersion=black-friday-landing-80-v1`, `isPromotion=true`, `taxMode=NULL`. Su `scope` separa **10 prestaciones**, incluida **12 meses de soporte técnico**. Por ello, no se afirma IVA incluido. La promoción referencia con `supersedesPriceListId` a la tarifa base del mismo Product. La lógica vigente selecciona la promoción cuando hay exactamente una base y una promoción vinculadas; las dos PriceLists observadas cumplen esa relación, sin ambigüedad por promociones simultáneas en el contexto GLOBAL/USD examinado.

El inventario normal continúa en **1 Product, 2 PriceLists, 1 promoción y 0 tarifas EC**. La Landing Básica GLOBAL/USD 250 aún registra un mes de soporte en su `scope`. No hay evidencia de aplicación de A `COMMERCIAL_CATALOG_RECONCILE` ni B `COMMERCIAL_GLOBAL_LANDING_SUPPORT_12M`; ambas siguen pendientes y son independientes del despliegue A7-BF18. No se alteró el CRM.

## 7. Backup, rollback y compatibilidad

La imagen actual `f669a608…` está disponible localmente y su manifiesto remoto GHCR responde; su configuración OCI corresponde al commit activo. Es una referencia inmutable apta como objetivo de rollback **del backend**. Para revertir, el operador deberá usar el mismo proyecto y cadena Compose del contenedor actual, añadir al final un override explícito con esa imagen y `BACKEND_GIT_COMMIT=88e9712…`, y sustituir únicamente `app` con `--no-deps --no-build --pull never`. PostgreSQL, Redis y sus volúmenes no deben recrearse. La reversión funcional queda condicionada a que se mantengan esquema y flags compatibles, que la imagen siga presente y que el inbox no provoque un estado inseguro.

La evidencia de backup más reciente localizada es un catálogo privado del **25/10**: declara formato `pg_dump custom`, PostgreSQL 16.14, SHA-256 y lectura de índice `pg_restore` aprobada. **No** acredita restauración aislada (`restore_tested=false`). La tabla de artefactos de backup registra 0 filas; tampoco se encontró evidencia suficiente de copia externa, retención aprobada o backup actual. `current.json` declara `backup_external_restore_tested=false`. **`BACKUP_RESTORE_NOT_VERIFIED`**. Una imagen Docker anterior no reemplaza un backup de datos.

El Dockerfile del commit candidato exige `test -s /app/dist/main.js` y `node --check` en build y en la etapa final. El build y la comprobación de imagen del run #42389504813 terminaron `success`; esto atiende específicamente el incidente del 5/11 por ausencia de `dist/main.js`. La inspección remota confirmó entrypoint y comando. Aún queda comprobar el arranque real con PostgreSQL/Redis productivos en A7-BF18, después de autorización. Los cambios de PR #15 se limitan a selección y formato de respuesta Black Friday y transporte Nous, con pruebas aisladas publicadas en A7-BF15. No se verificó compatibilidad E2E con Meta ni con frontend CRM en esta fase.

## 8. Procedimiento propuesto para `HERMES_A7_BF18_PRODUCTION_DEPLOY`

1. **Autorización separada.** Solicitar aprobación explícita del despliegue por digest y del riesgo de cualquier prueba WhatsApp real. Resolver antes el ciclo `WebhookService.trim`, documentar la disposición segura del evento `FAILED` sin reintentar entregas ambiguas y obtener backup reciente con checksum, copia/retención autorizadas y restauración aislada validada en PostgreSQL compatible. Reconciliar `compose_paths.files` con la etiqueta del contenedor; ninguna aprobación comercial A/B sustituye estos gates.
2. **Preflight inmediato.** Confirmar HEAD piloto, tree, digest e identidad OCI; `current.json` frente a Docker; HTTP, contenedores, espacio, migraciones, Redis, flags Nous, catálogo y ledger. Confirmar 0 `PREPARED`/`AMBIGUOUS`, 0 claims, 0 trabajos Nous en espera o activos y ausencia de lease/reintento de inbox que haga inseguro el reemplazo. Ante cambio de identidad o actividad en vuelo, STOP.
3. **Concurrencia.** Usar el lock exclusivo existente de operaciones Docker y coordinar con los locks de release state y mantenimiento comercial. Verificar ausencia de otra operación antes de adquirirlos. Preservar una instantánea privada de identidades y contadores; no imprimir secretos.
4. **Preparación de imagen.** Solo en A7-BF18 autorizado, obtener la candidata exacta `ghcr.io/undercodeec/hermes-backend@sha256:959e80a4a6cfd8d65a33e38f7d52f9366a70a2b4fd8c526727cfa4955dce676b`, comprobar digest, plataforma, OCI revision y disponibilidad local del rollback `f669a608…`. No limpiar imágenes.
5. **Compose app-only.** Usar la cadena completa leída de la etiqueta efectiva, incluido el override del 5/11, y añadir un override final nuevo que cambie exclusivamente `services.app.image` y `BACKEND_GIT_COMMIT`. Renderizar en memoria y comprobar que PostgreSQL, Redis, n8n, volúmenes, redes, flags Nous y restantes servicios son idénticos. Ejecutar únicamente `docker compose ... up -d --no-deps --no-build --pull never app`; no `up` general, `down` ni migraciones automáticas.
6. **Postflight.** Exigir contenedor nuevo con digest y revisión OCI candidatos, 0 reinicios, HTTP 200 y conexiones sanas; confirmar 27 migraciones sin pendientes/fallidas, Redis y colas estables, ledger sin duplicados ni estados ambiguos nuevos, flags Nous y motores persistidos intactos, oferta comercial seleccionable, y dependencias sin recreación. Observar el inbox y errores. Actualizar el registro de release solo tras éxito; conservar la identidad anterior.
7. **STOP y rollback.** Detener el avance ante error de arranque, `dist/main.js` ausente, identidad incorrecta, migración inesperada, dependencia afectada, incremento de `AMBIGUOUS`, duplicados, pérdida de confirmación Meta, trabajos en vuelo, drift de flags o degradación del inbox. Bajo lock, añadir un override final con la imagen anterior `f669a608…` y commit `88e9712…`; sustituir solo `app` con `--no-deps --no-build --pull never`, comprobar HTTP, digest, OCI, ledger y colas. No revertir PostgreSQL ni Redis automáticamente; escalar si el esquema o los datos impiden la reversión.
8. **WhatsApp posterior y separada.** Solo con contacto autorizado, opt-in y evaluación específica del riesgo de enviar mensajes reales, consultar explícitamente por USD 80. Esperar primer mensaje con saludo, precio y diez prestaciones; segundo mensaje físico con pregunta comercial independiente, cuando el límite técnico F3 permita dos partes; dos registros durables y confirmación Meta. Una consulta posterior no debe repetir innecesariamente la lista. Si las condiciones no se cumplen, no ejecutar la prueba.

## 9. Dictamen y publicación

**`HERMES_A7_BF17_PRODUCTION_BLOCKED`.** No corresponde solicitar todavía autorización de despliegue A7-BF18. La imagen y la reversión del backend tienen identidad verificable, pero el evento de inbox en reintento continuo, la falta de restauración de backup comprobada y el drift de la lista Compose impiden recomendar el cambio. Las acciones correctivas son diagnosticar y contener el ciclo sin pérdida/duplicación de entregas, validar backup/restauración y reconciliar el estado Compose; repetir el preflight inmediatamente antes de proponer A7-BF18.

**`DOCS_SYNC_PENDING`.** El PR #16 seguía abierto como borrador y su HEAD era `69b4a6fe78f2f89f981a184c9578abebf391f0b4` durante la inspección. Dos claves SSH existentes permitieron leer el repositorio, pero GitHub rechazó el push con ambas porque están marcadas como solo lectura. Se prepararon este informe público saneado y la actualización del índice para publicación mediante Codex Local. `DOCS_SYNCED` requiere comprobar después ambos archivos en el HEAD remoto; no se modificaron `main`, la rama piloto ni los informes históricos.