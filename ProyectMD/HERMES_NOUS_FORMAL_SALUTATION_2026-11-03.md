# Hermes/Nous: tratamiento formal personalizado (2026-11-03)

## Base y alcance

Rama: `fix/nous-personalized-formal-salutation-20261103`, creada desde el HEAD remoto de `pilot/a7-d12-monitor-only-20261026` (`fb36afe`). El worktree principal, que contenía cambios ajenos, quedó intacto. No se modificaron tarifas, promociones, condiciones comerciales, Prisma schema, autenticación ni Meta Ads. No hubo migraciones, despliegue ni publicación de imágenes.

## Resolución determinista

`customer-salutation.ts` devuelve `MASCULINE`, `FEMININE`, `UNKNOWN` u `ORGANIZATION`, con nombre de pila seguro, tratamiento opcional y fuente. Son **fórmulas de cortesía para un mensaje**, no identidad de género confirmada ni dato persistido.

1. Una solicitud expresa de cómo dirigirse al cliente (`prefiero`, `llámeme`, `dígame`, `tráteme`) prevalece sobre el nombre. Se examinan mensajes del cliente recientes y el actual; una frase negada no autoriza el tratamiento. No se pregunta proactivamente el género.
2. Un nombre de contacto con indicador comercial (barbería, peluquería, salón, estética, spa, restaurante, tienda, taller, distribuidora, comercial, agencia, consultora, clínica, estudio, servicios, empresa o razón social) se trata como organización, incluso si contiene un nombre personal.
3. Se exige un nombre de hasta cinco términos, de letras y signos internos permitidos; se rechazan identificadores artificiales, números, emojis y caracteres especiales. Solo un catálogo pequeño de nombres de uso inequívoco en español habilita `estimado` o `estimada`; `Alex`, `Andrea` y nombres desconocidos quedan neutrales.
4. Un nombre neutral válido puede usarse sin título. Sin nombre fiable o con empresa, se usa saludo sin nombre.

El catálogo **no tiene una precisión estadística verificada**. Puede omitir nombres reales, no capta todas las marcas ni organizaciones y no garantiza que un nombre conocido corresponda a la preferencia de la persona. Por eso las dudas quedan neutrales y cualquier preferencia expresa prevalece. No se usan APIs ni se envían nombres a un servicio de clasificación. Los nombres de los mensajes siguen sujetos a las políticas de contexto existentes.

## Integración

- Nous recibe la resolución en `approvedState.salutation`; la instrucción le exige usted, no inferir género y no repetir el tratamiento. El transporte repara el saludo emitido y mantiene cada elemento de `replyParts` como mensaje independiente.
- Gemini recibe la misma resolución controlada en su contexto. `naturalOpening()` y la comprobación final usan el módulo central. La limpieza de estilo y los fallbacks conservan el trato formal preexistente.
- `AutoReplyService.polishInitialGreeting()` aplica la comprobación final antes de preparar el envío. Repara un título incorrecto o duplicado solo en la apertura, preservando la explicación comercial. Si la única modificación es el saludo de Nous, conserva `replyParts` y cambia solo la primera parte; el control de partes F3 sigue aplicándose a la lista real.
- El tratamiento se concentra en la primera respuesta. Un saludo posterior puede corresponderse sin repetir `estimado` o `estimada`. Los avisos técnicos sin saludo no reciben uno nuevo.

## Verificación local

| Comprobación | Resultado |
| --- | --- |
| Pruebas focalizadas de Nous, AutoReply, Gemini y saludos | 333 aprobadas, 0 fallidas |
| Suite unitaria completa | 1775 aprobadas, 1 fallida, 106 suites. Falla reproducible: `campaigns.media-security.spec.ts` espera HTTP 201 para un archivo exactamente de 16 MiB y recibe 413. El archivo y la ruta multimedia no se modificaron. |
| Integración directa | 86 pruebas fallaron por falta de `DATABASE_INTEGRATION_URL` y servicios aislados; 8 omitidas. Ninguna prueba de integración se considera aprobada. |
| A7-D16 | No ejecutado: `scripts/run-a7-d16-e2e.mjs` invoca `prisma migrate deploy`; la instrucción de esta tarea prohíbe ejecutar migraciones. |
| Build NestJS | Aprobado tras `prisma generate` local, sin migración. |
| ESLint | Aprobado. |
| Prisma validate | Aprobado con URL local sintética, sin conexión. |
| Escaneo de secretos | Aprobado: 545 archivos, incluidos los nuevos archivos preparados para el commit. |

Las pruebas focalizadas cubren los nombres y empresas solicitados, preferencia contradictoria, duplicación, corrección de respuesta de IA, continuidad y conservación de tres partes de WhatsApp. Las suites existentes de Black Friday, F3, STOP, opt-out y handoff pasaron dentro de las 1775 pruebas unitarias. La revisión de los archivos modificados confirma que no se tocaron precios, impuestos, prestaciones ni condiciones comerciales.

## Riesgos y rollback

Quedan pendientes la integración aislada y A7-D16 bajo un procedimiento que respete la prohibición de migraciones, además de la falla multimedia preexistente. Los nombres comerciales sin indicador pueden parecer nombres personales y viceversa; el resultado neutral limita la atribución de tratamiento. Las preferencias solo se recuerdan mientras estén disponibles en el historial reciente; no se añadieron columnas ni persistencia de inferencias.

Rollback: revertir el commit de esta rama antes de integrar o, si se integra después de la revisión, revertir el PR. No requiere rollback de datos ni esquema. El despliegue requiere revisión y aprobación separadas.

El informe se incluye explícitamente en el PR porque `ProyectMD/*.md` está ignorado por `.gitignore`, pero los informes de cambios anteriores de esta misma línea ya están versionados en `ProyectMD/`.
