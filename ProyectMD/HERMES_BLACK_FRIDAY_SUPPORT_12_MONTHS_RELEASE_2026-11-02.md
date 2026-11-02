# Black Friday: soporte de 12 meses y release único — 2026-11-02

## Alcance y autoridad

La instrucción comercial vigente para esta tarea es **12 meses de soporte técnico posteriores a la entrega** en la promoción Black Friday Landing Page. Las otras nueve prestaciones y los importes permanecen intactos. El backend sigue leyendo el `scope` de la `PriceList` seleccionada en cada turno: mientras el registro productivo diga un mes, esa es la duración comunicable. Preparar código y pruebas no actualiza el CRM.

Esta rama parte del HEAD `60d8c66123e44f17eeaba0842a92bd3205379af8` del PR #7. No modifica las ramas de los PR #6 y #7. La migración histórica `20261029200000_black_friday_landing_80` conserva el valor original de un mes; los planes normales y sus migraciones siguen con sus duraciones propias.

## Cambios de código

- `commercial-authority.service.ts`: reconoce las cuatro variantes autorizadas de doce meses o un año, con «posterior» o «posteriores», y entrega equivalencias al contexto de Nous solo cuando el `scope` seleccionado las respalda. Mantiene la equivalencia de un mes para la `PriceList` anterior.
- `black-friday-visual-response.ts`: muestra `🛠️ *1 año de soporte técnico posterior a la entrega*` para cualquiera de las cuatro variantes autorizadas. Si el `scope` aún indica un mes, muestra un mes.
- `commercial-claims.ts`: rechaza afirmaciones de duración que contradigan cualquier `PriceList` Black Friday seleccionada, así como soporte «24/7» o ilimitado. La protección se limita a esta promoción.
- `auto-reply.service.ts`: si se seleccionan dos promociones de mercados distintos con `scope` diferente, no construye una lista común a partir de la primera. Los controles de precio, STOP, handoff y entrega no cambian.
- Pruebas de autoridad, formateador, respuesta y actualización auditada de `PriceList`: cubren las dos duraciones según el registro seleccionado, diez prestaciones, tres mensajes, compactación F3 y actualización de solo `scope`.

## Actualización administrativa auditada en Codex VPS

**No ejecutar desde Codex Local.** El registro objetivo es `commercial-price-landing-black-friday-80-global-v1`. Un operador con rol `ADMIN` debe usar la API del CRM, que realiza la actualización y el `AuditLog` en una transacción serializable. No usar SQL directo ni editar la migración histórica.

1. Consultar `GET /api/price-lists/commercial-price-landing-black-friday-80-global-v1` con el token administrativo del procedimiento VPS. Guardar fuera del repositorio la respuesta completa como respaldo. Verificar ID, `policyVersion = black-friday-landing-80-v1`, promoción, relación con la tarifa base, estado y vigencia. Confirmar que `scope` contiene exactamente diez cláusulas separadas por `;` y que la décima es `1 mes de soporte posterior a la entrega.`. Si el valor difiere, detenerse y solicitar nueva revisión comercial.
2. Construir el nuevo `scope` reemplazando **solo** esa cláusula final por `12 meses de soporte técnico posteriores a la entrega.`. El nuevo texto debe ser idéntico en las primeras nueve cláusulas. Comparar ambos textos y registrar el diff de esa cláusula, sin incluir tokens ni datos personales.
3. Enviar `PUT /api/price-lists/commercial-price-landing-black-friday-80-global-v1` con `Content-Type: application/json` y un cuerpo que contenga **únicamente** `{ "scope": "<scope completo con la nueva cláusula>" }`. No incluir `price`, `currency`, `market`, impuestos, `validFrom`, `validUntil`, `isActive`, `supersedesPriceListId` ni otros campos.
4. Leer nuevamente el registro con `GET /api/price-lists/:id` y comparar todos los campos comerciales con el respaldo: solamente `scope` y `updatedAt` deben cambiar. Leer `GET /api/price-lists/:id/audit` y confirmar una entrada `PRICE_LIST_UPDATED` con el usuario administrador y `before.scope`/`after.scope` correctos. Si falta auditoría o cambia otro campo, detener el release y aplicar rollback comercial.
5. Consultar las demás `PriceList` Black Friday activas. Una tarifa específica ES/EUR o EC/USD con un `scope` diferente no hereda esta actualización global. No anunciar doce meses para ese mercado hasta que su propio registro tenga una actualización autorizada y auditada. Esta instrucción solo autoriza el ID global indicado.

La API administrativa disponible es `PUT /api/price-lists/:id`; `PriceListsService.update()` escribe el cambio y `AuditLog` en una misma transacción. El precio de USD 80 y cualquier eventual tarifa EUR 80 no se modifican con este procedimiento.

## Rollback comercial

Usar el respaldo del paso 1 para enviar otro `PUT /api/price-lists/:id` con solo `{ "scope": "<scope anterior de un mes>" }`. Confirmar la lectura posterior y la nueva entrada de auditoría. No restaurar toda la fila, para evitar revertir cambios independientes de vigencia, impuestos, mercado o precio. Si la corrección debe suspenderse con urgencia, el responsable comercial decide si desactiva la promoción por el canal administrativo; ese cambio requiere su propia autorización y registro.

## Pruebas

Sobre la rama de soporte: 105 suites unitarias y 1748 pruebas aprobadas; gate de integración aislado con 18 suites, 188 pruebas aprobadas y una omisión opcional permitida; A7-D16 con 6 suites y 31 pruebas aprobadas. Build, Prisma validate, security secrets y ESLint global pasaron. Las pruebas focalizadas de autoridad, formateador y respuesta pasaron con 234 casos; la actualización de `scope` y su auditoría pasó en la suite de `PriceListsService` (9 casos).

Estas son pruebas locales sintéticas. No prueban que el `scope` productivo ya haya cambiado ni que se haya enviado un WhatsApp real. Los gates del commit integrado definitivo deben repetirse antes de publicar la imagen.

## Orden del release

1. Registrar autorización del propietario y comprobar estado, diff, revisiones, checks y posibilidad de merge del PR #6; integrarlo a `pilot/a7-d12-monitor-only-20261026`.
2. Cambiar la base del PR #7 a la rama piloto, verificar que su diff contenga solo su corrección visual, registrar autorización y fusionarlo.
3. Cambiar la base del PR nuevo de soporte a la rama piloto, verificar que su diff contenga solo esta actualización, registrar autorización y fusionarlo.
4. Ejecutar unitarias, integración aislada, A7-D16, build, Prisma validate, secretos y ESLint sobre el **HEAD integrado definitivo**. Registrar commit SHA y tree SHA exactos.
5. En `main`, iniciar manualmente `.github/workflows/hermes-backend-ghcr-manual.yml` con `source_sha` igual al HEAD remoto piloto y `expected_tree` igual a su árbol. El workflow exige esa identidad, publica una sola imagen `linux/amd64` y verifica digest y OCI revision. No desplegar desde Codex Local.
6. Entregar a Codex VPS el SHA, tree, digest inmutable, resultados de gates y este procedimiento de `PriceList`. El release solo será comercialmente completo tras verificar código e `scope` productivo coincidentes. El despliegue de `hermes-app`, preflight y rollback operativo quedan bajo el runbook VPS.

El workflow GHCR está en `origin/main` y no se dispara con push. Las protecciones y revisiones exigidas por GitHub prevalecen; no usar force push ni saltarlas. La consulta de protección de rama con la conexión actual devolvió 403, por lo que su configuración debe verificarse en la interfaz por un operador autorizado antes de integrar.
