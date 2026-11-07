# Hermes 2.0 — Estado consolidado al 7 de noviembre de 2026

> **Fuente y límite:** síntesis documental a partir de los informes de Codex Local/VPS del 5 de noviembre, archivos previos del proyecto, código en GitHub (`pilot/a7-d12-monitor-only-20261026`) y caso de conversación comunicado por el propietario el 7 de noviembre. **No constituye una inspección en vivo del VPS el 7 de noviembre.** No reescribe las actas históricas.

## Dictamen ejecutivo

- **Backend:** `HERMES_BACKEND_DEPLOYED_CRM_ACTIVATION_PENDING`. El segundo despliegue app-only quedó validado en VPS el **5/11/2026**; sin rollback. El backend respondió `/api/docs` HTTP 200, no mostró reinicios y mantuvo PostgreSQL, Redis, Nous, bridge y n8n operativos. Estas afirmaciones corresponden al último informe de VPS disponible, no a una comprobación nueva de hoy.
- **Catálogo:** `HERMES_CRM_ACTIVATION_PREPARATION_BLOCKED`. Los preflights A y B concluyeron sin conflictos; **no se ejecutó `--apply`**. Faltan backup actual, restauración aislada validada, autorizaciones operativas independientes y evidencias Ed25519 para las escrituras comerciales.
- **Calidad conversacional:** **incidencia abierta, observada el 7/11**. Una consulta «hola quiero mas informacion de la promocion de $80.00» recibió una sola respuesta breve en vez del listado completo con emojis y la pregunta en un segundo mensaje físico. La causa probable está localizada en reglas de selección/formatos del código; **la corrección está propuesta, no implementada, ni probada ni desplegada**.

## Identidad del último backend reportado en producción

| Campo | Valor |
| --- | --- |
| Repositorio | `undercodeec/hermes_n8n` |
| Rama piloto examinada | `pilot/a7-d12-monitor-only-20261026` |
| Commit / revisión OCI | `88e9712fd6e16a730fcfd00acee10a25e84a429b` |
| Git tree | `906546252c7d63af5fb6951b675f1c4ca7784388` |
| Imagen aprobada y desplegada | `ghcr.io/undercodeec/hermes-backend@sha256:f669a608d0739fdfbdd687d83c0617208cd24be715365a4e10dae34241c3b730` |
| Publicación | GitHub Actions run `42057833032`, `success`, `linux/amd64` |
| Imagen anterior para rollback app-only | `ghcr.io/undercodeec/hermes-backend@sha256:5efdd8b8f8be60ca2eea42e492bd80d95453b808a234101508c1c8fb426c3e89` |
| Informe de validación | `HERMES_BACKEND_PRODUCTION_DEPLOY_RETRY_2026-11-05.md` |

El primer intento de release (`sha256:a68c4ec8...`) fue revertido porque faltaba `/app/dist/main.js`. El PR **#13** corrigió la raíz de compilación Nest y agregó comprobaciones obligatorias en Docker; **la imagen reparada sí arrancó**. Los PR **#11, #12, #9, #10 y #13** constan fusionados en la rama piloto. No confundir el rollback de la imagen defectuosa con el segundo despliegue exitoso.

## Estado de QA y límites

Últimos gates locales del release reparado: 1.855 pruebas unitarias, 188 de integración aislada (más una omisión autorizada), 31 A7-D16, 9 comerciales; TypeScript, build, ESLint, Prisma y secretos correctos; `npm audit --omit=dev` con 0 alertas productivas. Quedan 21 avisos de dependencias de desarrollo documentados. La prueba del contenedor publicado con PostgreSQL/Redis desechables devolvió HTTP 200. **No es evidencia de un flujo WhatsApp E2E real del 7/11.**

En VPS se verificaron conectividad y sondas comerciales de solo lectura. STOP, opt-out, handoff y deduplicación conservaron evidencia aislada, pero no se recorrieron con mensajes reales en producción. El error periódico anterior `WebhookService ... reading 'trim'` sigue abierto y no fue atribuido al nuevo release.

## Catálogo y condiciones comerciales definitivas

| Línea | Plan | Precio USD | Soporte |
| --- | --- | ---: | --- |
| Sitio Web | Lanzamiento | 360 | 12 meses |
| Sitio Web | Crecimiento | 510 | 12 meses |
| Sitio Web | Autoridad | 1.010 | 12 meses VIP prioritario |
| Tienda Online | Lanzamiento | 550 | 12 meses |
| Tienda Online | Crecimiento | 850 | 12 meses |
| Tienda Online | Élite | 3.490 | 12 meses VIP prioritario |
| Landing Page | Básica | 250 | 12 meses (**pendiente de actualizar en CRM**) |
| Landing Page | Pro | 600 | 12 meses |
| Landing Page | Premium | 1.500 | 12 meses |

Precios normales aprobados para EC/USD, IVA incluido según fichas/definiciones aprobadas. La oferta **Black Friday — Landing Page** es independiente: **USD 80, 10 prestaciones, 12 meses de soporte** en su PriceList productiva del último corte; su tratamiento fiscal no está definido, por lo que **no anunciar IVA incluido** para la promoción sin respaldo en CRM. La migración histórica original aún dice «1 mes»; el registro productivo consultado el 5/11 dice **12 meses**. Prevalece la PriceList vigente para lo que Nous puede afirmar, no una migración histórica ni un catálogo estático.

**Estado real del catálogo al último inventario:** 1 Product, 2 PriceLists, 1 promoción y 0 tarifas EC. La base GLOBAL de Landing Básica conserva **1 mes** en el `scope` productivo; los ocho productos/tarifas EC no existen todavía. La regla **comercial** de 12 meses para todos está aprobada por el propietario el 7/11, pero **no equivale a datos ya aplicados**.

### Operaciones de catálogo pendientes

- **A — `COMMERCIAL_CATALOG_RECONCILE`:** crear únicamente 8 Product y 8 PriceLists EC/USD ausentes, con precios/alcances y soporte de 12 meses aprobados; sin tocar la promoción ni la GLOBAL.
- **B — `COMMERCIAL_GLOBAL_LANDING_SUPPORT_12M`:** actualizar exclusivamente el `scope` de `commercial-price-landing-basic-global-v1` (USD 250) de 1 a 12 meses; conservar Black Friday intacto.
- Los preflights A/B terminaron sin conflictos el 5/11. Ningún `--apply` está acreditado. Requieren backup reciente con restauración aislada real, SHA-256, evidencias firmadas Ed25519, aprobación y autorización operativa **por separado**. No tratar la autorización comercial como permiso de saltarse estos gates. El entorno de mantenimiento utiliza Node 20; conviene alinearlo con Node 22. Revisar la restricción del ID de autorización para rollback B antes de ejecutarlo.

## Incidencia de WhatsApp Black Friday — 7/11

**Entrada reportada:** «hola quiero mas informacion de la promocion de $80.00». **Respuesta observada:** un único párrafo que ofrece USD 80, enumera beneficios parciales y termina preguntando por el negocio.

**Hallazgos en la rama piloto:** `asksForBlackFridayDetails()` no identifica «quiero más información»; la ruta de listado también puede depender de `verifiedAdCampaign`; `nous-hermes.transport.ts` favorece explícitamente una respuesta breve en consultas generales; una prueba existente espera una sola parte sin atribución Meta. El origen del lead debe servir a la atribución, no impedir la información autorizada. Son hipótesis técnicas apoyadas por código; el caso exacto requiere correlación de logs/entregas para demostrar qué rama ejecutó.

**Resultado deseado aprobado:** para una primera solicitud general sobre promoción activa, mensaje físico **1** con saludo cordial y localizado, precio autorizado y **10 líneas de emojis/prestaciones** con saltos de línea; mensaje físico **2** con una pregunta de descubrimiento contextual. Preguntas puntuales («¿Incluye hosting?») deben obtener respuesta breve y sin repetir lista. Usar hora IANA validada (para Ecuador, `America/Guayaquil`) y tratamiento neutral ante nombre ambiguo; no adivinar género. Conservar STOP, privacidad, idempotencia, límites F3, ventana WhatsApp y CRM como fuente de verdad. **Pendiente de PR, gates, GHCR y despliegue independiente.**

## Otras líneas y restricciones

Nous comercial permanece activo en el piloto según los informes; **F3/F4/aprendizaje no se deben describir como autónomos o habilitados**. Flags de aprendizaje y canary guard seguían apagados en el informe del 5/11. No consta aquí nuevo cierre de política de privacidad/retención ni backup externo. El frontend de CRM es un despliegue independiente; este corte no lo modifica ni lo vuelve a certificar.

## Prioridad de trabajo

1. **Respuesta Black Friday:** PR focalizado, pruebas de 2 partes físicas, horarios, contexto, ausencia de Meta attribution y seguridad. No despliegue automático.
2. **Catálogo A/B:** resolver las autorizaciones y los gates de respaldo/restauración; ejecutar solo cuando estén satisfechos.
3. **Operación:** observar el error `WebhookService.trim`; revisar privacidad, backups, y comprobaciones E2E autorizadas sin clientes reales.

## Fuentes de precedencia

1. `HERMES_BACKEND_PRODUCTION_DEPLOY_RETRY_2026-11-05.md` — último backend reportado sirviendo.
2. `HERMES_CRM_COMMERCIAL_ACTIVATION_PREPARED_2026-11-05.md` — último inventario, preflights y bloqueos A/B.
3. `HERMES_DOCKER_ENTRYPOINT_FIX_HANDOFF_2026-11-05.md` — corrección PR #13 e imagen.
4. Código GitHub del commit `88e9712f…` — reglas conversacionales que aún estaban desplegadas.
5. Caso aportado por el propietario el 7/11 — evidencia de experiencia del cliente, pendiente de correlación operativa.
6. Informes 29/10, 2/11, 4/11 y `ProyectMD/estado-proyecto.md` — **históricos**, no reemplazan los cortes posteriores.
