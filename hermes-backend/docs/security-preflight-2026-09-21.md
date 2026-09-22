# Preflight de secretos y dependencias

Fecha: 2026-09-21. Base: `058874eedc53b4a423ef9f68e646844437088b56`.

Este cambio prepara el repositorio. No accede a la VPS, no rota credenciales,
no despliega y no modifica `N8N_ENCRYPTION_KEY`.

## Auditoría de secretos versionados

No se reproducen valores en este informe.

| Ubicación en la base                   | Variable o parámetro                         | Consumidor         | Tipo                        | Acción requerida                                                                                                               |
| -------------------------------------- | -------------------------------------------- | ------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `hermes-backend/docker-compose.yml:34` | `POSTGRES_USER`                              | PostgreSQL 16      | Identificador de credencial | Retirado del Compose; provisionar junto con la contraseña en el archivo externo PostgreSQL.                                    |
| `hermes-backend/docker-compose.yml:35` | `POSTGRES_PASSWORD`                          | PostgreSQL 16      | Contraseña activa           | Retirada del Compose; provisionar en el archivo externo PostgreSQL y rotar coordinadamente en la VPS.                          |
| `hermes-backend/docker-compose.yml:75` | `N8N_BASIC_AUTH_USER`                        | n8n fijado por VPS | Identificador de credencial | Retirado del Compose; conservar/provisionar en el archivo externo n8n según la versión realmente desplegada.                   |
| `hermes-backend/docker-compose.yml:76` | `N8N_BASIC_AUTH_PASSWORD`                    | n8n fijado por VPS | Contraseña activa           | Retirada del Compose; rotar en la VPS después de fijar y verificar la imagen existente.                                        |
| `hermes-backend/docker-compose.yml:86` | `N8N_HMAC_SECRET`                            | n8n y backend      | Secreto HMAC compartido     | El valor no estaba literal, pero ahora ambos consumidores lo reciben desde archivos externos separados; rotar coordinadamente. |
| `hermes-backend/.env.example`          | variables `*_SECRET`, `*_TOKEN`, `*_API_KEY` | Backend            | Placeholders                | Mantener sólo ejemplos ficticios; los valores reales van en `/etc/hermes-crm/backend.env`.                                     |
| `ProyectMD/estado-proyecto.md:496-529` | URL PostgreSQL y variables sensibles         | Documentación      | Placeholders                | No son credenciales operativas; mantener los marcadores ficticios y no sustituirlos por valores reales.                        |
| specs TypeScript                       | claves/tokens de fixture                     | Jest               | Datos de prueba             | No son credenciales operativas; conservar formatos obviamente ficticios y mantener el escáner de formas de token conocidas.    |

El escaneo de archivos versionados no encontró claves privadas ni tokens con
forma de Meta, Google o Bearer reales. Las rutas `*_FILE` y los nombres de
variables no son secretos. Las credenciales que alguna vez estuvieron en Git se
consideran expuestas aunque ya no aparezcan en `HEAD`; no se reescribe el
historial automáticamente.

## Mecanismo implementado

Compose exige un archivo de interpolación externo que contiene únicamente
rutas y la imagen n8n fijada:

```text
/etc/hermes-crm/compose.env       root:root 0600
/etc/hermes-crm/backend.env       root:root 0600
/etc/hermes-crm/postgres.env      root:root 0600
/etc/hermes-crm/n8n.env           root:root 0600
```

Mapeo:

| Servicio       | Entrada                                | Contenido                                                                                                       |
| -------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Backend NestJS | `HERMES_BACKEND_ENV_FILE` → `env_file` | `DATABASE_URL`, `REDIS_URL`, credenciales Meta/Gemini, JWT, HMAC n8n y demás configuración privada del backend. |
| PostgreSQL     | `POSTGRES_ENV_FILE` → `env_file`       | `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`. La imagen oficial los consume directamente.                |
| n8n            | `N8N_ENV_FILE` → `env_file`            | Credenciales compatibles con la versión fijada y `N8N_HMAC_SECRET`.                                             |
| Compose        | `/etc/hermes-crm/compose.env`          | Las tres rutas anteriores y `N8N_IMAGE` con digest exacto. No contiene los valores secretos de servicio.        |
| Nous           | Docker secret existente                | `/etc/hermes-agent-client/api-key` montado como `/run/secrets/nous_hermes_api_key`.                             |

No se usó `*_FILE` indiscriminadamente. PostgreSQL 16.14 sí soporta de forma
nativa `POSTGRES_PASSWORD_FILE`, pero los archivos `env_file` son compatibles
con el contenedor existente y evitan un wrapper adicional. El backend/Prisma
requiere `DATABASE_URL`. El HMAC de n8n es una variable personalizada usada por
workflows y no está garantizado que el cargador genérico `_FILE` de n8n la
importe, por lo que n8n recibe variables normales desde su archivo externo.

Los ejemplos ficticios están en `deploy/*.env.example`. Los archivos reales,
directorios `secrets/`, claves, certificados y backups están ignorados por Git.
`npm run security:secrets` revisa archivos versionados y nuevos no ignorados sin
mostrar valores.

## n8n y preservación de datos cifrados

La clave expuesta en el Compose era `N8N_BASIC_AUTH_PASSWORD`; no era una
contraseña PostgreSQL, el HMAC ni `N8N_ENCRYPTION_KEY`.

La etiqueta local `n8nio/n8n:latest`, consultada únicamente para verificación,
resolvió a n8n `2.39.10`, digest
`sha256:94d70bcbc868123de206d6f89786bb90f753c26b8f28889f8ddc5e224b230247`.
Esa versión ya no contiene las variables `N8N_BASIC_AUTH_*`. Esto no demuestra
qué imagen corre en la VPS y hace inseguro recrear producción con `latest`.
Compose ahora exige que Codex VPS configure `N8N_IMAGE` con el digest de la
imagen que ya está ejecutando antes de cualquier recreación.

`N8N_ENCRYPTION_KEY` no aparece en archivos versionados. No se genera ni se
sustituye. El volumen `hermes_n8n_data` debe conservarse. Antes de externalizar
esa clave en el futuro se debe:

1. obtener de forma segura la clave efectiva del contenedor/volumen actual sin
   imprimirla;
2. crear y verificar un backup restaurable del volumen y base de n8n;
3. arrancar una restauración aislada con exactamente la misma clave;
4. comprobar que credenciales y workflows se descifran;
5. sólo entonces fijar la clave existente en el archivo externo.

Una clave nueva sobre datos cifrados existentes provoca pérdida de acceso a las
credenciales de n8n.

## Procedimiento VPS sin valores

1. Detener el cambio si no se puede identificar el digest, versión y variables
   efectivas del contenedor n8n actual.
2. Crear un backup verificable de PostgreSQL y del volumen `hermes_n8n_data`.
3. Crear `/etc/hermes-crm` como `root:root 0700` y los cuatro archivos como
   `root:root 0600`, partiendo de los ejemplos sin copiarlos dentro de Git.
4. En `compose.env`, fijar rutas absolutas y el digest actual de n8n.
5. Copiar la configuración backend actual a `backend.env`; no inventar valores.
6. Copiar los parámetros PostgreSQL efectivos a `postgres.env` y los de n8n a
   `n8n.env`. Mantener `N8N_ENCRYPTION_KEY` sin cambios y en su ubicación actual.
7. Validar estructura sin revelar variables:

   ```bash
   docker compose --env-file /etc/hermes-crm/compose.env config --quiet
   ```

8. Rotar PostgreSQL en una ventana coordinada: preparar el nuevo
   `DATABASE_URL`, ejecutar `ALTER ROLE ... PASSWORD ...` mediante una sesión
   administrativa sin registrar el valor, actualizar `postgres.env`, reiniciar
   sólo `app` y verificar conexiones. Cambiar `POSTGRES_PASSWORD` sin `ALTER
ROLE` no modifica un volumen ya inicializado.
9. Rotar basic auth de n8n sólo si la imagen fijada todavía consume esas
   variables. Recrear únicamente n8n y comprobar login y workflows. Si la
   versión usa user management, documentar su mecanismo real y retirar las
   variables obsoletas en vez de confiar en ellas.
10. Rotar `N8N_HMAC_SECRET` simultáneamente en `backend.env` y `n8n.env`; durante
    la diferencia de valores los eventos fallarán autenticación.
11. Mantener disponibles los secretos anteriores para rollback controlado hasta
    completar las verificaciones. No borrar volúmenes.

## Auditoría de dependencias

`npm audit --json` sobre el lockfile reportó 15 paquetes afectados: 13 high, 2
moderate, 0 critical. No se ejecutó `npm audit fix` ni se cambió el lockfile.

| Paquete                    | Relación / entorno     | Severidad | Explotabilidad en Hermes                                                                                                                  | Corrección disponible                                      |
| -------------------------- | ---------------------- | --------: | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `@nestjs/bullmq`           | Directa, producción    |      High | Hallazgo propagado desde Nest core/platform; no es una vulnerabilidad BullMQ independiente.                                               | npm propone 12.0.0, major.                                 |
| `@nestjs/bull-shared`      | Transitiva, producción |      High | Propagado desde Nest core/platform.                                                                                                       | Serie 12; requiere migración coordinada.                   |
| `@nestjs/core`             | Directa, producción    |      High | Propagado por `platform-express`/Multer; relevante porque hay HTTP público.                                                               | npm propone 12.0.4, major.                                 |
| `@nestjs/event-emitter`    | Directa, producción    |      High | Propagado desde Nest core; no recibe multipart directamente.                                                                              | npm propone 12.0.1, major.                                 |
| `@nestjs/platform-express` | Directa, producción    |      High | Relevante: incluye una copia vulnerable de Multer.                                                                                        | npm propone 12.0.4, major.                                 |
| `@nestjs/swagger`          | Directa, producción    |      High | Propagado desde Nest core; exposición contextual baja si Swagger no procesa entrada multipart.                                            | npm propone 12.0.1, major.                                 |
| `@nestjs/testing`          | Directa, desarrollo    |      High | No está en la imagen de producción (`npm ci --omit=dev`).                                                                                 | npm propone 12.0.4, major.                                 |
| `baseline-browser-mapping` | Transitiva, desarrollo |  Moderate | Herramienta de build; sin entrada remota en runtime.                                                                                      | ≥2.11.0; dry-run elegiría 2.11.25.                         |
| `brace-expansion`          | Transitiva, desarrollo |      High | CLI/build con patrones controlados por el repositorio; no runtime.                                                                        | ≥1.1.18, ≥2.1.4 y ≥5.0.9 según la rama.                    |
| `browserslist`             | Transitiva, desarrollo |      High | Build; no consulta stats aportados por clientes en producción.                                                                            | ≥4.28.7; dry-run elegiría 4.29.0.                          |
| `fast-uri`                 | Transitiva, desarrollo |      High | Usada por tooling/validación; no se identificó ruta SSRF directa en runtime.                                                              | ≥3.1.6; dry-run elegiría 3.1.8.                            |
| `js-yaml`                  | Transitiva, desarrollo |      High | Las copias vulnerables 3.15.0 y 4.3.0 sólo pertenecen al tooling; la copia 5.2.2 de producción no está afectada.                          | 3.x ≥3.15.2; 4.x ≥4.3.2.                                   |
| `multer`                   | Transitiva, producción |      High | Explotable como DoS en endpoints multipart; la copia anidada 2.2.0 de Nest está afectada. La dependencia directa 2.3.0 ya está corregida. | ≥2.3.0; npm sólo resuelve toda la cadena migrando Nest 12. |
| `nestjs-cls`               | Directa, producción    |      High | Hallazgo propagado desde Nest core.                                                                                                       | ≥6.3.0; dry-run elegiría 6.3.1.                            |
| `qs`                       | Transitiva, producción |  Moderate | Posible DoS mediante query parsing en endpoints públicos.                                                                                 | ≥6.16.0.                                                   |

Los 15 paquetes agregan 22 advisories. El riesgo prioritario es la copia Multer
2.2.0 alcanzable por cargas multipart y, después, `qs`. Una actualización mayor
Nest 11 → 12 no se mezcla con la rotación de credenciales; requiere rama,
pruebas de uploads, auth, webhooks, E2E y rollback propios. Las correcciones
transitivas de desarrollo pueden evaluarse por separado con un lockfile limpio.

## Lint

Comando ejecutado sin `--fix`:

```text
npx eslint "{src,apps,libs,test}/**/*.ts"
```

Resultado: exit code 1, 129 errores y 4 advertencias en 23 archivos. El cambio
de saneamiento no modifica ningún archivo TypeScript respecto de
`058874eedc53b4a423ef9f68e646844437088b56`; por tanto, los 133 hallazgos son
deuda heredada y no hay regresiones de lint introducidas por este trabajo.

| Regla                                        | Severidad   | Cantidad |
| -------------------------------------------- | ----------- | -------: |
| `@typescript-eslint/no-unsafe-member-access` | Error       |       52 |
| `@typescript-eslint/no-unsafe-assignment`    | Error       |       46 |
| `@typescript-eslint/no-unsafe-call`          | Error       |       10 |
| `prettier/prettier`                          | Error       |       10 |
| `@typescript-eslint/no-unused-vars`          | Error       |        5 |
| `@typescript-eslint/no-unsafe-argument`      | Advertencia |        4 |
| `@typescript-eslint/unbound-method`          | Error       |        2 |
| `@typescript-eslint/no-unsafe-return`        | Error       |        2 |
| `@typescript-eslint/require-await`           | Error       |        1 |
| `@typescript-eslint/no-base-to-string`       | Error       |        1 |

| Archivo                                                     | Errores | Advertencias | Reglas (cantidad)                                                                                                              |
| ----------------------------------------------------------- | ------: | -----------: | ------------------------------------------------------------------------------------------------------------------------------ |
| `src/auth/auth.service.spec.ts`                             |       2 |            0 | `@typescript-eslint/no-unsafe-assignment` E×2                                                                                  |
| `src/auth/auth.service.ts`                                  |       2 |            0 | `@typescript-eslint/no-unsafe-assignment` E×2                                                                                  |
| `src/auto-replies/whatsapp-message-splitter.ts`             |       1 |            0 | `prettier/prettier` E×1                                                                                                        |
| `src/campaigns/campaigns.service.spec.ts`                   |      43 |            4 | `@typescript-eslint/no-unsafe-argument` W×4; `no-unsafe-assignment` E×19; `no-unsafe-call` E×8; `no-unsafe-member-access` E×16 |
| `src/common/decorators/current-user.decorator.ts`           |       6 |            0 | `@typescript-eslint/no-unsafe-assignment` E×2; `no-unsafe-member-access` E×2; `no-unsafe-return` E×2                           |
| `src/common/guards/roles.guard.ts`                          |       2 |            0 | `@typescript-eslint/no-unsafe-assignment` E×1; `no-unsafe-member-access` E×1                                                   |
| `src/common/interceptors/logging.interceptor.ts`            |       5 |            0 | `@typescript-eslint/no-unsafe-assignment` E×4; `no-unsafe-member-access` E×1                                                   |
| `src/conversation-guard/conversation-guard.service.spec.ts` |       2 |            0 | `@typescript-eslint/no-unsafe-call` E×1; `no-unsafe-member-access` E×1                                                         |
| `src/conversation-guard/conversation-guard.service.ts`      |       3 |            0 | `prettier/prettier` E×3                                                                                                        |
| `src/conversations/dto/create-conversation.dto.ts`          |       2 |            0 | `@typescript-eslint/no-unused-vars` E×2                                                                                        |
| `src/hermes/commercial-catalog.spec.ts`                     |       1 |            0 | `prettier/prettier` E×1                                                                                                        |
| `src/hermes/commercial-catalog.ts`                          |       5 |            0 | `prettier/prettier` E×5                                                                                                        |
| `src/hermes/commercial-policy.service.spec.ts`              |       1 |            0 | `@typescript-eslint/no-unused-vars` E×1                                                                                        |
| `src/hermes/hermes.service.spec.ts`                         |      21 |            0 | `@typescript-eslint/no-unsafe-assignment` E×4; `no-unsafe-call` E×1; `no-unsafe-member-access` E×16                            |
| `src/hermes/hermes-diagnostics.ts`                          |       1 |            0 | `@typescript-eslint/no-base-to-string` E×1                                                                                     |
| `src/integrations/n8n/n8n.dispatcher.ts`                    |       1 |            0 | `@typescript-eslint/no-unsafe-member-access` E×1                                                                               |
| `src/knowledge/knowledge.service.ts`                        |       8 |            0 | `@typescript-eslint/no-unsafe-assignment` E×4; `no-unsafe-member-access` E×4                                                   |
| `src/playbooks/playbooks.service.ts`                        |       3 |            0 | `@typescript-eslint/no-unsafe-assignment` E×1; `no-unsafe-member-access` E×2                                                   |
| `src/price-lists/price-lists.service.ts`                    |       3 |            0 | `@typescript-eslint/no-unsafe-assignment` E×1; `no-unsafe-member-access` E×2                                                   |
| `src/products/dto/create-product.dto.ts`                    |       1 |            0 | `@typescript-eslint/no-unused-vars` E×1                                                                                        |
| `src/products/products.service.ts`                          |       4 |            0 | `@typescript-eslint/no-unsafe-assignment` E×2; `no-unsafe-member-access` E×2                                                   |
| `src/tasks/tasks.service.spec.ts`                           |       8 |            0 | `@typescript-eslint/no-unsafe-assignment` E×4; `no-unsafe-member-access` E×2; `unbound-method` E×2                             |
| `src/webhook/webhook.controller.ts`                         |       4 |            0 | `@typescript-eslint/no-unsafe-member-access` E×2; `no-unused-vars` E×1; `require-await` E×1                                    |

## Validación local

Todas las pruebas que requieren infraestructura usaron contenedores locales
desechables. Al terminar no quedó ningún contenedor ni volumen de prueba y no
se accedió a la VPS.

| Verificación                     | Comando / alcance                                                                                      | Resultado exacto                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Prisma                           | `npx prisma validate`                                                                                  | Exit 0; `prisma/schema.prisma` válido.                                                                                       |
| Unitarias                        | `npm test -- --runInBand`                                                                              | Exit 0; 29/29 suites y 285/285 pruebas.                                                                                      |
| E2E                              | `npm run test:e2e -- --runInBand`                                                                      | Exit 0; 1/1 suite y 11/11 pruebas.                                                                                           |
| Integración                      | PostgreSQL 16 Alpine + Redis 7 Alpine desechables; `prisma migrate deploy`; `npm run test:integration` | Exit 0; 9 migraciones aplicadas; 2/2 suites y 2/2 pruebas; contenedores eliminados.                                          |
| Build                            | `npm run build`                                                                                        | Exit 0.                                                                                                                      |
| Build limpio del contenedor      | `docker build --target builder ...`                                                                    | Exit 0; `npm ci` instaló 795 paquetes desde el lockfile, Prisma generó el cliente y Nest compiló; imagen temporal eliminada. |
| Docker Compose                   | `docker compose --env-file deploy/compose.env.example config --quiet` con rutas a ejemplos locales     | Exit 0; se utilizó sólo para validar estructura, con la imagen n8n local fijada por digest.                                  |
| Lint de archivo ejecutable nuevo | `npx eslint scripts/check-secrets.mjs`                                                                 | Exit 0; ningún archivo TypeScript fue modificado.                                                                            |
| Formato de archivos modificados  | `npx prettier --check ...`                                                                             | Exit 0; todos los archivos aplicables cumplen el formato.                                                                    |
| Escáner de secretos              | `npm run security:secrets`                                                                             | Exit 0 en el árbol saneado; la prueba negativa controlada detectó 1/1 literal ficticio sin mostrar su valor.                 |
| Auditoría npm                    | `npm audit --json`                                                                                     | Exit 1 esperado por hallazgos: 15 paquetes, 13 high, 2 moderate, 0 critical; lockfile sin cambios.                           |
| Lint global                      | `npx eslint "{src,apps,libs,test}/**/*.ts"`                                                            | Exit 1 por deuda heredada: 129 errores y 4 advertencias en 23 archivos; detalle por regla y archivo en este documento.       |
| Puerta conversacional            | Ejemplo y valores por defecto en código                                                                | `HERMES_CONVERSATION_ENGINE=gemini_direct`; `NOUS_HERMES_CONVERSATION_ALLOWLIST=`.                                           |
