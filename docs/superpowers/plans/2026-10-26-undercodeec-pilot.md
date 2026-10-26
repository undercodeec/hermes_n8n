# UnderCodeEC Pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preparar el backend A7-D4 para un único número UnderCodeEC, con Nous comercial desactivado por defecto y controles mínimos de operación.

**Architecture:** Conservar la persistencia `pilotEngine` y la reserva durable `InboundTurn`. Validar el número en el webhook; clasificar el origen en metadatos de conversación; frenar el despacho Nous en el motor y transporte. Usar la base existente para telemetría y una consulta operativa simple.

**Tech Stack:** NestJS, TypeScript, Prisma/PostgreSQL, BullMQ, Jest.

**Spec:** `docs/superpowers/specs/2026-10-26-undercodeec-pilot-design.md`

## Global Constraints

- Un solo negocio y número WhatsApp Business: UnderCodeEC.
- `META_PHONE_NUMBER_ID` procede de configuración, no de código.
- Nous comercial apagado por defecto; no push, deploy, activación ni inferencias reales.
- Conservar idempotencia, opt-out, consentimiento, handoff y motor fijado por conversación.
- No paneles ni multiempresa.

## Review Focus

- Evento firmado con número ausente o incorrecto: no crea trabajo ni conversa con el cliente.
- Reintento del mismo mensaje y referral: origen y motor de la conversación permanecen estables.
- Baja comercial textual seguida de solicitud de soporte: marketing queda desactivado y el servicio continúa.
- Interruptor cambiado tras encolar Nous: el transporte comprueba el estado antes de HTTP.
- Métricas sin tokens o costo del proveedor: se reporta desconocido, nunca USD 0 facturado.

---

### Task 1: Número y origen de conversación

**Files:** `src/webhook/dto/meta-webhook.dto.ts`, `src/webhook/webhook.service.ts`, `src/webhook/webhook.service.spec.ts`, `.env.example`.

**Interfaces:** El webhook consume `metadata.phone_number_id` y `message.referral`; produce metadatos estables `pilotOrigin` y `pilotAd` y mantiene `pilotEngine`.

- [x] Escribir casos fallidos para número incorrecto/ausente, anuncio y orgánico, reintento y conversación existente.
- [x] Ejecutar sólo la suite webhook y confirmar el fallo esperado.
- [x] Implementar validación, atribución mínima y selección de motor con activación explícita.
- [x] Ejecutar suite webhook y revisar la salida.

### Task 2: Baja textual

**Files:** `src/webhook/webhook.service.ts`, `src/webhook/webhook.service.spec.ts`, `src/campaigns/campaigns.service.ts`.

**Interfaces:** Detectar texto comercial inequívoco; `CampaignsService.optOut(contactId, source?)` conserva baja idempotente.

- [x] Escribir casos fallidos de baja clara, soporte y texto ambiguo.
- [x] Confirmar fallos, implementar y ejecutar suites webhook/campaigns.

### Task 3: Interruptor y consumo Nous

**Files:** `src/conversation-engine/nous-hermes.engine.ts`, `src/conversation-engine/nous-hermes.transport.ts`, `src/conversation-engine/*.spec.ts`, `.env.example`.

**Interfaces:** `NOUS_PILOT_COMMERCIAL_ENABLED=false` y `NOUS_PILOT_OPERATIONS_ENABLED=true`; cortar antes de encolar y antes de HTTP, sin modificar `pilotEngine`. Eventos estructurados de volumen y saturación.

- [x] Escribir casos fallidos para flags apagados y cambio entre cola y despacho.
- [x] Confirmar fallos, implementar y ejecutar suites focalizadas.

### Task 4: Reporte y documentación

**Files:** `scripts/undercode-pilot-report.sql`, pruebas focalizadas, `docs/undercodeec-pilot-runbook.md`.

**Interfaces:** Reporte SQL local de solo lectura por origen, solicitudes, tokens y costo estimado; sin inferencias.

- [x] Publicar consulta SQL read-only que agrupa Meta Ads/orgánico y conserva valores desconocidos.
- [x] Ejecutar pruebas focalizadas del ruteo y la medición; corregir fixtures F3 que precedían la reserva A7-D4.
- [x] Ejecutar `npm run build`, pruebas focalizadas, suite completa, ESLint y `git diff --check`.

**Verificación local:** 91/91 suites y 1488/1488 pruebas aprobadas; build y ESLint focalizado aprobados. El SQL operativo no se ejecutó contra una base real en esta fase DARK.
