// Local QA only: exercises the production controller, read service and JWT/roles
// guards against synthetic Prisma records. Never loads .env or calls Google.
const { ValidationPipe } = require('@nestjs/common');
const { Test } = require('@nestjs/testing');
const { ConfigService } = require('@nestjs/config');
const { JwtService } = require('@nestjs/jwt');
const { MeetingsController } = require('../../dist/integrations/google-calendar/meetings.controller');
const { MeetingReadService } = require('../../dist/integrations/google-calendar/meeting-read.service');
const { JwtStrategy } = require('../../dist/auth/strategies/jwt.strategy');
const { PrismaService } = require('../../dist/prisma/prisma.service');

async function start() {
  const secret = 'synthetic-calendar-qa-secret-local-only';
  const jwt = new JwtService({ secret });
  const rows = [
    ['CONFIRMED', '2026-09-28T16:00:00Z', 'America/Guayaquil'],
    ['PENDING', '2026-09-28T16:15:00Z', 'Europe/Madrid'],
    ['CANCELLED', '2026-09-29T17:00:00Z', 'Europe/Madrid'],
    ['FAILED', '2026-09-29T18:00:00Z', 'Atlantic/Canary'],
    ['CONFIRMED', '2026-09-29T03:00:00Z', 'America/Guayaquil'],
    ['CONFIRMED', '2026-10-25T13:00:00Z', 'Europe/Madrid'],
  ].map(([status, start, timezone], index) => ({
    id: `qa-${index}`, status, startAt: new Date(start), endAt: new Date(Date.parse(start) + 1800000),
    timezone, meetUrl: index === 0 ? 'https://meet.google.com/synthetic-qa' : null,
    serviceContext: 'Demostración local', cancelledAt: status === 'CANCELLED' ? new Date('2026-09-28T12:00:00Z') : null,
    contact: { id: `qa-contact-${index}`, name: index === 1 ? 'Reunión pendiente con nombre de contacto muy largo para verificar el diseño' : `Contacto de prueba ${index + 1}`, company: 'Empresa sintética', email: null, phone: null, waId: '593000000000' },
    lead: index === 0 ? { id: 'qa-lead', stage: 'QUALIFIED', productOfInterest: 'Demo' } : null,
    conversation: index === 0 ? { id: 'qa-conversation', status: 'OPEN' } : null,
    task: null,
  }));
  const module = await Test.createTestingModule({
    controllers: [MeetingsController],
    providers: [MeetingReadService, JwtStrategy,
      { provide: ConfigService, useValue: new ConfigService({ JWT_SECRET: secret }) },
      { provide: PrismaService, useValue: {
        user: { findUnique: async ({ where }) => ({ id: where.id, role: where.id, name: 'Operador de prueba', email: 'qa@example.test', isActive: true }) },
        meeting: { findMany: async ({ where }) => rows.filter((row) => row.startAt < where.startAt.lt && row.endAt > where.endAt.gt && (!where.status || row.status === where.status) && (!where.timezone || row.timezone === where.timezone)).sort((a, b) => a.startAt - b.startAt) },
      } },
    ],
  }).compile();
  const app = module.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } }));
  const server = app.getHttpAdapter().getInstance();
  server.get('/api/qa-session', (_req, res) => res.json({ accessToken: jwt.sign({ sub: 'SALES_AGENT', email: 'qa@example.test', role: 'SALES_AGENT' }), adminToken: 'synthetic-admin-qa', user: { id: 'SALES_AGENT', name: 'Operador de prueba', role: 'SALES_AGENT', email: 'qa@example.test' } }));
  server.get('/api/auth/profile', (_req, res) => res.json({ id: 'SALES_AGENT', name: 'Operador de prueba', role: 'SALES_AGENT' }));
  server.get('/api/admin/profile', (_req, res) => res.json({ id: 'qa-admin' }));
  server.get('/api/conversations', (_req, res) => res.json({ data: [], total: 0 }));
  app.enableCors({ origin: 'http://localhost:3100' });
  await app.listen(3103, '127.0.0.1');
  console.log('Synthetic calendar QA listening on http://127.0.0.1:3103');
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void app.close().then(() => process.exit(0)); });
}
start().catch((error) => { console.error(error); process.exit(1); });
