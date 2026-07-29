import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConversationStatus, LeadStage, UserRole } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AnalyticsController } from '../src/analytics/analytics.controller';
import { AnalyticsService } from '../src/analytics/analytics.service';
import { AuthController } from '../src/auth/auth.controller';
import { AuthService } from '../src/auth/auth.service';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { ConversationsController } from '../src/conversations/conversations.controller';
import { ConversationsService } from '../src/conversations/conversations.service';
import {
  HandoffResolutionAction,
  ResolveHandoffDto,
} from '../src/handoff/dto/handoff-actions.dto';
import { HandoffController } from '../src/handoff/handoff.controller';
import { HandoffService } from '../src/handoff/handoff.service';
import { LeadsController } from '../src/leads/leads.controller';
import { LeadsService } from '../src/leads/leads.service';

describe('Contratos HTTP del CRM (e2e aislado)', () => {
  let app: INestApplication<App>;

  const authService = {
    login: jest.fn(),
    loginWithCrmProof: jest.fn(),
    register: jest.fn(),
    getProfile: jest.fn(),
  };
  const leadsService = {
    create: jest.fn(),
    findAll: jest.fn(),
    getFunnelDistribution: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
  };
  const conversationsService = {
    create: jest.fn(),
    findAll: jest.fn(),
    findMessages: jest.fn(),
    findOne: jest.fn(),
    reply: jest.fn(),
    close: jest.fn(),
  };
  const handoffService = {
    create: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    assign: jest.fn(),
    resolve: jest.fn(),
  };
  const analyticsService = {
    getCrmOverview: jest.fn(),
    getFunnelDistribution: jest.fn(),
    getConversationMetrics: jest.fn(),
    getAverageResponseTime: jest.fn(),
    getCostMetrics: jest.fn(),
    getCampaignPerformance: jest.fn(),
  };

  const testAuthGuard: CanActivate = {
    canActivate(context: ExecutionContext) {
      const httpRequest = context.switchToHttp().getRequest<{
        headers: Record<string, string | string[] | undefined>;
        user?: { id: string; role: UserRole };
      }>();
      const requestedRole = httpRequest.headers['x-test-role'];
      httpRequest.user = {
        id: 'user-1',
        role:
          requestedRole === UserRole.SALES_AGENT
            ? UserRole.SALES_AGENT
            : UserRole.ADMIN,
      };
      return true;
    },
  };

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      controllers: [
        AuthController,
        LeadsController,
        ConversationsController,
        HandoffController,
        AnalyticsController,
      ],
      providers: [
        { provide: AuthService, useValue: authService },
        { provide: LeadsService, useValue: leadsService },
        { provide: ConversationsService, useValue: conversationsService },
        { provide: HandoffService, useValue: handoffService },
        { provide: AnalyticsService, useValue: analyticsService },
        RolesGuard,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(testAuthGuard)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

    it('publica login como HTTP 200 y valida sus credenciales', async () => {
    authService.login.mockResolvedValue({
      accessToken: 'jwt',
      user: { id: 'user-1', role: UserRole.ADMIN },
    });

    const loginResponse = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'admin@example.com', password: 'secret-value' })
      .expect(200);
    const loginBody = loginResponse.body as { accessToken?: string };
    expect(loginBody.accessToken).toBe('jwt');

    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'incorrecto', password: 'secret-value' })
      .expect(400);

      expect(authService.login).toHaveBeenCalledTimes(1);
    });

    it('canjea una prueba OTP del Admin por un JWT propio de Hermes', async () => {
      authService.loginWithCrmProof.mockResolvedValue({
        accessToken: 'hermes-crm-jwt',
        user: { id: 'operator-1', role: UserRole.ADMIN },
      });

      const response = await request(app.getHttpServer())
        .post('/api/auth/crm-proof')
        .send({ proof: 'header.payload.signature' })
        .expect(200);

      expect(response.body.accessToken).toBe('hermes-crm-jwt');
      expect(authService.loginWithCrmProof).toHaveBeenCalledWith(
        'header.payload.signature',
      );
    });

  it('restringe el registro a ADMIN y exige contraseña de 12 caracteres', async () => {
    authService.register.mockResolvedValue({
      id: 'new-user',
      role: UserRole.SALES_AGENT,
    });
    const validBody = {
      email: 'agent@example.com',
      password: 'long-password',
      name: 'Agente',
    };

    await request(app.getHttpServer())
      .post('/api/auth/register')
      .set('x-test-role', UserRole.SALES_AGENT)
      .send(validBody)
      .expect(403);

    await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ ...validBody, password: 'short' })
      .expect(400);

    await request(app.getHttpServer())
      .post('/api/auth/register')
      .send(validBody)
      .expect(201);

    expect(authService.register).toHaveBeenCalledTimes(1);
  });

  it('transforma y valida filtros paginados de leads', async () => {
    leadsService.findAll.mockResolvedValue({
      data: [],
      meta: { page: 2, limit: 10, total: 0 },
    });

    await request(app.getHttpServer())
      .get(
        '/api/leads?page=2&limit=10&stage=NEW&hasHandoff=true&hermesReplied=false',
      )
      .expect(200);

    expect(leadsService.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 2,
        limit: 10,
        stage: LeadStage.NEW,
        hasHandoff: true,
        hermesReplied: false,
      }),
    );

    await request(app.getHttpServer()).get('/api/leads?limit=101').expect(400);
  });

  it('registra el actor autenticado al cambiar una etapa', async () => {
    leadsService.update.mockResolvedValue({
      id: 'lead-1',
      stage: LeadStage.QUALIFIED,
    });

    await request(app.getHttpServer())
      .put('/api/leads/lead-1')
      .send({ stage: LeadStage.QUALIFIED })
      .expect(200);

    expect(leadsService.update).toHaveBeenCalledWith(
      'lead-1',
      { stage: LeadStage.QUALIFIED },
      'user-1',
    );
  });

  it('expone filtros de inbox y paginación de mensajes', async () => {
    conversationsService.findAll.mockResolvedValue({
      data: [],
      meta: { page: 1, limit: 20, total: 0 },
    });
    conversationsService.findMessages.mockResolvedValue({
      data: [],
      meta: { page: 2, limit: 25, total: 0 },
    });

    await request(app.getHttpServer())
      .get(
        `/api/conversations?status=${ConversationStatus.HANDED_OFF}&priorityOnly=true`,
      )
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/conversations/conversation-1/messages?page=2&limit=25')
      .expect(200);

    expect(conversationsService.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ConversationStatus.HANDED_OFF,
        priorityOnly: true,
      }),
    );
    expect(conversationsService.findMessages).toHaveBeenCalledWith(
      'conversation-1',
      expect.objectContaining({ page: 2, limit: 25 }),
    );
  });

  it('propaga el error legible cuando la respuesta requiere plantilla', async () => {
    conversationsService.reply.mockRejectedValueOnce(
      new BadRequestException({
        code: 'WHATSAPP_TEMPLATE_REQUIRED',
        message: 'La ventana de respuesta está cerrada',
      }),
    );

    const replyResponse = await request(app.getHttpServer())
      .post('/api/conversations/conversation-1/reply')
      .send({ content: 'Respuesta manual' })
      .expect(400);
    const replyBody = replyResponse.body as {
      code?: string;
      path?: string;
    };
    expect(replyBody.code).toBe('WHATSAPP_TEMPLATE_REQUIRED');
    expect(replyBody.path).toBe('/api/conversations/conversation-1/reply');

    expect(conversationsService.reply).toHaveBeenCalledWith(
      'conversation-1',
      { content: 'Respuesta manual' },
      'user-1',
    );
  });

  it('toma y resuelve handoffs con actor y acción explícitos', async () => {
    handoffService.assign.mockResolvedValue({ id: 'handoff-1' });
    handoffService.resolve.mockResolvedValue({ id: 'handoff-1' });
    const resolution: ResolveHandoffDto = {
      resolution: 'Cliente atendido',
      action: HandoffResolutionAction.RETURN_TO_HERMES,
    };

    await request(app.getHttpServer())
      .put('/api/handoff/handoff-1/take')
      .send({})
      .expect(200);
    await request(app.getHttpServer())
      .put('/api/handoff/handoff-1/resolve')
      .send(resolution)
      .expect(200);

    expect(handoffService.assign).toHaveBeenCalledWith(
      'handoff-1',
      'user-1',
      'user-1',
    );
    expect(handoffService.resolve).toHaveBeenCalledWith(
      'handoff-1',
      resolution,
      'user-1',
    );

    await request(app.getHttpServer())
      .put('/api/handoff/handoff-1/resolve')
      .send({ ...resolution, resolution: '' })
      .expect(400);
  });

  it('publica el resumen CRM protegido', async () => {
    analyticsService.getCrmOverview.mockResolvedValue({
      totalObserved: 2,
      qualified: 1,
      open: 2,
      won: 0,
      lost: 0,
      pendingHandoffs: 1,
    });

    const overviewResponse = await request(app.getHttpServer())
      .get('/api/analytics/crm-overview')
      .expect(200);
    const overviewBody = overviewResponse.body as {
      totalObserved?: number;
      pendingHandoffs?: number;
    };
    expect(overviewBody.totalObserved).toBe(2);
    expect(overviewBody.pendingHandoffs).toBe(1);
  });

  it('incluye las rutas críticas en el contrato OpenAPI', () => {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Hermes CRM')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);

    expect(document.paths['/api/auth/login']).toBeDefined();
    expect(document.paths['/api/leads']).toBeDefined();
    expect(document.paths['/api/conversations/{id}/messages']).toBeDefined();
    expect(document.paths['/api/conversations/{id}/reply']).toBeDefined();
    expect(document.paths['/api/handoff/{id}/resolve']).toBeDefined();
    expect(document.paths['/api/analytics/crm-overview']).toBeDefined();
  });
});
