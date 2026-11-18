/** Opt-in staging authentication. Never ship endpoint secrets or log OTP/proof/tokens. */
export type Storage = { getItemAsync(key: string): Promise<string | null>; setItemAsync(key: string, value: string): Promise<void>; deleteItemAsync(key: string): Promise<void> };
export type Transport = (url: string, init: RequestInit) => Promise<Response>;
export type AuthConfig = { adminBase: string; hermesBase: string };
const KEY = 'hermes.crm.mobile.refresh.v1';
const PENDING_KEY = 'hermes.crm.mobile.refresh.pending.v1';

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
export class RefreshUncertain extends Error { constructor() { super('No se pudo confirmar la renovación. Solicite un nuevo código de acceso.'); } }
export class LocalClearFailed extends Error { constructor() { super('No se confirmó el borrado local. La pantalla permanece bloqueada; reintente el borrado antes de continuar.'); } }

type Tokens = { accessToken: string; refreshToken: string };
export class StagingAuth {
  private accessToken: string | null = null;
  private refreshPending: Promise<void> | null = null;
  private lastActivitySent = 0;
  private generation = 0;
  private blocked = false;
  private storageQueue: Promise<unknown> = Promise.resolve();
  constructor(private readonly config: AuthConfig, private readonly storage: Storage, private readonly transport: Transport = fetch) {}

  private async request(base: string, path: string, method: 'GET' | 'POST', data?: object, token?: string) {
    let response: Response;
    try {
      response = await this.transport(`${base}${path}`, {
        method, headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(data ? { body: JSON.stringify(data) } : {}),
      });
    } catch { throw new NetworkUnavailable(); }
    if (response.status === 401 || response.status === 403) throw new SessionExpired();
    if (response.status === 429) throw new Error('Demasiados intentos. Espere antes de volver a intentarlo.');
    if (response.status === 400) throw new Error('Código inválido o vencido. Solicite uno nuevo.');
    if (!response.ok) throw new Error('No se pudo completar la operación. Inténtelo de nuevo.');
    try { return await response.json() as Record<string, unknown>; } catch { throw new Error('Respuesta de autenticación no válida.'); }
  }

  private post(base: string, path: string, data: object, token?: string) { return this.request(base, path, 'POST', data, token); }
  private get(base: string, path: string, token: string) { return this.request(base, path, 'GET', undefined, token); }

  async requestCode(email: string) {
    await this.post(this.config.adminBase, '/api/crm/auth/request-code', { email: email.trim() });
  }

  async verifyCode(email: string, code: string) {
    const generation = this.generation;
    if (!/^\d{8}$/.test(code)) throw new Error('Ingrese los ocho dígitos del código.');
    if (this.blocked && (await this.storage.getItemAsync(KEY) !== null || await this.storage.getItemAsync(PENDING_KEY) !== null)) throw new LocalClearFailed();
    const verified = await this.post(this.config.adminBase, '/api/crm/auth/mobile/verify-code', { email: email.trim(), code });
    if (generation !== this.generation) throw new SessionExpired();
    if (typeof verified.proof !== 'string') throw new Error('Respuesta de autenticación no válida.');
    const session = await this.post(this.config.hermesBase, '/api/auth/mobile/crm-proof', { proof: verified.proof });
    if (generation !== this.generation) throw new SessionExpired();
    await this.save(session, generation);
    this.blocked = false;
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
      if (this.blocked) throw new SessionExpired();
      // A prior attempt may have reached the server and rotated the token.
      // Never replay it, including after a process restart.
      if (await this.storage.getItemAsync(PENDING_KEY)) {
        await this.clear();
        throw new RefreshUncertain();
      }
      const refreshToken = await this.storage.getItemAsync(KEY);
      if (generation !== this.generation) throw new SessionExpired();
      if (!refreshToken) throw new SessionExpired();
      const mark = this.storageQueue.then(async () => {
        if (generation !== this.generation) throw new SessionExpired();
        await this.storage.setItemAsync(PENDING_KEY, '1');
      });
      this.storageQueue = mark.catch(() => undefined);
      await mark;
      if (generation !== this.generation) throw new SessionExpired();
      try {
        const result = await this.post(this.config.hermesBase, '/api/auth/mobile/refresh', { refreshToken });
        await this.save(result, generation);
        const done = this.storageQueue.then(async () => {
          if (generation !== this.generation) throw new SessionExpired();
          await this.storage.deleteItemAsync(PENDING_KEY);
          if (await this.storage.getItemAsync(PENDING_KEY) !== null) throw new LocalClearFailed();
        });
        this.storageQueue = done.catch(() => undefined);
        await done;
      } catch (failure) {
        if (generation !== this.generation) throw new SessionExpired();
        await this.clear();
        throw failure instanceof SessionExpired ? failure : new RefreshUncertain();
      }
    })().finally(() => { this.refreshPending = null; });
    return this.refreshPending;
  }

  async validate() {
    if (this.blocked) throw new SessionExpired();
    if (this.refreshPending) await this.refreshPending;
    const generation = this.generation;
    const hadAccess = !!this.accessToken;
    if (!hadAccess) await this.refresh();
    if (generation !== this.generation) throw new SessionExpired();
    try {
      const status = await this.get(this.config.hermesBase, '/api/auth/mobile/session', this.accessToken!);
      if (generation !== this.generation) throw new SessionExpired();
      if (status.active !== true) throw new SessionExpired();
    } catch (error) {
      if (!(error instanceof SessionExpired) || !hadAccess) throw error;
      if (generation !== this.generation) throw error;
      // An access token may expire without ending the session. The server validates
      // the inactivity window before allowing refresh; refresh never extends it.
      await this.refresh();
      const status = await this.get(this.config.hermesBase, '/api/auth/mobile/session', this.accessToken!);
      if (generation !== this.generation) throw new SessionExpired();
      if (status.active !== true) throw new SessionExpired();
    }
  }

  async activity() {
    const generation = this.generation;
    const now = Date.now();
    if (now - this.lastActivitySent < 15_000) return;
    await this.validate();
    if (generation !== this.generation) throw new SessionExpired();
    await this.post(this.config.hermesBase, '/api/auth/mobile/activity', {}, this.accessToken!);
    if (generation !== this.generation) throw new SessionExpired();
    this.lastActivitySent = now;
  }

  async logout() {
    const token = this.accessToken;
    this.blocked = true;
    // Lock synchronously, never refresh just to log out. An expired JWT or
    // offline request cannot prove server-side revocation with this contract.
    this.generation++;
    this.accessToken = null;
    this.lastActivitySent = 0;
    const remote = token ? this.post(this.config.hermesBase, '/api/auth/mobile/logout', {}, token).then(() => true, () => false) : Promise.resolve(false);
    await this.clear();
    return await remote ? 'revoked' as const : 'unconfirmed' as const;
  }

  async clear() {
    this.generation++;
    this.accessToken = null;
    this.lastActivitySent = 0;
    const remove = this.storageQueue.then(async () => {
      await this.storage.deleteItemAsync(KEY);
      if (await this.storage.getItemAsync(KEY) !== null) throw new LocalClearFailed();
      await this.storage.deleteItemAsync(PENDING_KEY);
      if (await this.storage.getItemAsync(PENDING_KEY) !== null) throw new LocalClearFailed();
    });
    this.storageQueue = remove.catch(() => undefined);
    try { await remove; } catch { this.blocked = true; throw new LocalClearFailed(); }
  }
}
