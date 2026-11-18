/** G4 read-only inbox. The caller owns authentication; no credentials or chats are persisted. */
export type AuthorizedGet = (path: string) => Promise<Response>;

export type InboxMessage = {
  id: string; conversationId: string; direction: string; sender: string;
  type: string; content: string | null; createdAt: string;
};
export type InboxConversation = {
  id: string; status: string; updatedAt: string;
  contact: { id: string; name: string | null; phone: string | null };
  latestMessage?: InboxMessage | null;
};
export type InboxSnapshot = {
  locked: boolean; busy: boolean; loadingMore: boolean; notice: string;
  conversations: InboxConversation[]; nextCursor: string | null;
  selected: InboxConversation | null; messages: InboxMessage[]; messagesCursor: string | null;
};

const root = '/api/mobile/inbox';
const blank = (): InboxSnapshot => ({ locked: true, busy: false, loadingMore: false, notice: '', conversations: [], nextCursor: null, selected: null, messages: [], messagesCursor: null });
type Page<T> = { data: T[]; nextCursor: string | null; reconciliation: 'restart' };

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Respuesta de lectura no válida.');
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Respuesta de lectura no válida.');
  return value;
}
function optionalString(value: unknown): string | null {
  if (value === null) return null;
  return string(value);
}
function message(value: unknown): InboxMessage {
  const data = record(value);
  return {
    id: string(data.id), conversationId: string(data.conversationId),
    direction: string(data.direction), sender: string(data.sender), type: string(data.type),
    content: data.type === 'TEXT' ? optionalString(data.content) : null,
    createdAt: string(data.createdAt),
  };
}
function conversation(value: unknown, listing = false): InboxConversation {
  const data = record(value);
  const contact = record(data.contact);
  return {
    id: string(data.id), status: string(data.status), updatedAt: string(data.updatedAt),
    contact: { id: string(contact.id), name: optionalString(contact.name), phone: optionalString(contact.phone) },
    ...(listing ? { latestMessage: data.latestMessage === null ? null : message(data.latestMessage) } : {}),
  };
}
function page<T>(value: unknown, parse: (item: unknown) => T): Page<T> {
  const data = record(value);
  if (!Array.isArray(data.data) || (data.nextCursor !== null && typeof data.nextCursor !== 'string') || data.reconciliation !== 'restart') throw new Error('Respuesta de lectura no válida.');
  return { data: data.data.map(parse), nextCursor: data.nextCursor as string | null, reconciliation: 'restart' };
}
function mergeById<T extends { id: string }>(before: T[], after: T[]): T[] {
  const rows = new Map(before.map((item) => [item.id, item]));
  for (const item of after) rows.set(item.id, item);
  return [...rows.values()];
}

export class MobileInboxClient {
  private state = blank();
  private generation = 0;
  private pendingPage = false;
  private listeners = new Set<(state: InboxSnapshot) => void>();
  constructor(private readonly authorizedGet: AuthorizedGet, private readonly onAccessLost?: () => void) {}

  get snapshot(): InboxSnapshot { return this.state; }
  subscribe(listener: (state: InboxSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => { this.listeners.delete(listener); };
  }
  private update(state: InboxSnapshot) {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
  /** Discard everything immediately on logout/background; late HTTP replies cannot repopulate it. */
  lock() {
    this.generation++;
    this.pendingPage = false;
    this.update(blank());
  }
  private fail(generation: number) {
    if (generation !== this.generation) return;
    this.lock();
    this.update({ ...this.state, notice: 'No se pudo verificar la conexión o el acceso. Los datos están bloqueados. Reintente.' });
    this.onAccessLost?.();
  }
  private async get(path: string): Promise<unknown> {
    const response = await this.authorizedGet(path);
    if (response.status === 400) throw new InvalidCursor();
    if (!response.ok) throw new Error('Lectura no disponible.');
    return response.json();
  }
  private listPath(cursor?: string) { return `${root}?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`; }
  private messagesPath(id: string, cursor?: string) { return `${root}/${encodeURIComponent(id)}/messages?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`; }

  /** Reconciliation always starts at page 1, including foreground and manual refresh. */
  async refresh() {
    const generation = ++this.generation;
    this.pendingPage = false;
    this.update({ ...blank(), busy: true });
    try {
      const listing = page(await this.get(this.listPath()), (item) => conversation(item, true));
      if (generation !== this.generation) return;
      this.update({ ...blank(), locked: false, conversations: mergeById([], listing.data), nextCursor: listing.nextCursor });
    } catch { this.fail(generation); }
  }

  async moreConversations() {
    const cursor = this.state.nextCursor;
    if (this.state.locked || this.state.busy || this.pendingPage || !cursor) return;
    const generation = this.generation;
    this.pendingPage = true;
    this.update({ ...this.state, loadingMore: true });
    try {
      const listing = page(await this.get(this.listPath(cursor)), (item) => conversation(item, true));
      if (generation !== this.generation) return;
      this.update({ ...this.state, loadingMore: false, conversations: mergeById(this.state.conversations, listing.data), nextCursor: listing.nextCursor });
    } catch (error) {
      if (generation !== this.generation) return;
      if (error instanceof InvalidCursor) { await this.refresh(); return; }
      this.fail(generation);
    } finally { if (generation === this.generation) this.pendingPage = false; }
  }

  async open(id: string) {
    if (this.state.locked || !this.state.conversations.some((row) => row.id === id)) return;
    const generation = ++this.generation;
    this.pendingPage = false;
    this.update({ ...this.state, selected: null, messages: [], messagesCursor: null, busy: true });
    try {
      const detail = conversation(await this.get(`${root}/${encodeURIComponent(id)}`));
      if (generation !== this.generation) return;
      if (detail.id !== id) throw new Error('Detalle no válido.');
      const history = page(await this.get(this.messagesPath(id)), message);
      if (generation !== this.generation || history.data.some((item) => item.conversationId !== id)) throw new Error('Historial no válido.');
      this.update({ ...this.state, busy: false, selected: detail, messages: mergeById([], history.data), messagesCursor: history.nextCursor });
    } catch { this.fail(generation); }
  }

  close() {
    this.generation++;
    this.pendingPage = false;
    this.update({ ...this.state, busy: false, loadingMore: false, selected: null, messages: [], messagesCursor: null });
  }

  async moreMessages() {
    const { selected, messagesCursor: cursor } = this.state;
    if (this.state.locked || this.state.busy || this.pendingPage || !selected || !cursor) return;
    const generation = this.generation;
    this.pendingPage = true;
    this.update({ ...this.state, loadingMore: true });
    try {
      const history = page(await this.get(this.messagesPath(selected.id, cursor)), message);
      if (generation !== this.generation) return;
      if (history.data.some((item) => item.conversationId !== selected.id)) throw new Error('Historial no válido.');
      this.update({ ...this.state, loadingMore: false, messages: mergeById(this.state.messages, history.data), messagesCursor: history.nextCursor });
    } catch (error) {
      if (generation !== this.generation) return;
      if (error instanceof InvalidCursor) { await this.refresh(); return; }
      this.fail(generation);
    } finally { if (generation === this.generation) this.pendingPage = false; }
  }
}

class InvalidCursor extends Error {}
