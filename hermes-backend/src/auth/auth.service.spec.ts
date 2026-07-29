import { createHmac } from 'crypto';
import { UnauthorizedException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuthService } from './auth.service';

const secret = 'a-shared-secret-with-at-least-thirty-two-characters';
const now = Math.floor(Date.now() / 1000);

function proof(overrides: Record<string, unknown> = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
    'base64url',
  );
  const payload = Buffer.from(
    JSON.stringify({
      iss: 'undercodeec-admin',
      aud: 'hermes-crm',
      sub: 'gerencia@undercodeec.com',
      role: 'ADMIN',
      jti: 'proof-id-which-is-long-enough',
      iat: now,
      exp: now + 120,
      ...overrides,
    }),
  ).toString('base64url');
  const signature = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

describe('AuthService CRM proof', () => {
  const upsert = jest.fn();
  const sign = jest.fn().mockReturnValue('hermes-jwt');
  const config = {
    get: jest.fn((key: string, fallback?: string) => {
      const values: Record<string, string> = {
        CRM_HERMES_PROOF_SECRET: secret,
        CRM_OPERATOR_EMAIL: 'gerencia@undercodeec.com',
      };
      return values[key] ?? fallback;
    }),
  };
  const service = new AuthService(
    { user: { upsert } } as never,
    { sign } as never,
    config as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    upsert.mockResolvedValue({
      id: 'operator-1',
      email: 'gerencia@undercodeec.com',
      name: 'Gerencia Undercodeec',
      role: UserRole.ADMIN,
    });
  });

  it('canjea una prueba válida y prepara al operador ADMIN', async () => {
    const result = await service.loginWithCrmProof(proof({ jti: 'valid-proof-id-00000001' }));

    expect(result.accessToken).toBe('hermes-jwt');
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: 'gerencia@undercodeec.com' },
        create: expect.objectContaining({ role: UserRole.ADMIN }),
        update: expect.objectContaining({ role: UserRole.ADMIN, isActive: true }),
      }),
    );
  });

  it('rechaza una prueba cuya firma fue alterada', async () => {
    await expect(service.loginWithCrmProof(`${proof() }x`)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it('rechaza reutilizar una prueba previamente canjeada', async () => {
    const signedProof = proof({ jti: 'reused-proof-id-00000001' });
    await service.loginWithCrmProof(signedProof);
    await expect(service.loginWithCrmProof(signedProof)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
