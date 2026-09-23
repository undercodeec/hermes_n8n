# Autoridad comercial por mercado: auditoría y entrega local

## Arquitectura y fuentes encontradas

El webhook de WhatsApp guarda el mensaje entrante y `AutoReplyService` prepara el contexto antes de llamar a `ConversationEngineService`. Este selecciona `NousHermesTransport` o `DirectGeminiEngine`. Ambos reciben `approvedKnowledge`; Gemini recibe además `commercialSnapshot`. La respuesta pasa por política conversacional, validación comercial, guardia de salida y entrega por partes de WhatsApp.

| Componente | Fuente anterior | Fuente operativa con este cambio |
| --- | --- | --- |
| Gemini directo | `commercial-catalog.ts`, `Product.priceLists`, `KnowledgeDocument`, `SalesPlaybook` | Instantánea CRM en el flujo WhatsApp. Una llamada interna sin instantánea conserva contexto descriptivo, pero ningún precio queda autorizado. |
| Nous | `commercialCatalogContext` enviado como `approvedKnowledge` | Solo ofertas pertinentes seleccionadas desde `Product` y `PriceList` de PostgreSQL. |
| Política de conversación | `hasPublishedPriceFor` del catálogo versionado | Detecta intención de precio; `AutoReplyService` concede permiso solo si la instantánea CRM tiene oferta monetaria autorizada. |
| Validación y posprocesado | `responseContainsOnlyAuthorizedPrices`, `repairNousCommercialClaims` y `missingPublishedPriceAnswer` | `reviewCommercialClaims` contrasta importe, moneda, tipo de precio, IVA y promoción con la instantánea. `answerExplicitPriceIfMissing` solo repara una pregunta directa con una única oferta monetaria pertinente. |

La frase observada `Tienda de Lanzamiento: USD $550. Precios publicados con IVA incluido.` provenía de `missingPublishedPriceAnswer` en `auto-reply.service.ts`, después de `repairNousCommercialClaims`. Esa inserción se retiró del flujo. El catálogo versionado conserva cifras antiguas únicamente como artefacto de reversión; ninguna ruta activa de respuesta comercial las consulta. No se autoriza usarlo automáticamente cuando PostgreSQL falla o no contiene una tarifa aprobada.

`KnowledgeDocument` y `SalesPlaybook` pueden contener texto comercial anterior y todavía existen en la base. El flujo WhatsApp con instantánea no los incluye en la respuesta de precio. Antes de una futura API comercial hay que auditar su contenido, retirar o marcar como histórico cualquier cifra contradictoria y separar contenido descriptivo de tarifas. No se inspeccionaron registros de producción ni se accedió a la VPS.

## Fuente operativa y reglas

Se extienden los modelos Prisma existentes. `Product.serviceCode` identifica el servicio; `PriceList` guarda mercado `EC` o `ES`, moneda, importe decimal, tipo `FIXED`/`FROM`/`QUOTE_REQUIRED`, impuestos, ámbito, restricciones, versión de política, estado, vigencia y relación de una promoción con su tarifa base. La migración deja las filas antiguas sin mercado ni versión: no quedan autorizadas por accidente. `QUOTE_REQUIRED` no tiene importe.

La resolución de mercado prioriza la indicación actual del cliente, luego `commercialProfile.market` confirmado y finalmente una mención inequívoca en mensajes recientes del cliente. La ubicación descriptiva del perfil y el prefijo telefónico no determinan mercado. Si hay una consulta de precio para un servicio identificado y el mercado sigue desconocido, la salida pide una sola aclaración: Ecuador o España. Una conversación que no necesita precio sigue sin esa pregunta.

La consulta selecciona productos activos del servicio relevante y tarifas activas del mercado, moneda y fecha actuales. Una fila incompleta o una ambigüedad entre varias tarifas base no se publica. Una promoción solo reemplaza a su base cuando ambas son vigentes y la relación `supersedesPriceListId` coincide. Si no hay oferta autorizada, no se comunica un importe. La validación retira afirmaciones monetarias falsas sin borrar el resto de la respuesta; no enumera precios por el mero hecho de existir.

Las alternativas web se validan por los nombres de las ofertas presentes en la instantánea; no se exigen cifras literales. Una recuperación de salida puede mencionar las dos opciones por nombre, sin insertar importes. La selección posterior de «la de $X» usa el precio que apareció en el último mensaje enviado al cliente solo para identificar la opción; no lo utiliza como autoridad comercial. Las menciones de IVA y promociones se comprueban contra el plan nombrado. Los porcentajes de IVA requieren una tasa aprobada que coincida.

## Datos que debe definir el propietario

No se asignaron ni migraron importes comerciales. Una fila por **cada variante o plan que realmente se ofrezca**. Los nombres y el alcance también requieren confirmación: esta lista solo sirve para recoger decisiones, no publica planes.

| Mercado | Servicio o variante a confirmar | Importe | Moneda | FIXED / FROM / QUOTE_REQUIRED | IVA / impuesto y tasa | Vigencia desde / hasta | Alcance y restricciones | Versión de política |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Ecuador | Landing Básica | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente |
| Ecuador | Landing Pro | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente |
| Ecuador | Landing Premium | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente |
| Ecuador | Web Lanzamiento | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente |
| Ecuador | Web Crecimiento | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente |
| Ecuador | Web Autoridad | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente |
| Ecuador | Tienda Lanzamiento | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente |
| Ecuador | Tienda Crecimiento | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente |
| Ecuador | Tienda Élite | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente |
| España | Landing Básica | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente |
| España | Landing Pro | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente |
| España | Landing Premium | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente |
| España | Web Lanzamiento | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente |
| España | Web Crecimiento | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente |
| España | Web Autoridad | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente |
| España | Tienda Lanzamiento | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente |
| España | Tienda Crecimiento | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente |
| España | Tienda Élite | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente | Pendiente |

Confirmar también si hay otros servicios, renovaciones, promociones por mercado, política de redondeo y qué sucede al vencer una tarifa. Para cada promoción se necesita su tarifa base, fecha de inicio y fin, alcance y restricciones. No inferir estos datos de páginas públicas antiguas.

## Web y despliegue posterior

Este repositorio contiene el backend; no hay código de Web Ecuador o Web España que permita diseñar una sincronización concreta sin auditar sus rutas, caché, autenticación y despliegue. La estrategia posterior es exponer una API pública de lectura desde el CRM que devuelva solo ofertas activas por mercado y servicio, con identificador de política y encabezados de caché de corta duración. Las dos webs consumirían esa API o una exportación generada desde ella. El CRM y Hermes usarían la misma consulta de autoridad. No se implementó esa API ni se cambió ninguna web.

Para migrar en un entorno posterior: respaldar PostgreSQL, aplicar la migración Prisma, revisar los registros existentes sin asignarles mercado automáticamente, cargar exclusivamente las filas aprobadas por el propietario, validar la consulta de cada mercado/servicio y probar el canary. Hasta entonces las filas antiguas siguen almacenadas pero no son tarifas autorizadas para Hermes. El cambio de aplicación debe coordinarse con la migración; un rollback de código puede reactivar el catálogo versionado anterior, por lo que debe evaluarse contra la política comercial vigente antes de ejecutarlo. Esta entrega no despliega ni accede a la VPS.

## Verificación local

Se ejecutaron `npx prisma validate`, `npm run build`, lint de los archivos de producción modificados, la suite Jest y las pruebas HTTP e2e. Las pruebas incluyen varios negocios y partes de respuesta, mercado conocido/desconocido, cambio de mercado, Ecuador/España, `FIXED`, `FROM`, `QUOTE_REQUIRED`, promoción y vencimiento, IVA, precio no autorizado, reparación de pregunta directa y conversación sin necesidad de mencionar precios. Las pruebas de integración con una base PostgreSQL real, Redis, Meta y el servicio Nous no se ejecutaron: requieren un entorno de staging con datos aprobados.
