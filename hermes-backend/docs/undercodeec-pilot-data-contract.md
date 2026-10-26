# UnderCodeEC A7-D10-R1: contrato mínimo de datos y evidencia pendiente

## Datos para Hermes CRM

Este contrato describe una futura lectura autenticada del CRM; no añade un dashboard ni publica un endpoint nuevo. El reporte SQL de 30 días (`scripts/undercode-pilot-report.sql`) entrega sus agregados actuales. Para un endpoint, conservar la autorización existente de conversaciones (`ADMIN` o `SALES_AGENT`) y la misma semántica:

| Campo | Origen persistido | Regla |
| --- | --- | --- |
| `origin` | `conversations.metadata.pilotOrigin` y `pilotOriginEvidence` | `meta_ad` con referencia `ad` o `ctwa_clid`; `organic` solo con `source_type=post`; `unknown` sin prueba. Un `organic` antiguo sin evidencia se presenta como `unknown`. No se reclasifica al recibir otra referencia. |
| `initialAdSourceId` | `conversations.metadata.pilotAd.sourceId` | ID recibido de Meta, o `null`; no es nombre ni campaña. |
| `ctwaClidPresent` | `conversations.metadata.pilotAd.ctwaClidPresent` | Booleano de presencia. El valor original solo está en el payload crudo persistido para uso interno autorizado. |
| `laterAdReferences` | Mensajes entrantes con `metadata.pilotOrigin=meta_ad` posteriores al primer entrante | Exponer `messageId`, `sourceId` si existe y fecha; nunca el `ctwa_clid` crudo. El origen inicial queda intacto. |
| `newConversations`, `inboundMessages` | `conversations.createdAt`, `messages.direction=INBOUND` | Conteos del período y número autorizado, sin inferir conversaciones de eventos repetidos. |
| `qualifiedLeadsVerified`, `contractsWonVerified`, `contractsLostVerified` | `advertising_conversions`, enlazadas por `leads.conversationId` | Contar leads distintos solo con `verified=true`, `invalidatedAt IS NULL` y evento real `LEAD_QUALIFIED`, `CONTRACT_WON` o `CONTRACT_LOST`. Cero significa ningún evento verificable en esos registros. |
| `nousRequests`, `estimatedUsd`, `knownTokens`, `knownProviderCostEstimate` | Reservas `nous_hermes_normal`, precio operativo y metadata de respuesta confirmada | La estimación no representa facturación; tokens y costo conocido pueden ser `null`. |
| `billedUsd` | No disponible | Siempre `null` hasta contar con una fuente de factura verificada. |

La lista individual de referencias posteriores se obtiene de `messages.metadata.pilotAd` en orden de creación. El SQL entrega su conteo, no la lista. `sourceId` puede faltar. No sintetizar campaña, nombre de anuncio, conversiones, valor contratado ni gasto. Los datos de una conversación existente fuera del piloto no reciben un origen inventado.

Forma mínima sugerida para la respuesta de lectura, al implementar el endpoint:

```json
{
  "version": 1,
  "windowDays": 30,
  "rows": [
    {
      "origin": "meta_ad",
      "initialAdSourceId": "ad-7",
      "newConversations": 1,
      "inboundMessages": 2,
      "laterAdReferralMessages": 1,
      "qualifiedLeadsVerified": 1,
      "contractsWonVerified": 1,
      "contractsLostVerified": 0,
      "nousRequests": 2,
      "estimatedUsd": "0.04",
      "knownTokens": 100,
      "knownProviderCostEstimate": "0.000003",
      "billedUsd": null
    }
  ]
}
```

La clave `ctwa_clid` se conserva en `messages.rawPayload` y en el evento durable de webhook. La respuesta de mensajes del CRM la elimina del payload presentado sin alterar el registro original. La metadata visible solo expone presencia. No incluir el click ID en logs, reportes, URL, SSE ni respuesta agregada. Restringir lectura del payload original a mantenimiento autorizado conforme a la política de acceso y retención vigente.

## Contrato backend → Nous Agent que debe contrastarse con A7-D8

El backend actual usa `POST http://nous-hermes-api:8642/v1/chat/completions`, Bearer leído de archivo secreto, `Content-Type: application/json`, `model=hermes-agent`, `stream=false` y `messages` con roles `system`, `user` y, para historial, `assistant`. No envía `response_format`, herramientas ni headers de sesión. La respuesta aceptada exige HTTP 2xx, `choices[0].finish_reason=stop`, `choices[0].message.content` como cadena JSON con `replyText` no vacío o `replyParts` de 1 a 6 partes, sin herramientas ni razonamiento. El validador acepta propuestas opcionales de intención, etiquetas, perfil con evidencia literal y una acción propuesta; el CRM decide cualquier acción. `usage.prompt_tokens` y `usage.completion_tokens` son opcionales. El transporte limita tamaño, tiempo y caracteres y trata el 429 según el claim durable.

El handoff histórico del VPS fechado 21/09/2026 documenta un contrato v1 parecido, incluido `finish_reason=error` bajo fallo y 429 por concurrencia. No identifica el artefacto real **A7-D8** ni acredita la configuración actual.

Pedir a Codex VPS únicamente evidencias de lectura, saneadas y fechadas; ninguna prueba debe enviar una inferencia facturable en este cierre:

1. Revisión/commit A7-D8, digest de imagen del agente y del puente HTTP, fecha de despliegue y ruta de configuración activa. Entregar hashes e identificadores, no archivos de secretos ni volcados de variables de entorno.
2. Definición efectiva del endpoint `/v1/chat/completions`: método, autenticación exigida, alias `hermes-agent`, campos de solicitud admitidos y rechazados, límites de body y ruta del puente. Adjuntar archivo o fragmentos saneados con líneas y versión.
3. Esquema efectivo de respuesta: `choices`, `finish_reason`, `message.content`, `usage`, `model`, errores 4xx/5xx y 429. Si existen logs sintéticos previos, entregar una muestra redactada que pruebe el JSON final requerido, sin datos de clientes ni tokens Bearer.
4. Configuración efectiva de aislamiento: ausencia de herramientas y headers de sesión obligatorios, rutas/redes permitidas y semántica de estado entre llamadas. Entregar resultados de inspección, no credenciales ni prompts privados completos.
5. Proveedor/modelo subyacente, límites de concurrencia, tokens, timeout, reintentos y medición/capacidad de gasto actuales. El alias `hermes-agent` por sí solo no demuestra el modelo real ni el costo facturado.
6. Diferencias concretas frente a este backend y al contrato histórico v1. Si falta alguna prueba, marcarla `UNKNOWN`; no certificar compatibilidad A7-D8 por mocks ni por la salud del contenedor.

La publicación requiere una revisión cruzada de esas evidencias con `nous-hermes.transport.ts` y `agent-output.validator.ts`, además de autorización separada para cualquier prueba activa, push, despliegue o activación comercial.
