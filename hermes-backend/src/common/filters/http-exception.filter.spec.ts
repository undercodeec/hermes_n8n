import { ArgumentsHost, Logger } from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';

it('sanitizes callback path and stack on errors', () => {
  const log = jest
    .spyOn(Logger.prototype, 'error')
    .mockImplementation(() => undefined);
  const json = jest.fn();
  const response = { status: () => ({ json }) };
  try {
    new HttpExceptionFilter().catch(new Error('test-sensitive-secret'), {
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'GET',
          url: '/api/integrations/google/callback?code=test-sensitive-code',
        }),
        getResponse: () => response,
      }),
    } as ArgumentsHost);
    expect(JSON.stringify(json.mock.calls)).not.toContain('test-sensitive');
    expect(JSON.stringify(log.mock.calls)).not.toContain('test-sensitive');
  } finally {
    log.mockRestore();
  }
});
