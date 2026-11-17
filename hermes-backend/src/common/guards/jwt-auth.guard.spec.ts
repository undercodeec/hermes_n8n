import { ForbiddenException } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';
import { MobileAuthGuard } from '../../auth/mobile-auth.guard';

describe('mobile token route isolation', () => {
  const context = {} as never;
  it('rejects mobile tokens in legacy authenticated endpoints', () => {
    const legacy = new JwtAuthGuard();
    expect(() => legacy.handleRequest(null, { id: 'operator', sessionId: 'sid' }, null, context)).toThrow(ForbiddenException);
    expect(legacy.handleRequest(null, { id: 'operator' }, null, context)).toMatchObject({ id: 'operator' });
  });
  it('permits mobile tokens only in explicit mobile endpoints', () => {
    const mobile = new MobileAuthGuard();
    expect(mobile.handleRequest(null, { id: 'operator', sessionId: 'sid' }, null, context)).toMatchObject({ sessionId: 'sid' });
  });
});
