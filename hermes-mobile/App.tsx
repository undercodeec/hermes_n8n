import { useEffect, useReducer, useState } from 'react';
import { AppState, Image, Pressable, SafeAreaView, ScrollView, StatusBar, StyleSheet, Text, TextInput, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Feather } from '@expo/vector-icons';
import { canCompose, demoReducer, initialState, visibleChats } from './src/demo';
import { crm } from './src/crmStyles';

const ink = '#162636';
const muted = '#627383';
const accent = '#087D75';

function Button({ label, onPress, quiet = false, disabled = false }: { label: string; onPress: () => void; quiet?: boolean; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={[styles.button, quiet && styles.quietButton, disabled && styles.disabled]}>
    <Text style={[styles.buttonText, quiet && styles.quietText]}>{label}</Text>
  </Pressable>;
}

function DemoLogin({ onEnter }: { onEnter: () => void }) {
  const [step, setStep] = useState<'request' | 'verify'>('request');
  return <LinearGradient colors={['#F8FAFF', '#F0F4FC', '#F8FAFF']} style={styles.loginBackground}>
    <ScrollView contentContainerStyle={styles.loginScroll} keyboardShouldPersistTaps="handled">
      <View style={styles.loginCard}>
        <Image source={require('./assets/hermes-crm-logo.png')} style={styles.loginLogo} resizeMode="contain" accessibilityLabel="Hermes CRM" />
        <Text style={styles.loginEyebrow}>ACCESO PRIVADO</Text>
        <Text style={styles.loginTitle}>Acceso de gerencia</Text>
        <View style={styles.loginRule} />
        <View style={styles.demoBanner}>
          <Feather name="info" size={16} color="#5364BA" />
          <Text style={styles.demoBannerText}>Vista de demostración. No ingrese datos reales; no se enviará ningún código.</Text>
        </View>
        <Text style={styles.loginLabel}>{step === 'request' ? 'Correo de acceso' : 'Código recibido por correo'}</Text>
        <View style={styles.loginInput}>
          <Feather name={step === 'request' ? 'mail' : 'key'} size={18} color="#8793AB" />
          <TextInput accessibilityLabel={step === 'request' ? 'Correo ficticio de ejemplo, no editable' : 'Código ficticio de ejemplo, no editable'} editable={false} value={step === 'request' ? 'agente@example.invalid' : '00000000'} style={styles.loginInputText} />
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel={step === 'request' ? 'Simular envío de código de acceso' : 'Entrar a la demostración del CRM'} onPress={() => step === 'request' ? setStep('verify') : onEnter()}>
          <LinearGradient colors={['#3F7BFF', '#6A63FF']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.loginPrimary}>
            <Text style={styles.loginPrimaryText}>{step === 'request' ? 'Enviar código de acceso' : 'Entrar al CRM'}</Text><Feather name="arrow-right" size={18} color="#FFFFFF" />
          </LinearGradient>
        </Pressable>
        {step === 'verify' ? <Pressable accessibilityRole="button" onPress={() => setStep('request')} style={styles.loginSecondary}><Text style={styles.loginSecondaryText}>Solicitar un nuevo código</Text></Pressable> : null}
        <View style={styles.securityDivider}><View style={styles.securityLine} /><Feather name="lock" size={14} color="#7D88A4" /><View style={styles.securityLine} /></View>
        <Text style={styles.securityNote}>Solo los correos autorizados pueden recibir un código de acceso.</Text>
        <Text style={styles.demoFootnote}>Esta maqueta no valida acceso ni procesa credenciales.</Text>
      </View>
      <Text style={styles.loginFooter}>HERMES CRM · VISTA DE PRUEBA</Text>
    </ScrollView>
  </LinearGradient>;
}

export default function App() {
  const [state, dispatch] = useReducer(demoReducer, initialState);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (status) => { if (status === 'active') dispatch({ type: 'FOREGROUND' }); });
    return () => subscription.remove();
  }, []);
  const selected = state.chats.find((chat) => chat.id === state.selectedId);
  const chats = visibleChats(state);
  const canWrite = canCompose(state);
  return <SafeAreaView style={styles.root}>
    <StatusBar barStyle="dark-content" />
    {!state.signedIn ? <DemoLogin onEnter={() => dispatch({ type: 'LOGIN' })} /> : <>
      {state.notice ? <Pressable accessibilityRole="button" accessibilityLabel="Descartar aviso" onPress={() => dispatch({ type: 'CLEAR_NOTICE' })} style={crm.notice}><Text style={crm.noticeText}>{state.notice}  ×</Text></Pressable> : null}
      {!state.online ? <View style={crm.offline}><Text style={crm.offlineText}>Sin conexión simulada · acciones deshabilitadas</Text></View> : null}
      {selected ? <>
        <View style={crm.chatHeader}>
          <Pressable accessibilityRole="button" accessibilityLabel="Volver a conversaciones" onPress={() => dispatch({ type: 'BACK' })} style={crm.iconButton}><Feather name="arrow-left" size={19} color="#536078" /></Pressable>
          <View style={crm.avatar}><Text style={crm.avatarText}>{selected.name.slice(-1)}</Text></View>
          <View style={crm.chatIdentity}><Text style={crm.name} numberOfLines={1}>{selected.name}</Text><Text style={crm.helper}>Contacto ficticio · {selected.topic}</Text></View>
          <Text style={crm.badge}>{selected.control === 'hermes' ? 'Hermes activo' : 'Humano'}</Text>
        </View>
        <View style={crm.handoff}>
          <View style={[crm.row, { gap: 9 }]}><Feather name="shield" size={18} color="#B06A32" /><Text style={crm.handoffTitle}>{selected.control === 'hermes' ? 'Hermes atiende esta conversación' : 'Atención humana simulada'}</Text></View>
          <Text style={crm.handoffCopy}>{selected.control === 'hermes' ? 'Tome el control para practicar una respuesta en la demostración.' : 'Solo una simulación visual: no cambia la atención del CRM real.'}</Text>
          <Pressable accessibilityRole="button" accessibilityState={{ disabled: !state.online }} disabled={!state.online} style={[crm.handoffButton, !state.online && crm.disabled]} onPress={() => dispatch({ type: selected.control === 'hermes' ? 'TAKE_CONTROL' : 'RETURN_CONTROL' })}><Text style={crm.handoffButtonText}>{selected.control === 'hermes' ? 'Tomar control humano' : 'Devolver a Hermes'}</Text></Pressable>
        </View>
        <ScrollView style={crm.root} contentContainerStyle={crm.history} keyboardShouldPersistTaps="handled">
          <Text style={crm.day}>Historial de ejemplo</Text>
          {selected.messages.map((message) => <View key={message.id} style={[crm.bubble, message.kind === 'agent' && crm.agentBubble, message.kind === 'hermes' && crm.hermesBubble]}>
            <Text style={[crm.messageAuthor, message.kind === 'agent' && crm.agentAuthor]}>{message.kind === 'agent' ? 'Operador · DEMO' : message.kind === 'hermes' ? 'Hermes · DEMO' : 'Cliente · DEMO'}</Text>
            <Text style={crm.message}>{message.text}</Text><Text style={crm.messageTime}>{message.time}</Text>
          </View>)}
        </ScrollView>
        <View style={crm.composer}>
          <Text style={crm.composerHint}>{!state.online ? 'Sin conexión simulada. No se puede responder.' : canWrite ? 'Respuesta de prueba · no se envía a WhatsApp' : 'La respuesta manual requiere tomar el control humano.'}</Text>
          <View style={crm.row}><TextInput accessibilityLabel="Escribir respuesta ficticia" placeholder={canWrite ? 'Escribe una respuesta como operador…' : 'Respuesta manual no disponible'} placeholderTextColor="#9AA2AE" editable={canWrite} multiline value={state.draft} onChangeText={(text) => dispatch({ type: 'DRAFT', text })} style={crm.composerInput} />
            <Pressable accessibilityRole="button" accessibilityLabel="Agregar respuesta ficticia" accessibilityState={{ disabled: !canWrite || !state.draft.trim() }} disabled={!canWrite || !state.draft.trim()} onPress={() => dispatch({ type: 'SEND_DEMO' })} style={[crm.send, (!canWrite || !state.draft.trim()) && crm.disabled]}><Feather name="send" size={18} color="#FFFFFF" /></Pressable></View>
        </View>
      </> : <>
        <View style={crm.header}>
          <View style={crm.brandRow}><Image source={require('./assets/hermes-crm-logo.png')} style={crm.logo} resizeMode="contain" accessibilityLabel="Hermes CRM" /><Text style={crm.demoTag}>DEMO · SIN DATOS REALES</Text></View>
          <View style={crm.titleRow}><View><Text style={crm.eyebrow}>WHATSAPP</Text><Text style={crm.title}>Inbox</Text></View><Pressable accessibilityRole="button" accessibilityLabel={state.online ? 'Simular desconexión' : 'Simular reconexión'} onPress={() => dispatch({ type: 'NETWORK', online: !state.online })} style={crm.iconButton}><Feather name={state.online ? 'wifi' : 'wifi-off'} size={18} color="#667185" /></Pressable></View>
        </View>
        <View style={crm.filters}>
          <View style={crm.search}><Feather name="search" size={17} color="#96A0B0" /><TextInput accessibilityLabel="Buscar conversaciones ficticias" placeholder="Buscar contacto…" placeholderTextColor="#9AA4B3" value={state.search} onChangeText={(text) => dispatch({ type: 'SEARCH', text })} style={crm.searchInput} /></View>
          <View style={crm.filterRow}>{([{ label: 'Todos', value: 'todos' }, { label: 'Hermes activo', value: 'hermes' }, { label: 'Control humano', value: 'humano' }] as const).map((filter) => <Pressable key={filter.value} accessibilityRole="button" accessibilityState={{ selected: state.controlFilter === filter.value }} onPress={() => dispatch({ type: 'CONTROL_FILTER', value: filter.value })} style={[crm.filter, state.controlFilter === filter.value && crm.filterActive]}><Text style={[crm.filterText, state.controlFilter === filter.value && crm.filterActiveText]}>{filter.label}</Text></Pressable>)}
            <Pressable accessibilityRole="button" accessibilityState={{ selected: state.priorityFilter === 'alta' }} onPress={() => dispatch({ type: 'PRIORITY_FILTER', value: state.priorityFilter === 'alta' ? 'todas' : 'alta' })} style={[crm.filter, state.priorityFilter === 'alta' && crm.filterActive]}><Text style={[crm.filterText, state.priorityFilter === 'alta' && crm.filterActiveText]}>⚑ Prioridad</Text></Pressable></View>
        </View>
        <Text style={crm.listMeta}>{chats.length} conversaciones · datos ficticios</Text>
        <ScrollView style={crm.list} keyboardShouldPersistTaps="handled">
          {chats.length ? chats.map((chat) => <Pressable key={chat.id} accessibilityRole="button" accessibilityLabel={`Abrir conversación ficticia de ${chat.name}`} onPress={() => dispatch({ type: 'OPEN', id: chat.id })} style={crm.conversation}>
            <View style={crm.avatar}><Text style={crm.avatarText}>{chat.name.slice(-1)}</Text></View>
            <View style={crm.conversationContent}><View style={crm.between}><Text style={crm.name} numberOfLines={1}>{chat.name}</Text><Text style={crm.time}>{chat.messages.at(-1)?.time}</Text></View>
              <Text style={crm.preview} numberOfLines={1}>{chat.messages.at(-1)?.text}</Text>
              <View style={[crm.row, { gap: 6 }]}><Feather name={chat.control === 'humano' ? 'user-check' : 'cpu'} size={13} color="#7B8497" /><Text style={crm.status}>{chat.control === 'humano' ? 'Atención humana' : 'Hermes activo'}{chat.priority === 'alta' ? ' · Prioridad' : ''}</Text></View></View>
          </Pressable>) : <Text style={crm.empty}>No hay conversaciones para los filtros elegidos.</Text>}
        </ScrollView>
        <View style={crm.footer}><Button label="Cerrar demostración" quiet onPress={() => dispatch({ type: 'LOGOUT' })} /></View>
      </>}
    </>}
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  loginBackground: { flex: 1 }, loginScroll: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 22, paddingVertical: 36 },
  loginCard: { width: '100%', maxWidth: 468, backgroundColor: '#FFFFFF', borderRadius: 27, paddingHorizontal: 30, paddingVertical: 34, borderWidth: 1, borderColor: '#DCE4F7', shadowColor: '#435390', shadowOffset: { width: 0, height: 20 }, shadowOpacity: 0.12, shadowRadius: 28, elevation: 5 },
  loginLogo: { width: 176, height: 42, alignSelf: 'flex-start', marginBottom: 31 }, loginEyebrow: { color: '#625DE3', fontSize: 10, fontWeight: '800', letterSpacing: 1.6, marginBottom: 13 }, loginTitle: { color: '#11183D', fontSize: 28, lineHeight: 34, letterSpacing: -1.1, fontWeight: '800' }, loginRule: { height: 1, backgroundColor: '#E3E8F6', marginTop: 24, marginBottom: 23 },
  demoBanner: { flexDirection: 'row', gap: 9, alignItems: 'flex-start', backgroundColor: '#F1F5FF', borderColor: '#DBE4FB', borderWidth: 1, borderRadius: 10, padding: 12, marginBottom: 24 }, demoBannerText: { color: '#53648A', fontSize: 12, lineHeight: 18, flex: 1 }, loginLabel: { color: '#374262', fontSize: 12, fontWeight: '700', marginBottom: 9 }, loginInput: { height: 54, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 11, borderWidth: 1, borderColor: '#D6DDF3', borderRadius: 13, backgroundColor: '#FFFFFF', marginBottom: 19 }, loginInputText: { flex: 1, color: '#6A7793', fontSize: 14, padding: 0 },
  loginPrimary: { minHeight: 54, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 11, borderRadius: 14 }, loginPrimaryText: { color: '#FFFFFF', fontWeight: '700', fontSize: 14 }, loginSecondary: { minHeight: 44, alignItems: 'center', justifyContent: 'center', borderColor: '#D8DDF1', borderWidth: 1, borderRadius: 12, backgroundColor: '#FAFBFF', marginTop: 12 }, loginSecondaryText: { color: '#5C63C9', fontSize: 12, fontWeight: '700' }, securityDivider: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 27 }, securityLine: { flex: 1, height: 1, backgroundColor: '#E4E8F4' }, securityNote: { color: '#77839B', fontSize: 11, textAlign: 'center', lineHeight: 17, marginTop: 13 }, demoFootnote: { color: '#9AA5B9', fontSize: 10, textAlign: 'center', marginTop: 12 }, loginFooter: { color: '#929DB7', fontSize: 10, letterSpacing: 1.2, marginTop: 26 },
  root: { flex: 1, backgroundColor: '#F4F4EF' }, top: { paddingHorizontal: 22, paddingTop: 14, paddingBottom: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderColor: '#DEE4DF' },
  brand: { color: ink, fontSize: 20, fontWeight: '900', letterSpacing: 1.3 }, brandLight: { fontWeight: '400' }, pill: { backgroundColor: '#E9E3D5', color: '#685732', borderRadius: 20, paddingHorizontal: 9, paddingVertical: 6, fontSize: 9, fontWeight: '800' },
  login: { flex: 1, paddingHorizontal: 26, justifyContent: 'center', gap: 14 }, eyebrow: { color: accent, fontSize: 11, fontWeight: '800', letterSpacing: 2 }, heading: { color: ink, fontSize: 33, lineHeight: 39, fontWeight: '800', marginTop: 8 }, body: { color: muted, fontSize: 15, lineHeight: 22, marginTop: 6 },
  card: { marginTop: 24, backgroundColor: 'white', padding: 22, borderRadius: 20, gap: 12, borderWidth: 1, borderColor: '#DFE6E1' }, label: { color: muted, fontSize: 11, fontWeight: '800', letterSpacing: 1 }, cardTitle: { color: ink, fontSize: 17, fontWeight: '700', flexShrink: 1 },
  button: { backgroundColor: ink, padding: 13, borderRadius: 11, alignItems: 'center', justifyContent: 'center', marginTop: 4 }, buttonText: { color: 'white', fontSize: 13, fontWeight: '700' }, quietButton: { backgroundColor: '#DFEBE7', paddingHorizontal: 11 }, quietText: { color: '#16544D' }, disabled: { opacity: 0.42 },
  toolbar: { paddingHorizontal: 18, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, connection: { color: accent, fontSize: 11, fontWeight: '700', flexShrink: 1 }, notice: { backgroundColor: '#E4F2EC', padding: 12, marginHorizontal: 18, borderRadius: 10 }, noticeText: { color: '#174C47', fontSize: 12 },
  feed: { flex: 1 }, list: { padding: 22, paddingBottom: 42 }, chatCard: { backgroundColor: 'white', borderRadius: 16, borderWidth: 1, borderColor: '#DEE6E0', padding: 18, marginTop: 14, gap: 7 }, chatTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, count: { backgroundColor: accent, color: 'white', overflow: 'hidden', borderRadius: 12, paddingHorizontal: 8, paddingVertical: 4, fontSize: 12 }, subtitle: { color: muted, fontSize: 12 }, preview: { color: ink, fontSize: 14, marginTop: 4 }, stage: { color: accent, fontSize: 11, fontWeight: '800', marginTop: 8 },
  sectionHeader: { paddingHorizontal: 20, paddingTop: 4, paddingBottom: 12, gap: 7 }, title: { color: ink, fontSize: 23, fontWeight: '800' }, feedContent: { padding: 18, paddingBottom: 25, gap: 12 }, bubble: { backgroundColor: 'white', padding: 15, borderRadius: 14, maxWidth: '86%', alignSelf: 'flex-start', borderWidth: 1, borderColor: '#E1E6E2' }, agentBubble: { backgroundColor: '#DAEEE7', alignSelf: 'flex-end', borderColor: '#C8E3D9' }, messageAuthor: { color: muted, fontSize: 10, fontWeight: '700', marginBottom: 7 }, message: { color: ink, fontSize: 14, lineHeight: 21 },
  composer: { backgroundColor: 'white', padding: 15, gap: 9, borderTopWidth: 1, borderColor: '#DEE6E0' }, input: { borderWidth: 1, borderColor: '#CFDBD5', borderRadius: 10, padding: 12, color: ink, maxHeight: 100, minHeight: 48, textAlignVertical: 'top' },
});
