import { useEffect, useReducer } from 'react';
import { AppState, Pressable, SafeAreaView, ScrollView, StatusBar, StyleSheet, Text, TextInput, View } from 'react-native';
import { demoReducer, initialState } from './src/demo';

const ink = '#162636';
const muted = '#627383';
const accent = '#087D75';

function Button({ label, onPress, quiet = false, disabled = false }: { label: string; onPress: () => void; quiet?: boolean; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={[styles.button, quiet && styles.quietButton, disabled && styles.disabled]}>
    <Text style={[styles.buttonText, quiet && styles.quietText]}>{label}</Text>
  </Pressable>;
}

export default function App() {
  const [state, dispatch] = useReducer(demoReducer, initialState);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (status) => { if (status === 'active') dispatch({ type: 'FOREGROUND' }); });
    return () => subscription.remove();
  }, []);
  const selected = state.chats.find((chat) => chat.id === state.selectedId);
  return <SafeAreaView style={styles.root}>
    <StatusBar barStyle="dark-content" />
    <View style={styles.top}>
      <Text style={styles.brand}>HERMES <Text style={styles.brandLight}>/ CRM</Text></Text>
      <Text style={styles.pill}>PROTOTIPO · SIN RED</Text>
    </View>
    {!state.signedIn ? <View style={styles.login}>
      <Text style={styles.eyebrow}>ACCESO DE PRUEBA</Text>
      <Text style={styles.heading}>Su equipo, al tanto de cada conversación.</Text>
      <Text style={styles.body}>Explore el Inbox con datos inventados. No se solicitarán credenciales ni se contactará al servidor.</Text>
      <View style={styles.card}>
        <Text style={styles.label}>OPERADOR FICTICIO</Text>
        <Text style={styles.cardTitle}>Agente de demostración</Text>
        <Text style={styles.body}>El acceso es simulado. Sin sesión, token ni permisos reales.</Text>
        <Button label="Entrar a la demostración" onPress={() => dispatch({ type: 'LOGIN' })} />
      </View>
    </View> : <>
      <View style={styles.toolbar}>
        <Text style={styles.connection}>{state.online ? '●  En línea (simulado)' : '●  Sin conexión (simulado)'}</Text>
        <Button quiet label={state.online ? 'Simular sin conexión' : 'Simular reconexión'} onPress={() => dispatch({ type: 'NETWORK', online: !state.online })} />
      </View>
      {state.notice ? <Pressable accessibilityRole="button" accessibilityLabel="Descartar aviso" onPress={() => dispatch({ type: 'CLEAR_NOTICE' })} style={styles.notice}><Text style={styles.noticeText}>{state.notice}  ×</Text></Pressable> : null}
      {selected ? <>
        <View style={styles.sectionHeader}>
          <Button label="Volver al Inbox" quiet onPress={() => dispatch({ type: 'BACK' })} />
          <Text style={styles.eyebrow}>CONVERSACIÓN FICTICIA</Text>
          <Text style={styles.title}>{selected.name}</Text>
          <Text style={styles.subtitle}>{selected.topic} · {selected.stage}</Text>
        </View>
        <ScrollView style={styles.feed} contentContainerStyle={styles.feedContent} keyboardShouldPersistTaps="handled">
          {selected.messages.map((message) => <View key={message.id} style={[styles.bubble, message.kind === 'agent' && styles.agentBubble]}>
            <Text style={styles.messageAuthor}>{message.kind === 'agent' ? 'Equipo · DEMO' : selected.name} · {message.time}</Text>
            <Text style={styles.message}>{message.text}</Text>
          </View>)}
        </ScrollView>
        <View style={styles.composer}>
          <Text style={styles.label}>RESPUESTA LOCAL · NO SE ENVÍA</Text>
          <TextInput accessibilityLabel="Escribir respuesta ficticia" placeholder={state.online ? 'Escriba una respuesta de prueba…' : 'No disponible sin conexión'} placeholderTextColor={muted} editable={state.online} multiline value={state.draft} onChangeText={(text) => dispatch({ type: 'DRAFT', text })} style={styles.input} />
          <Button label="Agregar respuesta ficticia" disabled={!state.online || !state.draft.trim()} onPress={() => dispatch({ type: 'SEND_DEMO' })} />
        </View>
      </> : <>
        <ScrollView style={styles.feed} contentContainerStyle={styles.list}>
          <Text style={styles.eyebrow}>BUEN DÍA, EQUIPO</Text>
          <Text style={styles.heading}>Bandeja de entrada</Text>
          <Text style={styles.body}>Conversaciones de ejemplo. Sin datos de clientes reales.</Text>
          {state.chats.map((chat) => <Pressable key={chat.id} accessibilityRole="button" accessibilityLabel={`Abrir conversación ficticia de ${chat.name}`} onPress={() => dispatch({ type: 'OPEN', id: chat.id })} style={styles.chatCard}>
            <View style={styles.chatTop}><Text style={styles.cardTitle}>{chat.name}</Text>{chat.unread ? <Text style={styles.count}>{chat.unread}</Text> : null}</View>
            <Text style={styles.subtitle}>{chat.topic}</Text>
            <Text style={styles.preview} numberOfLines={1}>{chat.messages.at(-1)?.text}</Text>
            <Text style={styles.stage}>{chat.stage}  ↗</Text>
          </Pressable>)}
          <Button label="Cerrar demostración" quiet onPress={() => dispatch({ type: 'LOGOUT' })} />
        </ScrollView>
      </>}
    </>}
  </SafeAreaView>;
}

const styles = StyleSheet.create({
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
