# HERMES 2.0 — recuperación selectiva del catálogo comercial

Fecha: 2026-10-30. Ámbito: Codex Local, Windows. Dictamen: **READY_FOR_VPS_CATALOG_REPAIR** para entregar el artefacto al operador de Codex VPS; **no se ha ejecutado en producción**.

## 1. Diagnóstico y límites de la evidencia

Codex VPS informó `products=0`, `price_lists=0` en `hermes_db` y que `20260923020000_seed_global_commercial_prices` figura aplicada. No se accedió a la VPS ni se verificaron directamente esas cifras en este trabajo local. Una migración aplicada en `_prisma_migrations` registra la ejecución pasada; no garantiza que las filas sigan presentes. Por tanto, el estado informado es compatible con una eliminación posterior, una restauración de datos incompleta o una inspección de otra base/esquema. **No hay causa demostrada**.

Se revisaron las migraciones versionadas y el código de catálogo. `src/products/products.controller.ts` y `src/products/products.service.ts` exponen un borrado de producto; `src/price-lists/price-lists.controller.ts` y `src/price-lists/price-lists.service.ts` exponen un borrado de tarifa. La relación `price_lists.productId` tiene `ON DELETE CASCADE`, por lo que borrar un producto podría borrar su tarifa. Esto es una hipótesis técnica, no evidencia de que esas rutas se usaran. No se halló en el código revisado una tarea automática que borre todo el catálogo ni un replay de la migración histórica; la ausencia de ese mecanismo en el repositorio tampoco excluye intervenciones externas.

Para investigar la causa en VPS se necesitan, **solo en lectura**, la identidad de base y esquema (`current_database()`, `current_schema()`, `search_path`), recuentos por tabla/esquema, filas pertinentes de `_prisma_migrations` con `checksum`, fechas y estado, logs de despliegues y PostgreSQL alrededor de la desaparición, registros de auditoría disponibles de las rutas de borrado, y cronología de restauraciones o cambios de volumen. No atribuir la desaparición a una persona o acción sin esos datos.

## 2. Fuente aprobada y estado que se recupera

Se inspeccionaron `20260923020000_seed_global_commercial_prices`, `20260925120000_commercial_plan_terms`, `20261029200000_black_friday_landing_80` y `prisma/schema.prisma`. El producto y la tarifa usan IDs estables; `products.id` y `price_lists.id` son claves primarias, `products.sku` es `UNIQUE`, y `price_lists.productId` referencia `products.id` con cascada al borrar producto. Los scripts usan los nombres y enumeraciones Prisma existentes.

| Fila | Campos comerciales aprobados |
| --- | --- |
| Producto `commercial-product-landing-basic` | `Landing Básica`; descripción `Landing page de una sola sección.`; categoría `Landing Page`; `serviceCode=LANDING_PAGE`; `sku=commercial-landing-basic`; `imageUrl=NULL`; `isActive=true`; `metadata.commercialTerms={"renewalUsdPerYear":40,"estimatedBusinessDays":10}`. |
| Tarifa `commercial-price-landing-basic-global-v1` | Producto anterior; `Tarifa global vigente`; `250.00 USD`; `market=NULL` (global); `priceType=FIXED`; `taxMode=INCLUDED`; `taxLabel=IVA`; `taxRatePercent=NULL`; `policyVersion=global-v1`; `isPromotion=false`; `supersedesPriceListId=NULL`; `validUntil=NULL`; `restrictions=NULL`; nota `Precio confirmado para Hermes.`; `isActive=true`. |

El alcance exacto de la tarifa es: “Una página, diseño adaptable, WhatsApp y llamada, formulario, beneficios, dominio .com y hosting básico por un año, cinco correos corporativos, SEO técnico base y un mes de soporte.” `validFrom`, `createdAt` y `updatedAt` usan el momento de inserción cuando falta una fila. Los valores históricos de esos campos no se inventan. Una fila existente se conserva si coincide en los campos comerciales y `validFrom` no está en el futuro. La migración de condiciones fusionaba `commercialTerms` con otros metadatos; por eso se permiten otras claves de `metadata`, pero `commercialTerms` debe coincidir exactamente.

La migración Black Friday es la única fuente de la futura promoción `commercial-price-landing-black-friday-80-global-v1`: USD 80, inactiva, ligada a la tarifa base. El procedimiento de recuperación **no inserta ni activa** esa promoción. Si ya existe con su ID, se comprueba el conjunto completo de sus campos aprobados y se bloquea ante cualquier diferencia; esto evita que el `ON CONFLICT DO NOTHING` de la migración Black Friday oculte una oferta errónea.

## 3. Artefacto y garantías

Commit inmutable de los scripts y pruebas: **`fd82b973bcf8e3076f33c421869759e490cef123`** en la rama `fix/commercial-base-recovery-20261030`. Los cuatro archivos están en `hermes-backend/scripts/commercial-base-recovery/`.

| Archivo | SHA-256 de los bytes del blob Git |
| --- | --- |
| `preflight.sql` | `5da256e15f8075b62913ce655bad53a8df0b983e9190cdbef36aea46eb9b8ab3` |
| `repair.sql` | `05e882d2de8d1abaa242e3459c65f1c16fc244b8138dea6c29e3631cce21c1d9` |
| `verify.sql` | `c7f93c777e4e5c4a3bdbcf061e2b1b16706c7a9fc7485a821d5fdedb0924e014` |
| `test-repair.mjs` | `73b9b9dca183152247096fdc9c31b6ff8fc5b834e625047245a43fffd95069d2` |

`preflight.sql` es solo lectura y produce `BASE_CATALOG_MISSING`, `BASE_CATALOG_PARTIAL`, `BASE_CATALOG_ALREADY_VALID` o `BASE_CATALOG_CONFLICT`, más conteos. `repair.sql` inicia una transacción, limita tiempos, toma un advisory lock y bloquea las dos tablas durante la comprobación e inserción. Inserta solo las filas faltantes, no usa UPSERT ni cambia filas existentes y revierte todo ante conflicto/error. `verify.sql` es solo lectura y termina con error si falla una condición. El SQL de reparación no contiene `DELETE`, `DROP`, `TRUNCATE` ni escrituras en `_prisma_migrations`.

## 4. Pruebas locales y resultado

Las pruebas se ejecutaron en PostgreSQL 18, ligado a `127.0.0.1:55433`, dentro de un clúster temporal exclusivo de esta tarea. El harness exige identidad de host, usuario, base y directorio de datos antes de cualquier escritura; fija `PGHOSTADDR` a loopback, ignora `PGSERVICE` heredado y limpia los esquemas creados. No se usó producción.

`node --test scripts/commercial-base-recovery/test-repair.mjs`: **12/12 casos aprobados**, incluidos ausencia de ambas filas, solo producto, filas válidas, ejecución repetida, colisión de SKU, importe o condiciones incompatibles, duplicado lógico, promoción incompatible, host heredado malicioso, fallo insertado con rollback, concurrencia y compatibilidad con Prisma. La prueba final aplica las **26 migraciones reales anteriores a Black Friday** en un esquema local aislado, simula la pérdida de las dos filas, comprueba que los demás registros se conservan, ejecuta el repair y aplica la migración 27 real. Confirma USD 80, `isActive=false`, vínculo con la tarifa USD 250, ausencia de duplicados y postcheck correcto.

También pasaron `node --check` y `git diff --check` después del último ajuste. Antes del ajuste final, el backend completo pasó **101 suites / 1619 tests**, `npm run build` y `npx prisma validate`. El ajuste final afecta únicamente a SQL de recuperación y su harness; se volvió a ejecutar la suite de integración de 12 casos.

La revisión independiente detectó inicialmente dos defectos: herencia de `PGHOSTADDR` y validación incompleta de una oferta Black Friday preexistente. Se añadieron pruebas que fallaban por esos motivos, se corrigieron ambos y pasaron en la ejecución final. El harness también pasó a usar las migraciones históricas reales en la prueba de compatibilidad.

## 5. Condiciones de bloqueo y riesgo

El propietario dispensó un respaldo nuevo con `DATABASE_BACKUP_WAIVED_BY_OWNER`. **No existe un punto de recuperación reciente verificado**. El procedimiento evita una limpieza destructiva como rollback, pero un fallo operativo o una condición desconocida en producción no tendrá ese respaldo reciente. El operador debe dejar constancia de esta limitación antes de ejecutar.

Detenerse sin ejecutar `repair.sql` si la base/esquema no son `hermes_db` y el esquema previsto, la suma SHA-256 no coincide, la migración histórica no figura aplicada o su checksum difiere del archivo versionado, el preflight devuelve conflicto/error, aparece un SKU/ID duplicado, hay una tarifa comercial incompatible, la promoción existe con valores diferentes, hay migraciones fallidas o el estado de la oferta ya aplicada es ambiguo. Si Black Friday ya figura aplicada pero falta su fila, no repetir esa migración ni editar `_prisma_migrations`: requiere otro procedimiento. Si el preflight devuelve `BASE_CATALOG_ALREADY_VALID`, ejecutar `verify.sql` y omitir repair. Los locks y límites de tiempo pueden abortar la operación durante tráfico concurrente; se debe diagnosticar y repetir preflight, no forzarla.

## 6. Instrucciones para Codex VPS

Estas instrucciones son para una **ejecución posterior y separada**. Primero identificar el repositorio, el contenedor PostgreSQL y las credenciales que el contenedor ya tiene configuradas; no imprimir secretos ni cadenas de conexión. La base declarada es `hermes_db`. Ejecutar los comandos desde un shell del VPS después de comprobar que el checkout es el repositorio correcto:

```sh
REPO=/ruta/al/checkout/hermes_n8n
PG_CONTAINER=nombre_real_del_contenedor_postgres
ARTIFACT_COMMIT=fd82b973bcf8e3076f33c421869759e490cef123
STAGE=$(mktemp -d)
git -C "$REPO" fetch origin fix/commercial-base-recovery-20261030
git -C "$REPO" cat-file -e "$ARTIFACT_COMMIT^{commit}"
for name in preflight.sql repair.sql verify.sql; do
  git -C "$REPO" cat-file blob "$ARTIFACT_COMMIT:hermes-backend/scripts/commercial-base-recovery/$name" > "$STAGE/$name"
done
cd "$STAGE"
printf '%s\n' \
  '5da256e15f8075b62913ce655bad53a8df0b983e9190cdbef36aea46eb9b8ab3  preflight.sql' \
  '05e882d2de8d1abaa242e3459c65f1c16fc244b8138dea6c29e3631cce21c1d9  repair.sql' \
  'c7f93c777e4e5c4a3bdbcf061e2b1b16706c7a9fc7485a821d5fdedb0924e014  verify.sql' | sha256sum -c -
```

La verificación de checksum debe mostrar `OK` para los tres archivos antes de usar cualquiera de ellos. Ejecutar una inspección de solo lectura con el mecanismo de acceso aprobado en VPS; por ejemplo, si el contenedor expone `POSTGRES_USER`:

```sh
docker exec -i "$PG_CONTAINER" sh -c 'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d hermes_db -tA' <<'SQL'
SELECT current_database(), current_schema(), current_setting('search_path');
SELECT migration_name, checksum, finished_at, rolled_back_at
FROM "_prisma_migrations"
WHERE migration_name IN (
  '20260923020000_seed_global_commercial_prices',
  '20260925120000_commercial_plan_terms',
  '20261029200000_black_friday_landing_80'
)
ORDER BY migration_name;
SELECT count(*) FROM products;
SELECT count(*) FROM price_lists;
SQL
```

Confirmar base y esquema esperados, estado de migraciones y checksum de cada migración aplicada contra el archivo versionado. Comparar los recuentos reales con el informe VPS. Los comandos siguientes fallan si `psql` encuentra errores (`ON_ERROR_STOP=1`); leer el dictamen de cada paso y detenerse ante cualquier desviación:

```sh
docker exec -i "$PG_CONTAINER" sh -c 'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d hermes_db -tA' < "$STAGE/preflight.sql"
# Solo si el dictamen es BASE_CATALOG_MISSING o BASE_CATALOG_PARTIAL:
docker exec -i "$PG_CONTAINER" sh -c 'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d hermes_db -tA' < "$STAGE/repair.sql"
docker exec -i "$PG_CONTAINER" sh -c 'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d hermes_db -tA' < "$STAGE/verify.sql"
docker exec -i "$PG_CONTAINER" sh -c 'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d hermes_db -tA' < "$STAGE/preflight.sql"
```

El último dictamen debe ser `BASE_CATALOG_ALREADY_VALID`; la fila base debe estar activa en USD 250 y el producto debe conservar `LANDING_PAGE` y sus condiciones. Si el repair falla, la transacción se revierte; inspeccionar el error y repetir preflight antes de plantear otro intento. No modificar `_prisma_migrations` ni ejecutar manualmente el seed histórico.

Después, Codex VPS podrá aplicar `20261029200000_black_friday_landing_80` mediante el flujo aprobado de migraciones de la **imagen ya publicada** `ghcr.io/undercodeec/hermes-backend@sha256:db399bba2886bd25c9b9730e08c79ae0223c90286e64b52cb7c65e87bd414be6` (fuente `fa537a90aeecda0efce1d3248354bc2dd647cbda`, Actions `41062257744`). Verificar que existe exactamente una oferta USD 80, `isActive=false`, `validUntil=NULL` y `supersedesPriceListId='commercial-price-landing-basic-global-v1'` antes del despliegue del backend aprobado. La activación comercial requiere autorización aparte. **No se necesita una nueva imagen GHCR** para esta reparación SQL independiente.

## 7. Estado Git

La rama de reparación se creó desde `fa537a90aeecda0efce1d3248354bc2dd647cbda` en un worktree aislado. El commit `fd82b973bcf8e3076f33c421869759e490cef123` fija los bytes de los scripts y pruebas. Este informe es documentación de entrega posterior; sus ediciones no alteran esos blobs. No se cambió el backend de Nous, frontend, WhatsApp, F3/F4 ni la rama piloto. No se generó imagen nueva ni se desplegó nada.
