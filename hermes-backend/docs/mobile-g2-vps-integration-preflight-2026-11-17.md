# G2 móvil: preflight de integración (solo lectura, 2026-11-17 UTC)

**Estado:** NO GO para producción. Ningún PR G2/G3 se integró o desplegó durante esta revisión; no se enviaron correos ni mensajes y no se aplicaron migraciones. Nunca copiar correos de operadores, credenciales, proofs, OTP ni valores `.env` a esta bitácora.

## Evidencia observada en VPS

- Hermes `hermes-app`: imagen efectiva `ghcr.io/undercodeec/hermes-backend@sha256:4003d04037c7c3d28ff0b9c1da1554ea5151764bd4d3b9ab2762c681a3ebadbb`, contenedor activo, `/api/docs` respondió 200 desde loopback. Checkout `/var/www/hermes`: `ad555f0438c6aaf14c009df829ab5e12a4f57287` **no demuestra** el commit dentro de la imagen; preservar ambos datos de forma separada.
- PostgreSQL Hermes: última migración aplicada reportada `20261029200000_black_friday_landing_80`; `20261117190000_mobile_sessions` **no aplicada**. Consulta de solo lectura a `_prisma_migrations`.
- API Express UnderCode: proceso PM2 `node /var/www/html/undercodeec/backend/server.js` iniciado el 13 de noviembre; checkout de esa ruta en `4548ce8e4d04c30ca64b19b2b01e91d76645f4ea`. El código de ese proceso en disco no contiene audiencia móvil ni ruta `mobile/verify-code`: no se ha verificado ninguna API móvil desplegada. La web es **otro artefacto**: `/var/www/current` apunta a versión `444738a08f970da671fc6ed6d02ac5d9a05f76f6`; el cambio de esa web no equivale a actualizar la API PM2.
- Comprobación privada sin revelar valores: el correo de operador configurado en el contenedor Hermes coincide con el operador aceptado por la API Express; el correo de administrador de la configuración utilizada por dicha API coincide también. La clave de proof presente en la configuración de la API coincide con la del contenedor Hermes. Esta comparación estática no prueba entrega SMTP, permisos de BD, ni que una configuración modificada después del inicio esté cargada en memoria.
- Disco raíz al 84 % (9,1 GB libres); memoria 3,8 GiB total y 2,2 GiB disponible en el momento de la consulta. Confirmar espacio para backup, imágenes y restauración aislada antes de programar ventana.

## Artefactos de desarrollo (no desplegados)

| Componente | PR borrador y HEAD | Migración previa requerida |
| --- | --- | --- |
| UnderCodeEC API OTP | websiteUndercodeec #6 `97200497db76db9928276e988dd67720b8f91d8b` | `backend/sql/20261117_crm_auth_otp.sql` en MariaDB/MySQL verificada |
| Hermes backend sesiones | hermes_n8n #29 `64ece8652d2093c118904339b7245b3e48e59aec` | `prisma/migrations/20261117190000_mobile_sessions/migration.sql` en PostgreSQL Hermes |
| App opt-in | hermes_n8n #28 `0d2b069e8f5ff495339758ac8b24b7bc7213cde5` | Ninguna; modo ficticio sigue predeterminado |

## Gates antes de la ventana

1. Ensayar en integración aislada **ambos** procesos con PostgreSQL y MariaDB desechables, operador sintético y servidor SMTP capturador sin relay externo; probar solicitud OTP, verificación móvil y web con códigos distintos, proof de audiencia respectiva, rechazo cruzado/replay, 30 minutos inactivos, refresh, teléfono único y revocación web sin cerrar la web. No conectar Meta ni enviar mensajes. Probar el cliente opt-in en el teléfono contra integración, sin afirmar validación iOS.
2. Verificar en la API UnderCode real la ruta de migración, identidad de la base, backups restaurables, privilegios DML, tablas y límites por IP detrás de proxy; confirmar estrategia PM2 y que la configuración cargada al reiniciar siga alineada entre servicios. Preservar sesiones web existentes y ensayar el cambio del canje web de Hermes respecto a operador deshabilitado. No usar pruebas destructivas en producción.
3. Validar backups de ambas bases mediante restauración aislada, comprobar espacio, digests/commits previos, un único operador configurado, colas y monitoreo. Revisar y aprobar por separado el contrato de Inbox móvil: G2 solo publica autenticación, **no** lectura de chats ni mensajería. Los PR siguen en borrador hasta completar estos gates.

## Secuencia de ventana propuesta (requiere autorización y revisión específicas)

1. Registrar versiones *efectivas* de API PM2 y de la imagen Hermes, estado de la web, backup/restauración y hora de último OTP/proof. Pausar temporalmente **canjes de login**, no el CRM entero; observar que pendientes caduquen. No imprimir pruebas, JWT, correos ni credenciales.
2. Aplicar manualmente SQL aditivo de UnderCode a la base **identificada**, verificar tablas y DML antes de actualizar la API; publicar el HEAD revisado del PR #6 y reiniciar solo la API con el procedimiento PM2 probado. Comprobar disponibilidad y login **web** antes de continuar. El cambio de web Next.js no es requisito automático de este paso.
3. Aplicar migración Prisma aditiva G2 a PostgreSQL identificado, comprobar `_prisma_migrations`; publicar imagen Hermes construida desde el HEAD aprobado del PR #29 por **digest inmutable** y recrear únicamente `hermes-app` con `--no-deps`. La versión/digest G2 aún no existe como artefacto productivo verificado: no sustituirlo por un tag flotante. Comprobar health, reinicios, login web, pruebas negativas móviles y ausencia de efectos sobre mensajería.
4. Solo tras pruebas E2E reales en integración y pruebas de compatibilidad, distribuir app G3 opt-in indicando servidor de integración autorizado; no confundir exportación Android/iOS con verificación de autenticación productiva ni dar acceso a Inbox sin contrato separado.

**Reversión coordinada:** retener tablas, backups, imágenes y versiones antiguas. La API OTP antigua no lee códigos guardados por la nueva: pausar login y esperar la caducidad de pendientes/reemitir al revertir la API. El backend Hermes anterior no consulta el ledger persistente de proofs: antes de arrancarlo, detener canjes y esperar **al menos 210 segundos desde el último proof firmado** (180 s de vida máxima aceptada + 30 s de desviación), salvo rotación coordinada revisada. Volver al digest previo del backend y a la versión PM2 anterior por separado; no ejecutar SQL inverso improvisado ni borrar volúmenes. Los JWT móviles requieren nuevo ingreso tras el rollback; preservar las sesiones web y verificar `/api/docs` y el login web. Una reversión de código no es una restauración de datos: usar solo backups cuya restauración aislada se haya validado.
