import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { GoogleOAuthService } from '../integrations/google-calendar/google-oauth.service';
import { saveGoogleToken } from '../integrations/google-calendar/secure-token-file';

export async function authorizeGoogleCalendar(args: string[]): Promise<void> {
  const arg = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const credentials = arg('--credentials'),
    output = arg('--output') ?? resolve('secrets/google-calendar.env');
  const config: Record<string, string | undefined> = {
    ...process.env,
    GOOGLE_OAUTH_REDIRECT_URI:
      'http://localhost:3003/api/integrations/google/callback',
  };
  if (credentials) {
    const value = JSON.parse(readFileSync(resolve(credentials), 'utf8')) as {
      web?: { client_id?: string; client_secret?: string };
    };
    config.GOOGLE_CLIENT_ID = value.web?.client_id;
    config.GOOGLE_CLIENT_SECRET = value.web?.client_secret;
  }
  const oauth = new GoogleOAuthService(new ConfigService(config)),
    binding = randomBytes(32).toString('base64url');
  const flow = oauth.begin(binding);
  await new Promise<void>((resolveFlow, reject) => {
    let processing = false;
    const server = createServer((request, response) => {
      void (async () => {
        const url = new URL(request.url ?? '', 'http://localhost:3003');
        response.setHeader('Cache-Control', 'no-store');
        if (url.pathname !== '/api/integrations/google/callback') {
          response.writeHead(404).end();
          return;
        }
        if (processing) {
          response.writeHead(409).end('Flujo en procesamiento.');
          return;
        }
        processing = true;
        try {
          const result = await oauth.complete(
            url.searchParams.get('state') ?? '',
            url.searchParams.get('code') ?? '',
            binding,
          );
          if (!result.refreshToken) throw new Error('Missing refresh token');
          saveGoogleToken(output, result.refreshToken);
          response
            .writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
            .end(
              'Autorización completada. Credenciales guardadas localmente; puede cerrar esta ventana.',
            );
          console.log(
            'Refresh token guardado en el archivo local indicado. No fue mostrado ni enviado al CRM.',
          );
          clearTimeout(timer);
          server.close();
          resolveFlow();
        } catch {
          response
            .writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
            .end('No se completó la autorización. Repita la utilidad local.');
          clearTimeout(timer);
          server.close();
          reject(new Error('Google OAuth bootstrap failed'));
        }
      })();
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('Google OAuth bootstrap expired'));
    }, 600000);
    server.on('error', () => {
      clearTimeout(timer);
      reject(new Error('Local OAuth listener unavailable'));
    });
    server.listen(3003, '127.0.0.1', () =>
      console.log(`Abra esta URL en su navegador local:\n${flow.url}`),
    );
  });
}
if (require.main === module)
  void authorizeGoogleCalendar(process.argv.slice(2)).catch(() => {
    console.error(
      'No se completó la autorización local de Google Calendar. Revise configuración, URI registrada y permisos del archivo.',
    );
    process.exitCode = 1;
  });
