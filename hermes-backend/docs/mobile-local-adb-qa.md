# QA móvil local aislado (Windows / adb reverse)

Este runner **no inicia el backend completo**: monta exclusivamente el router OTP real de UnderCodeEC (`createCrmAuthRouter`, `createCrmOtpStore`) y `AuthController` + `MobileInboxController` de Hermes con Prisma real. No registra Meta, webhook, respuestas salientes, Redis ni proveedores externos. Crea PostgreSQL y MariaDB migrados, un chat WhatsApp ficticio con dos mensajes y Mailpit desechables; no usa `.env`, teléfono, VPS ni bases compartidas.

Requisitos: PowerShell de Windows, Docker Desktop local activo con las imágenes **ya presentes** `postgres:16-alpine`, `mariadb:11.4`, `axllent/mailpit:v1.28` (no descarga imágenes), Node y dependencias instaladas en **este worktree** (`npm ci`, `npx prisma generate`) y en un checkout local del backend UnderCodeEC con `crmAuthRoutes.js`, `crmOtpStore.js`, `sql/20261117_crm_auth_otp.sql` y soporte explícito de `operatorEmail` en la fábrica del router. La variante G2 `g2-mobile-otp-proof` cumple este contrato; otras variantes que ignoran la sustitución se rechazan. Se deben usar una shell limpia, contexto Docker local `npipe`, puertos libres 18081–18084, y no definir `DATABASE_URL`, las variables `HERMES_LOCAL_ADB_*`, `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_TLS_VERIFY` ni `NODE_OPTIONS`.

Desde `hermes-backend/` en el worktree aislado:

```powershell
npm ci
npx prisma generate
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-mobile-local-adb.ps1 -ProviderBackend 'D:\ruta\al\backend\undercodeec' -ConfirmLocalSynthetic YES-SYNTHETIC-LOCAL-ONLY
```

Dejar la consola abierta; cancelar con **Ctrl+C** para cerrar APIs y eliminar contenedores. Para un ensayo automático sin teléfono: añadir `-RehearsalSeconds 10` (1–120); comprueba HTTP OTP → Mailpit → prueba → JWT móvil → Inbox/mensajes y sale limpiando. Si el proceso PowerShell se mata a la fuerza o se corta la energía, verificar manualmente los contenedores `hermes-adb-*` y retirarlos **solo después de confirmar que pertenecen a este ensayo**. Nunca reenviar logs de credenciales ni activar trazas HTTP con cuerpos.

Endpoints loopback: OTP `http://127.0.0.1:18081/api/crm/auth`, Hermes `http://127.0.0.1:18082/api/auth` y `/api/mobile/inbox`, Mailpit `http://127.0.0.1:18083` (SMTP 18084). `GET /__qa/health` en ambas APIs no devuelve secretos; no prueba una sesión. Las DB usan puertos loopback aleatorios, nombres únicos y contraseñas efímeras; `docker rm -f` elimina también sus datos. No copiar URLs de DB, contraseñas, códigos, proofs ni tokens a logs. El correo permitido es exclusivamente `isolated-operator@example.test`.

Para una **futura** prueba Android autorizada, usar el mecanismo estándar `adb reverse tcp:18081 tcp:18081` y `adb reverse tcp:18082 tcp:18082`, apuntando las bases URL de la app a `http://127.0.0.1:18081` y `http://127.0.0.1:18082`. No se ejecuta adb en este runner; Mailpit se consulta desde el host, no en el dispositivo. Tráfico exclusivamente de prueba local HTTP sin TLS: no usar en red compartida, producción ni con datos reales. El aislamiento loopback del host no sustituye el control físico del dispositivo o de otras aplicaciones locales.
