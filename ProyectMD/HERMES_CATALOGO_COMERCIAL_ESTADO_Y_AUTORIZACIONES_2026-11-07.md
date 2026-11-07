# Hermes — Catálogo comercial, estado y autorizaciones (7/11/2026)

> **Separación obligatoria:** aprobación comercial **≠** autorización operativa para escribir PostgreSQL. Este documento actualiza la lectura del inventario; **no ejecuta A/B ni concede permiso para saltar backups, restauración o firma**.

## Nueve planes normales: decisión comercial ratificada el 7/11

| Categoría | Plan | Precio USD (IVA incluido) | Soporte aprobado |
| --- | --- | ---: | --- |
| Sitio Web | Lanzamiento | 360 | 12 meses técnico |
| Sitio Web | Crecimiento | 510 | 12 meses técnico |
| Sitio Web | Autoridad | 1.010 | 12 meses VIP prioritario |
| Tienda Online | Lanzamiento | 550 | 12 meses técnico |
| Tienda Online | Crecimiento | 850 | 12 meses técnico |
| Tienda Online | Élite | 3.490 | 12 meses VIP prioritario |
| Landing Page | Básica | 250 | 12 meses técnico |
| Landing Page | Pro | 600 | 12 meses técnico |
| Landing Page | Premium | 1.500 | 12 meses técnico |

### Detalle Landing Page

**Landing Básica — USD 250 (captación de leads):** una sección, responsive, botón WhatsApp y llamada, formulario de contacto/captura, sección de beneficios, dominio .com y hosting básico por un año, cinco correos corporativos y SEO técnico base. **12 meses** de soporte posterior a la entrega es la decisión comercial vigente; la ficha antigua de «1 mes» quedó obsoleta.

**Landing Pro — USD 600 (marketing integrado):** todo lo de Básica más textos persuasivos, formulario optimizado, recurso/incentivo promocional, seguimiento de campañas con Google Analytics e integración WhatsApp con respuestas iniciales; **12 meses** de soporte.

**Landing Premium — USD 1.500 (embudo automatizado):** todo lo de Básica más palabras clave para Google, campaña Google Ads activa por un mes y diseño personalizado con animaciones inmersivas; **12 meses** de soporte. Estas prestaciones son la descripción comercial del propietario; las `scope` literales del script de reconciliación son más resumidas. **Revisar y conciliar cualquier divergencia material antes de `--apply` sin introducir cambios silenciosos.**

### Black Friday no es un cuarto plan normal

Promoción separada `commercial-price-landing-black-friday-80-global-v1`: **USD 80, 10 prestaciones y 12 meses de soporte** en la última lectura de PostgreSQL. Su impuesto quedó **sin definición** (`taxMode=null`); no anunciar «IVA incluido» para esta promoción. La fuente histórica `20261029200000_black_friday_landing_80/migration.sql` conserva «1 mes» por ser la migración original; el registro CRM productivo consultado el 5/11 ya indica 12. No reejecutar la migración ni editarla para sincronizar el estado.

## Último inventario productivo documentado (5/11)

- **1 Product, 2 PriceLists, 1 promoción, 0 tarifas EC.** La Landing Básica GLOBAL/USD 250 sigue con «1 mes» en `scope` aunque comercialmente se aprobaron 12.
- **A, `COMMERCIAL_CATALOG_RECONCILE`:** preflight sin conflictos; faltan 8 Product y 8 PriceLists EC/USD para los otros ocho planes, ya definidos con 12 meses. Debe dejar **9 Product y 10 PriceLists** contando la promoción.
- **B, `COMMERCIAL_GLOBAL_LANDING_SUPPORT_12M`:** preflight sin conflictos; cambia únicamente `scope` de base GLOBAL/USD 250 a 12 meses; sin alterar Black Friday. Después, el preflight EC de soporte debe ser `changes=[]` y `failures=[]`.
- **Ninguna operación A/B aplicada.** `HERMES_CRM_ACTIVATION_PREPARATION_BLOCKED` sigue siendo el dictamen del último informe.

## Puertas operativas que siguen bloqueadas

1. Backup completo **actual** y privado, con SHA-256; ubicación, destino externo y retención expresamente aprobados.
2. Restauración real **aislada**, con PostgreSQL compatible y resultado observado `PASS`; no usar dump histórico como si fuera actual.
3. Operaciones **A y B separadas**: aprobaciones comerciales vinculadas a IDs comprobables; autorización operativa específica para cada una, más evidencia Ed25519 válida con `operation`, `approvedMarket`, identidad de BD, `backupId`, `restoreId`, expiración y clave pública protegida.
4. Ejecutar con Node compatible (preferencia Node 22) desde checkout de mantenimiento independiente, sin montar sobre `hermes-app`.
5. Revisar **antes de B** que el script de rollback exige el `authorizationId` original para la reversión y una evidencia nueva con operación de rollback. No suavizar el guard.
6. Validación post-`--apply` (solo cuando se autorice): contar filas, cotejar `AuditLog`, precios, impuesto, `scope`, promociones y selección EC/no EC; comprobar respuesta de Nous sin enviar WhatsApp a clientes reales.

**Próximo estado posible, no alcanzado:** `HERMES_COMMERCIAL_PRODUCTION_ACTIVE`.

## Fuentes

`HERMES_CRM_COMMERCIAL_ACTIVATION_PREPARED_2026-11-05.md`; `ProyectMD/HERMES_OPTION_B_GLOBAL_SUPPORT_12M_2026-11-04.md`; `ProyectMD/HERMES_COMMERCIAL_CATALOG_RECONCILIATION_PLAN_2026-11-04.md`; `scripts/reconcile-commercial-catalog.ts`; `scripts/update-global-landing-support-12m.ts`; confirmación de soporte anual del propietario el 7/11.
