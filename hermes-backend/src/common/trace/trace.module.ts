import { Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { randomUUID } from 'crypto';
import type { Request } from 'express';

/**
 * Configura `nestjs-cls` para tener un `traceId` por request, accesible en
 * cualquier servicio sin pasarlo manualmente. Si el request entrante ya trae
 * `x-trace-id` (ej. propagado desde otro servicio) se reusa; si no, se genera.
 *
 * El `traceId` se serializa dentro del payload de cada evento de dominio para
 * poder seguirlo a través de BullMQ y n8n (el worker de BullMQ NO comparte el
 * contexto async del request, por eso viaja en el payload — ver §12 del plan).
 */
@Module({
  imports: [
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        generateId: true,
        idGenerator: (req: Request) =>
          (req.headers['x-trace-id'] as string) ?? randomUUID(),
        setup: (cls) => {
          cls.set('traceId', cls.getId());
        },
      },
    }),
  ],
  exports: [ClsModule],
})
export class TraceModule {}
