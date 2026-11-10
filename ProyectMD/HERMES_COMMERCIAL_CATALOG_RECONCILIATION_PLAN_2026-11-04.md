# Reconciliación controlada del catálogo comercial — 2026-11-04

> **Plan histórico, no autorización operativa.** Revalidar antes de ejecutar. [Estado vigente](estado-proyecto.md).

## Evidencia y decisión comercial

La migración `20260923020000_seed_global_commercial_prices` insertó nueve Product/PriceList GLOBAL/USD. Las migraciones posteriores presentes en esta rama no contienen borrado de los ocho faltantes; `20260925120000_commercial_plan_terms` añade metadatos a los nueve y `20261029200000_black_friday_landing_80` añade solo la promoción de landing básica. El historial Git contiene un procedimiento selectivo de recuperación de la landing básica (`ee9e4bb`, endurecido en `fd82b97`), sin prueba de que se haya ejecutado en producción. Tampoco hay evidencia local de una eliminación intencional, de un backup parcial o de la causa de la ausencia productiva. **No repetir la migración histórica ni ejecutar reset/db push.**

Los SKU y Product ID históricos se conservan si existen. Para Product ausentes se proponen los mismos ID históricos; para tarifas nuevas se proponen ID `commercial-price-<slug>-ec-12m-v1`, de modo que no se simule que la antigua GLOBAL/USD está restaurada. La política de selección da preferencia a EC sobre GLOBAL en Ecuador; una tarifa EC no se ofrece a España. La tarifa global existente de Landing Básica USD 250 no se modifica **en esta operación de reconciliación**: la opción B del propietario, registrada en `ProyectMD/prompt.md` el 2026-11-04, autoriza comercialmente actualizar su soporte en una operación separada. La promoción GLOBAL/USD 80 de Black Friday tampoco se modifica.

## Matriz aprobada comercialmente para Ecuador, pendiente de ejecución operativa

| SKU | USD aprobado | Mercado propuesto | Fiscalidad propuesta | Soporte |
| --- | ---: | --- | --- | --- |
| `commercial-website-launch` | 360 | EC/USD | IVA incluido, sin tasa numérica | 12 meses técnico |
| `commercial-website-growth` | 510 | EC/USD | IVA incluido, sin tasa numérica | 12 meses técnico |
| `commercial-website-authority` | 1010 | EC/USD | IVA incluido, sin tasa numérica | 12 meses VIP prioritario |
| `commercial-store-launch` | 550 | EC/USD | IVA incluido, sin tasa numérica | 12 meses técnico |
| `commercial-store-growth` | 850 | EC/USD | IVA incluido, sin tasa numérica | 12 meses técnico |
| `commercial-store-elite` | 3490 | EC/USD | IVA incluido, sin tasa numérica | 12 meses VIP prioritario |
| `commercial-landing-pro` | 600 | EC/USD | IVA incluido, sin tasa numérica | 12 meses técnico |
| `commercial-landing-premium` | 1500 | EC/USD | IVA incluido, sin tasa numérica | 12 meses técnico |

Los importes, doce meses, EC/USD e IVA incluido para Ecuador están aprobados comercialmente por la opción B del propietario. **La aprobación no autoriza escrituras productivas.** La antigua etiqueta GLOBAL no se extrapola a otros países. No se crean ES/EUR, no se convierten monedas y no se registra 7 % como IVA. Las prestaciones y metadatos del Product se comparan con la definición revisada; una divergencia exige decisión humana, no corrección automática. Las ocho PriceLists EC ya se crean con doce meses; `update-commercial-support-12m.ts` solo comprueba su consistencia y actúa si detecta un alcance antiguo autorizado. La tarifa GLOBAL de Landing Básica se trata por `update-global-landing-support-12m.ts` bajo evidencia y auditoría propias.

## Operación manual de Codex VPS

1. Confirmar la base objetivo por un identificador operativo independiente del URL; revisar estado real de los nueve SKU, ID, PriceLists, relaciones, impuestos, promociones y vigencia. Buscar dependencias de los ID históricos. Vincular la aprobación comercial de opción B a un identificador verificable y obtener autorización operativa específica para esta reconciliación.
2. Generar backup actual completo, conservarlo en ubicación protegida, calcular SHA-256, restaurarlo en PostgreSQL aislado y registrar resultado, fecha e ID. La evidencia firmada Ed25519 incluye operación, autorización, aprobación comercial, ID de base, backup, hash, restauración y expiración. La clave pública confiable se instala fuera del repositorio; las credenciales y la clave privada no se incluyen aquí. Un backup histórico no sirve.
3. Ejecutar **solo preflight de lectura** desde `hermes-backend`: `npx ts-node scripts/reconcile-commercial-catalog.ts --market EC`. Guardar JSON y comparar con la observación aprobada. Cualquier Product, ID o tarifa en conflicto bloquea toda la operación; no se sobrescribe ni duplica. Ejecutar aparte los preflight de soporte EC (`update-commercial-support-12m.ts`) y GLOBAL (`update-global-landing-support-12m.ts`); el preflight EC puede fallar legítimamente antes de reconciliar los ocho registros.
4. Después de aprobación explícita del resultado, el operador VPS puede ejecutar el modo manual `--apply --market EC --commercial-approval-id <COMM-ID> --authorization-id <AUTH-ID> --backup-id <BKP-ID> --evidence-file <RUTA_ABSOLUTA>`. El archivo firmado debe estar dentro de `HERMES_MAINTENANCE_EVIDENCE_DIR`, el backup protegido también, y la clave pública en `HERMES_MAINTENANCE_TRUSTED_PUBLIC_KEY`; `HERMES_MAINTENANCE_DATABASE_ID` debe corresponder a la base autorizada. No automatizar este paso en build, arranque, migración, Docker ni pruebas unitarias.
5. El script revalida dentro de una transacción SERIALIZABLE y crea solo Product/PriceList ausentes. Usa ID estables, valida conflictos de SKU/ID y tarifas activas, y registra `AuditLog` por cada fila creada, con run ID, autorización, aprobación, hash y estado posterior. El segundo preflight debe devolver `missing: []` y `failures: []`. Verificar además la respuesta para EC y la ausencia de esas tarifas para ES.
6. Si se requiere reversión, examinar primero los AuditLog y las referencias creadas después. El rollback manual `--rollback-run-id <RUN-ID> --market EC` exige una nueva evidencia firmada para `COMMERCIAL_CATALOG_ROLLBACK` y los mismos flags de autorización comercial, backup y evidencia. Solo elimina filas creadas por ese run y sin cambios posteriores; falla cerrado ante diferencias o relaciones nuevas. Conservar el backup para restauración aislada/completa por runbook.

La actualización GLOBAL es una **operación separada**: puede prepararse y ejecutarse independientemente de crear las ocho tarifas EC, con su propia autorización, backup, evidencia firmada, `AuditLog` y rollback. El script EC verifica las ocho tarifas creadas; no cambia la GLOBAL. No usar el run ID ni la evidencia de catálogo como permiso implícito para modificar soporte. El procedimiento GLOBAL figura en `HERMES_PRICE_LIST_12M_DEPLOYMENT_PLAN_2026-11-04.md`.

## Gates de salida

- Estado productivo y causa histórica documentados sin suposiciones; ocho productos y ocho tarifas clasificados por preflight.
- Decisión comercial de opción B registrada; identificador verificable de esa aprobación y autorización operativa aún deben incorporarse a la evidencia firmada del VPS.
- Backup reciente íntegro, SHA-256 y restauración aislada comprobada; archivo y clave protegidos.
- Pruebas con PostgreSQL desechable de idempotencia, concurrencia, rollback y AuditLog ejecutadas en local, según el informe de remediación. A7-D16 aislado y validación operativa siguen pendientes. Ninguno de estos gates autoriza por sí solo despliegue o fusión.
