import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';
import { MobileInboxQuery, MobileMessageQuery } from './mobile-inbox.dto';

describe('mobile inbox query conversion', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });
  const metadata = (
    metatype: ArgumentMetadata['metatype'],
  ): ArgumentMetadata => ({
    type: 'query',
    metatype,
    data: undefined,
  });

  it.each([
    [MobileInboxQuery, 20],
    [MobileMessageQuery, 50],
  ])('converts HTTP query limit for %p', async (query, limit) => {
    const transformed: unknown = await pipe.transform(
      { limit: String(limit) },
      metadata(query),
    );
    const result = transformed as { limit: unknown };
    expect(result.limit).toBe(limit);
    expect(typeof result.limit).toBe('number');
    await expect(
      pipe.transform({ limit: '0' }, metadata(query)),
    ).rejects.toThrow();
    await expect(
      pipe.transform({ limit: 'oops' }, metadata(query)),
    ).rejects.toThrow();
  });
});
