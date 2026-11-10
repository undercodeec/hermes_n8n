# Inbox sobre piloto — candidato para QA (2026-11-10)

## Dictamen final independiente y autorización de cierre

**QA final favorable**, comunicado por el coordinador: autorizado commit/push de estos siete archivos y PR de desarrollo contra `pilot/a7-d12-monitor-only-20261026`, sin merge/despliegue. Los apartados siguientes conservan cronología; las referencias históricas a pendiente QA o 7 PG no sustituyen este dictamen final.

- QA ejecutó `--serve-local`: Jest **7 PASS**, benchmark omitido explícitamente. El wrapper PowerShell/background informó **exit1 pese al log Jest PASS y limpieza**; no se registra falsamente exit0 para ese wrapper. Se distingue resultado de Jest y proceso contenedor/orquestador.
- CRM ejecutó `scripts/inbox-local-harness.mjs` **SIN --fixture, exit0**: login/canje proof real Nest, listado50, detalle, móvil390 y volver. Auth/Conversations/Prisma/PostgreSQL reales con auxiliares explícitos del harness. No equivale a backend completo ni a validación de pagos reales.
- Repetición PG estándar independiente: **8/8 PASS, exit0**; cuatro lectores concurrentes200, transfer literal JSON null, feedback completo, auxiliares sin JWT401, mutaciones405. Benchmark **10.068 chats/200.198 mensajes**, p95 serial **178ms**, cuatro lectores **222ms**, presupuesto local **2.000ms**. Permanece límite **O(N) IDs precargados**, tres parámetros SQL y capacidad no acreditada por encima del volumen/concurrencia probados.
- **39 unitarias, 14 runner, lint/build**: evidencia de QA independiente anterior favorable; no se repitieron en la última ronda porque sólo cambiaron test local/informe, no código runtime aprobado. También constan las repeticiones del implementador en la cronología.
- Transfer: adaptador **test-only JWT+Roles**, PaymentsService real/PG y JSON null explícito. Feedback real/PG; colaboradores mutantes de pagos fail-closed y middleware405. Sin cambios de runtime productivo para resolver el harness. OTP admin usa rutas aisladas con **SMTP/perfil/sesiones sustituidos**. Filtros/paginación/mensaje nuevo **browser sólo fixture**; no atribuir esos checks al browser real. SSE local real sin eventos inventados; dashboard opcional404 declarado.
- Inspección de capturas denegada: **gate visual pendiente**, sin certificación de apariencia. No despliegue autorizado. No eludir permisos ni inferir validación visual a partir de exit0 funcional.
- QA confirmó limpieza de **ambas ejecuciones**: contenedores/redes exclusivos eliminados y puertos **3310–3312 libres**. No servicios live persistentes de la tarea.
- Alcance final exclusivo Inbox: sin main/pilot merge, GHCR, dispatch/workflows, VPS, producción, WhatsApp real, otras PR (#19/#20), sitio comercial ni cambios de raíz vieja. Commit de rutas exactas; informe ignorado se incorpora mediante `git add -f` **sólo sobre esta ruta**, sin cambiar gitignore.

## Procedencia y alcance

- Worktree autorizado único: `D:/Documentos/Hermes/hermes-backend/.inbox-pilot-candidate-20261110`.
- Directorio de comandos: el subdirectorio `hermes-backend` de ese worktree.
- Rama: `feat/hermes-inbox-order-pilot-20261110`; base/HEAD sin commit de tarea: `ca85b991db1651f5bf500f3fb8e9db95ba9d56f0`.
- Base confirmada contra `git ls-remote origin refs/heads/pilot/a7-d12-monitor-only-20261026`. Instalación aislada `npm ci --ignore-scripts --no-audit --no-fund` y `node node_modules/prisma/build/index.js generate`. Sin modificar manifiesto/lockfile ni reutilizar dependencias/client Prisma viejos.
- AGENTS de `D:/Documentos/Hermes/AGENTS.md` releído exitosamente. No hay AGENTS versionado en la raíz candidata. Aplican además las reglas Docker UnderCode proporcionadas.
- La raíz sucia y todos sus cambios comerciales/documentales quedan intactos. Los cambios Inbox de la rama vieja, incluido su informe local, no se borraron ni incorporaron al candidato como snapshots. Se aplicó únicamente el delta semántico sobre el servicio real piloto; se mantienen `origin`, atribución, `projectCrm*`, saneamiento de incidentes y comportamiento multimedia/audio.
- No commit/push todavía: pendiente QA independiente y orden de cierre. No merge, GHCR, VPS, despliegue, otras tareas/PR o Hermes Web.

## Archivos de la tarea, relativos a la raíz Git candidata

1. `hermes-backend/src/conversations/conversations.service.ts`
2. `hermes-backend/src/conversations/conversations.service.spec.ts`
3. `hermes-backend/src/conversations/conversations.inbox-order.spec.ts`
4. `hermes-backend/scripts/run-inbox-order-integration.mjs`
5. `hermes-backend/scripts/run-inbox-order-integration.test.mjs`
6. `hermes-backend/test/conversations-inbox-order.integration-spec.ts`
7. `hermes-backend/docs/inbox-order-pilot-validation-2026-11-10.md`

No cambios de controller, DTO, helper de atribución, esquema o migraciones. El helper legado `readAttributions` está tipado como PrismaService pero sólo usa `$queryRaw`; el servicio le pasa el cliente transaccional con aserción de tipo localizada y comentada, conservando la misma implementación/proyección y snapshot.

## Contrato CRM

`GET /api/conversations`, mismos guards ADMIN/SALES_AGENT y envoltorio `{ data,total,page,limit,totalPages }`. El proxy CRM conserva su ruta `/api/hermes/*` y debe reenviar los parámetros existentes.

- Orden global antes de paginar: último mensaje de cualquier dirección por `createdAt DESC`, vacías al final, empate conversación por `id COLLATE "C" ASC`. UUID/IDs ASCII quedan en orden lexical estable; collation explícita evita depender de locale PostgreSQL.
- Preview: `createdAt DESC, id DESC`. Estado, `updatedAt`, handoffs y pagos no promueven chats sin mensaje nuevo. `isPriority` sigue indicador y `priorityOnly` filtro.
- Todos los filtros piloto se conservan y se aplican antes de ranking: query/nombre/teléfono/waId, status, intent, from/to y origin meta_ad/organic/unknown. Fechas mantienen la semántica previa: **updatedAt de conversación**, no timestamp de mensaje.
- Snapshot RepeatableRead por petición para IDs filtrados, ranking SQL, hidratación, agregado inbound y atribución. No snapshot/cursor entre peticiones de páginas diferentes: mensajes concurrentes pueden desplazar offsets; cliente debe refrescar/resetear y deduplicar IDs.
- `assignedAgent` sólo selecciona `{ id,name,email,role }` o null en listado/detalle; conserva además `projectCrmHandoff`. Defensa en profundidad: el piloto ya proyectaba usuarios públicos; no se afirma que Inbox haya introducido ni que el piloto expusiera el hash heredado de la base vieja.

## Ranking SQL y límites explícitos

Primero Prisma selecciona **todos los IDs coincidentes** para mantener exactamente sus filtros, incluida atribución/origin. Sólo esos IDs se transfieren a Node, no historiales ni timestamps globales. SQL parametrizado usa `unnest($1::text[])`, `LEFT JOIN LATERAL` con `ORDER BY createdAt DESC LIMIT 1`, índice existente `(conversationId,createdAt)`, ranking + OFFSET/LIMIT en PostgreSQL. Sólo se hidratan los IDs de la página; se restaura ese orden después del `IN` de Prisma.

No hay concatenación de entrada en SQL: array de IDs + offset + limit son **tres parámetros**, incluso con más de 32.767 candidatos. Regresión unitaria con 33.000 IDs y metacaracteres SQL comprueba binding, no es un ensayo de rendimiento de 33.000 chats reales. PostgreSQL real prueba el binding del array con 10.068 IDs.

**Límite restante:** enumeración de IDs sigue O(N) en memoria/red por lectura; búsquedas laterales y ordenamiento siguen creciendo con N. No se introdujo cap/truncación silenciosa. Fixture usa IDs sintéticos de 8/17 caracteres (~171k caracteres de contenido de IDs); 10.068 UUID reales tienen ~362k caracteres antes de overhead de codificación/protocolo. No se certifican millones de IDs ni el límite físico de array/memoria PostgreSQL. Para escalar más, mover también filtros al SQL con paridad revisada o introducir resumen indexado de último mensaje, con decisión de esquema independiente.

## Comandos finales reproducibles

Desde el backend candidato indicado arriba:

```powershell
node node_modules/jest/bin/jest.js --runInBand src/conversations src/attribution-crm
node --test scripts/run-inbox-order-integration.test.mjs
node node_modules/eslint/bin/eslint.js src/conversations/conversations.service.ts src/conversations/conversations.service.spec.ts src/conversations/conversations.inbox-order.spec.ts test/conversations-inbox-order.integration-spec.ts
node node_modules/prettier/bin/prettier.cjs --check scripts/run-inbox-order-integration.mjs scripts/run-inbox-order-integration.test.mjs
node node_modules/@nestjs/cli/bin/nest.js build
node scripts/run-inbox-order-integration.mjs --export-fixture
git diff --check
```

Resultados: **5 suites / 39 unitarias PASS; runner 14/14 PASS; PG real 7/7 PASS; build PASS**. ESLint acotado y formato se repitieron tras corregir dos accesos mock sin tipar detectados en la última ronda. No se ejecutó suite/lint completo ajeno: no se afirma validación global de todos los módulos piloto.

PG cubre >50 chats, ties entre páginas, previews, vacías, total/pages sin duplicados sobre datos estables, filtros reales (incluidos los tres origin y combinación prioridad/origin), nuevo mensaje sin actualizar conversación, commit concurrente tras seleccionar candidatos antes de ranking/hidratación, agregado inbound consistente, proyección de metadata/rawPayload/usuario segura en JSON real y atribución pública preservada. Firma pública y pruebas piloto existentes de audio/proyección siguen pasando.

## Volumen y presupuesto

La primera implementación de ranking Node sobre piloto pasó funcionalmente pero dio p95 **2.511 ms**, superando el presupuesto local propuesto de 2 s. Se corrigió; no se oculta ese resultado.

Último run SQL: **10.068 chats / 200.198 mensajes**, limit 50, páginas 1/100 alternadas, diez lecturas seriales en ms:
`171,163,151,164,151,154,158,171,153,199`.

- p50 **158 ms**, p95 **199 ms**.
- Cuatro lectores simultáneos, tres oleadas (12 lecturas): `256,262,300,335,231,238,239,260,247,248,252,283` ms; p95 nearest-rank **335 ms**.
- RSS final proceso Jest **208 MiB**; no es memoria incremental/peak del servicio. Seed sintético de mensajes cortos; red local Docker.
- Presupuesto de evaluación: p95 <= **2.000 ms** tanto serial como cuatro lectores a este volumen; observado PASS. El test registra tiempos, no impone un assert dependiente del hardware.
- Prisma conserva timeout interactivo por defecto de **5 s** y maxWait de **2 s**; no se amplían para esconder lentitud. Las 22 llamadas completaron sin timeout/pool error. No se probó saturación sostenida, muchos procesos/pestañas, históricos mucho mayores, payloads grandes, CPU/red remotas o p99.
- Polling 15 s implica cuatro requests/min/tab. Cuatro lectores se ensayaron en tres ráfagas, **no** equivalen a una certificación de carga sostenida. Por encima de 10k/200k o cuatro lectores, rendimiento queda no validado; requiere benchmark independiente y/o eliminar enumeración global de IDs.

## Migraciones piloto y drift heredado

Las **27 migraciones SQL existentes** se aplican desde cero con `ON_ERROR_STOP=1` antes de fixtures sobre una base exclusiva nueva. Prisma generado corresponde al esquema piloto y usa realmente esa base. No se crea ni ejecuta migración nueva ni ledger Prisma productivo.

Comprobación adicional read-only `prisma migrate diff --from-url <base desechable> --to-schema-datamodel prisma/schema.prisma --exit-code` detectó **drift basal preexistente**, sin diferencias en archivos de schema/migraciones respecto a ca85b991:

- Nombres de índices en `advertising_daily_metrics`, `campaign_template_media`, `transfer_payment_proof_messages` distintos del nombre esperado por Prisma (truncamiento PostgreSQL).
- Default `retention_recovery_policy.updatedAt`: migración `now()` frente al modelo sin default.

El runner imprime y reconoce únicamente el texto exacto `KNOWN_PILOT_DRIFT` documentado en su fuente; cualquier drift adicional falla **antes de escribir fixtures**. Pruebas de frontera verifican aceptación exacta/rechazo adicional y limpieza. No declarar este piloto “sin drift”; corrección basal pertenece a otra tarea. Dos ejecuciones de diagnóstico fallaron inicialmente al exigir drift cero, pero limpiaron recursos.

## Docker y recursos liberados

Contexto inicial `desktop-linux`, endpoint named pipe local; runner fija `DOCKER_CONTEXT=desktop-linux` después de verificarlo sin cambiar contexto global. Entorno hijo reducido (sin URLs/credenciales del llamador); `.env` Prisma deshabilitado en el test mediante hook interno versionado para Prisma 5, a revisar al actualizarlo.

Sin Compose: configuración del runner revisada. `postgres:16-alpine --pull=never`, puerto loopback aleatorio, PGDATA tmpfs, cero bind mounts/volúmenes nombrados persistentes, red/contenedor con nombre y label exclusivos. Destino host/puerto/base impreso y validado por URL en el test antes de fixtures. Limpieza independiente por label+nombre exactos de la invocación, también ante fallos; nunca prune/global/recursos ajenos.

Ejecuciones de este candidato, todas limpiadas (prefijo proyecto `hermes-inbox-test-`, base `inbox_test_`):

| Sufijo único | Puerto | Resultado |
| --- | --- | --- |
| `1e9ccbfa11f74c30a53cb6797e2c37d0` | 50289 | PG funcional/volumen Node PASS, presupuesto fallido |
| `c189a347a566456db5771d0ae3e060a0` | 62836 | PG funcional/volumen SQL PASS |
| `47f8af6b70144b34a6e69b0184daddd5` | 52981 | Diagnóstico drift basal, fixtures no ejecutados |
| `ca9ac21db288475080d26869f8b3843e` | 51783 | Diagnóstico detallado drift basal, fixtures no ejecutados |
| `6ae73f3a99f24aeb857d35476f347922` | 61812 | Final PG 7/7, fixture + volumen/concurrencia PASS |

Último contenedor `8ce5c85196d8`, red `49baf494546a`, ambos eliminados. Se libera uso de Docker/build del candidato para QA; no servidor o base de esta tarea queda en ejecución.

## Harness navegador/proxy para coordinador

```powershell
node scripts/run-inbox-order-integration.mjs --export-fixture |
  ForEach-Object {
    if ($_ -match 'INBOX_BROWSER_FIXTURE (.+)$') { $Matches[1] }
  }
```

Dos líneas JSON independientes `{scenario,pages,detail}`: `initial` y `new-message`. Cada una tiene dos respuestas de páginas con total 68 y detalle serializado real del servicio piloto; fechas ISO, datos exclusivamente ficticios. Último run parseó ambas exportaciones correctamente (dos páginas/68 filas). El coordinador puede guardarlas en su ubicación CRM autorizada, servir `pages[page-1]` desde upstream mock **sólo loopback** y alternar escenario para refresh; conservar proxy real y fixture local de autenticación del CRM. No requiere JWT ni credenciales reales, no desactivar guards de producción. Esta prueba grabada verifica contrato/order/proxy/browser, **no** acredita auth Nest/live upstream. Validación navegador/CRM/proxy corresponde al coordinador, no se afirma aquí.

## Pendiente QA/cierre

### Corrección P2 tras QA cruzada — detalle completo (vigente)

La primera versión live omitía transfer/feedback, y el 404 obligatorio de transferencia abortaba `Promise.all` en `src/app/admin/crm/inbox/page.jsx` líneas 270–279. El listado/login PG real estaba probado, pero **no** se acreditó navegación de detalle con esa versión. La siguiente configuración y evidencia sustituyen la limitación de auxiliares404 del apartado histórico inferior.

Dependencias inspeccionadas en page.jsx y `src/lib/hermes/api.js`, sin modificar CRM:

| GET requerido | Implementación local vigente | Contrato comprobado |
| --- | --- | --- |
| `/conversations/:id` | ConversationsController/Service reales + PG | 200, detalle con id |
| `/conversations/:id/messages?page=1&limit=50` | ConversationsController/Service reales + PG | 200, historial paginado real |
| `/transfers/conversation/:id` | **Adaptador test-only LocalTransferReadController**, JWT+Roles guards reales, PaymentsService.byConversation real + PG | 200 `application/json`, cuerpo literal `null` para fixture sin transferencia |
| `/feedback/conversation/:id` | FeedbackController/Service reales + PG | 200 `{data:[],summary:{total:0,good:0,bad:0,reasons:{}}}` |

No se afirma que el adaptador transfer sea el controlador productivo: `res.json` se usa explícitamente para asegurar JSON null, mientras Nest por defecto serializa un retorno null como cuerpo vacío. No se inventan objetos `{}`/pagos ni se parchea CRM. PaymentsService lee la tabla real; sus colaboradores de deliveries/leads/policy usados por mutaciones son **sustitutos fail-closed** (Proxy que lanza excepción ante cualquier acceso), no implementaciones de pagos reales. Config sólo sintética y pagos no habilitados. Feedback no recibe scheduler opcional; no se genera revisión. Middleware bloquea POST feedback, aprobación/reply/handoff/otros cambios con405 antes de dispatch; sólo proof auth sintético puede escribir usuario de test.

SSE sigue ConversationEventsService real en modo local sin Redis: connected/heartbeat, sin eventos de clientes inventados. Dashboard transitorio `/analytics/crm-overview`, `/analytics/funnel`, `/leads?page=1&limit=5` no se implementa: **404 declarado**; no se certifica dashboard/backend completo. No se añaden sustitutos silenciosos de contadores/leads.

La regresión HTTP ahora corre también en la prueba PG estándar, puerto efímero y sin espera: replica el `Promise.all` de las cuatro dependencias, asegura status `[200,200,200,200]`, tipo JSON y texto `null` exactos, feedback completo, auxiliares sin JWT401 y mutaciones405. En modo `--serve-local` usa3312 y permanece disponible hasta diez minutos/stop; omite sólo benchmark grande. No inicia servicios externos ni modifica auth/guards reales.

Última ejecución tras corrección: `node scripts/run-inbox-order-integration.mjs`, **8/8 PG PASS**, sin skips, 27 migraciones aplicadas, drift basal exacto registrado. Proyecto/base sufijo `1491233badd140a78ae53e8aebcdcddb`, puerto62018; contenedor `52b609213612` y red `dcd36a40a3ce` eliminados. No live en ejecución; **QA debe iniciar --serve-local cuando esté lista**, evitando caducidad previa. Volumen10068/200198: serial p50 147ms/p95179ms, cuatro lectores p95219ms, RSS284MiB incluyendo Jest/seed/Nest, presupuesto2s PASS. Scoped ESLint del test corregido PASS.

Comando live/requisitos URL+secret idénticos a los del apartado siguiente. Certificación pretendida: **Nest Auth+Conversations+Prisma/PG reales con auxiliares enumerados**, no backend completo. CRM real cubre login/detalle/desktop/móvil/volver; filtros/paginación/mensaje nuevo pertenecen a pruebas fixture/unit/PG, no atribuirlas al harness browser real si no se ejecutan allí. OTP admin usa cuerpos de rutas reales aislados, pero SMTP, perfil/sesiones admin siguen sustituidos en CRM. La inspección visual mediante read denegada por permisos continúa como limitación; no se elude ni se certifica apariencia por capturas no revisadas.

### Modo live Nest/PG añadido para QA cruzada

`node scripts/run-inbox-order-integration.mjs --serve-local` prepara la misma base exclusiva/migraciones/fixtures, omite el benchmark grande, ejecuta las regresiones funcionales y publica un módulo Nest mínimo en **127.0.0.1:3312** durante un máximo de diez minutos. Usa **AuthController, AuthService, JwtStrategy, ConversationsController y ConversationsService reales** contra Prisma/PostgreSQL real. No importa AppModule ni inicia Redis, Meta, workers, SMTP o servicios externos. ConfigService recibe sólo configuración sintética explícita, JWT efímero, Prisma ya conectado a la base desechable. Los guards reales permanecen activos; no se simula el canje JWT/validación de usuario.

Middleware test-only rechaza mutaciones (405) salvo POST de `/auth/crm-proof`, que puede crear/actualizar exclusivamente el usuario sintético en esta base ficticia. `/auth/login`, registro, replies, estados y pagos no se ejecutan. Soporta rutas con o sin `/api` para el proxy. Eventos SSE son locales del proceso, sin Redis. Transfer/feedback no forman parte de este módulo mínimo; sus rutas pueden responder 404, no se afirma validación integral de todos los módulos CRM.

Desde el candidato CRM, SIN `--fixture`:

```powershell
$env:INBOX_LOCAL_NEST_URL='http://127.0.0.1:3312'
$env:INBOX_LOCAL_PROOF_SECRET='inbox-local-synthetic-proof-20261110-only'
node scripts/inbox-local-harness.mjs
```

El secret es deliberadamente ficticio, hardcoded sólo en harness de tests. Nunca usar con datos/despliegue reales. POST proof debe usar `iss=undercodeec-admin`, `aud=hermes-crm`, sub `gerencia@undercodeec.com`, role ADMIN, jti único y vigencia <=180 s. Ninguna credencial real se requiere. Auto-test del modo live comprueba sin sesión 401, canje 200, listado real total68/filas50, replay401, reply405. Se repitió externamente por HTTP desde Node con resultado exacto `{proof:200,list:200,total:68,rows:50,replay:401,blockedReply:405}` sin imprimir tokens.

Primer live: proyecto/base sufijo `43e3c29efe284f31813e9abac053c843`; 27 migraciones + drift basal conocido. Para cerrar antes del límite: `Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3312/__inbox_local_stop`. Esto resuelve la espera, cierra Nest/Prisma y permite al runner eliminar sólo su contenedor/red. No matar procesos globales ni limpiar Docker ajeno. Mientras esté publicado el live, **no** se afirma que sus recursos estén liberados; esperar log/resultado de cierre y comprobar recursos por nombre exacto.

Último lint final volvió a pasar tras retirar casts redundantes del mock tipado. Unitarias39/runner14/build permanecen PASS en esta misma revisión; el test live se omite explícitamente en la ejecución PG estándar, y el benchmark se omite explícitamente en modo live. Intento de leer el archivo de salida administrado del proceso background fue denegado por la herramienta read; no se reintentó por otra vía. Se usó HTTP local independiente para validar servicio real y el runner notificará su salida automáticamente.

Revisión independiente del candidato exacto, repetición de comandos y verificación CRM/proxy. Luego, sólo con orden del coordinador, commit de rutas exactas + push de esta rama/PR dirigido al piloto; no merge ni imágenes/despliegue. La rama vieja conserva sus cambios previos, y su validación no sustituye la presente. Este informe puede estar ignorado por la política `*.md`; comprobar y, tras aprobación, incorporar sólo esta ruta mediante `git add -f` si corresponde.
