import { ConfigService } from '@nestjs/config';
import { GoogleOAuthService } from './google-oauth.service';

describe('Local Google OAuth', () => {
  const config = new ConfigService({
    GOOGLE_CLIENT_ID: 'test-client',
    GOOGLE_CLIENT_SECRET: 'test-secret',
  });
  it('requests offline consent with only Calendar scopes', () => {
    const service = new GoogleOAuthService(config);
    const start = service.begin('browser');
    const url = new URL(start.url);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')).toContain('calendar.freebusy');
    expect(url.searchParams.get('state')?.length).toBeGreaterThan(32);
  });
  it('rejects forged state before code exchange', async () => {
    const service = new GoogleOAuthService(config);
    await expect(
      service.complete('forged', 'code', 'browser'),
    ).rejects.toMatchObject({ code: 'GOOGLE_CALENDAR_AUTH_FAILED' });
  });
  it('binds state to initiating browser and consumes it once', async () => {
    const service = new GoogleOAuthService(config);
    const getToken = jest
      .fn()
      .mockResolvedValue({ tokens: { refresh_token: 'test-refresh' } });
    Object.assign(service, {
      client: {
        generateAuthUrl: () => 'https://accounts.google.com/test',
        getToken,
      },
    });
    const start = service.begin('browser');
    await expect(
      service.complete(start.state, 'code', 'other'),
    ).rejects.toMatchObject({ code: 'GOOGLE_CALENDAR_AUTH_FAILED' });
    const second = service.begin('browser');
    expect(await service.complete(second.state, 'code', 'browser')).toEqual({
      refreshToken: 'test-refresh',
    });
    await expect(
      service.complete(second.state, 'code', 'browser'),
    ).rejects.toMatchObject({ code: 'GOOGLE_CALENDAR_AUTH_FAILED' });
    expect(getToken).toHaveBeenCalledTimes(1);
  });
  it('expires state after ten minutes', async () => {
    jest.useFakeTimers();
    try {
      const service = new GoogleOAuthService(config);
      const start = service.begin('browser');
      jest.advanceTimersByTime(600001);
      await expect(
        service.complete(start.state, 'code', 'browser'),
      ).rejects.toMatchObject({ code: 'GOOGLE_CALENDAR_AUTH_FAILED' });
    } finally {
      jest.useRealTimers();
    }
  });
  it('reports a missing refresh token without fabricating one', async () => {
    const service = new GoogleOAuthService(config);
    Object.assign(service, {
      client: {
        generateAuthUrl: () => 'https://accounts.google.com/test',
        getToken: jest
          .fn()
          .mockResolvedValue({ tokens: { access_token: 'test-access' } }),
      },
    });
    const start = service.begin('browser');
    expect(await service.complete(start.state, 'code', 'browser')).toEqual({
      refreshToken: undefined,
    });
  });
});
