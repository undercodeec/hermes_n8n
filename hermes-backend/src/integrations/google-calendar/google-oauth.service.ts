import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createCalendarOAuth, GOOGLE_SCOPES } from './google-calendar.service';
import { CalendarError, classifyCalendarError } from './calendar.errors';

@Injectable()
export class GoogleOAuthService {
  private readonly states = new Map<
    string,
    { binding: Buffer; expires: number }
  >();
  private readonly client: ReturnType<typeof createCalendarOAuth>;
  constructor(private readonly config: ConfigService) {
    this.client = createCalendarOAuth({
      clientId: config.get('GOOGLE_CLIENT_ID', ''),
      clientSecret: config.get('GOOGLE_CLIENT_SECRET', ''),
      redirectUri: config.get(
        'GOOGLE_OAUTH_REDIRECT_URI',
        'http://localhost:3003/api/integrations/google/callback',
      ),
    });
  }
  begin(binding: string): { url: string; state: string } {
    if (
      !this.config.get('GOOGLE_CLIENT_ID') ||
      !this.config.get('GOOGLE_CLIENT_SECRET') ||
      !binding
    )
      throw new CalendarError('GOOGLE_CALENDAR_AUTH_FAILED');
    for (const [key, value] of this.states)
      if (value.expires < Date.now()) this.states.delete(key);
    if (this.states.size >= 100)
      throw new CalendarError('GOOGLE_CALENDAR_AUTH_FAILED');
    const state = randomBytes(32).toString('base64url');
    this.states.set(createHash('sha256').update(state).digest('hex'), {
      binding: createHash('sha256').update(binding).digest(),
      expires: Date.now() + 600000,
    });
    return {
      state,
      url: this.client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: GOOGLE_SCOPES,
        state,
      }),
    };
  }
  async complete(
    state: string,
    code: string,
    binding: string,
  ): Promise<{ refreshToken?: string }> {
    if (!state || !code || !binding || state.length > 256 || code.length > 4096)
      throw new CalendarError('GOOGLE_CALENDAR_AUTH_FAILED');
    const key = createHash('sha256').update(state).digest('hex'),
      expected = this.states.get(key);
    this.states.delete(key);
    if (
      !expected ||
      expected.expires < Date.now() ||
      !timingSafeEqual(
        expected.binding,
        createHash('sha256').update(binding).digest(),
      )
    )
      throw new CalendarError('GOOGLE_CALENDAR_AUTH_FAILED');
    try {
      const result = await this.client.getToken(code);
      return { refreshToken: result.tokens.refresh_token ?? undefined };
    } catch (error) {
      throw classifyCalendarError(error, 'GOOGLE_CALENDAR_AUTH_FAILED');
    }
  }
}
