# Runbook de despliegue VPS — correcciones locales

Fecha: 2026-09-22
Commit de referencia: `8da7d06b4cc6415dd7d8c28444983576b226d424`
Autor: `Christopher Gallardo <undercodeec@gmail.com>`

Este documento sirve para un futuro despliegue del backend Hermes CRM. No ejecuta ni autoriza cambios en la VPS por sí solo. No registrar valores secretos en Git, Markdown, logs ni historial de shell.

## 1. Estado local validado

El commit importa `HermesModule` desde `AutoReplyModule`, por lo que `CommercialPolicyService` está disponible al compilar el grafo real de `AppModule`.

Docker Compose publica el backend como `127.0.0.1:3003:3003`, no como `3003:3003`. El backend continúa escuchando en 3003 dentro del contenedor; Nginx, si existe, debe ser el único componente que lo exponga mediante HTTPS.

| Control sobre el commit | Resultado |
| --- | --- |
| `npm ci` con npm 10.8.2 | PASS |
| Prisma validate/generate y 9 migraciones en PostgreSQL desechable | PASS |
| `npm run build` | PASS |
| ESLint global sin `--fix` | PASS, 0 errores y 0 advertencias |
| Unitarias | PASS, 30 suites / 287 pruebas |
| E2E incluido bootstrap de `AppModule` | PASS, 2 suites / 12 pruebas |
| Integración PostgreSQL y BullMQ | PASS, 2 suites / 2 pruebas |
| Escaneo de secretos | PASS, 224 archivos |
| Imagen Node 20 y `GET /api/docs` | PASS, HTTP 200 |

La E2E de bootstrap sustituye las cinco colas BullMQ y usa Redis sintético inalcanzable. Por ello detecta faltas de DI sin conectarse a Redis de la VPS ni dejar reintentos abiertos.

## 2. Riesgos de seguridad pendientes

El proyecto es funcionalmente válido en local, pero no está libre de riesgo. `npm audit` reporta **8 vulnerabilidades altas**, sin críticas ni moderadas. La imagen de producción creada con `npm ci --omit=dev` conserva 7 altas.

| Riesgo | Impacto | Resolución correcta |
| --- | --- | --- |
| Multer transitivo de NestJS 11 | Posible DoS en endpoints multipart públicos | Migrar y probar NestJS 12 |
| Core, platform-express, BullMQ, Swagger y event-emitter | Hallazgos propagados por la familia NestJS | Actualización coordinada a NestJS 12 |
| Dependencias de desarrollo | No forman parte de la imagen de producción | Mantener lockfile en una tarea separada |

La actualización compatible ya redujo el resultado de 15 a 8 hallazgos y alineó `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express` y `@nestjs/testing` en 11.2.5. La corrección restante requiere NestJS 12; debe hacerse en una rama exclusiva con pruebas de auth, webhooks, multipart, BullMQ y rollback.

No usar `npm audit fix --force`, no actualizar NestJS 11 a 12 de improviso y no añadir endpoints multipart públicos sin aplicar límites de tamaño, rate limiting y timeouts en el proxy.

## 3. Archivos externos a Git

Crear los siguientes archivos protegidos en la VPS. Las rutas pueden cambiar; los permisos no deben relajarse.

```text
/etc/hermes-crm/                 root:root 0700
/etc/hermes-crm/compose.env      root:root 0600
/etc/hermes-crm/backend.env      root:root 0600
/etc/hermes-crm/postgres.env     root:root 0600
/etc/hermes-crm/n8n.env          root:root 0600
/etc/hermes-agent-client/api-key root:root 0600
```

`compose.env` contiene rutas e imágenes, no secretos:

```dotenv
HERMES_BACKEND_ENV_FILE=/etc/hermes-crm/backend.env
POSTGRES_ENV_FILE=/etc/hermes-crm/postgres.env
N8N_ENV_FILE=/etc/hermes-crm/n8n.env
N8N_IMAGE=n8nio/n8n@sha256:<digest-verificado-en-la-vps>
```

No usar `n8nio/n8n:latest`. Antes de recrear n8n, identificar el digest en uso, preservar `hermes_n8n_data` y mantener la misma `N8N_ENCRYPTION_KEY`. Una clave nueva sobre datos existentes puede impedir descifrar workflows y credenciales.

`/etc/hermes-agent-client/api-key` se monta como Docker secret en `/run/secrets/nous_hermes_api_key`. No duplicar su contenido en `backend.env`.

### `postgres.env`

```dotenv
POSTGRES_USER=<usuario-existente>
POSTGRES_PASSWORD=<contraseña-existente-o-rotada-coordinadamente>
POSTGRES_DB=<base-existente>
```

Cambiar sólo `POSTGRES_PASSWORD` no cambia un rol dentro de un volumen PostgreSQL ya inicializado. Para rotar hay que ejecutar `ALTER ROLE ... PASSWORD ...`, actualizar `DATABASE_URL` de forma coordinada y comprobar la conexión antes de retirar el secreto anterior.

### `backend.env`

Usar `.env.example` como catálogo completo de nombres y no copiar valores de ejemplo.

| Categoría | Variables relevantes | Regla |
| --- | --- | --- |
| Runtime/BD | `NODE_ENV`, `PORT`, `DATABASE_URL`, `REDIS_URL` | `NODE_ENV=production`; dentro de Compose usar `postgres` y `redis`, nunca `localhost` |
| Sesión/CRM | `JWT_SECRET`, `CRM_HERMES_PROOF_SECRET`, `CRM_OPERATOR_EMAIL`, `CRM_BASE_URL`, `CORS_ORIGINS` | Secretos únicos y CORS sólo a orígenes HTTPS reales |
| Meta | `META_PHONE_NUMBER_ID`, `META_ACCESS_TOKEN`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `META_API_VERSION`, `META_WABA_ID` | Mantener valores operativos sin imprimirlos |
| Gemini | `HERMES_API_URL`, `HERMES_API_KEY`, `HERMES_MODEL`, límites `HERMES_*` | Confirmar modelo y cuota antes de tráfico real |
| Nous | `HERMES_CONVERSATION_ENGINE`, `NOUS_HERMES_CONVERSATION_ALLOWLIST`, `NOUS_HERMES_CHAT_COMPLETIONS_URL`, `NOUS_HERMES_API_KEY_FILE`, `NOUS_HERMES_*` | Estado validado: `gemini_direct`, allowlist vacía; activar sólo con prueba explícita |
| Guardas | `AI_GUARD_FAIL_CLOSED`, límites `AI_*`, `SPAM_COOLDOWN_SECONDS` | Conservar fail-closed y límites actuales |
| Campañas | `CAMPAIGNS_ENABLED`, `CAMPAIGN_SEND_RATE_PER_SECOND`, `CAMPAIGN_MEDIA_ALLOWED_HOSTS` | No habilitar envíos masivos en el primer arranque |
| n8n | `N8N_INTEGRATION_ENABLED`, `N8N_BASE_URL`, `N8N_HMAC_SECRET`, `N8N_*` | HMAC idéntico en backend y n8n |
| Publicidad | `AD_ATTRIBUTION_*`, `GOOGLE_*`, `ADVERTISING_GOOGLE_*` | Mantener flags de envío/sync apagados salvo prueba autorizada |
| Admin | `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | Provisionar fuera de logs; no duplicar usuarios existentes |

Si se activa Nous, `NOUS_HERMES_API_KEY_FILE` debe apuntar a `/run/secrets/nous_hermes_api_key`, nunca a una ruta de host ni a un archivo versionado.

### `n8n.env`

Conservar las variables compatibles con la imagen n8n realmente usada, incluido `N8N_HMAC_SECRET`. Mantener `N8N_ENCRYPTION_KEY` en su ubicación y valor actuales. Si esto no se puede identificar sin riesgo, detener el despliegue y ensayar una restauración aislada primero.

## 4. Prerrequisitos

1. Confirmar que el checkout contiene `8da7d06` o un commit posterior revisado.
2. Registrar imágenes/digests, estado de contenedores, discos y volúmenes.
3. Crear dump PostgreSQL recuperable, checksums y restauración aislada con `ON_ERROR_STOP=1`.
4. Respaldar el estado de n8n antes de recrearlo o rotar secretos.
5. Registrar commit y digest de imagen previos para rollback.
6. Preparar una ventana de observación de reinicios, CPU, RAM y logs.

```bash
git rev-parse HEAD
docker compose ps
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
docker inspect hermes-n8n --format '{{.Image}}'
docker volume ls
df -h
free -h
```

No imprimir `DATABASE_URL`, tokens Meta, claves Gemini, JWT, HMAC ni el contenido de `api-key`.

## 5. Procedimiento de despliegue

### A. Validar checkout y Compose

```bash
cd <ruta-repositorio>/hermes-backend
git status --short
git rev-parse HEAD
git show --no-patch --format=fuller 8da7d06
docker compose --env-file /etc/hermes-crm/compose.env config --quiet
```

La configuración renderizada debe cumplir: `app` en `127.0.0.1:3003:3003`; PostgreSQL, Redis y n8n en loopback; `hermes_client_api` externa sólo usada por `app`; ningún puerto 8642 publicado; `N8N_IMAGE` fijada por digest.

### B. Reproducir los controles locales

```bash
npm ci
npx prisma validate
npx prisma generate
npm run build
npx eslint "{src,apps,libs,test}/**/*.ts"
npm run security:secrets
```

El Dockerfile usa Node 20 y `npm ci --omit=dev`; el lockfile fue validado con npm 10.8.2. Si un control falla, no recrear servicios: corregir el checkout o volver al commit anterior.

### C. Aplicar migraciones explícitamente

Después de verificar los respaldos y sólo desde una sesión autorizada:

```bash
set -a
. /etc/hermes-crm/backend.env
set +a
npx prisma migrate deploy
```

La migración más reciente es `20260921170000_automated_delivery_ledger`. Si Prisma solicita una operación destructiva inesperada, detenerse. `migrate deploy` no debe convertirse en pérdida de datos planificada.

### D. Construir y recrear sólo el backend

```bash
docker compose --env-file /etc/hermes-crm/compose.env build app
docker compose --env-file /etc/hermes-crm/compose.env up -d --no-deps app
docker compose --env-file /etc/hermes-crm/compose.env ps app
docker logs --tail 200 hermes-app
```

`--no-deps` evita recrear PostgreSQL, Redis y n8n. No ejecutar `docker compose down -v` y no borrar `hermes_pgdata`, `hermes_redis_data` ni `hermes_n8n_data`.

## 6. Verificación posterior

```bash
curl --fail --silent --show-error http://127.0.0.1:3003/api/docs >/dev/null
docker inspect hermes-app --format '{{.State.Status}} {{.State.RestartCount}}'
docker compose --env-file /etc/hermes-crm/compose.env ps
ss -lntp | grep -E '(:3003|:5432|:6379|:5678|:8642)'
```

| Área | Criterio de aceptación |
| --- | --- |
| Backend | `/api/docs` devuelve 200 desde loopback y `hermes-app` no reinicia |
| Red | 3003, 5432, 6379 y 5678 sólo en `127.0.0.1`; 8642 no publicado |
| Datos | Sin Prisma P2021/P1001 ni migraciones pendientes |
| Colas | Sin bucles Redis ni trabajos inesperados al arrancar |
| n8n | Workflows y credenciales disponibles; volumen y encryption key intactos |
| Integraciones | Probar un evento ficticio Meta/n8n autorizado, sin campañas masivas |
| Nginx | Proxy HTTPS a `127.0.0.1:3003`, sin puertos Docker adicionales |
| Logs | No aparecen secretos en backend, Docker, proxy ni shell |

Si se activa Nous en el futuro, validar primero health privado, Bearer, límite de concurrencia y fallo de Gemini; nunca publicar 8642 al host.

## 7. Rollback

Usar rollback si falla `/api/docs`, el backend no inicia, aumenta el contador de reinicios, hay errores de BD/Redis o falla una integración esencial.

1. No borrar volúmenes ni secretos.
2. Volver al commit y digest registrados antes de la ventana.
3. Reconstruir y recrear sólo `app` con `--no-deps`.
4. Verificar `/api/docs` desde loopback y los logs.
5. Si ya hubo migración, no ejecutar SQL inverso bajo presión; restaurar sólo con backup probado y aprobado.
6. Conservar secreto anterior y nuevo hasta que el sistema se estabilice.

```bash
git checkout <commit-anterior-verificado>
docker compose --env-file /etc/hermes-crm/compose.env build app
docker compose --env-file /etc/hermes-crm/compose.env up -d --no-deps app
curl --fail http://127.0.0.1:3003/api/docs >/dev/null
```

Usar un tag/release de rollback en operación continua, no una referencia ambigua.

## Referencias

- `docs/security-preflight-2026-09-21.md`: preflight histórico; sus cifras de lint y auditoría fueron sustituidas por este documento.
- `../../ProyectMD/vps-preflight.md`: evidencia y restricciones VPS anteriores.
- `../../ProyectMD/hermes-agent-vps-handoff.md`: contrato privado del agente Nous Hermes.
- `.env.example`: catálogo de variables; nunca debe contener valores operativos.
