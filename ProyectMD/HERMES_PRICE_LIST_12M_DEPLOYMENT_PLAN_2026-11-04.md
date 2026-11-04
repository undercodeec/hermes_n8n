# Plan operativo: soporte de 12 meses en PriceList

## Separación

La implementación de código es local. No se ejecutó ninguna actualización de PostgreSQL productivo, despliegue, migración ni reinicio. Codex VPS debe ejecutar este mantenimiento como una operación independiente, después de aprobar el PR y contar con autorización operativa. El script actual cubre **solo las ocho tarifas EC/USD propuestas**; Landing Básica GLOBAL/USD se excluye hasta contar con justificación y aprobación independientes.

## Preflight y backup

1. Obtener backup PostgreSQL íntegro y verificar restaurabilidad. Registrar identificador, fecha, responsable y ubicación segura. No incluir datos de clientes en el PR.
2. En VPS, inspeccionar las ocho combinaciones EC/USD reales `Product.sku` / `PriceList.id`, mercado, moneda, precio, impuestos, vigencia, estado, scope, `policyVersion` y promociones. No presumir presencia por migraciones históricas.
3. Ejecutar solo preflight: `npx ts-node scripts/update-commercial-support-12m.ts`. El programa imprime antes/después y divergencias. Guardar ese reporte como evidencia privada.
4. Bloquear si falta un plan, no hay exactamente una tarifa EC/USD activa, el importe o IVA difiere, faltan scope/version o existen condiciones de soporte inesperadas. Las promociones Black Friday y tarifas GLOBAL se excluyen.

## Aplicación posterior autorizada

Con un backup verificado y autorización comercial/operativa identificable:

`npx ts-node scripts/update-commercial-support-12m.ts --apply --authorization-id <AUTH-ID> --backup-id <BKP-ID> --evidence-file <RUTA_ABSOLUTA>`

El script usa Prisma en transacción SERIALIZABLE, revalida el catálogo y compara el scope y `updatedAt` originales antes de cada escritura. Cambia solo `PriceList.scope` y crea un `AuditLog` por tarifa afectada. Registra antes, después, ID de tarifa, SKU, motivo, autorización, backup y fecha del log. Repetirlo no genera cambios cuando el soporte ya es de 12 meses. No altera precio, impuestos, moneda, mercado, vigencia, promociones ni otras prestaciones. No se ejecuta en el arranque del backend ni en migraciones generales.

## Verificación y rollback

Tras aplicar, repetir preflight y verificar las ocho respuestas CRM en EC; comprobar modalidades ordinaria/VIP y ausencia de duplicados. Si una cláusula debe revertirse, usar su audit ID:

`npx ts-node scripts/update-commercial-support-12m.ts --rollback-audit-id <AUDIT_ID> --authorization-id <AUTH-ID> --backup-id <BKP-ID> --evidence-file <RUTA_ABSOLUTA>`

El rollback exige que el scope actual coincida exactamente con el estado posterior auditado; registra su propia auditoría. Si hubo otra modificación comercial, detener y revisar manualmente. Conservar el backup para recuperación de base completa según el runbook VPS. Aplicación y rollback requieren evidencia firmada específica de la operación, backup reciente con SHA-256 y restauración aislada verificada. La clave pública confiable y el archivo protegido permanecen fuera del repositorio, según el plan de reconciliación del catálogo.

## Dependencias y riesgos

El script no se ejecutó contra ninguna base productiva. La validación de los ocho registros productivos, el backup y la aprobación operativa siguen pendientes. Mientras tanto, las respuestas mantienen como autoridad la PriceList vigente, que podría seguir mostrando soporte antiguo. Landing Básica GLOBAL/USD conserva su estado actual hasta una decisión separada.
