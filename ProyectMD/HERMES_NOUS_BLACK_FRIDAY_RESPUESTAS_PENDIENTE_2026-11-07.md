# Hermes / Nous — Incidencia de respuesta Black Friday (7/11/2026)

> **Estado: DIAGNOSTICADO; CORRECCIÓN NO IMPLEMENTADA.** Este documento fija comportamiento esperado y pruebas; **no** certifica nuevo PR, commit, imagen GHCR, envío Meta ni despliegue.

## Caso observado

**Cliente (7/11/2026, 04:19, zona horaria reportada Ecuador):** «hola quiero mas informacion de la promocion de $80.00».

**Respuesta reportada:** «Hola. La promoción de Black Friday para Landing Page tiene un valor fijo de 80.00 USD. Está diseñada en una sola sección enfocada en captar clientes, adaptada a celulares y con botones directos de contacto. ¿De qué trata su negocio o servicio para comentarle cómo le serviría?».

La respuesta confirma parte del precio/alcance, pero **omite el inventario completo**, no utiliza lista visual y contiene la pregunta en el mismo mensaje. El propietario requiere una conversación visual de **dos envíos físicos** para primera solicitud general de detalles, sin depender del origen publicitario.

## Código revisado y causas plausibles

| Archivo | Hallazgo verificado en commit `88e9712f…` | Impacto |
| --- | --- | --- |
| `src/auto-replies/black-friday-visual-response.ts` | `asksForBlackFridayDetails()` reconoce «qué incluye», «detalle completo», etc.; no «quiero más información». | La intención general puede pasar a respuesta breve. |
| `src/auto-replies/auto-reply.service.ts` | Una ruta del listado depende de `priorityCampaignInquiry && verifiedAdCampaign` si la intención de detalles no se detectó. | La atribución Meta puede cambiar el formato. |
| `src/conversation-engine/nous-hermes.transport.ts` | Instruye un solo mensaje breve para consulta general; reserva lista completa a «qué incluye». | El modelo puede resumir en lugar de enumerar. |
| `src/auto-replies/auto-reply.service.spec.ts` | Hay prueba que espera `parts.length === 1` en primera consulta general sin Meta. | La expectativa actual perpetúa el comportamiento antiguo. |
| `src/hermes/customer-salutation.ts` | Tratamiento formal conservador por nombre/preferencia; no determina horario del cliente. | No garantiza «Buenos días/tardes/noches». |
| `src/automated-deliveries/automated-delivery.service.ts` | Hay lote ordenado por `partIndex` y ledger durable. | Se puede enviar 2 veces sin inventar otro transporte. |

**Precisión:** `detailParts.join(' ')` compone texto consolidado, pero **no necesariamente une los envíos físicos**: cuando existen `detailParts`, también se preservan como arreglo para `prepareBatch`. El problema principal es la **activación de la ruta detallada**. No atribuir el fallo particular a un único `if` sin correlacionar `sourceMessageId`, motor y lotes.

## Contrato conversacional propuesto (por aprobar en código)

**Regla:** primera solicitud general identificable de la promoción Black Friday que esté **activa, vigente y aprobada en el CRM** → entregar precio y **diez** prestaciones autorizadas, seguidas de una pregunta en segundo mensaje físico. Debe funcionar tanto por WhatsApp orgánico como por Meta Ads. No convertir moneda ni inferir IVA para Black Friday.

**Mensaje físico 1 — ejemplo de mañana, contacto sin nombre validado:**

```text
Buenos días. Con gusto le comparto la información de nuestra promoción Black Friday por USD $80.

🎯 Captación de clientes potenciales
🖥️ Landing Page de una sola sección
📱 Diseño responsive, optimizado para celulares
💬 Botón flotante de WhatsApp y llamada directa
📝 Formulario de contacto o captura de prospectos
⭐ Sección de beneficios de su servicio o producto
🌍 Dominio .com y hosting básico por 1 año
📧 5 correos corporativos
🔍 SEO técnico base
🛠️ *1 año de soporte técnico posterior a la entrega*
```

**Mensaje físico 2:**

```text
Cuénteme, por favor, ¿qué tipo de proyecto o solución tiene en mente?
```

Para «estimado Carlos»/«estimada María», usar exclusivamente el tratamiento autorizado por el resolutor actual, sin inferir identidad de género. Para una empresa o tratamiento ambiguo, saludo neutral. La zona horaria debe ser IANA verificada; Ecuador usa `America/Guayaquil`. Documentar las franjas de buenos días, tardes y noches, **incluida la madrugada**, antes de implementar; evitar depender del reloj UTC del servidor.

El saludo y la pregunta son plantillas orientativas: **el precio, la moneda, las diez cláusulas, la vigencia, la promoción y la duración deben venir de la PriceList seleccionada**. La regla del propietario es 12 meses para todos los planes; la promoción USD 80 ya tenía 12 meses en el último inventario. No convertir esta decisión comercial en una escritura automática de BD.

## Excepciones necesarias

- Consulta puntual por hosting, soporte, plazo o una prestación: **respuesta focalizada**, no la lista completa.
- Segundo turno después de haber mostrado la lista: no repetir los diez beneficios ni la pregunta si ya se respondió.
- Promoción inactiva, ausente, sin moneda aplicable o con alcance divergente: **no inventar oferta**, derivar a confirmación humana cuando corresponda.
- Negación/cambio explícito a otro servicio: no imponer Black Friday.
- F3/caps o política de ventana: no forzar dos envíos si el control los prohíbe; degradar de forma segura y documentada, conservando las diez prestaciones cuando haya capacidad legal/operativa.
- STOP, opt-out, handoff, privacidad y reintentos: conservan prioridad. No modificar las políticas de idempotencia.

## Pruebas de aceptación obligatorias

1. Entrada exacta del 7/11 y variantes con o sin tilde, `USD 80`, `$80.00`, «ochenta dólares»; **dos partes de `AutomatedDelivery`** en primer turno cuando el presupuesto permita dos.
2. Repetir con y sin `verifiedAdCampaign`; mismo contenido comercial autorizado, sin dependencia del origen.
3. `partIndex=0`: saludo autorizado + precio USD 80 + **10 emojis / 10 líneas separadas** + soporte anual del `scope` vigente.
4. `partIndex=1`: solo la pregunta de descubrimiento; ninguna pregunta redundante en `partIndex=0`.
5. Buenos días/tardes/noches con límites explícitos de `America/Guayaquil`; empresa, Carlos, María y nombre ambiguo.
6. Preguntas específicas, opt-out, STOP, handoff, conversación ya respondida, precio/moneda no autorizados y promoción desactivada.
7. Entrega parcial: si parte 0 ya está confirmada y parte 1 pendiente, la recuperación no duplica parte 0; Meta `sendTextMessage` ejecuta exactamente dos llamadas en ruta aprobada.
8. Tanto motor `nous_hermes` como `gemini_direct`; no basta probar el formateador sin pasar por `AutoReplyService`/`AutomatedDelivery`.
9. Todos los gates existentes: unitarias, integración aislada, A7-D16, TypeScript, build, Prisma, secretos y auditoría productiva.

## Plan de implementación y release

Preparar **PR nuevo**, sin edición directa de producción, corrigiendo detector, selección determinista del formateador, política de prompt y expectativas obsoletas de tests. Revisar cambios antes de merge; compilar y probar imagen realmente arrancable por digest; despliegue app-only solo bajo autorización posterior. Mantener A/B comerciales **fuera** de este PR. Investigar de forma restringida el caso real por identificador de conversación (sin exponer datos privados en GitHub) para confirmar la rama exacta usada.

**Estado de salida actual:** `HERMES_BLACK_FRIDAY_RESPONSE_FIX_PENDING`.
