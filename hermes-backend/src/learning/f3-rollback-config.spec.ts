import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { retrievalEnabledForConversation } from './retrieval-canary-scope';

describe('F3 rollback configuration boundary', () => {
  const key = 'LEARNING_RETRIEVAL_ENABLED';
  const scopeKey = 'LEARNING_RETRIEVAL_CONVERSATION_ALLOWLIST';
  const qaId = '123e4567-e89b-42d3-a456-426614174000';
  const original = process.env[key];
  const originalScope = process.env[scopeKey];

  afterAll(() => {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
    if (originalScope === undefined) delete process.env[scopeKey];
    else process.env[scopeKey] = originalScope;
  });

  it('requires process recreation because validated environment is a startup snapshot', async () => {
    process.env[key] = 'true';
    process.env[scopeKey] = qaId;
    const first = await Test.createTestingModule({
      imports: [
        await ConfigModule.forRoot({
          ignoreEnvFile: true,
          validate: (env: Record<string, unknown>) => env,
        }),
      ],
    }).compile();
    expect(first.get(ConfigService).get(key, 'false')).toBe('true');
    expect(
      retrievalEnabledForConversation(first.get(ConfigService), qaId),
    ).toBe(true);

    process.env[scopeKey] = '';
    expect(first.get(ConfigService).get(key, 'false')).toBe('true');
    expect(
      retrievalEnabledForConversation(first.get(ConfigService), qaId),
    ).toBe(true);

    const second = await Test.createTestingModule({
      imports: [
        await ConfigModule.forRoot({
          ignoreEnvFile: true,
          validate: (env: Record<string, unknown>) => env,
        }),
      ],
    }).compile();
    expect(second.get(ConfigService).get(key, 'false')).toBe('true');
    expect(
      retrievalEnabledForConversation(second.get(ConfigService), qaId),
    ).toBe(false);
    process.env[key] = 'false';
    expect(second.get(ConfigService).get(key, 'false')).toBe('true');
    const third = await Test.createTestingModule({
      imports: [
        await ConfigModule.forRoot({
          ignoreEnvFile: true,
          validate: (env: Record<string, unknown>) => env,
        }),
      ],
    }).compile();
    expect(third.get(ConfigService).get(key, 'false')).toBe('false');
    await first.close();
    await second.close();
    await third.close();
  });
});
