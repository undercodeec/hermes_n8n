/** Opt-in staging authentication. Never ship endpoint secrets or log OTP/proof/tokens. */
export type Storage = { getItemAsync(key: string): Promise<string | null>; setItemAsync(key: string, value: string): Promise<void>; deleteItemAsync(key: string): Promise<void> };
export type Transport = (url: string, init: RequestInit) => Promise<Response>;
export type AuthConfig = { adminBase: string; hermesBase: string };
const KEY = 'hermes.crm.mobile.refresh.v1';

function baseUrl(value: string): string {
  const parsed = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '10.0.2.2'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) throw new Error('Se requiere HTTPS para la autenticación móvil.');
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('URL de autenticación no válida.');
  return parsed.href.replace(/\/$/, '');
}

export function stagingConfig(adminBase?: string, hermesBase?: string): AuthConfig | null {
  if (!adminBase || !hermesBase) return null;
  return { adminBase: baseUrl(adminBase), hermesBase: baseUrl(hermesBase) };
}

export class SessionExpired extends Error { constructor() { super('La sesión terminó. Solicite un nuevo código.'); } }
export class NetworkUnavailable extends Error { constructor() { super('Sin conexión. La información permanece bloqueada hasta validar la sesión.'); } }

type Tokens = { accessToken: string; refreshToken: string };
export class StagingAuth {
  private accessToken: string | null = null;
  private refreshPending: Promise<void> | null = null;
  private lastActivitySent = 0;
  private generation = 0;
  private storageQueue: Promise<unknown> = Promise.resolve();
  constructor(private readonly config: AuthConfig, private readonly storage: Storage, private readonly transport: Transport = fetch) {}

  private async post(base: string, path: string, data: object, token?: string) {
    let response: Response;
    try {
      response = await this.transport(`${base}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(data),
      });
    } catch { throw new NetworkUnavailable(); }
    if (response.status === 401 || response.status === 403) throw new SessionExpired();
    if (!response.ok) throw new Error('No se pudo completar la operación. Inténtelo de nuevo.');
    try { return await response.json() as Record<string, unknown>; } catch { throw new Error('Respuesta de autenticación no válida.'); }
  }

  async requestCode(email: string) {
    await this.post(this.config.adminBase, '/api/crm/auth/request-code', { email: email.trim() });
  }

  async verifyCode(email: string, code: string) {
    if (!/^\d{8}$/.test(code)) throw new Error('Ingrese los ocho dígitos del código.');
    const verified = await this.post(this.config.adminBase, '/api/crm/auth/mobile/verify-code', { email: email.trim(), code });
    if (typeof verified.proof !== 'string') throw new Error('Respuesta de autenticación no válida.');
    const session = await this.post(this.config.hermesBase, '/api/auth/mobile/crm-proof', { proof: verified.proof });
    await this.save(session, this.generation);
  }

  private async save(result: Record<string, unknown>, generation: number) {
    if (typeof result.accessToken !== 'string' || typeof result.refreshToken !== 'string') throw new Error('Respuesta de sesión no válida.');
    // Commit refresh to protected storage before exposing any protected screen.
    const write = this.storageQueue.then(async () => {
      if (generation !== this.generation) throw new SessionExpired();
      await this.storage.setItemAsync(KEY, result.refreshToken as string);
    });
    this.storageQueue = write.catch(() => undefined);
    await write;
    if (generation !== this.generation) throw new SessionExpired();
    this.accessToken = result.accessToken;
  }

  private async refresh() {
    if (!this.refreshPending) this.refreshPending = (async () => {
      const generation = this.generation;
      const refreshToken = await this.storage.getItemAsync(KEY);
      if (generation !== this.generation) throw new SessionExpired();
      if (!refreshToken) throw new SessionExpired();
      const result = await this.post(this.config.hermesBase, '/api/auth/mobile/refresh', { refreshToken });
      await this.save(result, generation);
    })().finally(() => { this.refreshPending = null; });
    return this.refreshPending;
  }

  async validate() {
    if (!this.accessToken) await this.refresh();
    try {
      const status = await this.post(this.config.hermesBase, '/api/auth/mobile/status', {}, this.accessToken!);
      if (status.active !== true) throw new SessionExpired();
    } catch (error) {
      if (!(error instanceof SessionExpired)) throw error;
      // An access token may expire without ending the session. The server validates
      // the inactivity window before allowing refresh; refresh never extends it.
      await this.refresh();
      const status = await this.post(this.config.hermesBase, '/api/auth/mobile/status', {}, this.accessToken!);
      if (status.active !== true) throw new SessionExpired();
    }
  }

  async activity() {
    const now = Date.now();
    if (now - this.lastActivitySent < 15_000) return;
    await this.validate();
    await this.post(this.config.hermesBase, '/api/auth/mobile/activity', {}, this.accessToken!);
    this.lastActivitySent = now;
  }

  async logout() {
    try {
      if (this.accessToken) await this.post(this.config.hermesBase, '/api/auth/mobile/logout', {}, this.accessToken);
    } finally { await this.clear(); }
  }

  async clear() {
    this.generation++;
    this.accessToken = null;
    this.lastActivitySent = 0;
    const remove = this.storageQueue.then(() => this.storage.deleteItemAsync(KEY));
    this.storageQueue = remove.catch(() => undefined);
    await remove;
  }
}
