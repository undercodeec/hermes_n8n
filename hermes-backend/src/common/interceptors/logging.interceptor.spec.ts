import { ExecutionContext, Logger } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { LoggingInterceptor } from './logging.interceptor';

it('never logs OAuth callback query credentials', async () => {
  const log = jest
    .spyOn(Logger.prototype, 'log')
    .mockImplementation(() => undefined);
  try {
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'GET',
          url: '/api/integrations/google/callback?code=test-sensitive-code&state=test-sensitive-state',
        }),
        getResponse: () => ({ statusCode: 200 }),
      }),
    } as ExecutionContext;
    await lastValueFrom(
      new LoggingInterceptor().intercept(context, { handle: () => of('ok') }),
    );
    const output = log.mock.calls.flat().join(' ');
    expect(output).toContain('/api/integrations/google/callback');
    expect(output).not.toContain('test-sensitive');
  } finally {
    log.mockRestore();
  }
});
