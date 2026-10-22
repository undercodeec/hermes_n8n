import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CampaignsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';

describe('POST /api/campaigns/media multipart security', () => {
  let app: INestApplication;
  const uploadMedia = jest.fn().mockResolvedValue({ id: 'synthetic-media' });
  const authorized = (req: request.SuperTest<request.Test>) =>
    req.set('Authorization', 'Bearer synthetic');

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [CampaignsController],
      providers: [{ provide: CampaignsService, useValue: { uploadMedia } }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: {
          switchToHttp: () => { getRequest: () => {
            headers: { authorization?: string };
            user?: { id: string };
          } };
        }) => {
          const req = context.switchToHttp().getRequest();
          if (req.headers.authorization !== 'Bearer synthetic') return false;
          req.user = { id: 'synthetic-operator' };
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
    await app.init();
  });

  beforeEach(() => uploadMedia.mockClear());
  afterAll(async () => app?.close());

  it('runs JWT before multipart parsing, even for a malformed unauthenticated body', async () => {
    await request(app.getHttpServer())
      .post('/api/campaigns/media')
      .set('Content-Type', 'multipart/form-data; boundary=synthetic')
      .send('--synthetic\r\nmalformed')
      .expect(403);
    expect(uploadMedia).not.toHaveBeenCalled();
  });

  it('rejects malformed multipart and remains available for a valid upload', async () => {
    await authorized(request(app.getHttpServer()).post('/api/campaigns/media'))
      .set('Content-Type', 'multipart/form-data; boundary=synthetic')
      .send('--synthetic\r\nmalformed')
      .expect(400);
    expect(uploadMedia).not.toHaveBeenCalled();

    await authorized(request(app.getHttpServer()).post('/api/campaigns/media'))
      .field('name', 'Synthetic clip')
      .attach('file', Buffer.from('synthetic mp4'), {
        filename: 'clip.mp4',
        contentType: 'video/mp4',
      })
      .expect(201, { id: 'synthetic-media' });
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(uploadMedia).toHaveBeenCalledWith(
      expect.objectContaining({ originalname: 'clip.mp4' }),
      expect.objectContaining({ name: 'Synthetic clip' }),
      { id: 'synthetic-operator' },
    );
  });

  it('rejects excessive field count without reaching the service', async () => {
    const upload = authorized(
      request(app.getHttpServer()).post('/api/campaigns/media'),
    );
    for (let index = 0; index < 9; index += 1) {
      upload.field(`field${index}`, 'synthetic');
    }
    await upload.expect(400);
    expect(uploadMedia).not.toHaveBeenCalled();
  });

  it('rejects an overlong multipart field name without reaching the service', async () => {
    await authorized(request(app.getHttpServer()).post('/api/campaigns/media'))
      .field('x'.repeat(101), 'synthetic')
      .expect(400);
    expect(uploadMedia).not.toHaveBeenCalled();
  });

  it('rejects a file larger than 16 MiB without reaching the service', async () => {
    await authorized(request(app.getHttpServer()).post('/api/campaigns/media'))
      .attach('file', Buffer.alloc(16 * 1024 * 1024 + 1), {
        filename: 'oversized.mp4',
        contentType: 'video/mp4',
      })
      .expect(413);
    expect(uploadMedia).not.toHaveBeenCalled();
  });

  it('accepts a file exactly at the 16 MiB boundary', async () => {
    await authorized(request(app.getHttpServer()).post('/api/campaigns/media'))
      .attach('file', Buffer.alloc(16 * 1024 * 1024), {
        filename: 'boundary.mp4',
        contentType: 'video/mp4',
      })
      .expect(201, { id: 'synthetic-media' });
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(uploadMedia.mock.calls[0][0].size).toBe(16 * 1024 * 1024);
  });
});
