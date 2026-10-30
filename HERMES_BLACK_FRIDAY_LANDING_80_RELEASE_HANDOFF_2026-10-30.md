# Hermes 2.0 — handoff de release Black Friday Landing Page USD $80

Fecha: 30 de octubre de 2026. Destinatario: Codex VPS y operador de release. **Dictamen local: `READY_FOR_VPS_DEPLOY`**, sujeto a los controles de preflight que se indican abajo. Este documento prepara el despliegue; no registra un despliegue, una migración productiva ni la activación comercial.

## 1. Identidad inmutable y procedencia

| Elemento | Valor verificado |
|---|---|
| Rama autorizada para publicar backend | `pilot/a7-d12-monitor-only-20261026` |
| HEAD remoto piloto y commit fuente | `fa537a90aeecda0efce1d3248354bc2dd647cbda` |
| Tree Git fuente | `5750f411270112e41e65a049f651b1a58402daba` |
| Base piloto previa | `1fa0e13ba46e72949797c283fab554d93d1aa1d3` |
| Promoción de código | Fast-forward remoto `1fa0e13..fa537a9`, sin force push; `main` backend no se modificó |
| Delta de campaña sobre el piloto | `4a4e39d` y `fa537a9`; 12 archivos, 875 inserciones y 24 eliminaciones |
| Imagen para uso por digest | `ghcr.io/undercodeec/hermes-backend@sha256:db399bba2886bd25c9b9730e08c79ae0223c90286e64b52cb7c65e87bd414be6` |
| Manifiesto linux/amd64 | `sha256:e3eba3d8516a24ddac8abf1fc4c03917e86976efd5d8d152f60bf2ae5b4805d1` |
| GitHub Actions | [Run 41062257744](https://github.com/undercodeec/hermes_n8n/actions/runs/41062257744), `success` |
| Workflow | `hermes-backend-ghcr-manual.yml`, despachado desde `main`; el job exigió que el SHA solicitado coincidiera con el HEAD remoto del piloto y verificó el tree del checkout |

La etiqueta del run fue `fa537a90aeecda0efce1d3248354bc2dd647cbda-run41062257744-attempt1`; **usar el digest, no la etiqueta**, para el despliegue. El índice GHCR es accesible desde el entorno local. El job hizo pull de `linux/amd64` y comprobó que `org.opencontainers.image.revision` era el commit fuente. Una lectura independiente del config OCI confirmó `linux/amd64` y esa revisión.

El Dockerfile copia `/app/prisma` al runtime. Se descargó de GHCR la capa `sha256:53dddb01798cbb9d8520e552c9ba2a382e678a507472ac776ca780295915e5c2`, se validó su SHA-256 y se comprobó que contiene `app/prisma/migrations/20261029200000_black_friday_landing_80/migration.sql`. El SQL dentro de la capa es idéntico byte a byte al blob Git fuente (SHA-256 `2b288a687318bc5c00bb96aff8f186b9fe5a9f5e0312a0974e9e4cb202b5f4ae`).

## 2. Compatibilidad y resultados locales

El último backend servido **según el corte documental de 29/10**, no revalidado ahora en VPS, es `e673417b9f2fa959959c5e0a75fad1d08d006388`, imagen `ghcr.io/undercodeec/hermes-backend@sha256:92c3f81e8369b8b02f102585a9554ed3d1115b7889b0f411ae8836cd1acb5c7f`. Ese commit es ancestro del nuevo candidato. Entre ambos están Audio Inbox, fallback humanizado de audio y la campaña. El rollback documentado para A7-D21 era `sha256:9e7235982087841d505386bef3d9b13e6ce86c0520211f8d5df78fe29e44ec2e`; **Codex VPS debe identificar y conservar el digest realmente servido al iniciar la ventana**, aunque difiera del corte documental.

- Suite backend: **101 suites, 1619 pruebas aprobadas**, con mocks y datos sintéticos.
- `npm run build`, ESLint dirigido a los nueve archivos TypeScript afectados, `npx prisma validate` y `git diff --check`: aprobados.
- Pruebas comerciales: consulta general y precio, diez prestaciones, consultas puntuales, tienda online, inactividad, plan ordinario, audio transcrito, nombre disponible o no, plazo sin fuente, impuestos y ausencia de duplicación en el flujo probado.
- No se ejecutó un modelo Nous real ni WhatsApp real. No afirmar que el texto final en producción ya fue validado.
- No hay cambios a `prisma/schema.prisma` ni a `.env.example` respecto al backend servido documentado; **no se requieren variables nuevas** para esta campaña. F3/F4 siguen desactivados en el código publicado.

## 3. Migración y ensayo aislado

`20261029200000_black_friday_landing_80` es **solo de datos**: usa `INSERT ... SELECT` sobre `price_lists`; no cambia tablas ni columnas. Selecciona la tarifa base `commercial-price-landing-basic-global-v1` con mercado global y `isPromotion=false`. Crea `commercial-price-landing-black-friday-80-global-v1` para el mismo producto, precio `80.00` USD, `isPromotion=true`, `supersedesPriceListId` hacia la base, `isActive=false` y `validUntil=NULL`. El `scope` contiene las diez prestaciones confirmadas. `ON CONFLICT ("id") DO NOTHING` hace idempotente la repetición del SQL para esa ID; no modifica una fila preexistente.

En PostgreSQL 18 **temporal y aislado en Windows**, `npx prisma migrate deploy` aplicó las 27 migraciones del candidato desde cero. La consulta posterior encontró la tarifa base y exactamente una promocional, con USD 80, inactiva, sin caducidad y con la referencia correcta. Reejecutar el SQL devolvió `INSERT 0 0` y dejó una única fila con el estado seguro. Se detuvo el servidor temporal. Esta prueba no sustituye la comprobación en PostgreSQL productivo 16 ni prueba las respuestas de un modelo real.

**Riesgo principal:** si falta la tarifa base, el `INSERT ... SELECT` inserta cero filas y Prisma puede marcar la migración como completada. `migrate deploy` entonces no la repetirá. Por eso los controles de existencia **antes y después** son obligatorios. Si falta la base antes, detener el release. Si falta la nueva fila después de una migración marcada como exitosa, detener backend/activación y preparar una migración correctiva revisada; no usar `migrate resolve` ni crear manualmente una tarifa comercial sin aprobación.

## 4. Preflight obligatorio para Codex VPS

Ejecutar en la VPS únicamente mediante el procedimiento de release autorizado, con una ventana, respaldo y rollback comprobados. Este documento no autoriza acceso SSH desde Codex Local. Antes de tocar servicios:

1. Registrar commit e imagen **realmente servidos**, salud de app/PostgreSQL/Redis/n8n, estado de migraciones y backup/restauración disponibles. Si la línea servida no es ancestro compatible de `fa537a9`, reconciliar y detener este procedimiento.
2. Confirmar que el digest nuevo se puede descargar con las credenciales GHCR existentes. Fijarlo en el override de imagen del release; validar el Compose renderizado y que solo `app` cambiará. Mantener el digest anterior para rollback.
3. Confirmar que las migraciones previas del repositorio están aplicadas y que la única pendiente prevista es `20261029200000_black_friday_landing_80`. Un estado diferente requiere análisis antes de continuar. La fotografía del 29/10 reportaba 26 migraciones en producción; no asumir que sigue vigente.
4. **Antes de `migrate deploy`**, consultar la base por su conexión autorizada y exigir exactamente una tarifa base global `commercial-price-landing-basic-global-v1`, asociada a `LANDING_PAGE` y `isPromotion=false`. Si la tarifa nueva ya existe, exigir que siga inactiva y revisar su contenido antes de continuar. No imprimir secretos ni URLs de base.
5. Confirmar que el equipo comercial y de soporte conoce que la oferta permanecerá inactiva tras desplegar.

Ejemplo de comprobación de la tarifa base **dentro del contenedor PostgreSQL existente**, ajustando solo el método de conexión si la operación real usa otro:

```bash
docker exec hermes-postgres sh -ec '
  count=$(psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -tAc "SELECT count(*) FROM price_lists p JOIN products x ON x.id = p.\"productId\" WHERE p.id = '\''commercial-price-landing-basic-global-v1'\'' AND p.market IS NULL AND p.\"isPromotion\" = false AND x.\"serviceCode\" = '\''LANDING_PAGE'\'';")
  [ "$count" = 1 ] || { echo "BLOCKED: missing or ambiguous base tariff" >&2; exit 1; }
'
```

El operador debe revisar el resultado real y el estado de `_prisma_migrations`; una respuesta exitosa de Prisma por sí sola no basta.

## 5. B — Aplicación y comprobación de la migración

Hacer este paso como tarea **única y explícita**, usando la imagen nueva por digest con las variables y red de la app existentes, sin levantar otra instancia del servidor de respuestas. El CLI `prisma` está en las dependencias de runtime de la imagen. Ejemplo conceptual con el Compose/override autorizado de la VPS:

```bash
docker compose --env-file /etc/hermes-crm/compose.env -f <compose-base> -f <override-imagen-por-digest> config --quiet
docker compose --env-file /etc/hermes-crm/compose.env -f <compose-base> -f <override-imagen-por-digest> run --rm --no-deps app npx prisma migrate status
docker compose --env-file /etc/hermes-crm/compose.env -f <compose-base> -f <override-imagen-por-digest> run --rm --no-deps app npx prisma migrate deploy
```

Después, consultar `_prisma_migrations` y `price_lists`. Exigir una migración terminada sin error y **exactamente una** fila `commercial-price-landing-black-friday-80-global-v1` con `price=80.00`, `currency=USD`, `isPromotion=true`, `isActive=false`, `validUntil IS NULL`, `policyVersion=black-friday-landing-80-v1`, `supersedesPriceListId` hacia la tarifa base y el `productId` de esa misma base. Comprobar que `scope` contiene las diez prestaciones. Si cualquier condición falla: **detener la release y no activar**. No reescribir el estado de Prisma para ocultar una fila ausente.

## 6. A — Despliegue del backend

Solo tras pasar B, fijar el digest inmutable anterior en el override aprobado y recrear **únicamente** `app` con `docker compose ... up -d --no-deps app`. No ejecutar `down -v`, ni recrear PostgreSQL/Redis/n8n. Confirmar salud, logs sin errores de migración, identidad OCI y que los demás contenedores conservaron su identidad. Registrar resultado y el digest anterior en el acta VPS.

Con la promoción aún inactiva, validar de forma controlada: pregunta Black Friday sin anuncio del precio promocional; consulta ordinaria de landing con su precio normal; ruta de audio transcrito y fallback; STOP y handoff; ausencia de duplicados. Para validar texto natural de Nous se requiere una prueba de modelo real autorizada y registrada; los mocks locales no la sustituyen. No generar tráfico WhatsApp real por rutina.

## 7. C — Activación comercial separada

**No ejecutar durante A ni B.** Tras aprobación comercial explícita y QA, un operador autenticado puede activar la ID promocional mediante `PUT /api/price-lists/commercial-price-landing-black-friday-80-global-v1` con `{"isActive":true}`. Confirmar en CRM y base que solo esa fila cambió, y entonces probar con una consulta autorizada que Nous puede ofrecer USD $80 y las diez prestaciones sin inventar impuestos, plazo, renovaciones, pagos ni resultados. No asignar una fecha de caducidad no confirmada.

Al finalizar la campaña, desactivar con el mismo endpoint y `{"isActive":false}`; verificar que Nous ya no anuncia la promoción. La ruta existente requiere JWT. Registrar quién autorizó y ejecutó ambos cambios.

## 8. Recuperación y riesgos residuales

- Si falla A, restaurar **el digest servido registrado al inicio**, recrear solo `app` y verificar salud. No usar automáticamente el digest documental del 29/10 si la VPS ya avanzó.
- Si la campaña llegó a activarse, desactivarla antes del rollback del backend. La fila de datos puede permanecer **inactiva**: no hay cambio de esquema que obligue a revertir la migración. Un rollback de imagen no revierte datos ni sustituye un backup.
- Si B falla o la fila falta tras un `migrate deploy` exitoso, no desplegar A ni activar C; conservar logs saneados y preparar reparación revisada. No ejecutar SQL destructivo ni borrar la fila para repetir el migrador.
- Verificar permisos de pull GHCR, espacio y salud de la VPS antes de reemplazar app. El acceso local al registro no demuestra acceso desde la VPS.
- La redacción final de Nous, el estado exacto de producción, backups, versión web y respuestas con sesión CRM no se han observado desde este entorno local.

**Conclusión:** artefacto aprobado publicado y verificado; migración incluida y ensayada en base aislada; procedimiento productivo con precheck y postcheck de la tarifa base/promocional preparado. `READY_FOR_VPS_DEPLOY` significa listo para el procedimiento VPS descrito, **no promoción activada ni despliegue realizado**.
