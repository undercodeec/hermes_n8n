# Índice documental de Hermes

Corte: **2026-11-10**, base `ca85b991`. [Estado canónico y evidencia GitHub](../../ProyectMD/estado-proyecto.md) · [Entrada del repositorio](../../README.md) · [Desarrollo backend](../README.md).

## Cómo leer este inventario

Inventario exhaustivo inicial: `git ls-files '*.md'` devolvió **72 archivos tracked**. Las tablas siguientes contienen una fila por archivo, agrupadas por familia; los documentos nuevos se enumeran aparte. No incluye archivos remotos de PR abiertos como si fueran locales, ni archivos no tracked anteriores. Clasificar no certifica cada afirmación técnica. No se han reejecutado pruebas de aplicación en esta tarea documental.

- **H**: evidencia histórica; conservar resultados originales, no reutilizar como estado actual.
- **P**: plan/diseño fechado; no implica implementación, aceptación ni autorización.
- **T**: referencia temática que se conserva; requiere contrastar código/runtime para operar, no certificada íntegramente en este corte.
- **C**: punto de entrada canónico reconciliado; sus límites y pendientes son explícitos.
- **A**: artefacto de evaluación offline/controlada, no CI ni producción.

Destinos vigentes: **E** = [estado del proyecto](../../ProyectMD/estado-proyecto.md); **D** = [despliegue y rollback](deployment-runbook.md); **B** = [comercial Black Friday](commercial-black-friday-runbook.md); **N** = [Nous](nous-hermes-runbook.md). «Mismo documento» conserva la referencia temática, no ratifica su vigencia operativa.

## Raíz — actas y handoffs (7)

| Archivo | Familia | Estado | Destino vigente |
|---|---|---|---|
| [HERMES_A7_D12_MONITOR_ONLY_LOCAL_IMPLEMENTATION_REPORT.md](../../HERMES_A7_D12_MONITOR_ONLY_LOCAL_IMPLEMENTATION_REPORT.md) | Nous / MONITOR_ONLY | H | E + N |
| [HERMES_A7_D13_DURABLE_CONTINUATION_LOCAL_REPORT.md](../../HERMES_A7_D13_DURABLE_CONTINUATION_LOCAL_REPORT.md) | Continuación durable | H | E + N |
| [HERMES_A7_D16_R1_NOUS_E2E_TEST_HARNESS_REPORT.md](../../HERMES_A7_D16_R1_NOUS_E2E_TEST_HARNESS_REPORT.md) | QA aislado | H | E + N |
| [HERMES_A7_D16_R2_PILOT_CRITICAL_VALIDATION_REPORT.md](../../HERMES_A7_D16_R2_PILOT_CRITICAL_VALIDATION_REPORT.md) | QA piloto | H | E + D |
| [HERMES_A7_D21_META_ATTRIBUTION_CRM_UI_REPORT.md](../../HERMES_A7_D21_META_ATTRIBUTION_CRM_UI_REPORT.md) | Atribución CRM | H | E + [atribución](advertising-attribution.md) |
| [HERMES_BLACK_FRIDAY_LANDING_80_IMPLEMENTATION_REPORT.md](../../HERMES_BLACK_FRIDAY_LANDING_80_IMPLEMENTATION_REPORT.md) | Comercial | H | B |
| [HERMES_BLACK_FRIDAY_LANDING_80_RELEASE_HANDOFF_2026-10-30.md](../../HERMES_BLACK_FRIDAY_LANDING_80_RELEASE_HANDOFF_2026-10-30.md) | Release comercial | H | B + D |

## ProyectMD — estado, informes y planes (19)

| Archivo | Familia | Estado | Destino vigente |
|---|---|---|---|
| [HERMES_A7_BF17_R2_WEBHOOK_INBOX_FIX_2026-11-07.md](../../ProyectMD/HERMES_A7_BF17_R2_WEBHOOK_INBOX_FIX_2026-11-07.md) | Webhook / incidente | H | E + D |
| [HERMES_A7_D4_NOUS_IDEMPOTENCY_PATCH_REPORT.md](../../ProyectMD/HERMES_A7_D4_NOUS_IDEMPOTENCY_PATCH_REPORT.md) | Idempotencia Nous | H | N + E |
| [HERMES_A7_LANZAMIENTO_ACELERADO_NOUS_GEMINI_LOCAL_REPORT.md](../../ProyectMD/HERMES_A7_LANZAMIENTO_ACELERADO_NOUS_GEMINI_LOCAL_REPORT.md) | Piloto motores | H | N + D |
| [HERMES_A7_VPS_NOUS_SMOKE_Y_PILOTO_PLAN.md](../../ProyectMD/HERMES_A7_VPS_NOUS_SMOKE_Y_PILOTO_PLAN.md) | Piloto VPS | P | D + N |
| [HERMES_AUDIO_FALLBACK_HUMANIZATION_REPORT.md](../../ProyectMD/HERMES_AUDIO_FALLBACK_HUMANIZATION_REPORT.md) | Audio / conversación | H | N + E |
| [HERMES_BLACK_FRIDAY_CONVERSATION_FIX_2026-11-07.md](../../ProyectMD/HERMES_BLACK_FRIDAY_CONVERSATION_FIX_2026-11-07.md) | Conversación comercial | H | B |
| [HERMES_BLACK_FRIDAY_SUPPORT_12_MONTHS_RELEASE_2026-11-02.md](../../ProyectMD/HERMES_BLACK_FRIDAY_SUPPORT_12_MONTHS_RELEASE_2026-11-02.md) | Soporte comercial | H | B |
| [HERMES_BLACK_FRIDAY_WHATSAPP_VISUAL_RESPONSES_2026-11-02.md](../../ProyectMD/HERMES_BLACK_FRIDAY_WHATSAPP_VISUAL_RESPONSES_2026-11-02.md) | Respuestas visuales | H | B |
| [HERMES_COMMERCIAL_CATALOG_RECONCILIATION_PLAN_2026-11-04.md](../../ProyectMD/HERMES_COMMERCIAL_CATALOG_RECONCILIATION_PLAN_2026-11-04.md) | Catálogo | P | B |
| [HERMES_INTEGRATION_GATE_RECOVERY_2026-10-31.md](../../ProyectMD/HERMES_INTEGRATION_GATE_RECOVERY_2026-10-31.md) | CI / integración | H | E + D |
| [HERMES_MARKET_PHONE_FALLBACK_CONVERSATIONAL_FIX_2026-11-02.md](../../ProyectMD/HERMES_MARKET_PHONE_FALLBACK_CONVERSATIONAL_FIX_2026-11-02.md) | Mercado / conversación | H | B |
| [HERMES_META_AD_MARKET_CURRENCY_FIX_2026-10-31.md](../../ProyectMD/HERMES_META_AD_MARKET_CURRENCY_FIX_2026-10-31.md) | Mercado / atribución | H | B + [atribución](advertising-attribution.md) |
| [HERMES_NOUS_CONVERSATIONAL_QUALITY_FIX_2026-10-31.md](../../ProyectMD/HERMES_NOUS_CONVERSATIONAL_QUALITY_FIX_2026-10-31.md) | Calidad Nous | H | N + E |
| [HERMES_NOUS_FORMAL_SALUTATION_2026-11-03.md](../../ProyectMD/HERMES_NOUS_FORMAL_SALUTATION_2026-11-03.md) | Tono Nous | H | N + B |
| [HERMES_OPTION_B_GLOBAL_SUPPORT_12M_2026-11-04.md](../../ProyectMD/HERMES_OPTION_B_GLOBAL_SUPPORT_12M_2026-11-04.md) | Términos comerciales | H | B |
| [HERMES_PR10_BLOCKERS_REMEDIATION_2026-11-04.md](../../ProyectMD/HERMES_PR10_BLOCKERS_REMEDIATION_2026-11-04.md) | Remediación PR | H | E + D |
| [HERMES_PRICE_LIST_12M_DEPLOYMENT_PLAN_2026-11-04.md](../../ProyectMD/HERMES_PRICE_LIST_12M_DEPLOYMENT_PLAN_2026-11-04.md) | Despliegue catálogo | P | B + D |
| [HERMES_TYPESCRIPT_SECURITY_REMEDIATION_2026-11-04.md](../../ProyectMD/HERMES_TYPESCRIPT_SECURITY_REMEDIATION_2026-11-04.md) | Dependencias / QA | H | E + D |
| [estado-proyecto.md](../../ProyectMD/estado-proyecto.md) | Reconciliación global | C | E; octubre preservado en archivo histórico |

## Superpowers raíz — planes y especificaciones (8)

| Archivo | Familia | Estado | Destino vigente |
|---|---|---|---|
| [2026-09-21-hermes-first-deployment.md](../../docs/superpowers/plans/2026-09-21-hermes-first-deployment.md) | Despliegue / plan | P | D |
| [2026-10-26-undercodeec-pilot.md](../../docs/superpowers/plans/2026-10-26-undercodeec-pilot.md) | Piloto / plan | P | D + [piloto](undercodeec-pilot-runbook.md) |
| [2026-10-28-meta-attribution-crm.md](../../docs/superpowers/plans/2026-10-28-meta-attribution-crm.md) | Atribución / plan | P | [atribución](advertising-attribution.md) + E |
| [2026-11-02-market-phone-conversation.md](../../docs/superpowers/plans/2026-11-02-market-phone-conversation.md) | Mercado / plan | P | B |
| [2026-09-07-whatsapp-template-media-design.md](../../docs/superpowers/specs/2026-09-07-whatsapp-template-media-design.md) | Media / diseño | P | E + [backend](../README.md) |
| [2026-09-21-hermes-first-deployment-design.md](../../docs/superpowers/specs/2026-09-21-hermes-first-deployment-design.md) | Despliegue / diseño | P | D |
| [2026-10-26-undercodeec-pilot-design.md](../../docs/superpowers/specs/2026-10-26-undercodeec-pilot-design.md) | Piloto / diseño | P | D + [piloto](undercodeec-pilot-runbook.md) |
| [2026-10-28-meta-attribution-crm-design.md](../../docs/superpowers/specs/2026-10-28-meta-attribution-crm-design.md) | Atribución / diseño | P | [atribución](advertising-attribution.md) + E |

## Backend — entrada y referencias temáticas (31)

| Archivo | Familia | Estado | Destino vigente |
|---|---|---|---|
| [hermes-backend/README.md](../README.md) | Desarrollo | C | Mismo documento + E |
| [HERMES_A7_D10_R3_FINAL_COMPATIBILITY_REPORT.md](HERMES_A7_D10_R3_FINAL_COMPATIBILITY_REPORT.md) | Compatibilidad | H | E + N |
| [advertising-attribution.md](advertising-attribution.md) | Atribución | T | Mismo documento + E |
| [commercial-authority-handoff-2026-09-23.md](commercial-authority-handoff-2026-09-23.md) | Autoridad comercial | H | B |
| [conversation-learning-operations.md](conversation-learning-operations.md) | Aprendizaje / operación | T | Mismo documento + E |
| [conversation-memory-phase4-evaluation.md](conversation-memory-phase4-evaluation.md) | Memoria / evaluación | T | Mismo documento + E |
| [crm-baseline-agent.md](crm-baseline-agent.md) | Agente baseline | T | Mismo documento + N |
| [deployment-vps-runbook-2026-09-22.md](deployment-vps-runbook-2026-09-22.md) | Despliegue antiguo | H | D |
| [f2-provider-evaluation-harness.md](f2-provider-evaluation-harness.md) | F2 / evaluación | T | Mismo documento + E |
| [f2-provider-evaluation-human-review-template.md](f2-provider-evaluation-human-review-template.md) | F2 / plantilla humana | T | Mismo documento |
| [f3-approval-authority.md](f3-approval-authority.md) | F3 / aprobación | T | Mismo documento + E |
| [f3-commercial-precedence-authority.md](f3-commercial-precedence-authority.md) | F3 / precedencia | T | Mismo documento + B |
| [f3-privacy-isolation.md](f3-privacy-isolation.md) | F3 / privacidad | T | Mismo documento + E |
| [f3-retrieval-canary.md](f3-retrieval-canary.md) | F3 / retrieval | T | Mismo documento + E |
| [f3-rollback.md](f3-rollback.md) | F3 / rollback | T | Mismo documento + D |
| [f3-single-generation-canary-guard.md](f3-single-generation-canary-guard.md) | F3 / canary | T | Mismo documento + E |
| [f3-traceability.md](f3-traceability.md) | F3 / trazabilidad | T | Mismo documento + E |
| [google-calendar-runbook.md](google-calendar-runbook.md) | Calendar | T | Mismo documento + E |
| [hermes-learning-loop-plan.md](hermes-learning-loop-plan.md) | Aprendizaje / fases | P | Mismo documento + E |
| [nous-commercial-conversation-change.md](nous-commercial-conversation-change.md) | Conversación comercial | H | B + N |
| [nous-hermes-conversational-integration.md](nous-hermes-conversational-integration.md) | Contrato Nous | T | Mismo documento + N |
| [nous-hermes-runbook.md](nous-hermes-runbook.md) | Operación Nous | T | N + D |
| [phase0-backend-provenance.md](phase0-backend-provenance.md) | Fase 0 / provenance | T | Mismo documento + D |
| [phase0-final-output-evaluation.md](phase0-final-output-evaluation.md) | Fase 0 / evaluación | T | Mismo documento + E |
| [phase0-learning-capacity.md](phase0-learning-capacity.md) | Fase 0 / capacidad | T | Mismo documento + E |
| [retention-recovery-policy.md](retention-recovery-policy.md) | Retención / recuperación | T | Mismo documento + E |
| [security-preflight-2026-09-21.md](security-preflight-2026-09-21.md) | Seguridad fechada | H | D |
| [superpowers/plans/2026-10-29-black-friday-landing-80.md](superpowers/plans/2026-10-29-black-friday-landing-80.md) | Comercial / plan | P | B |
| [transfer-payment-crm-implementation-plan.md](transfer-payment-crm-implementation-plan.md) | Pagos / plan | P | Mismo documento + E |
| [undercodeec-pilot-data-contract.md](undercodeec-pilot-data-contract.md) | Piloto / contrato | T | Mismo documento + E |
| [undercodeec-pilot-runbook.md](undercodeec-pilot-runbook.md) | Piloto / operación | T | Mismo documento + D |

## Artefactos de evaluación conservados sin editar (7)

| Archivo | Familia | Estado | Destino vigente |
|---|---|---|---|
| [f3-approval-gate/offline-approval-summary.md](../artifacts/f3-approval-gate/offline-approval-summary.md) | F3 / aprobación | A | [autoridad](f3-approval-authority.md) + E |
| [f3-commercial-precedence-gate/offline-commercial-summary.md](../artifacts/f3-commercial-precedence-gate/offline-commercial-summary.md) | F3 / comercial | A | [precedencia](f3-commercial-precedence-authority.md) + B |
| [f3-privacy-isolation-gate/offline-privacy-summary.md](../artifacts/f3-privacy-isolation-gate/offline-privacy-summary.md) | F3 / privacidad | A | [aislamiento](f3-privacy-isolation.md) + E |
| [f3-retrieval-canary-gate/controlled-canary-summary.md](../artifacts/f3-retrieval-canary-gate/controlled-canary-summary.md) | F3 / canary controlado | A | [retrieval](f3-retrieval-canary.md) + E |
| [f3-rollback-gate/offline-rollback-summary.md](../artifacts/f3-rollback-gate/offline-rollback-summary.md) | F3 / rollback | A | [rollback](f3-rollback.md) + D |
| [f3-shadow-gate/offline-shadow-summary.md](../artifacts/f3-shadow-gate/offline-shadow-summary.md) | F3 / shadow | A | E + N |
| [f3-traceability-gate/offline-traceability-summary.md](../artifacts/f3-traceability-gate/offline-traceability-summary.md) | F3 / trazabilidad | A | [trazabilidad](f3-traceability.md) + E |

## Nuevos documentos de esta reconciliación (fuera del inventario inicial)

| Documento | Familia / estado | Destino |
|---|---|---|
| [README raíz](../../README.md) | Entrada / C | E e índice |
| [Este índice](README.md) | Inventario / C | Cada familia |
| [Estado histórico octubre](../../ProyectMD/estado-proyecto-historico-2026-10.md) | Archivo / H | E |
| [deployment-runbook.md](deployment-runbook.md) | Operación / C | D |
| [commercial-black-friday-runbook.md](commercial-black-friday-runbook.md) | Comercial / C | B |

Los dos runbooks están enlazados desde la entrada raíz y el estado canónico. Gestión de `.gitignore`: la regla `*.md` afecta a documentos nuevos sin excepción; el índice y `deployment-runbook.md` tienen excepciones explícitas. Para incorporar nuevos Markdown, revisar `git check-ignore` y usar una excepción acotada o `git add -f` selectivo, sin ampliar el staging a archivos ajenos. Los documentos ya tracked no quedan excluidos por esa regla.

El archivo de octubre preserva resultados y observaciones: frente al estado original de la base sólo cambia el título, añade el aviso histórico y convierte dos enlaces a documentos retirados en referencias textuales, sin alterar sus descripciones.

## Evidencia externa y pendientes

El [preflight de PR #16](https://github.com/undercodeec/hermes_n8n/blob/5034fac19dcdbe49562a5b5cec068d3de0f9f60d/ProyectMD/HERMES_A7_BF17_PRODUCTION_PREFLIGHT_2026-11-07.md) no es un archivo local ni un merge. Corte reportado 07/11 16:23 UTC: servido `88e9712`, BLOCKED, no revalidado. Consultar E para commits, PR abiertos, GHCR e integration gate fallido. Producción actual desconocida.

Pendiente: revalidación funcional de referencias T, revisión del runtime, evidencia CI nueva y seguimiento de PR #14/#16/#18/#19. Los artefactos offline, las casillas de planes y los informes de QA local no sustituyen estas comprobaciones. STOP/opt-out, handoff humano e idempotencia son gates obligatorios; este índice no autoriza activar políticas o enviar mensajes.
