# Mercado y moneda por Meta Ad ID verificado — 31 de octubre de 2026

## Estado

- Rama: `fix/meta-ad-market-currency-20261031`, basada en `fix/nous-conversational-quality-20261031` (`0a0bb53975085abc5a02b7b9af005bc06eec2bbc`).
- PR: https://github.com/undercodeec/hermes_n8n/pull/3 (base PR #2).
- Commit de código: `5f7aa7b7f4675b3dfb4ceaf2ec2ab345b5f3ea4d`; Tree SHA: `eb56c334175c8dc03b50d481003cec5b9913aba6`.
- Sin despliegue, cambios en PostgreSQL productivo ni envíos de WhatsApp reales.

## Causa raíz y corrección

La atribución Meta verificaba la campaña, pero no asociaba el Ad ID al mercado. Una consulta genérica podía llegar a `CommercialAuthorityService` sin país ni moneda. La selección de Black Friday admitía entonces la `PriceList` global en USD, incluso para el anuncio español; la respuesta podía combinar ambas monedas o trasladar USD al mensaje. Se conservó la mejora conversacional previa para responder en un solo mensaje breve.

| Ad ID verificado | Mercado | Moneda esperada |
| --- | --- | --- |
| `52583085497631` | `ES` | `EUR` |
| `52581450998031` | `EC` | `USD` |

`verified-ad-campaign.ts` mapea únicamente esos ID cuando la atribución procede de Meta y el ID figura en `HERMES_BLACK_FRIDAY_AD_SOURCE_IDS`. Conserva la ventana de siete días, los límites de campaña y la prioridad del anuncio más reciente. Un ID escrito por el cliente, un anuncio desconocido o el fallback sin ID no asignan mercado. El ID no autoriza importes.

`AutoReplyService` entrega ese contexto verificado a `CommercialAuthorityService`, que prioriza el país explícito **del proyecto** y después el mercado del anuncio. Si ambos se contradicen, retiene el precio y pregunta brevemente si se desea orientación para el país indicado. En una consulta genérica atribuida no pregunta «¿España o Ecuador?».

Para Black Friday, la autoridad consulta `PriceList` activas y vigentes, con la política `black-friday-landing-80-v1`, tipo, alcance y vínculo `supersedesPriceListId` válidos. El anuncio de España selecciona solo una promoción `ES/EUR`; nunca usa la promoción global `USD`. El anuncio de Ecuador selecciona primero `EC/USD` y, si no existe, admite la promoción global `USD` existente, siempre que esté activa y sea válida. Si no hay tarifa compatible, solicita confirmación comercial y no convierte monedas. Una mención del cliente de una moneda opuesta tampoco autoriza la tarifa del anuncio.

## Auditoría comercial de solo lectura

Se intentó consultar `PriceList` mediante Prisma con la configuración local, sin escribir en la base ni mostrar credenciales. La consulta terminó con `PrismaClientInitializationError`. Por ello **no están verificados** los ID, importes, estados, vigencias ni condiciones fiscales actuales del CRM de España o Ecuador. No se puede afirmar que la promoción EUR 80 exista o falte en la base real.

La migración versionada `20261029200000_black_friday_landing_80` documenta un registro `commercial-price-landing-black-friday-80-global-v1`, mercado `GLOBAL`, moneda `USD`, importe `80.00`, política `black-friday-landing-80-v1`, inicialmente `isActive=false` y sin tratamiento fiscal confirmado. Ese registro es evidencia del repositorio, **no** de su estado actual en producción. No hay una migración versionada de promoción `ES/EUR` en esta rama.

El usuario confirmó EUR 80 para España y USD 80 para Ecuador, pero el importe EUR no se cargó automáticamente. Antes de habilitar la respuesta con precio español, el propietario debe revisar el catálogo real desde el CRM y, si falta, configurar una `PriceList` `ES/EUR` aprobada y vigente, con condiciones fiscales, alcance y relación con la tarifa base definidos. Este PR no crea ni activa tarifas.

## Verificación

| Control | Resultado |
| --- | --- |
| Suite unitaria completa | 104 suites, 1694/1694 pruebas aprobadas en el árbol final. |
| A7–D16 aislado con PostgreSQL y Redis de prueba | 6 suites, 31/31; resumen en `hermes-backend/artifacts/a7-d16-e2e/summary.json`. |
| Build NestJS | Aprobado. |
| Prisma validate | Aprobado con URL ficticia; no conectó al CRM. |
| `security:secrets` | Aprobado, 511 archivos revisados. |
| ESLint, Prettier y `git diff --check` | Aprobados en archivos modificados. |
| Integración general | Se intentó ejecutar; 16 suites no arrancaron por ausencia de `DATABASE_INTEGRATION_URL`. La integración correspondiente A7–D16 sí pasó en entorno aislado. |

Las regresiones enfocadas cubren anuncios ES y EC, tarifa ES ausente, promoción EC inactiva, tarifa global USD para EC, contradicción con país explícito del proyecto, moneda mencionada en oposición al anuncio, anuncio diferente o ausente, atribución vencida, anuncio posterior, nombre válido, continuidad y una respuesta breve sin duplicar precio. La suite existente cubre STOP, handoff, opt-out y otras protecciones.

## Riesgos y publicación

1. Revisar el PR conversacional previo y después este PR; ambos son necesarios para el resultado descrito.
2. Consultar el CRM real en modo lectura y registrar para cada `PriceList` de la campaña ID, mercado, moneda, precio, `isActive`, vigencia, política, impuestos y `supersedesPriceListId`.
3. Resolver las condiciones fiscales de España y aprobar en el CRM la tarifa `ES/EUR` si falta. Verificar también la activación de la promoción `EC/USD` o de la tarifa global USD aplicable.
4. Al publicar el código, configurar `HERMES_BLACK_FRIDAY_AD_SOURCE_IDS=52583085497631,52581450998031` en el entorno correspondiente y verificar los límites temporales de campaña. No basta con actualizar `.env.example`.
5. Ejecutar una prueba controlada por cada Ad ID con lectura del catálogo real y sin envío al cliente antes de habilitar el flujo; luego observar moneda, precio, número de mensajes y trazas de atribución.

La redacción del modelo puede variar; el cierre comercial comprueba las afirmaciones de precio. La consulta directa al catálogo real y la integración general siguen pendientes por conectividad/configuración, no por una falla de los casos aislados.
