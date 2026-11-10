# Opción B: soporte anual de los nueve planes — 2026-11-04

> **Acta histórica.** Resultados originales conservados; no acredita producción actual. [Estado vigente](estado-proyecto.md).

## Decisión y alcance

El propietario aprobó expresamente en `ProyectMD/prompt.md` la opción B: Landing Básica GLOBAL/USD 250 pasa de un mes a doce meses de soporte técnico; los otros ocho planes EC/USD se preparan con doce meses desde su creación; Autoridad y Élite mantienen VIP prioritario. Los nueve importes permanecen 250, 600, 1500, 360, 510, 1010, 550, 850 y 3490 USD. La aprobación es **comercial**, no es permiso para escribir en producción.

El HEAD inicial de este trabajo fue `7121dca8ca2d86eb5acf63e812b320f933efd1af`, rama `feat/hermes-commercial-packages-20261104`, descendiente de PR #9. La reconciliación EC y el cambio GLOBAL son operaciones y auditorías independientes. `update-global-landing-support-12m.ts` conserva los ID históricos de Product y PriceList, precio, moneda, mercado null/GLOBAL, tratamiento fiscal, vigencia, promociones y restricciones; solo puede cambiar `scope` de la base. Los scopes EC propuestos conservan las prestaciones de la migración histórica y sustituyen únicamente las antiguas duraciones de soporte. `update-commercial-support-12m.ts` sigue limitado a las ocho EC y, tras su creación, debe ser un no-op.

## Preflight y seguridad

El preflight GLOBAL compara el Product activo, tarifa base USD 250 vigente, `global-v1`, IVA incluido sin tasa numérica y scope histórico exacto de un mes o el scope aprobado de doce. Rechaza duplicados, cláusulas contradictorias y divergencias. Comprueba la promoción Black Friday existente: USD 80, diez prestaciones originales, soporte anual, relación con la base y `policyVersion` correcto. Si la promoción no coincide, no permite modificar la base. La promoción no recibe escritura ni nueva fila.

La futura aplicación y su rollback exigen evidencias **distintas**, firmadas Ed25519 y vinculadas a la operación, mercado GLOBAL, aprobación comercial verificable, autorización operativa, ID de base, backup reciente, SHA-256 y restauración aislada. El script revalida el estado en una transacción SERIALIZABLE, usa `updatedAt` para concurrencia y registra `AuditLog` atómico. El estado completo posterior se resume por SHA-256 en el AuditLog; el rollback rechaza cambios posteriores de Product o PriceLists. Los detalles y comandos están en `HERMES_PRICE_LIST_12M_DEPLOYMENT_PLAN_2026-11-04.md`.

## Validación local

- Build: aprobado. Suite unitaria: **112 suites, 1855 pruebas aprobadas**; incluye los casos conversacionales de PR #10 y las nuevas pruebas GLOBAL. ESLint global: aprobado. Prisma validate con URL desechable: aprobado. Secret scan: aprobado.
- PostgreSQL 18 desechable en `127.0.0.1:56544`: preflight reconoció la base GLOBAL de un mes y Black Friday de doce; backup del estado se restauró en otra base aislada antes de firmar evidencia de prueba. Aplicación de prueba cambió una sola cláusula y creó un AuditLog; repetición no generó otra escritura. Rollback auditado devolvió el scope anterior.
- Una falla inducida en `AuditLog` abortó la transacción y dejó intacto el mes original. En una carrera de dos procesos, uno aplicó y el otro observó el estado ya actualizado; se creó una sola actualización adicional, sin duplicados. El hash de la fila Black Friday permaneció `3202a4688f8bae047b915fb311e745dd` antes y después; quedaron ocho tarifas EC, el ID GLOBAL original y USD 250.
- Tras añadir el hash de estado al AuditLog, se repitieron aplicación y rollback con el código final; ambos pasaron.
- `tsc --noEmit` global continúa con **146 errores**. Tras regenerar el cliente Prisma local de PR #9, esa rama base mostró también **146**; los errores están en pruebas existentes y diferencias de tipos ya presentes. La compilación estricta aislada de los scripts comerciales modificados pasó. No se declara verde este gate.

## Riesgos y pendientes

La tarifa base es GLOBAL: el nuevo plazo de soporte será visible en todo mercado donde la política actual seleccione esa misma PriceList, incluido potencialmente España. Esta operación no crea EUR, no convierte importes y no cambia impuestos de ningún mercado. Las ocho tarifas EC se ofrecen solo bajo la selección EC aprobada. Antes de producción faltan identificar formalmente la aprobación comercial en la evidencia firmada, autorización operativa específica, preflight productivo, backup productivo actual con restauración, integración aislada y A7-D16. No se desplegó, fusionó ni escribió en PostgreSQL productivo.

Dictámenes: `OPTION_B_SUPPORT_12M_LOCAL_IMPLEMENTED`, `GLOBAL_LANDING_SUPPORT_UPDATE_PREPARED`, `EC_CATALOG_RECONCILIATION_PREPARED`, `PRODUCTION_UPDATE_PENDING`.
