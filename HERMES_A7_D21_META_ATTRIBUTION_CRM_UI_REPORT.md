# Hermes A7-D21 — atribución Meta Ads en el CRM

**Dictamen: `ATTRIBUTION_UI_LOCAL_READY`**
Fecha: 2026-10-28. Alcance: implementación, pruebas y documentación locales. No se integró ni desplegó.

## Base y ramas

| Repositorio | Base | Rama y worktree | Commit de implementación |
| --- | --- | --- | --- |
| Hermes backend | `888a5c02692613e4f524dfda0c63fee150c5a513` | `feat/a7-d21-meta-crm` en `D:\Documentos\Hermes\.worktrees\a7-d21-meta-crm` | `c1479b95d5403ee3c12f0b875bddb41f086ec243` |
| UnderCodeEC Next.js | `4548ce8` | `feat/a7-d21-meta-crm` en `D:\Documentos\undercodeec_nextjs\.worktrees\a7-d21-meta-crm` | `ba36fd6abf516a4c9c0c1963a8203ea92161247a` |

Se conservaron los worktrees de origen y sus cambios preexistentes. Este informe y los documentos de diseño/plan se registran en un commit de documentación posterior.

## Cambios de backend

- La proyección compartida del CRM entrega campos explícitos de conversaciones, mensajes, leads, contactos y handoffs. Descarta `rawPayload`, el `ctwa_clid` crudo, metadatos privados de Nous y otros datos JSON no necesarios. Conserva texto, tipo, remitente, fechas, estado, datos comerciales y el incidente Hermes saneado que requiere la UI.
- `GET /api/conversations` y `GET /api/leads` aceptan `origin=meta_ad|organic|unknown`. El filtro se aplica en SQL antes de `skip`/`take`; el total corresponde al filtro. Los leads sin conversación pertenecen a `unknown`.
- Los listados y detalles de conversaciones y leads incluyen `attribution`. La referencia de anuncio posterior se obtiene en una consulta por lote para las conversaciones de la página, sin cambiar el origen inicial. Las respuestas de creación/edición y las rutas alternas de mensajes/handoffs también se proyectan de forma segura.
- `GET /api/analytics/acquisition` consulta las cohortes WhatsApp en un único SQL agregado. Devuelve conversaciones, mensajes entrantes, referencias posteriores, eventos comerciales verificados no invalidados, solicitudes Nous reservadas y estimación operativa cuando existe una tarifa configurada. `billedUsd` permanece `null`.
- El resumen agrupa por fecha de inicio de conversación en `America/Guayaquil`. Cada cohorte suma los mensajes, conversiones y solicitudes asociados registrados hasta la consulta, aunque ocurran después de la fecha de inicio. No representa el número de conversiones ocurridas *ese día*. El rango máximo es 366 días.

## Cambios de frontend

- Inbox: etiqueta de origen en la lista, filtro, paginación, evidencia de atribución en detalle, ID inicial de anuncio cuando existe y referencias publicitarias posteriores. La suscripción SSE y la recarga de conversaciones se conservaron.
- Pipeline y ficha de lead: etiqueta, filtro, paginación y panel de atribución. El campo comercial `campaignSource` sigue siendo independiente de la evidencia de WhatsApp.
- Nueva sección autenticada **Origen de conversaciones** en `/admin/crm/origen`, separada de la sección actual **Publicidad y atribución**. Incluye rangos Hoy/7/30 días/personalizado, KPIs, distribución por origen, evolución diaria, tabla por ID de anuncio, y estados de carga, vacío y error. Los rangos usan el calendario de Ecuador.
- La interfaz identifica la fuente Hermes y señala que inversión, clics, costo por lead y ROAS no están disponibles sin Meta Marketing API. No inventa campañas, nombres de anuncio ni facturación IA.

## Contrato API definitivo

Las rutas usan el prefijo `/api` del backend y el cliente autenticado existente. Los listados conservan `data`, `total`, `page`, `limit` y `totalPages`.

| Ruta | Parámetros nuevos | Resultado relevante | Autorización |
| --- | --- | --- | --- |
| `GET /api/conversations` | `origin` opcional | Cada fila incluye `attribution`; filtros y paginación existentes se mantienen | JWT, `ADMIN` o `SALES_AGENT` |
| `GET /api/conversations/:id` | — | `attribution` y mensajes saneados | JWT, `ADMIN` o `SALES_AGENT` |
| `GET /api/conversations/:id/messages` | — | Historial paginado con proyección segura | JWT, `ADMIN` o `SALES_AGENT` |
| `GET /api/leads` | `origin` opcional | Cada fila incluye `attribution` | JWT, `ADMIN` o `SALES_AGENT` |
| `GET /api/leads/:id` | — | `attribution` y relaciones saneadas | JWT, `ADMIN` o `SALES_AGENT` |
| `GET /api/analytics/acquisition` | `from` y `to` opcionales, `YYYY-MM-DD` inclusivos, máximo 366 días; predeterminado últimos 30 días | `range`, `totals`, `byOrigin`, `daily`, `byAd`, `sources` | JWT, `ADMIN` o `SALES_AGENT` |

Ejemplo de objeto `attribution` en conversación y lead:

```json
{
  "origin": "meta_ad",
  "evidence": "meta_referral_ad",
  "initialAdSourceId": "123456789",
  "ctwaClidPresent": true,
  "laterAdReferences": [
    { "messageId": "uuid", "occurredAt": "2026-10-28T15:00:00.000Z", "sourceId": "987654321", "ctwaClidPresent": false }
  ]
}
```

`meta_ad` exige `pilotOrigin=meta_ad` y evidencia `meta_referral_ad` o `meta_ctwa_clid`; `organic` exige `pilotOrigin=organic` y `meta_referral_post`; lo demás es `unknown` con evidencia `insufficient`. `initialAdSourceId` puede ser `null`. `ctwaClidPresent` indica presencia y nunca contiene el valor del clic. Las referencias posteriores solo contienen ID del mensaje, fecha, ID de anuncio válido si existe y presencia del clic. El origen inicial no se recalcula con ellas.

El resumen devuelve métricas numéricas `newConversations`, `inboundMessages`, `laterAdReferralMessages`, `qualifiedLeadsVerified`, `contractsWonVerified`, `contractsLostVerified` y `nousRequests` en `totals`, cada elemento de `byOrigin` y cada elemento de `byAd`. `totals` añade `estimatedUsd: number|null` y `billedUsd: null`. `daily` tiene `date`, `meta_ad`, `organic`, `unknown` y `total`. `byAd` usa `sourceId` como identificador, sin nombre inferido. `sources.adsSpend` es `null`.

## Pruebas y verificación

| Verificación | Resultado |
| --- | --- |
| Backend `npm test -- --runInBand --silent` | 97 suites; 1541 pruebas aprobadas |
| Backend `npm run build` | Correcto |
| Backend ESLint dirigido a los archivos nuevos y modificados | Sin errores |
| Frontend `pnpm test` | 172 aprobadas, 1 omitida |
| Frontend `pnpm lint` | Sin errores; 172 advertencias preexistentes en el proyecto |
| Frontend `pnpm build` | Correcto; ruta `/admin/crm/origen` incluida |
| PostgreSQL 18 local aislado, esquema con 26 migraciones y datos sintéticos | Clasificación 1 Meta Ads, 1 orgánico y 3 desconocidos; conteos y paginación por origen; lead sin conversación incluido en `unknown`; resumen de cohorte ejecutado |

La compilación Next.js necesitó ajustar **temporalmente** `turbopack.root` al repositorio original porque este worktree usa una unión local a `node_modules`; se restauró `next.config.ts` antes del commit. La compilación con la configuración y dependencias normales de despliegue debe formar parte de la validación de publicación. No hubo sesión visual autenticada local ni herramienta de navegador para producir capturas; no se adjuntan imágenes simuladas.

## Archivos modificados

Backend: `hermes-backend/src/analytics/analytics.module.ts`; `src/attribution-crm/{acquisition.controller.ts,acquisition.service.ts,acquisition.service.spec.ts,attribution-crm.ts,attribution-crm.spec.ts}`; `src/conversations/{conversations.controller.ts,conversations.service.ts,conversations.service.spec.ts,dto/query-conversations.dto.ts}`; `src/handoff/{handoff.controller.ts,handoff.service.ts,handoff.service.spec.ts}`; `src/leads/{leads.controller.ts,leads.service.ts,leads.service.spec.ts,dto/query-leads.dto.ts}`; `src/messages/{messages.service.ts,messages.service.spec.ts}`.

Frontend: `src/app/admin/crm/_components/{AttributionDetails.jsx,OriginBadge.jsx,CrmShell.jsx}`; `src/app/admin/crm/{crm.css,inbox/page.jsx,leads/page.jsx,leads/[id]/page.jsx,origen/page.jsx}`; `src/lib/hermes/{api.js,meta-attribution.mjs}`; `tests/meta-attribution-crm.test.mjs`.

## Riesgos pendientes y publicación

- La atribución de un lead sigue la conversación enlazada actualmente. Si la lógica comercial existente reasocia un lead a otra conversación, un informe histórico por lead puede cambiar. No se modificó esa lógica ni se inventó un origen permanente del lead.
- La tabla por ID de anuncio contiene solo IDs recibidos de Meta; los anuncios sin ID siguen contados en `meta_ad` y en los totales, pero no aparecen como fila de anuncio. No hay inversión ni costos por lead conciliados.
- El período es una cohorte por inicio de conversación, no una vista de eventos ocurridos dentro del período. Debe conservarse este rótulo al publicar. La inspección visual autenticada con datos controlados queda para el entorno de preproducción.
- Antes de publicar: revisar ambos commits y el contrato, integrar cada rama por separado sobre las bases aprobadas, validar la compilación normal del frontend, ejecutar migraciones **solo si** una integración futura las requiere (esta entrega no añade migraciones), comprobar permisos y el Inbox con datos controlados en preproducción, y aprobar por separado despliegue de backend y frontend. Publicar backend antes de activar la UI que consulta el nuevo endpoint.

## Compatibilidad con Nous activo

No se cambió webhook, recepción, respuesta WhatsApp, generación IA, cuotas, presupuesto, variables comerciales, aprendizaje ni F3/F4. El resumen solo lee `inbound_turns` y los eventos comerciales existentes. La suite de backend incluyó la regresión Nous. No se enviaron mensajes ni se tocaron conversaciones reales, VPS o producción.
