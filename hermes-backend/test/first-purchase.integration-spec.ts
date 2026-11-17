import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import {
  AdvertisingEventType,
  BankAccountType,
  LeadStage,
} from '@prisma/client';
import { Queue } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import request from 'supertest';
import { AdvertisingController } from '../src/advertising/advertising.controller';
import { AdvertisingService } from '../src/advertising/advertising.service';
import { GoogleAdsReportingService } from '../src/advertising/google-ads-reporting.service';
import { AutomatedDeliveryService } from '../src/automated-deliveries/automated-delivery.service';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { LeadsController } from '../src/leads/leads.controller';
import { LeadsService } from '../src/leads/leads.service';
import { PaymentsService } from '../src/payments/payments.service';
import { TransferIntentPolicy } from '../src/payments/transfer-intent.policy';
import { PrismaService } from '../src/prisma/prisma.service';

const testUrl = process.env.FIRST_PURCHASE_TEST_DATABASE_URL;
if (!testUrl) throw new Error('FIRST_PURCHASE_TEST_DATABASE_URL required');
const destination = new URL(testUrl);
if (
  !['localhost', '127.0.0.1'].includes(destination.hostname) ||
  !/^hermes_first_purchase_test_[a-z0-9_]+$/i.test(
    destination.pathname.slice(1),
  )
)
  throw new Error(
    'Only a dedicated local hermes_first_purchase_test_* database is permitted',
  );
process.env.DATABASE_URL = testUrl;

describe('first purchase PostgreSQL HTTP integration', () => {
  const prisma = new PrismaService();
  const config = new ConfigService({ PAYMENTS_TRANSFER_ENABLED: 'true' });
  const leads = new LeadsService(
    prisma,
    { emit: jest.fn() } as unknown as EventEmitter2,
    { isActive: () => false } as ClsService,
    config,
  );
  const advertising = new AdvertisingService(prisma, config, {} as Queue);
  const deliveries = {
    prepareBatch: jest.fn(),
    deliverPreparedBatch: jest.fn().mockResolvedValue({ confirmed: 0 }),
  };
  const payments = new PaymentsService(
    prisma,
    config,
    new TransferIntentPolicy(),
    deliveries as unknown as AutomatedDeliveryService,
    leads,
  );
  let app: INestApplication;
  let userId: string;
  beforeAll(async () => {
    await prisma.$connect();
    jest.spyOn(advertising, 'prepareSync').mockResolvedValue(undefined);
    jest
      .spyOn(
        payments as unknown as { decrypt(value: string): string },
        'decrypt',
      )
      .mockReturnValue('synthetic');
    const user = await prisma.user.create({
      data: {
        email: `${randomUUID()}@test.invalid`,
        password: 'synthetic',
        name: 'Test',
      },
    });
    userId = user.id;
    const module = await Test.createTestingModule({
      controllers: [LeadsController, AdvertisingController],
      providers: [
        { provide: LeadsService, useValue: leads },
        { provide: AdvertisingService, useValue: advertising },
        { provide: GoogleAdsReportingService, useValue: {} },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    app.use(
      (req: { user?: { id: string } }, _res: unknown, next: () => void) => {
        req.user = { id: userId };
        next();
      },
    );
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });
  afterAll(async () => {
    if (app) await app.close();
    await prisma.$disconnect();
  });

  it('PUT first purchase then POST second lead and retry without another conversion', async () => {
    const contact = await prisma.contact.create({
      data: { waId: `test-${randomUUID()}` },
    });
    const first = await prisma.lead.create({
      data: { contactId: contact.id, stage: LeadStage.QUALIFIED },
    });
    await request(app.getHttpServer())
      .put(`/api/leads/${first.id}`)
      .send({ stage: 'WON' })
      .expect(200);
    // The first lead is terminal before creating the next: the open-lead index is respected.
    const second = await prisma.lead.create({
      data: { contactId: contact.id, stage: LeadStage.QUALIFIED },
    });
    const body = { eventType: 'CONTRACT_WON' };
    const expected = {
      leadId: second.id,
      eventType: 'CONTRACT_WON',
      conversionCreated: false,
      reason: 'FIRST_PURCHASE_ALREADY_RECORDED',
    };
    const result = await request(app.getHttpServer())
      .post(`/api/advertising/leads/${second.id}/events`)
      .send(body)
      .expect(201);
    expect(result.body).toEqual(expected);
    const retry = await request(app.getHttpServer())
      .post(`/api/advertising/leads/${second.id}/events`)
      .send(body)
      .expect(201);
    expect(retry.body).toEqual(expected);
    const conversions = await prisma.advertisingConversion.findMany({
      where: {
        contactId: contact.id,
        eventType: AdvertisingEventType.CONTRACT_WON,
      },
      include: { syncJob: true },
    });
    expect(conversions).toHaveLength(1);
    expect(conversions[0].leadId).toBe(first.id);
    expect(conversions[0].value).toBeNull();
    expect(conversions[0].syncJob).not.toBeNull();
    expect(
      (await prisma.lead.findUniqueOrThrow({ where: { id: second.id } })).stage,
    ).toBe(LeadStage.WON);
  });

  it('POST first purchase returns its actual conversion and PUT closes a later lead', async () => {
    const contact = await prisma.contact.create({
      data: { waId: `test-${randomUUID()}` },
    });
    const first = await prisma.lead.create({
      data: { contactId: contact.id, stage: LeadStage.QUALIFIED },
    });
    const firstResult = await request(app.getHttpServer())
      .post(`/api/advertising/leads/${first.id}/events`)
      .send({ eventType: 'CONTRACT_WON' })
      .expect(201);
    expect(firstResult.body.leadId).toBe(first.id);
    expect(firstResult.body.id).toBeDefined();
    expect(firstResult.body.value).toBeNull();
    const retry = await request(app.getHttpServer())
      .post(`/api/advertising/leads/${first.id}/events`)
      .send({ eventType: 'CONTRACT_WON' })
      .expect(201);
    expect(retry.body.id).toBe(firstResult.body.id);
    const second = await prisma.lead.create({
      data: { contactId: contact.id, stage: LeadStage.QUALIFIED },
    });
    await request(app.getHttpServer())
      .put(`/api/leads/${second.id}`)
      .send({ stage: 'WON' })
      .expect(200);
    expect(
      await prisma.advertisingConversion.count({
        where: {
          contactId: contact.id,
          eventType: AdvertisingEventType.CONTRACT_WON,
        },
      }),
    ).toBe(1);
  });

  it('serializes a transfer request against a manual WON without inconsistent state', async () => {
    const contact = await prisma.contact.create({
      data: { waId: `test-${randomUUID()}` },
    });
    const conversation = await prisma.conversation.create({
      data: { contactId: contact.id },
    });
    const lead = await prisma.lead.create({
      data: {
        contactId: contact.id,
        conversationId: conversation.id,
        stage: LeadStage.QUALIFIED,
        serviceRequested: 'Synthetic service',
        proposalValue: 100,
      },
    });
    await prisma.bankAccount.create({
      data: {
        label: 'synthetic',
        bankName: 'synthetic',
        accountHolder: 'synthetic',
        accountType: BankAccountType.SAVINGS,
        accountNumberEncrypted: 'synthetic',
        accountNumberLast4: '0000',
        currency: 'USD',
      },
    });
    const [close, transfer] = await Promise.all([
      request(app.getHttpServer())
        .put(`/api/leads/${lead.id}`)
        .send({ stage: 'WON' }),
      payments.maybeSendInstructions({
        conversationId: conversation.id,
        contactId: contact.id,
        sourceMessageId: `test-${randomUUID()}`,
        text: 'quiero transferir, dame los datos de transferencia',
      }),
    ]);
    const current = await prisma.lead.findUniqueOrThrow({
      where: { id: lead.id },
    });
    const transfers = await prisma.transferPayment.count({
      where: { leadId: lead.id },
    });
    if (transfer) {
      expect(close.status).toBe(409);
      expect(current.stage).toBe(LeadStage.PAYMENT_PENDING);
      expect(transfers).toBe(1);
    } else {
      expect(close.status).toBe(200);
      expect(current.stage).toBe(LeadStage.WON);
      expect(transfers).toBe(0);
    }
  });

  it('blocks PUT and POST loss while an active transfer exists', async () => {
    const contact = await prisma.contact.create({
      data: { waId: `test-${randomUUID()}` },
    });
    const conversation = await prisma.conversation.create({
      data: { contactId: contact.id },
    });
    const lead = await prisma.lead.create({
      data: {
        contactId: contact.id,
        conversationId: conversation.id,
        stage: LeadStage.PAYMENT_PENDING,
      },
    });
    const account = await prisma.bankAccount.create({
      data: {
        label: 'synthetic',
        bankName: 'synthetic',
        accountHolder: 'synthetic',
        accountType: BankAccountType.SAVINGS,
        accountNumberEncrypted: 'synthetic',
        accountNumberLast4: '0000',
        currency: 'USD',
      },
    });
    const payment = await prisma.transferPayment.create({
      data: {
        leadId: lead.id,
        contactId: contact.id,
        conversationId: conversation.id,
        bankAccountId: account.id,
        bankAccountSnapshot: {},
        amountExpected: 100,
        currency: 'USD',
        sourceMessageId: `test-${randomUUID()}`,
      },
    });
    await request(app.getHttpServer())
      .put(`/api/leads/${lead.id}`)
      .send({ stage: 'LOST' })
      .expect(409);
    await request(app.getHttpServer())
      .post(`/api/advertising/leads/${lead.id}/events`)
      .send({ eventType: 'CONTRACT_LOST' })
      .expect(409);
    await prisma.lead.update({
      where: { id: lead.id },
      data: { stage: LeadStage.PAYMENT_REVIEW },
    });
    await prisma.transferPayment.update({
      where: { id: payment.id },
      data: { status: 'UNDER_REVIEW' },
    });
    await request(app.getHttpServer())
      .post(`/api/advertising/leads/${lead.id}/events`)
      .send({ eventType: 'CONTRACT_LOST' })
      .expect(409);
    expect(
      (await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).stage,
    ).toBe(LeadStage.PAYMENT_REVIEW);
    expect(
      await prisma.advertisingConversion.count({
        where: {
          leadId: lead.id,
          eventType: AdvertisingEventType.CONTRACT_LOST,
        },
      }),
    ).toBe(0);
  });

  it('rejects isolated revenue including zero and accepts zero with real complete contract', async () => {
    const contact = await prisma.contact.create({
      data: { waId: `test-${randomUUID()}` },
    });
    const lead = await prisma.lead.create({
      data: { contactId: contact.id, stage: LeadStage.QUALIFIED },
    });
    for (const revenueReceived of [0, 25]) {
      await request(app.getHttpServer())
        .post(`/api/advertising/leads/${lead.id}/events`)
        .send({ eventType: 'CONTRACT_WON', revenueReceived })
        .expect(400);
    }
    expect(
      (await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).stage,
    ).toBe(LeadStage.QUALIFIED);
    await request(app.getHttpServer())
      .post(`/api/advertising/leads/${lead.id}/events`)
      .send({
        eventType: 'CONTRACT_WON',
        value: 100,
        currency: 'USD',
        commercialReference: 'synthetic',
        revenueReceived: 0,
      })
      .expect(201);
    const updated = await prisma.lead.findUniqueOrThrow({
      where: { id: lead.id },
    });
    expect(Number(updated.contractedAmount)).toBe(100);
    expect(Number(updated.revenueReceived)).toBe(0);
    expect(updated.revenueReceived).not.toBeNull();
  });

  it('rejects changes to explicit received revenue on first-purchase POST replays', async () => {
    const body = {
      eventType: 'CONTRACT_WON',
      value: 100,
      currency: 'USD',
      commercialReference: 'synthetic',
    };
    const firstContact = await prisma.contact.create({
      data: { waId: `test-${randomUUID()}` },
    });
    const firstLead = await prisma.lead.create({
      data: { contactId: firstContact.id, stage: LeadStage.QUALIFIED },
    });
    const first = await request(app.getHttpServer())
      .post(`/api/advertising/leads/${firstLead.id}/events`)
      .send(body)
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/advertising/leads/${firstLead.id}/events`)
      .send({ ...body, revenueReceived: 0 })
      .expect(409);
    expect(
      (await prisma.lead.findUniqueOrThrow({ where: { id: firstLead.id } }))
        .revenueReceived,
    ).toBeNull();
    const omitted = await request(app.getHttpServer())
      .post(`/api/advertising/leads/${firstLead.id}/events`)
      .send(body)
      .expect(201);
    expect(omitted.body.id).toBe(first.body.id);

    const secondContact = await prisma.contact.create({
      data: { waId: `test-${randomUUID()}` },
    });
    const secondLead = await prisma.lead.create({
      data: { contactId: secondContact.id, stage: LeadStage.QUALIFIED },
    });
    const second = await request(app.getHttpServer())
      .post(`/api/advertising/leads/${secondLead.id}/events`)
      .send({ ...body, revenueReceived: 0 })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/advertising/leads/${secondLead.id}/events`)
      .send({ ...body, revenueReceived: 25 })
      .expect(409);
    const equal = await request(app.getHttpServer())
      .post(`/api/advertising/leads/${secondLead.id}/events`)
      .send({ ...body, revenueReceived: 0 })
      .expect(201);
    expect(equal.body.id).toBe(second.body.id);
    const persisted = await prisma.lead.findUniqueOrThrow({
      where: { id: secondLead.id },
    });
    expect(persisted.revenueReceived).not.toBeNull();
    expect(Number(persisted.revenueReceived)).toBe(0);
    expect(
      await prisma.advertisingConversion.count({
        where: {
          leadId: secondLead.id,
          eventType: AdvertisingEventType.CONTRACT_WON,
        },
      }),
    ).toBe(1);
  });

  it('keeps audited correct-stage reconciliation usable', async () => {
    const contact = await prisma.contact.create({
      data: { waId: `test-${randomUUID()}` },
    });
    const lead = await prisma.lead.create({
      data: { contactId: contact.id, stage: LeadStage.NEW },
    });
    await request(app.getHttpServer())
      .put(`/api/leads/${lead.id}`)
      .send({ stage: 'QUALIFIED' })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/leads/${lead.id}/correct-stage`)
      .send({
        targetStage: 'CONTACTED',
        expectedCurrentStage: 'QUALIFIED',
        reasonCode: 'TEST_CORRECTION',
        reason: 'Synthetic test correction',
        requestKey: randomUUID(),
      })
      .expect(201);
    const conversion = await prisma.advertisingConversion.findFirstOrThrow({
      where: {
        leadId: lead.id,
        eventType: AdvertisingEventType.LEAD_QUALIFIED,
      },
      include: { syncJob: true },
    });
    expect(conversion.invalidatedAt).not.toBeNull();
    expect(conversion.syncJob?.status).toBe('CANCELLED');
  });
});
