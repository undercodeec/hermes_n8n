/** G0 demo: no HTTP client, credentials, persistence, or production data. */
export type ChatMessage = { id: string; kind: 'client' | 'agent' | 'hermes'; text: string; time: string };
export type Control = 'hermes' | 'humano';
export type Priority = 'alta' | 'normal';
export type Chat = { id: string; name: string; topic: string; stage: string; unread: number; control: Control; priority: Priority; messages: ChatMessage[] };
export type DemoState = { signedIn: boolean; online: boolean; selectedId: string | null; chats: Chat[]; draft: string; notice: string; search: string; controlFilter: 'todos' | Control; priorityFilter: 'todas' | Priority };

export const initialState: DemoState = {
  signedIn: false,
  online: true,
  selectedId: null,
  draft: '',
  notice: '',
  search: '',
  controlFilter: 'todos',
  priorityFilter: 'todas',
  chats: [
    { id: 'demo-a', name: 'Cliente de ejemplo A', topic: 'Sitio web informativo', stage: 'Pendiente de atención', unread: 1, control: 'hermes', priority: 'alta', messages: [
      { id: 'a1', kind: 'client', text: 'Hola, quisiera conocer las opciones para un sitio web.', time: '09:15' },
      { id: 'a2', kind: 'hermes', text: 'Hola, con gusto. ¿Qué secciones necesita?', time: '09:17' },
      { id: 'a3', kind: 'client', text: 'Una portada, servicios y contacto.', time: '09:20' },
    ] },
    { id: 'demo-b', name: 'Cliente de ejemplo B', topic: 'Consulta sobre una app', stage: 'En seguimiento', unread: 0, control: 'hermes', priority: 'normal', messages: [
      { id: 'b1', kind: 'client', text: 'Necesito una app para organizar citas.', time: 'Ayer' },
      { id: 'b2', kind: 'hermes', text: 'Con gusto revisamos las funciones necesarias.', time: 'Ayer' },
    ] },
    { id: 'demo-c', name: 'Cliente de ejemplo C', topic: 'Información general', stage: 'Atención humana', unread: 2, control: 'humano', priority: 'alta', messages: [
      { id: 'c1', kind: 'client', text: 'Prefiero hablar con una persona del equipo.', time: '08:44' },
    ] },
  ],
};

export type DemoAction =
  | { type: 'LOGIN' } | { type: 'LOGOUT' } | { type: 'OPEN'; id: string } | { type: 'BACK' }
  | { type: 'NETWORK'; online: boolean } | { type: 'FOREGROUND' } | { type: 'DRAFT'; text: string }
  | { type: 'SEARCH'; text: string } | { type: 'CONTROL_FILTER'; value: DemoState['controlFilter'] }
  | { type: 'PRIORITY_FILTER'; value: DemoState['priorityFilter'] } | { type: 'TAKE_CONTROL' } | { type: 'RETURN_CONTROL' }
  | { type: 'SEND_DEMO' } | { type: 'CLEAR_NOTICE' };

const normalize = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Local inbox view; filters never modify the synthetic fixture. */
export function visibleChats(state: DemoState): Chat[] {
  const query = normalize(state.search.trim());
  return state.chats.filter((chat) =>
    (state.controlFilter === 'todos' || chat.control === state.controlFilter) &&
    (state.priorityFilter === 'todas' || chat.priority === state.priorityFilter) &&
    (!query || normalize(`${chat.name} ${chat.topic} ${chat.stage}`).includes(query))
  );
}

/** Shared UI/reducer rule for composing and sending a fictitious reply. */
export function canCompose(state: DemoState): boolean {
  return state.signedIn && state.online && state.chats.some((chat) => chat.id === state.selectedId && chat.control === 'humano');
}

export function demoReducer(state: DemoState, action: DemoAction): DemoState {
  switch (action.type) {
    case 'LOGIN': return { ...state, signedIn: true, notice: 'Modo demostración: no se conectó al CRM.' };
    case 'LOGOUT': return { ...initialState, online: state.online };
    case 'OPEN': {
      if (!state.signedIn || !state.chats.some((chat) => chat.id === action.id)) return state;
      return { ...state, selectedId: action.id, draft: '', chats: state.chats.map((chat) => chat.id === action.id ? { ...chat, unread: 0 } : chat) };
    }
    case 'BACK': return { ...state, selectedId: null, draft: '' };
    case 'NETWORK': return { ...state, online: action.online, draft: action.online ? state.draft : '', notice: action.online ? 'Conexión simulada: vista reconciliada con datos ficticios.' : 'Sin conexión: no se pueden redactar ni enviar mensajes.' };
    case 'FOREGROUND': return state.signedIn && state.online ? { ...state, notice: 'Vista reconciliada con datos ficticios al volver a primer plano.' } : state;
    case 'SEARCH': return { ...state, search: action.text };
    case 'CONTROL_FILTER': return { ...state, controlFilter: action.value };
    case 'PRIORITY_FILTER': return { ...state, priorityFilter: action.value };
    case 'TAKE_CONTROL':
    case 'RETURN_CONTROL': {
      const chat = state.chats.find((item) => item.id === state.selectedId);
      const control: Control = action.type === 'TAKE_CONTROL' ? 'humano' : 'hermes';
      if (!state.signedIn || !state.online || !chat || chat.control === control) return state;
      return { ...state, draft: '', notice: control === 'humano' ? 'Control humano tomado solo en la demostración; no se realizó ninguna conexión.' : 'Control devuelto a Hermes solo en la demostración; no se realizó ninguna conexión.', chats: state.chats.map((item) => item.id === chat.id ? { ...item, control } : item) };
    }
    case 'DRAFT': return canCompose(state) ? { ...state, draft: action.text.slice(0, 4096) } : state;
    case 'SEND_DEMO': {
      const text = state.draft.trim();
      if (!canCompose(state) || !text) return state;
      return { ...state, draft: '', notice: 'Solo demostración: no se envió ningún WhatsApp.', chats: state.chats.map((chat) => chat.id === state.selectedId ? { ...chat, messages: [...chat.messages, { id: `demo-${chat.messages.length + 1}`, kind: 'agent', text, time: 'Simulado' }] } : chat) };
    }
    case 'CLEAR_NOTICE': return { ...state, notice: '' };
  }
}
