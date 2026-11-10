# Plan operativo: opción B, doce meses de soporte

> **Plan histórico, no autorización operativa.** Revalidar antes de ejecutar. [Estado vigente](estado-proyecto.md).

## Autorización comercial y separación

El propietario aprobó la **opción B** el 2026-11-04 en `ProyectMD/prompt.md`: nueve planes con doce meses de soporte, mismos precios y prestaciones; Plan de Autoridad y Tienda Élite mantienen VIP prioritario. La aprobación comercial permite preparar código y procedimientos, **sin autorizar escrituras productivas ni despliegue**.

Hay dos operaciones independientes. **A:** `reconcile-commercial-catalog.ts` crea únicamente los ocho Product/PriceList EC/USD ausentes, ya con doce meses. **B:** `update-global-landing-support-12m.ts` cambia únicamente la cláusula de soporte de la PriceList GLOBAL/USD 250 existente `commercial-price-landing-basic-global-v1`. `update-commercial-support-12m.ts` queda como comprobación y mantenimiento separado para las ocho tarifas EC; con el catálogo recién creado, su preflight debe mostrar cero cambios. Ninguna operación exige ejecutar otra en la misma transacción.

## Preflight de la operación B

Desde `hermes-backend`, ejecutar en modo de lectura: `npx ts-node scripts/update-global-landing-support-12m.ts`. Verificar y conservar el reporte. El script exige Product `commercial-product-landing-basic` activo, SKU correcto, PriceList base activa y vigente con ID original, mercado GLOBAL/null, USD 250, IVA incluido sin tasa numérica, `global-v1` y scope histórico de un mes o el scope exacto aprobado de doce meses. Rechaza otra tarifa base GLOBAL activa, una tarifa EC activa adicional y cualquier cláusula de soporte diferente o contradictoria.

La relación con `commercial-price-landing-black-friday-80-global-v1` también es obligatoria: mismo Product, referencia a la base, USD 80, GLOBAL, promoción y `policyVersion` correctas, diez cláusulas aprobadas y doce meses de soporte. La operación no escribe en esa promoción ni cambia su estado, impuestos, vigencia, restricciones o scope. Una divergencia detiene el proceso para revisión comercial.

## Backup, autorización y aplicación posterior

Cada operación requiere su propio identificador de autorización operativa y evidencia firmada Ed25519, backup **actual** con SHA-256 y restauración aislada verificada. El archivo protegido y el backup se ubican bajo `HERMES_MAINTENANCE_EVIDENCE_DIR`; la clave pública confiable se instala fuera del repositorio en `HERMES_MAINTENANCE_TRUSTED_PUBLIC_KEY`. `HERMES_MAINTENANCE_DATABASE_ID` identifica la base aprobada. El documento firmado de B incluye `operation = COMMERCIAL_GLOBAL_LANDING_SUPPORT_12M`, `approvedMarket = GLOBAL`, `commercialApprovalId` verificable y su propia expiración. Los parámetros de texto, por sí solos, no autorizan la escritura. No guardar credenciales ni clave privada en el código.

Solo un operador VPS, tras revisar el preflight y obtener autorización operativa, podrá ejecutar:

`npx ts-node scripts/update-global-landing-support-12m.ts --apply --commercial-approval-id <COMM-ID> --authorization-id <AUTH-ID> --backup-id <BKP-ID> --evidence-file <RUTA_ABSOLUTA>`

El script revalida Product, PriceList base y Black Friday dentro de una transacción SERIALIZABLE; compara el estado leído y `updatedAt`, actualiza únicamente `scope` y crea un `AuditLog` específico `COMMERCIAL_GLOBAL_LANDING_SUPPORT_12M` en la misma transacción. Un segundo preflight debe mostrar `change` ausente y una repetición del modo apply no genera escrituras ni nuevos AuditLog. Precio, moneda, mercado, impuestos, vigencia, promociones, restricciones y prestaciones no relacionadas permanecen intactos.

## Rollback de la operación B

Con nueva evidencia firmada para `COMMERCIAL_GLOBAL_LANDING_SUPPORT_ROLLBACK`, backup reciente y revisión de cambios posteriores, usar el ID del AuditLog de la aplicación:

`npx ts-node scripts/update-global-landing-support-12m.ts --rollback-audit-id <AUDIT-ID> --commercial-approval-id <COMM-ID> --authorization-id <AUTH-ID> --backup-id <BKP-ID> --evidence-file <RUTA_ABSOLUTA>`

El rollback solo restaura el scope anterior si la fila y Black Friday todavía coinciden con el estado auditado; registra un segundo AuditLog. Si hubo un cambio concurrente o comercial independiente, detiene la operación. Conservar el backup para una restauración aislada o completa según el runbook VPS.

## Ocho tarifas EC

Tras la reconciliación A, ejecutar `npx ts-node scripts/update-commercial-support-12m.ts` en lectura. Debe devolver `changes: []` y `failures: []`. Si no es así, revisar cuál de las ocho tarifas EC diverge. El script EC no toca Landing Básica GLOBAL ni Black Friday. Una futura aplicación EC requeriría autorización, backup y evidencia propios; no reutilizar la evidencia de B.

## Gates pendientes

No se ejecutó ninguna de estas operaciones contra PostgreSQL productivo. Faltan preflight productivo, vincular la aprobación comercial a un identificador verificable, autorización operativa específica, backup productivo reciente, restauración aislada, integración A7-D16 y revisión de PR. No fusionar ni desplegar mientras estos gates sigan abiertos.
