/** G0 demo: no HTTP client, credentials, persistence, or production data. */
export type ChatMessage = { id: string; kind: 'client' | 'agent'; text: string; time: string };
export type Chat = { id: string; name: string; topic: string; stage: string; unread: number; messages: ChatMessage[] };
export type DemoState = { signedIn: boolean; online: boolean; selectedId: string | null; chats: Chat[]; draft: string; notice: string };

export const initialState: DemoState = {
  signedIn: false,
  online: true,
  selectedId: null,
  draft: '',
  notice: '',
  chats: [
    { id: 'demo-a', name: 'Cliente de ejemplo A', topic: 'Sitio web informativo', stage: 'Pendiente de atención', unread: 1, messages: [
      { id: 'a1', kind: 'client', text: 'Hola, quisiera conocer las opciones para un sitio web.', time: '09:15' },
      { id: 'a2', kind: 'agent', text: 'Hola, con gusto. ¿Qué secciones necesita?', time: '09:17' },
      { id: 'a3', kind: 'client', text: 'Una portada, servicios y contacto.', time: '09:20' },
    ] },
    { id: 'demo-b', name: 'Cliente de ejemplo B', topic: 'Consulta sobre una app', stage: 'En seguimiento', unread: 0, messages: [
      { id: 'b1', kind: 'client', text: 'Necesito una app para organizar citas.', time: 'Ayer' },
      { id: 'b2', kind: 'agent', text: 'Con gusto revisamos las funciones necesarias.', time: 'Ayer' },
    ] },
    { id: 'demo-c', name: 'Cliente de ejemplo C', topic: 'Información general', stage: 'Atención humana', unread: 2, messages: [
      { id: 'c1', kind: 'client', text: 'Prefiero hablar con una persona del equipo.', time: '08:44' },
    ] },
  ],
};

export type DemoAction =
  | { type: 'LOGIN' } | { type: 'LOGOUT' } | { type: 'OPEN'; id: string } | { type: 'BACK' }
  | { type: 'NETWORK'; online: boolean } | { type: 'FOREGROUND' } | { type: 'DRAFT'; text: string }
  | { type: 'SEND_DEMO' } | { type: 'CLEAR_NOTICE' };

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
    case 'DRAFT': return state.signedIn && state.online && state.selectedId ? { ...state, draft: action.text.slice(0, 4096) } : state;
    case 'SEND_DEMO': {
      const text = state.draft.trim();
      if (!state.signedIn || !state.online || !state.selectedId || !text) return state;
      return { ...state, draft: '', notice: 'Solo demostración: no se envió ningún WhatsApp.', chats: state.chats.map((chat) => chat.id === state.selectedId ? { ...chat, messages: [...chat.messages, { id: `demo-${chat.messages.length + 1}`, kind: 'agent', text, time: 'Simulado' }] } : chat) };
    }
    case 'CLEAR_NOTICE': return { ...state, notice: '' };
  }
}
