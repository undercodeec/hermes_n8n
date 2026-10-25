import { AxiosError } from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import {
  appendNativeDiagnostic,
  safeNativeError,
} from './f3-native-diagnostics';

const sourceId = '13d6ef41-8384-4f2e-a0d0-1486d39a9080';
const secret = 'SENTINEL_SECRET_PROMPT_RESPONSE';

function axiosFailure(status?: number, code?: string, provider?: unknown) {
  const error = new AxiosError(secret, code);
  error.response = status
    ? {
        status,
        data: provider,
        statusText: secret,
        headers: { authorization: secret },
        config: {} as never,
      }
    : undefined;
  return error;
}

describe('F3 native diagnostic allowlist', () => {
  it.each([
    [400, 'HTTP_400'],
    [401, 'HTTP_401'],
    [403, 'HTTP_403'],
    [429, 'HTTP_429'],
    [503, 'HTTP_5XX'],
  ] as const)(
    'classifies HTTP %i without provider text',
    (status, failureClass) => {
      const result = safeNativeError(
        axiosFailure(status, 'ERR_BAD_RESPONSE', {
          error: { code: status, status: 'INVALID_ARGUMENT', message: secret },
          prompt: secret,
        }),
      );
      expect(result).toEqual({
        failureClass,
        httpStatus: status,
        providerErrorCode: status,
        providerStatus: 'INVALID_ARGUMENT',
      });
      expect(JSON.stringify(result)).not.toContain(secret);
    },
  );

  it.each([
    ['ENOTFOUND', 'DNS'],
    ['EAI_AGAIN', 'DNS'],
    ['ECONNABORTED', 'TIMEOUT'],
    ['ETIMEDOUT', 'TIMEOUT'],
    ['CERT_HAS_EXPIRED', 'TLS'],
  ] as const)(
    'classifies %s without leaking messages',
    (code, failureClass) => {
      expect(safeNativeError(axiosFailure(undefined, code))).toEqual({
        failureClass,
        transportCode: code,
      });
    },
  );

  it('rejects unknown provider enums and arbitrary Axios codes', () => {
    const result = safeNativeError(
      axiosFailure(418, secret, {
        error: { code: 999999, status: secret, message: secret },
      }),
    );
    expect(result).toEqual({ failureClass: 'HTTP_4XX', httpStatus: 418 });
  });

  it('appends safe stages to the inbound record for later reread', async () => {
    const stored: Record<string, unknown[]> = {};
    const execute = jest.fn(
      (_sql: TemplateStringsArray, raw: string, id: string) => {
        stored[id] ??= [];
        stored[id].push(JSON.parse(raw));
        return Promise.resolve(1);
      },
    );
    const prisma = { $executeRaw: execute } as unknown as PrismaService;
    await appendNativeDiagnostic(prisma, sourceId, {
      stage: 'HTTP_RESPONSE_OBSERVED',
      httpStatus: 429,
      requestAttemptedLocal: true,
      httpResponseObserved: true,
      providerReceipt: 'UNKNOWN',
      billingReconciled: 'UNKNOWN',
      extra: secret,
    } as never);
    expect(stored[sourceId]).toEqual([
      expect.objectContaining({
        stage: 'HTTP_RESPONSE_OBSERVED',
        httpStatus: 429,
        sourceMessageId: sourceId,
        requestAttemptedLocal: true,
        httpResponseObserved: true,
        providerReceipt: 'UNKNOWN',
        billingReconciled: 'UNKNOWN',
      }),
    ]);
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the inbound row cannot be updated', async () => {
    const prisma = {
      $executeRaw: jest.fn().mockResolvedValue(0),
    } as unknown as PrismaService;
    await expect(
      appendNativeDiagnostic(prisma, sourceId, { stage: 'DISPATCH_RESERVED' }),
    ).rejects.toThrow('F3_DIAGNOSTIC_PERSISTENCE_FAILED');
  });
});
