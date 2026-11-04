# Remediación de bloqueantes de PR #10 — 2026-11-04

## Alcance y estado

- Rama de trabajo: `feat/hermes-commercial-packages-20261104`; HEAD inicial `e332c75fb5361cb2dd58eb14784be75ab44c8aec`. El commit `41b9365` de PR #9 es ancestro. No se modificó la rama piloto ni PostgreSQL productivo.
- El informe `HERMES_PR9_PR10_PREDEPLOY_AUDIT_2026-11-04.md` citado en el encargo no está en este checkout ni en `ProyectMD` local. Se tomó el texto de `prompt.md` como evidencia de la observación productiva; no se infirió ningún estado adicional de producción.
- Dictamen del código conversacional: `PR10_CONVERSATIONAL_BLOCKERS_RESOLVED`, sujeto a la integración aislada final. Dictamen CRM: `CRM_CATALOG_RECONCILIATION_PREPARED` y `CRM_CATALOG_COMMERCIAL_APPROVAL_PENDING`. **PR #10 no está apto para producción**: faltan la decisión comercial de mercado, el preflight/backup real, la reconciliación autorizada y A7-D16.

## Bloqueante A: «paguina web»

La causa era que `requestedSolutionKinds()` no reconocía esa variante y devolvía `[]`; corregir solo el texto enviado al modelo no cambiaba el snapshot comercial. `spanish-text-normalizer.ts` corrige variantes acotadas de *paguina/pajina* en contexto web o con artículo, y *sitio wep*. `commercial-catalog.ts`, `commercial-policy.service.ts`, `commercial-authority.service.ts` y el formateador usan la normalización antes de decidir servicio, precio o tarjeta. La consulta «Valor de una paguina web» reconoce WEBSITE y precio. Las respuestas toman importes exclusivamente de `CommercialSnapshot.offers`, que se construye desde PriceList vigente; si falta la tarifa no se inventa.

## Bloqueante B: paquetes turísticos

La causa era la expresión `allPlans` que activaba tres tarjetas por la sola palabra «paquetes». `commercial-package-response.ts` exige una petición explícita de ver o comparar planes; «diez paquetes turísticos», «vender paquetes de viajes» y similares quedan como contenido del proyecto. Una comparación centrada en dos planes conserva esos dos. Una consulta de proyecto con adicionales muestra como máximo dos planes base del servicio pertinente; toma en cuenta `recommendedOfferId`, separa reservas/pagos como valoración adicional y evita presentar el precio base como costo total. El caso turístico con oferta sintética EC/USD obtiene Lanzamiento 360 y Crecimiento 510, sin Autoridad. Si la PriceList respectiva falta o no aplica al mercado, no se muestra su precio.

## Archivos revisables

- Conversación: `hermes-backend/src/hermes/spanish-text-normalizer.ts`, `commercial-catalog.ts`, `commercial-policy.service.ts`, `commercial-authority.service.ts`; `hermes-backend/src/auto-replies/commercial-package-response.ts` y sus pruebas, incluido `auto-reply.service.spec.ts` para la entrega final de WhatsApp.
- Mantenimiento: `hermes-backend/scripts/update-commercial-support-12m.ts`, `maintenance-evidence.ts`, `reconcile-commercial-catalog.ts` y pruebas de soporte, evidencia y clasificación de reconciliación.
- Procedimiento: `ProyectMD/HERMES_COMMERCIAL_CATALOG_RECONCILIATION_PLAN_2026-11-04.md` y el plan de soporte de doce meses actualizado.

## Validaciones y límites

- `npm run build`: aprobado.
- Ocho suites focalizadas de Jest: **496/496 aprobadas** tras el ajuste de pertinencia. Incluyen normalización, detección, política, snapshot, orquestación, envío WhatsApp, promoción Black Friday, soporte y controles unitarios de reconciliación.
- TypeScript aislado de los tres scripts de mantenimiento con `--strict`: aprobado.
- PostgreSQL 18 desechable en `127.0.0.1:56544`: 27 migraciones aplicadas a una instancia nueva; se simuló la ausencia de ocho Product mediante borrado **solo en esa instancia**. El preflight identificó 8 Product y 8 PriceList faltantes, sin conflictos. Un backup de esa instancia se restauró en una segunda base aislada antes de firmar evidencia de prueba. La aplicación de prueba creó 8 Product, 8 PriceList y 16 AuditLog. Una repetición creó cero filas. El rollback del run eliminó las 16 filas y registró 16 AuditLog de reversión.
- Dos aplicaciones simultáneas de prueba sobre el catálogo faltante: una terminó y la otra fue rechazada por conflicto de serialización; estado final 9 Product comerciales, 8 PriceList EC y sin duplicados.
- Soporte, sobre la misma instancia: una cláusula EC de un mes produjo un cambio; aplicación y rollback auditaron la operación, y el preflight posterior a la aplicación devolvió cero cambios. La PriceList GLOBAL/USD 250 conservó un mes de soporte. El script de soporte se limitó a ocho tarifas EC/USD.
- `npx tsc --noEmit` global: falla por errores de tipado existentes en múltiples suites ajenas, incluidos constructores de pruebas con argumentos incompletos; `npm run build` sí compila el backend. Este gate no se declara verde.
- No se ejecutó aplicación, rollback ni escrituras contra PostgreSQL productivo. La integración A7-D16 aislada y las verificaciones en VPS siguen pendientes.

## Riesgos residuales

El snapshot depende de PriceLists efectivamente presentes y vigentes. La evidencia del encargo identifica ocho ausentes; por eso el código puede reconocer WEBSITE sin tener dos tarifas para ofrecer. La tarifa global de Landing Básica y la promoción Black Friday permanecen separadas. La lectura de enlaces externos sigue pendiente como trabajo independiente. Mantener STOP, opt-out, handoff, deduplicación, privacidad, F3 e idempotencia de mensajes dentro del gate de regresión antes de desplegar.
