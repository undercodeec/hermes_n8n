# G2/G4: ensayo aislado de respaldo y restauración

Este ensayo **no respalda ni restaura datos existentes**. Crea dos contenedores efímeros nuevos (`postgres:16-alpine`, `mariadb:11.4`) con puertos aleatorios ligados exclusivamente a `127.0.0.1`, sin volúmenes ni conexiones a producción. Requiere Docker Desktop local para Windows (contexto `npipe`), PowerShell, `npm ci` en `hermes-backend/` y el archivo SQL G2 OTP del backend UnderCodeEC. No lee `.env` ni acepta una `DATABASE_URL` heredada.

Desde `hermes-backend/` en un checkout limpio de pruebas:

```powershell
npm ci
powershell.exe -NoProfile -File ./scripts/run-mobile-backup-restore.ps1 -UnderCodeSqlPath 'RUTA_ABSOLUTA_AL_BACKEND_UNDERCODEEC/sql/20261117_crm_auth_otp.sql'
```

El parámetro debe apuntar al archivo real `20261117_crm_auth_otp.sql`; nunca a un volcado o una conexión. El script aplica todas las migraciones Prisma de este checkout en una base PostgreSQL **nueva** y ese SQL en una base MariaDB **nueva**, inserta solamente filas de prueba (`synthetic-*` y `restore_fixture`), crea respaldos *dentro* de los contenedores, y los restaura en otras dos bases **nuevas**. Compara estructura (columnas, índices, restricciones y enums/triggers) y conteos de **todas** las tablas, además de exigir las tablas G2/G4 y una fila sintética en las tablas de sesión/prueba/respuesta. No imprime contraseñas, URL ni contenidos del backup.

La limpieza `finally` elimina únicamente los dos contenedores aleatorios propios, junto con sus bases y respaldos internos, incluso si falla una verificación. Después de una interrupción forzada del proceso PowerShell, comprobar manualmente `docker ps -a --filter name=hermes-restore-` y eliminar exclusivamente los contenedores identificados como pertenecientes al ensayo. No usar este script para evidencia de recuperación productiva ni como validación de un backup real: no prueba RPO/RTO, retención, red externa, datos de producción ni restauración en VPS.
