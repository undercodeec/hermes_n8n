# G2/G4: ensayo aislado de respaldo y restauración

## Deuda técnica aceptada por el propietario — 18/11/2026

El propietario decidió posponer la restauración aislada de backups **productivos** hasta ampliar la capacidad del VPS. Esta decisión permite continuar las validaciones no productivas, pero no constituye evidencia de que exista un backup recuperable ni acredita RPO/RTO. La deuda sigue abierta: al disponer de capacidad, identificar respaldos de PostgreSQL y MariaDB, espacio y destino aislado; verificar integridad y restauración bajo protocolo y registrar tiempos y resultados sin datos privados. No confundir rollback de código con recuperación de datos. Cualquier migración o despliegue productivo antes de cerrar esta deuda requiere presentar expresamente el riesgo residual, alternativas, impacto y una decisión operativa específica; no queda autorizado automáticamente por esta anotación.

**Actualización tras la decisión operativa específica del 18/11/2026:** el propietario autorizó continuar en el VPS real aceptando el riesgo residual de recuperación no verificada. Antes de migrar, se crearon backups nuevos de PostgreSQL (custom) y MariaDB (comprimido) en `/var/backups/hermes-mobile-20261118T155555Z-4c8f025f`, directorio restringido a `root`; se verificaron archivos, checksums e integridad de lectura. **No hubo restauración aislada de datos productivos** ni validación del backup externo. La aprobación permitió el despliegue realizado, pero **no cierra `BACKUP-01`**, no acredita recuperabilidad ni autoriza automáticamente operaciones posteriores. Véase el registro de versiones y límites en [`mobile-vps-real-integration-plan-2026-11-18.md`](mobile-vps-real-integration-plan-2026-11-18.md).

Este ensayo **no respalda ni restaura datos existentes**. Crea dos contenedores efímeros nuevos (`postgres:16-alpine`, `mariadb:11.4`) con puertos aleatorios ligados exclusivamente a `127.0.0.1`, sin volúmenes ni conexiones a producción. Requiere Docker Desktop local para Windows (contexto `npipe`), PowerShell, `npm ci` en `hermes-backend/` y el archivo SQL G2 OTP del backend UnderCodeEC. No lee `.env` ni acepta una `DATABASE_URL` heredada.

Desde `hermes-backend/` en un checkout limpio de pruebas:

```powershell
npm ci
powershell.exe -NoProfile -File ./scripts/run-mobile-backup-restore.ps1 -UnderCodeSqlPath 'RUTA_ABSOLUTA_AL_BACKEND_UNDERCODEEC/sql/20261117_crm_auth_otp.sql'
```

El parámetro debe apuntar al archivo real `20261117_crm_auth_otp.sql`; nunca a un volcado o una conexión. El script aplica todas las migraciones Prisma de este checkout en una base PostgreSQL **nueva** y ese SQL en una base MariaDB **nueva**, inserta solamente filas de prueba (`synthetic-*` y `restore_fixture`), crea respaldos *dentro* de los contenedores, y los restaura en otras dos bases **nuevas**. Compara estructura (columnas, índices, restricciones y enums/triggers) y conteos de **todas** las tablas, además de exigir las tablas G2/G4 y una fila sintética en las tablas de sesión/prueba/respuesta. No imprime contraseñas, URL ni contenidos del backup.

La limpieza `finally` elimina únicamente los dos contenedores aleatorios propios, junto con sus bases y respaldos internos, incluso si falla una verificación. Después de una interrupción forzada del proceso PowerShell, comprobar manualmente `docker ps -a --filter name=hermes-restore-` y eliminar exclusivamente los contenedores identificados como pertenecientes al ensayo. No usar este script para evidencia de recuperación productiva ni como validación de un backup real: no prueba RPO/RTO, retención, red externa, datos de producción ni restauración en VPS.
