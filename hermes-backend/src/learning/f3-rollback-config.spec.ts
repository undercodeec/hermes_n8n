import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

describe('F3 rollback configuration boundary', () => {
  const key = 'LEARNING_RETRIEVAL_ENABLED';
  const original = process.env[key];

  afterAll(() => {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  });

  it('requires process recreation because validated environment is a startup snapshot', async () => {
    process.env[key] = 'true';
    const first = await Test.createTestingModule({
      imports: [
        await ConfigModule.forRoot({
          ignoreEnvFile: true,
          validate: (env: Record<string, unknown>) => env,
        }),
      ],
    }).compile();
    expect(first.get(ConfigService).get(key, 'false')).toBe('true');

    process.env[key] = 'false';
    expect(first.get(ConfigService).get(key, 'false')).toBe('true');

    const second = await Test.createTestingModule({
      imports: [
        await ConfigModule.forRoot({
          ignoreEnvFile: true,
          validate: (env: Record<string, unknown>) => env,
        }),
      ],
    }).compile();
    expect(second.get(ConfigService).get(key, 'false')).toBe('false');
    await first.close();
    await second.close();
  });
});
