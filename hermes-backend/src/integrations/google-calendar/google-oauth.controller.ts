import {
  Controller,
  Get,
  NotFoundException,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { GoogleOAuthService } from './google-oauth.service';

@Controller('api/integrations/google')
export class GoogleOAuthController {
  constructor(
    private readonly oauth: GoogleOAuthService,
    private readonly config: ConfigService,
  ) {}
  private local(request: Request): void {
    const redirect = new URL(
      this.config.get(
        'GOOGLE_OAUTH_REDIRECT_URI',
        'http://localhost:3003/api/integrations/google/callback',
      ),
    );
    if (
      this.config.get('NODE_ENV') !== 'development' ||
      !['localhost', '127.0.0.1', '::1'].includes(request.hostname) ||
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(
        request.socket.remoteAddress ?? '',
      ) ||
      request.headers['x-forwarded-for'] ||
      !['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname)
    )
      throw new NotFoundException();
  }
  @Get('auth')
  auth(@Req() request: Request, @Res() response: Response): void {
    this.local(request);
    const binding = randomBytes(32).toString('base64url');
    const flow = this.oauth.begin(binding);
    response.setHeader('Cache-Control', 'no-store');
    response.cookie('hermes_google_oauth', binding, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 600000,
      path: '/api/integrations/google',
    });
    response.redirect(flow.url);
  }
  @Get('callback')
  async callback(
    @Req() request: Request,
    @Res() response: Response,
    @Query('state') state?: string,
    @Query('code') code?: string,
  ): Promise<void> {
    this.local(request);
    const binding =
      request.headers.cookie
        ?.split(';')
        .map((s) => s.trim())
        .find((s) => s.startsWith('hermes_google_oauth='))
        ?.slice('hermes_google_oauth='.length) ?? '';
    response.setHeader('Cache-Control', 'no-store');
    response.clearCookie('hermes_google_oauth', {
      path: '/api/integrations/google',
    });
    const result = await this.oauth.complete(
      typeof state === 'string' ? state : '',
      typeof code === 'string' ? code : '',
      binding,
    );
    response
      .type('text/plain')
      .send(
        result.refreshToken
          ? 'Autorización completada. Se recibió refresh token; no se guardó. Use la utilidad CLI local para obtener y guardar credenciales.'
          : 'Autorización completada sin refresh token. Repita el flujo de consentimiento con la utilidad CLI local.',
      );
  }
}
