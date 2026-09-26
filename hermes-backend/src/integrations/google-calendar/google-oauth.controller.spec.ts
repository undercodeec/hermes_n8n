import { ConfigService } from '@nestjs/config';
import { GoogleOAuthController } from './google-oauth.controller';
import { GoogleOAuthService } from './google-oauth.service';
import { Request, Response } from 'express';

describe('OAuth endpoint access', () => {
  const request = {
    hostname: 'localhost',
    socket: { remoteAddress: '127.0.0.1' },
    headers: {},
  } as Request;
  it.each(['production', 'test', undefined])('is unavailable in %s', (env) => {
    const controller = new GoogleOAuthController(
      {} as GoogleOAuthService,
      new ConfigService({ NODE_ENV: env }),
    );
    expect(() => controller.auth(request, {} as Response)).toThrow();
  });
  it.each([
    { hostname: 'public.example.com' },
    { socket: { remoteAddress: '198.51.100.4' } },
    { headers: { 'x-forwarded-for': '198.51.100.4' } },
  ])('rejects public or forwarded requests', (changes) => {
    const controller = new GoogleOAuthController(
      {} as GoogleOAuthService,
      new ConfigService({ NODE_ENV: 'development' }),
    );
    expect(() =>
      controller.auth({ ...request, ...changes } as Request, {} as Response),
    ).toThrow();
  });
  it('never exposes a refresh token from the callback', async () => {
    const oauth = {
      complete: jest
        .fn()
        .mockResolvedValue({ refreshToken: 'test-sensitive-refresh' }),
    };
    const send = jest.fn();
    const controller = new GoogleOAuthController(
      oauth as unknown as GoogleOAuthService,
      new ConfigService({ NODE_ENV: 'development' }),
    );
    const response = {
      setHeader: jest.fn(),
      clearCookie: jest.fn(),
      type: () => ({ send }),
    };
    await controller.callback(
      {
        ...request,
        headers: { cookie: 'hermes_google_oauth=test-browser' },
      } as Request,
      response as unknown as Response,
      'state',
      'code',
    );
    expect(JSON.stringify(send.mock.calls)).not.toContain(
      'test-sensitive-refresh',
    );
  });
});
