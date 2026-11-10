# Despliegue y rollback del backend

> **Protocolo vigente**, revisión documental 10/11/2026 contra `ca85b991`. No es autorización ni acta de despliegue. Para ramas, PR y estado actual consultar únicamente [estado del proyecto](../../ProyectMD/estado-proyecto.md).

## 1. Separar las evidencias

Una revisión de código, una publicación GHCR y una observación del contenedor servido son evidencias diferentes. No se deduce la tercera de las dos primeras. Este protocolo consolida la operación general antes repartida entre los runbooks de VPS, Nous y piloto; sus actas fechadas permanecen como antecedentes, no como instrucciones de actualización a `origin/main`.

La publicación se consulta en el [workflow manual de main](https://github.com/undercodeec/hermes_n8n/blob/main/.github/workflows/hermes-backend-ghcr-manual.yml). Ese workflow no existe en el árbol piloto auditado: no inventar un trigger push/merge ni copiarlo para poder desplegar. Al validar una publicación, registrar separadamente:

- SHA del workflow (`headSha` del run) y evento `workflow_dispatch`;
- `source_sha` completo y `expected_tree` del código realmente construido;
- resultado del run, etiqueta inmutable, digest del índice OCI, plataforma elegida y digest de su manifest;
- label `org.opencontainers.image.revision` de la imagen, que debe corresponder al source SHA, no necesariamente al SHA del workflow.

La evidencia fechada de publicación y los PR integrados/abiertos se mantienen en el estado canónico, no se duplican aquí. Un digest de índice no es el digest del manifest de plataforma ni el ID local de imagen.

### Comprobación reproducible de procedencia (solo lectura)

Desde el checkout, con GitHub CLI autenticado, consultar sin lanzar workflows:

```sh
git rev-parse HEAD
git rev-parse HEAD^{tree}
gh pr view 19 --repo undercodeec/hermes_n8n --json state,mergedAt,headRefOid,baseRefName,url
gh run view 42426065900 --repo undercodeec/hermes_n8n --json conclusion,event,headSha,url
gh run view 42426065900 --repo undercodeec/hermes_n8n --log
```

Revisión del 10/11/2026: el [run](https://github.com/undercodeec/hermes_n8n/actions/runs/42426065900) terminó correctamente y sus logs verifican source `ca85b991db1651f5bf500f3fb8e9db95ba9d56f0`, árbol `0f1b57434021587dd46347f03629ac9bac82122f` y revisión OCI. Su `headSha` es el del workflow, no el de esa fuente. Es una comprobación de publicación piloto, **no de producción**. El [PR 19](https://github.com/undercodeec/hermes_n8n/pull/19), head `63bd52a2accfd9100cb4132b16c39ba94dff4bdd`, sigue abierto/no integrado; ese run no contiene su cambio y no se acredita imagen de él. Reconsultar el estado canónico antes de operar y no publicar logs completos sin sanitización.

## 2. Preflight previo a cualquier cambio autorizado

1. Fijar candidato inmutable, árbol y release de rollback. Verificar compatibilidad del esquema y del agente Nous externo; no desplegar una rama por su nombre mutable.
2. Obtener auditoría **de solo lectura** del VPS: imagen/labels, servicios, salud PostgreSQL/Redis, colas y turnos pendientes, ledger de entregas, espacio, configuración efectiva sin secretos y migraciones aplicadas. No hay endpoint general `/health` documentado para este backend; no confundir `/health` del agente Nous con salud del CRM.
3. Obtener aprobación específica para migraciones, cambios de tarifas, políticas, credenciales o flags. Comparar migraciones antes de proponer ejecución: el comando histórico `prisma migrate deploy` no es un paso obligatorio sin revisión.
4. Verificar backup y restaurabilidad en destino aislado, de acuerdo con [retención y recuperación](retention-recovery-policy.md). Nunca restaurar una copia sobre producción para probarla.
5. Registrar qué procesos atienden turnos y cómo se detendrán nuevas admisiones y conciliarán operaciones en vuelo. Preservar `InboundTurn`, reservas de inferencia, `AutomatedDelivery` y operaciones Calendar/pagos.
6. Validar configuración privada y red. [Compose](../docker-compose.yml) requiere archivos externos y `BACKEND_GIT_COMMIT` completo para construir; el backend, PostgreSQL, Redis y n8n se publican solo en loopback. Nous utiliza la red externa `hermes_client_api`; no publicar 8642. No imprimir `docker inspect`/entornos completos ni secretos.

## 3. Preparación y ejecución bajo autorización separada

Para validación local con servicios simulados: `npm ci`, `npx prisma generate`, `npm run build`, `npm test -- --runInBand` desde `hermes-backend`. Consultar [README](../README.md) para harnesses. Esos comandos no prueban despliegue.

Si se prepara una imagen local, [procedencia de imagen](phase0-backend-provenance.md) describe el helper existente. El Dockerfile requiere SHA completo y escribe la label OCI; Compose principal construye desde fuente y **no consume automáticamente una publicación GHCR**. Antes de usar una imagen de registro, el operador debe revisar la configuración efectiva que fija su digest y su plataforma. No mezclar inadvertidamente build local con pull de GHCR.

La ejecución aprobada debe limitarse a los servicios y cambios revisados, conservar las imágenes anteriores y documentar el resultado. No recrear n8n/BD/Redis por conveniencia. No ejecutar seeds históricos para completar un release ni habilitar un proveedor como efecto colateral. Las instrucciones de septiembre que proponen actualizar `origin/main` o migrar indiscriminadamente son históricas y quedan sustituidas por este preflight.

## 4. Verificación posterior

- Capturar revisión y digest efectivamente servidos, hora UTC y configuración no secreta; comparar con el candidato aprobado.
- Verificar conectividad y autenticación con lectura mínima. Un `401` acredita protección de una ruta, no el éxito funcional del flujo completo.
- Solo con autorización, usar conversación QA/operator-owned; comprobar ingreso idempotente, motor seleccionado, resultado validado y entrega confirmada. No usar clientes recientes como sustitutos ni disparar Meta/Ads/Calendar sin permiso.
- Comprobar ausencia de duplicados, entregas ambiguas, colas antiguas y regresiones de CRM. Conservar únicamente identificadores técnicos y evidencia sanitizada.
- Registrar por separado pruebas no ejecutadas y servicios externos no verificados. El despliegue actual sigue sin acreditarse hasta contar con esta observación.

## 5. Rollback

Detener nuevas admisiones conforme a configuración aprobada, conciliar inferencias y entregas en vuelo y restaurar imagen/configuración anteriores compatibles. Un cambio global de motor no borra asignaciones persistidas del piloto; revisar [Nous](nous-hermes-runbook.md) y [operación comercial](commercial-black-friday-runbook.md). Los procesos deben reiniciarse controladamente para leer la nueva configuración; una petición ya enviada no se deshace.

No borrar colas, reservas, resultados durables ni ledger para forzar replay. No hacer rollback de esquema, restore de producción o retiro de aprendizajes como sustituto del rollback de código. Toda reversión de datos/esquema requiere revisión específica. [Rollback learning](f3-rollback.md) conserva la prueba offline y sus límites.
