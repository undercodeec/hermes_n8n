# Hermes backend

> **Protocolo vigente de desarrollo**, contrastado con el código `ca85b991` el 10/11/2026. No acredita despliegue ni configuración productiva. Estado transversal: [estado del proyecto](../ProyectMD/estado-proyecto.md).

CRM conversacional de WhatsApp en NestJS 11/TypeScript, Prisma/PostgreSQL y BullMQ/Redis. La imagen versionada usa Node 22. Este repositorio contiene el backend; la interfaz CRM externa no se acredita por compilar esta API.

## Desarrollo local

Desde `hermes-backend/`, con Node 22 y servicios **de desarrollo**:

```sh
npm ci
npx prisma generate
npm run build
npm test -- --runInBand
```

Para arrancar, preparar `.env` privado a partir de [`.env.example`](.env.example), con PostgreSQL/Redis aislados y credenciales simuladas o autorizadas; no reutilizar las productivas. Después, `npm run start:dev` (watch), `npm start` o `npm run start:prod` (requiere build). `PORT` gobierna el puerto: fallback del bootstrap 3000, Compose 3003. Swagger está en `/api/docs`. CORS exige `CORS_ORIGINS` en producción.

No ejecutar seeds ni migraciones sobre una base existente como parte de esta preparación. Revisar por separado las migraciones necesarias para una base local desechable. El Compose principal incluye n8n, secretos externos y una red privada Nous: no es un entorno de pruebas autocontenido.

## Comandos reales

| Propósito | Comando desde este directorio |
| --- | --- |
| Unitarias / cobertura | `npm test -- --runInBand` / `npm run test:cov` |
| E2E / integración (revisar fixtures y servicios antes) | `npm run test:e2e` / `npm run test:integration` |
| Evaluación sintética sin proveedor | `npm run evaluate:phase0:offline` |
| Evaluación F2 offline por defecto | `npm run evaluate:f2-provider` |
| Harness learning aislado | `npm run test:learning:integration` |
| Harness Nous aislado | `npm run test:a7-d16:e2e` |
| Capacidad aislada | `npm run capacity:learning` |
| Escaneo local de secretos | `npm run security:secrets` |
| Formato / lint **modifican archivos** | `npm run format` / `npm run lint` |

La fuente exhaustiva es [package.json](package.json). `evaluate:phase0:provider`, OAuth, creación de administradores y scripts de auditoría tienen requisitos y efectos propios: no son pasos automáticos del setup. Los resultados históricos de pruebas no equivalen a una ejecución nueva.

## Arquitectura y rutas

- `src/main.ts`: validación estricta de DTO, CORS, filtros, Swagger; `src/app.module.ts`: módulos y configuración.
- `src/webhook` → `src/auto-replies` → `src/conversation-engine`: ingreso Meta, turnos durables, selección Gemini/Nous y política comercial; `src/automated-deliveries` conserva el ledger de entrega. La identidad y los estados persistidos no se borran para reintentar un envío ambiguo.
- `src/hermes`: autoridad comercial y revisión de afirmaciones; productos y listas autorizadas alimentan el snapshot. Un seed o una respuesta del LLM no autoriza precios.
- `src/prisma` y `prisma/`: persistencia. `src/integrations`: n8n, Calendar y transporte Nous. `src/learning`: reviewer y candidatos sujetos a flags y aprobación humana.

| Superficie | Rutas existentes (no implican activación) |
| --- | --- |
| Auth / CRM | `/api/auth/*`, `/api/contacts`, `/api/leads`, `/api/conversations`, `/api/messages`, `/api/tasks`, `/api/handoff` |
| Catálogo | `/api/products`, `/api/price-lists`, `/api/knowledge`, `/api/playbooks` |
| WhatsApp | `GET/POST /webhooks/meta/whatsapp` |
| Publicidad | `/api/advertising/*`, `POST /api/advertising/contact-intents`, `/api/campaigns`, `/api/analytics/*` |
| Transferencias | `/api/bank-accounts`, `/api/transfers/:id`, `POST /api/transfers/:id/start-review`, `/approve`, `/reject` |
| Calendar | `GET /api/meetings`; OAuth `/api/integrations/google/auth` y `/callback` restringidos a desarrollo local |
| Learning | `/api/learning/candidates`, `POST /api/learning/candidates/:id/decision`, `POST /api/learning/reviews/canary` |
| Retención | `/api/admin/retention-recovery-policy` y operaciones subordinadas |

Los controladores/guards son la autoridad para métodos, roles y autenticación. La existencia de ruta no prueba disponibilidad en VPS ni integración de la UI.

## Operación y documentación

- [Despliegue y rollback](docs/deployment-runbook.md): procedencia, preflight y verificación separada del runtime.
- [Operación comercial Black Friday](docs/commercial-black-friday-runbook.md): mercado, autoridad y validación sin activar campañas.
- [Índice documental](docs/README.md), [Nous](docs/nous-hermes-runbook.md), [Calendar](docs/google-calendar-runbook.md), [publicidad](docs/advertising-attribution.md), [transferencias](docs/transfer-payment-crm-implementation-plan.md), [learning](docs/conversation-learning-operations.md).

Las cabeceras distinguen protocolos, plantillas e historia. Las actas se conservan; no usar sus flags, tarifas, commits o resultados como estado vigente. No se presume activado learning, pagos, Calendar, publicidad ni Nous.
