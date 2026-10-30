import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { UserRole } from '@prisma/client';
import { RolesGuard } from '../common/guards/roles.guard';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { PriceListsController } from './price-lists.controller';

describe('PriceListsController authorization', () => {
  const reflector = new Reflector();
  const guard = new RolesGuard(reflector);

  it('runs the official JWT and role guards on direct API requests', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, PriceListsController) as Array<{ name: string }>;
    expect(guards.map((item) => item.name)).toEqual(['JwtAuthGuard', 'RolesGuard']);
  });

  for (const method of ['create', 'update', 'remove'] as const) {
    it(`requires ADMIN for ${method} when called directly`, () => {
      const handler = PriceListsController.prototype[method];
      expect(reflector.get<UserRole[]>(ROLES_KEY, handler)).toEqual([UserRole.ADMIN]);
      const context = (role: UserRole) => ({
        getHandler: () => handler,
        getClass: () => PriceListsController,
        switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
      });
      expect(guard.canActivate(context(UserRole.ADMIN) as never)).toBe(true);
      expect(guard.canActivate(context(UserRole.SALES_AGENT) as never)).toBe(false);
    });
  }
});
