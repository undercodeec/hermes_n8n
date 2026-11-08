# Hermes 2.0 — A7-BF-15: integración definitiva del PR #15

> Edición pública: se omitió la transcripción de una consulta de cliente citada en la versión local. Los resultados técnicos no se alteraron. Algunas rutas relativas históricas apuntan a documentos locales que no forman parte de este PR; el índice A7-BF16 identifica las referencias consultables desde GitHub.

**Dictamen:** `HERMES_A7_BF15_MERGED_VALIDATED`

**Corte de integración:** 2026-11-07 15:45:27 UTC, según GitHub.

**Alcance:** fusión a la rama piloto y validación local del commit integrado. No se publicó imagen ni se accedió a la VPS.

## A. Identificación y control Git

| Concepto | Identidad verificada |
| --- | --- |
| Repositorio y PR | `undercodeec/hermes_n8n`, [PR #15](https://github.com/undercodeec/hermes_n8n/pull/15) |
| Origen | `fix/hermes-black-friday-conversation-20261107` |
| Destino | `pilot/a7-d12-monitor-only-20261026` |
| HEAD origen aprobado | `d3f71458b2507044c16384fbf07a25e16cc2b56f` |
| HEAD piloto previo | `88e9712fd6e16a730fcfd00acee10a25e84a429b` |
| Merge commit y HEAD piloto posterior | `49a7f6adf3776e81fae9675f66b12ad48271dcf3` |
| Tree final | `0498f5bf38b4645858bf67fce42017f0c6ec1572` |
| `main` remoto, sin cambios | `50c3d0f005683ef294d29cb6fab86fb4a8e134e1` |

Antes de fusionar, GitHub confirmó `state=open`, `merged=false`, `mergeable=true`, base y HEAD esperados. La API de archivos devolvió exactamente los nueve nombres aprobados; `git merge-tree` produjo el tree candidato sin conflictos y `git diff --check` aprobó. Se utilizó `PUT /pulls/15/merge` con `merge_method=merge` y el SHA aprobado como condición. GitHub respondió `merged=true`, `Pull Request successfully merged` y el commit de integración anterior. Después confirmó `state=closed`, `merged=true`, `merged_at=2026-11-07T15:45:27Z`; el HEAD remoto piloto coincide con el merge commit. Sus padres son, en orden, el piloto previo y el HEAD aprobado; su tree coincide con el candidato. No hubo squash, rebase, force push ni fusión hacia `main`.

Los cinco commits originales permanecen en la historia integrada: `953eb4ef1689bf6a02152e464939ed51e39172a1`, `c1c44b1e267f5cdb7bd7aa56a68a1fe6318448db`, `b066a9245592df3dfca596d34805c6256c9141cb`, `d51d934a67a1e3d7c4d50659674cba72975e7227` y `d3f71458b2507044c16384fbf07a25e16cc2b56f`.

**Nueve archivos afectados:** `ProyectMD/HERMES_BLACK_FRIDAY_CONVERSATION_FIX_2026-11-07.md`; `hermes-backend/src/hermes/black-friday-landing.ts` y su spec; `hermes-backend/src/auto-replies/black-friday-visual-response.ts` y su spec; `hermes-backend/src/auto-replies/auto-reply.service.ts` y su spec; `hermes-backend/src/conversation-engine/nous-hermes.transport.ts` y su spec. El diff integrado no toca migraciones, esquema Prisma, Dockerfile, dependencias, workflows, configuración de despliegue, tarifas ni variables sensibles.

Se creó un worktree de validación aislado en `D:\Documentos\Hermes\.worktrees\a7-bf15-merged-validation-20261107`, detached en el merge commit. Los worktrees anteriores no se movieron ni limpiaron. El worktree del PR conservó sus 25 archivos generados sin seguimiento; el checkout principal tenía 83 entradas locales previas, preservadas. Los artefactos generados por las pruebas del nuevo worktree permanecen sin seguimiento y no se publicaron.

## B. Validación del commit integrado

Todos los comandos de esta tabla se ejecutaron en el worktree aislado cuyo `HEAD` es `49a7f6adf3776e81fae9675f66b12ad48271dcf3`.

| Gate | Resultado |
| --- | --- |
| `npm ci` | Aprobado; 796 paquetes instalados |
| `prisma validate` con URL local sintética y `prisma generate` | Aprobados; sin conexión a PostgreSQL productivo |
| TypeScript `tsc --noEmit --incremental false` | Aprobado |
| `npm run build` | Aprobado |
| ESLint global, sin `--fix` | Aprobado |
| Prettier, ocho archivos TS del PR, `--end-of-line crlf` | Aprobado |
| Escaneo de secretos | Aprobado; 547 archivos examinados |
| Auditoría `npm audit --omit=dev --audit-level=high` | Aprobado; 0 vulnerabilidades productivas |
| Unitarias completas | 112 suites, 1906/1906 pruebas |
| Comerciales | 4 suites, 233/233 pruebas |
| Focalizadas de Black Friday | 3 suites, 298/298 pruebas |
| Integración aislada | 18 suites, 188 aprobadas, 0 fallidas, 1 omisión permitida |
| A7-D16 aislado | 6 suites, 31/31 pruebas |
| `git diff --check` frente al piloto previo | Aprobado |

La omisión permitida es el registro de intención web BFF v2 en `advertising-flow.integration-spec.ts`; el gate la declara aceptable. Los gates de Docker se ejecutaron secuencialmente sobre PostgreSQL y Redis desechables. No se hicieron llamadas Meta ni entregas WhatsApp reales.

**Incidencia de formato investigada:** Prettier sin opción de fin de línea marcó los ocho TS del PR y también un archivo ajeno. `core.autocrlf=true` convierte LF del índice a CRLF en el worktree Windows (`git ls-files --eol` mostró `i/lf w/crlf`). La comprobación con `--end-of-line crlf` aprobó los ocho archivos sin modificar el código. Una segunda comprobación con la API de Prettier sobre los ocho blobs LF del commit también aprobó; `git diff --check` aprobó. No se reformateó el merge.

**Auditoría de desarrollo:** `npm ci` informó 21 hallazgos en el conjunto total (2 bajos, 18 moderados, 1 crítico). La auditoría con `--omit=dev` halló cero vulnerabilidades productivas. No se aplicó `npm audit fix`; los hallazgos de herramientas de desarrollo requieren seguimiento separado.

GitHub no registra checks, estados ni runs de Actions para el merge commit (conteos cero); el estado combinado `pending` carece de contextos. Los gates de esta sección son evidencia local, no CI. El workflow A7-D16 y el de GHCR son manuales.

## C. Verificación funcional por pruebas aisladas

La suite de servicio cubre una consulta general sobre la promoción USD 80 con Gemini Direct y Nous: una oferta autorizada del CRM produce un batch con índices 0 y 1, dos operaciones Meta simuladas y dos registros de mensaje. La primera parte contiene precio USD 80, saludo, salto de párrafo, diez líneas con emojis y soporte de un año derivado del `scope` del fixture; la segunda es una pregunta comercial independiente. El precio y el soporte dependen de los datos comerciales autorizados, no de un literal impuesto al CRM.

Las pruebas cubren entrada orgánica, anuncio validado, promoción genérica sin contexto, presupuesto personal de USD 80, rechazo de oferta, consulta específica de hosting y soporte, saludo posterior, pregunta ya formulada, F3 de una o dos partes, STOP, handoff, idempotencia y recuperación parcial. No se verificó el `scope` ni el precio productivo en esta operación local.

## D. Reconciliación documental y límites productivos

El preflight anterior citó como última versión documentada R6 (26/10): backend `370f5f97498ef2bad7bdc5ea69e01d19c667b76b`, imagen ID `sha256:4e9d85e29915c516d532d9ad4ea7e885b1c3102ed3cca630a692dadbcb3db297`. Esa referencia fue superada documentalmente por [ESTADO-ACTUAL-HERMES-2026-10-29.md](ESTADO-ACTUAL-HERMES-2026-10-29.md) y el [runbook de despliegue del 29/10](../hermes-backend/docs/deployment-runbook.md), que registran A7-D27: backend `e673417b9f2fa959959c5e0a75fad1d08d006388`, tree `3eb1e163b7ea797a919279204a61ed67110883fb`, digest `ghcr.io/undercodeec/hermes-backend@sha256:92c3f81e8369b8b02f102585a9554ed3d1115b7889b0f411ae8836cd1acb5c7f` y rollback histórico A7-D19 `ghcr.io/undercodeec/hermes-backend@sha256:9e7235982087841d505386bef3d9b13e6ce86c0520211f8d5df78fe29e44ec2e`. El commit A7-D27 y su tree coinciden con objetos Git locales; esto no prueba el digest servido. El reporte original A7-D27 citado por esos documentos no se encontró en el checkout local; las identidades de despliegue provienen de la consolidación documental. No se alteraron los informes históricos.

Los documentos del 29/10 describen Nous comercial operativo con `HERMES_CONVERSATION_ENGINE=gemini_direct`, `HERMES_PILOT_NEW_CONVERSATION_ENGINE=nous_hermes`, `NOUS_PILOT_COMMERCIAL_ENABLED=true`, `NOUS_PILOT_OPERATIONS_ENABLED=true` y `NOUS_PILOT_BUDGET_MODE=MONITOR_ONLY`; son valores de aquel corte, no del runtime actual. F3/F4 figuraban OFF. R6 no debe usarse como rollback automático.

**Preflight obligatorio en VPS para A7-BF16:** leer `/root/evidence/hermes-release-state/current.json` y contrastar su commit, tree, digest, `compose_paths`, flags y rollback con Docker Compose renderizado, contenedor `hermes-app`, imagen efectivamente servida y revisión OCI. Registrar salud, disco, lock operativo, PostgreSQL y migraciones, Redis, colas, trabajos Nous y entregas `PREPARED`/`AMBIGUOUS` antes de cualquier cambio. Confirmar que existe una referencia inmutable y recuperable de la versión realmente servida; preservar trabajos y ledger, sin reintentar entregas ambiguas. Verificar aparte la oferta Black Friday activa, mercado, precio y diez prestaciones del `scope` en el CRM productivo mediante acceso autorizado y de solo lectura. Nada de esto se consultó en esta operación local.

## E. Handoff preparado: A7-BF16 — publicación GHCR y preflight productivo

El candidato exacto para el workflow manual `.github/workflows/hermes-backend-ghcr-manual.yml` es:

```text
source_sha   = 49a7f6adf3776e81fae9675f66b12ad48271dcf3
expected_tree = 0498f5bf38b4645858bf67fce42017f0c6ec1572
```

El workflow se lanza posteriormente desde `main`, verifica que `source_sha` coincide con el HEAD remoto piloto y que el tree coincide, construye `linux/amd64` y comprueba digest y revisión OCI. Los valores predeterminados del workflow son históricos y deben sustituirse. Antes de lanzarlo, reconfirmar que el piloto remoto sigue en ese SHA; cualquier avance exige un nuevo preflight. El Dockerfile y las dependencias no cambiaron en PR #15; la compatibilidad operativa se decidirá con el preflight VPS anterior. Ningún workflow GHCR fue ejecutado, ninguna etiqueta o imagen nueva fue publicada y no hubo despliegue.

**Resultado de A7-BF15:** integración y validación local aprobadas. La publicación, el acceso productivo, la verificación comercial y cualquier prueba WhatsApp real requieren una autorización posterior y evidencia del estado servido actual.
