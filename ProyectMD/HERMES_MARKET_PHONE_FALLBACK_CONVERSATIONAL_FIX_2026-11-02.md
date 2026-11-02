# Hermes: mercado por señales y continuidad comercial

Fecha: 2026-11-02
Base piloto: `56a8b48121463ce653918744031372b7c1807207`
Rama: `fix/market-phone-conversation-20261102`

## Alcance y diagnóstico confirmado

- El webhook toma el WhatsApp del **cliente** de `contacts[].wa_id` y lo guarda como `contact.waId`. `metadata.phone_number_id` identifica el número empresarial receptor y solo se usa para filtrar el webhook. No se ha modificado el webhook productivo.
- `message.referral.source_type = ad` o `ctwa_clid` no vacío se clasifican como referencia publicitaria. Un `source_id` solo se conserva cuando acompaña esa evidencia; `ctwa_clid` sin `source_id` no inventa un anuncio. Un mensaje sin referral queda con origen desconocido.
- La referencia de la primera entrada se guarda en metadata de la conversación. En una conversación existente, cada referencia posterior se guarda en metadata del mensaje; el CRM presenta esas referencias posteriores sin cambiar el origen inicial. Para contexto comercial se toma la referencia más reciente, con límite de siete días y ventana configurada de campaña. Un anuncio posterior desconocido no reactiva uno anterior conocido.
- El código anterior resolvía mercado con texto, anuncio, perfil e historial, pero no con `contact.waId`. La frase de verificación en `answerExplicitPriceIfMissing()` reemplazaba totalmente una respuesta segura. Si Nous devolvía «Gracias por confirmarlo», no había una continuación determinista. Los filtros de nombre aceptaban `MRS` y títulos similares.
- Había una ruta que seleccionaba una promoción GLOBAL/USD cuando el proyecto era explícitamente español y el mensaje mencionaba dólares. La nueva selección filtra primero por mercado y luego por moneda.

### Hipótesis y límites de la auditoría Meta

**NO VERIFICADO:** que Instagram falle o que Facebook e Instagram produzcan payloads distintos. El código trata cualquier referencia `ad` con los mismos campos; no hay un campo de plataforma validado en la proyección conservada que permita atribuirla a Facebook o Instagram por separado. Las pruebas de ambas procedencias usan payloads sintéticos equivalentes; no son evidencia de tráfico real de esas plataformas.

**NO VERIFICADO:** la proporción real de entradas sin `source_id`, solo con `ctwa_clid` o sin referral; la prevalencia de referencias posteriores; la situación actual de PriceList ES/EUR en el CRM productivo. Este trabajo no consultó PostgreSQL productivo ni volcó payloads, números, click IDs o identificadores de mensajes. La auditoría anterior había observado GLOBAL/USD 80 activa y ninguna ES/EUR; ese estado puede haber cambiado.

Consulta sugerida para un operador con acceso **solo lectura**, agregada y sin identificadores personales:

```sql
BEGIN TRANSACTION READ ONLY;
SELECT date_trunc('day', "createdAt") AS dia,
       count(*) AS entradas,
       count(*) FILTER (WHERE "rawPayload"->'referral' IS NOT NULL) AS con_referral,
       count(*) FILTER (WHERE "rawPayload" #>> '{referral,source_type}' = 'ad') AS tipo_ad,
       count(*) FILTER (WHERE nullif("rawPayload" #>> '{referral,source_id}', '') IS NOT NULL) AS con_source_id,
       count(*) FILTER (WHERE nullif("rawPayload" #>> '{referral,ctwa_clid}', '') IS NOT NULL) AS con_ctwa_clid
FROM messages
WHERE direction = 'INBOUND' AND "createdAt" >= now() - interval '7 days'
GROUP BY 1 ORDER BY 1;
ROLLBACK;
```

Para contrastar Facebook e Instagram se requiere una muestra de campañas identificadas fuera del webhook y una revisión autorizada de sus entradas, sin copiar identificadores sensibles al informe. La consulta anterior mide presencia de campos, no demuestra plataforma de origen.

## Cambio implementado y precedencia

`CommercialMarketResolver` interpreta `waId` con `libphonenumber-js`, después de normalizar y validar el formato internacional completo. `+34` se asocia a ES/EUR y `+593` a EC/USD; cualquier otro país o número inválido queda sin mercado telefónico. El prefijo describe la línea, no la residencia ni el país del proyecto.

| Prioridad | Señal | Código de inferencia |
|---:|---|---|
| 1 | País explícito del proyecto en el mensaje actual | `EXPLICIT_PROJECT` |
| 2 | Ad ID reconocido, permitido y vigente | `VERIFIED_META_AD` |
| 3 | País explícito en el mensaje actual | `EXPLICIT_CUSTOMER_MARKET` |
| 4 | Moneda explícita actual | `EXPLICIT_CUSTOMER_CURRENCY` |
| 5 | Mercado del CRM o proyecto explícito confirmado antes | `CRM_CONFIRMED` |
| 6 | Prefijo validado de `contact.waId` | `PHONE_COUNTRY_CODE` |
| 7 | Mención histórica de país | `HISTORY` |
| 8 | Sin señal suficiente o mensaje ambiguo | `UNKNOWN` |

El snapshot separa `market` (mercado comercial), `phoneCountry`, `projectCountry`, `requestedCurrency`, `adAttributionSource` y `marketInferenceSource`. `marketSource` conserva los alias anteriores para compatibilidad; la inferencia precisa está en `marketInferenceSource`. Ni el prefijo ni la moneda inferida se persisten como país del proyecto confirmado en el CRM. Una contradicción entre país del proyecto **actual** y anuncio verificado bloquea importes hasta una aclaración; un anuncio nuevo puede superar una mención histórica de otro proyecto.

Si el cliente propone un proyecto para «España o Ecuador», el mercado queda ambiguo y no se autoriza una tarifa por escoger la primera palabra. Una mención previa explícita del país del proyecto prevalece sobre un perfil CRM antiguo de otro mercado. Una moneda histórica tampoco restringe una promoción del mercado inferido por el teléfono cuando el mensaje actual no la repite.

## Tarifas y conversación

`CommercialAuthorityService` sigue siendo la única fuente de ofertas y sigue exigiendo PriceList activa, vigente, elegible y compatible. Se mantiene la base vinculada a la promoción; no se crearon ni actualizaron tarifas. Una promoción española no utiliza GLOBAL/USD, no convierte USD a EUR y no presume impuestos. La autorización del propietario para **80 EUR finales** no equivale por sí sola a una PriceList habilitada.

Cuando falta la tarifa aplicable, el sistema indica cuál debe confirmarse, conserva información segura de la landing y deja una pregunta de descubrimiento si faltan datos. Un «Euro y España» o «Ahora que» retoma el contexto y evita volver a preguntar el país o el tipo de proyecto ya conocido. El filtro de nombres elimina `MRS`, `MR`, `SR`, `SRA`, `CLIENTE` y `UNKNOWN`, pero permite nombres reales en mayúsculas. El prompt de Nous comunica la menor confianza del prefijo y pide continuidad sin promesas de handoff no ejecutado. Los controles de opt-out, handoff, deduplicación y revisión final permanecen.

Una pregunta puntual sobre hosting o soporte conserva su respuesta específica segura aunque mencione España y no exista aún tarifa española; el reparador de continuidad solo trata como confirmación una respuesta breve de país o moneda.

## Requisitos pendientes de CRM para España

Antes de publicar **80 EUR finales** para la landing española, un responsable comercial debe verificar en el CRM productivo:

1. Producto `LANDING_PAGE` activo y alcance exacto aprobado.
2. PriceList base **ES/EUR** real y aprobada, con importe normal y condiciones fiscales expresas; no copiar ni convertir la base GLOBAL/USD ni suponer 250 EUR.
3. PriceList promocional **ES/EUR 80**, activa dentro de la vigencia aprobada, vinculada a la base mediante `supersedesPriceListId`, con tipo `FIXED`, política Black Friday y condiciones fiscales autorizadas.
4. Configuración de Ad ID español `52583085497631` en la lista permitida y ventana de campaña correcta. La promoción ecuatoriana usa el Ad ID `52581450998031` y su PriceList USD correspondiente.

Estas son condiciones para una operación comercial posterior. Esta rama no escribe en PostgreSQL productivo ni modifica precios.

## Regresiones y validación local

- Resolución: prefijos ES/EC, país del proyecto distinto del teléfono, país de proyecto confirmado en historial, país ambiguo en un mismo proyecto, perfil CRM anterior contradictorio, moneda histórica frente a prefijo, anuncio verificado sobre teléfono e historial, moneda explícita y ausencia de ES/EUR.
- Atribución existente: `source_id` reconocido/desconocido, `ctwa_clid` sin ID, referencia posterior, caducidad, origen inicial conservado y clasificación común de referencias `ad`.
- Conversación: confirmación «Euro y España», continuación «Ahora que», preguntas puntuales sobre hosting y soporte, ausencia de precio español, conservación de explicación segura y una pregunta como máximo, filtro de títulos de nombre y origen de mercado comunicado a Nous.
- Suite unitaria final: **104 suites, 1.729 pruebas aprobadas**.
- Integración general aislada: **18 suites ejecutadas, 188 aprobadas, 0 fallidas, 1 omisión permitida preexistente**. PostgreSQL y Redis desechables en puertos loopback.
- A7-D16 aislada: **6 suites, 31 pruebas aprobadas**. Emitió una advertencia `MaxListenersExceededWarning` del harness, sin fallos.
- Build, Prisma validate con URL sintética, `security:secrets` y ESLint global: **aprobados sobre el árbol final**.
- No se enviaron WhatsApp reales ni se invocó un proveedor Nous productivo. Las respuestas de prueba son fixtures, no evidencia productiva.

## Riesgos, privacidad, despliegue y rollback

- **Riesgo comercial:** un prefijo puede corresponder a una línea usada en otro país. Por ello solo es respaldo; una señal explícita o anuncio verificado lo supera. Si el CRM no tiene la tarifa española compatible, se informa de la falta de confirmación sin cifra.
- **Privacidad:** se reutiliza `contact.waId`; no hay columnas nuevas de datos personales. El webhook ya conserva el payload crudo, que puede incluir `ctwa_clid`; este cambio no lo duplica ni lo imprime. Los diagnósticos propuestos son agregados.
- **Despliegue:** revisar y aprobar el PR; verificar con acceso solo lectura las PriceLists y la configuración de anuncios; ejecutar las validaciones sobre el commit final; desplegar mediante el proceso operativo existente; observar respuestas anonimizadas de ambos mercados y las rutas de handoff/STOP antes de ampliar tráfico.
- **Rollback:** revertir el commit de la rama y desplegar el artefacto anterior. No hay migración ni cambio de datos que revertir. No activar una PriceList nueva como parte del rollback de código.
