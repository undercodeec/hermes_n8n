import { useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import { AppState, Image, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { crm } from './crmStyles';
import { chronologicalMessages, MobileInboxClient, type AuthorizedGet, type InboxMessage, type InboxSnapshot } from './mobileInboxClient';

type Props = { authorizedGet: AuthorizedGet; onLogout: () => void; onActivity?: () => void; onAccessLost?: () => void };
const timestamp = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
};
const label = (name: string | null, phone: string | null) => name || phone || 'Contacto';
const text = (message: InboxMessage | null | undefined) => message?.type === 'TEXT' ? (message.content || 'Mensaje de texto vacío') : message ? 'Mensaje no textual · no disponible' : 'Sin mensajes';

function MessageHistory({ state, loadOlder }: { state: InboxSnapshot; loadOlder: () => void }) {
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const initiallyPositioned = useRef(false);
  return <ScrollView
    ref={scroll}
    style={crm.root}
    contentContainerStyle={crm.history}
    maintainVisibleContentPosition={{ minIndexForVisible: 1 }}
    onContentSizeChange={() => {
      if (!initiallyPositioned.current && state.messages.length) {
        initiallyPositioned.current = true;
        scroll.current?.scrollToEnd({ animated: false });
      }
    }}
  >
    <Text style={crm.day}>Historial · orden cronológico</Text>
    {state.messagesCursor ? <Pressable accessibilityRole="button" accessibilityState={{ disabled: state.loadingMore }} disabled={state.loadingMore} style={styles.more} onPress={loadOlder}><Text style={styles.moreText}>{state.loadingMore ? 'Cargando…' : 'Cargar mensajes anteriores'}</Text></Pressable> : null}
    {chronologicalMessages(state.messages).map((item) => <View key={item.id} style={[crm.bubble, item.direction === 'OUTBOUND' && crm.agentBubble]}>
      <Text style={crm.messageAuthor}>{item.sender}</Text>
      <Text style={crm.message}>{text(item)}</Text>
      <Text style={crm.messageTime}>{timestamp(item.createdAt)}</Text>
    </View>)}
    {!state.messages.length ? <Text style={crm.empty}>No hay mensajes de texto disponibles.</Text> : null}
  </ScrollView>;
}

/** Mount only inside the authenticated staging shell; never render alongside DemoApp. */
export function MobileInboxScreen({ authorizedGet, onLogout, onActivity, onAccessLost }: Props) {
  const client = useMemo(() => new MobileInboxClient(authorizedGet, onAccessLost), [authorizedGet, onAccessLost]);
  const [state, setState] = useState(client.snapshot);
  useEffect(() => {
    const unsubscribe = client.subscribe(setState);
    if (AppState.currentState === 'active') void client.refresh();
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active') client.lock();
      else void client.refresh();
    });
    return () => { subscription.remove(); unsubscribe(); client.lock(); };
  }, [client]);
  const action = (callback: () => void) => { onActivity?.(); callback(); };

  return <SafeAreaView style={styles.root} onTouchStart={onActivity}>
    <View style={crm.header}>
      <View style={crm.brandRow}>
        <Image source={require('../assets/hermes-crm-logo.png')} style={crm.logo} resizeMode="contain" accessibilityLabel="Hermes CRM" />
        <Text style={styles.environment}>DATOS DEL ENTORNO DE PRUEBA</Text>
      </View>
      <View style={crm.titleRow}>
        <Text style={crm.title}>{state.selected ? 'Conversación' : 'Chats'}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Cerrar sesión móvil" style={crm.iconButton} onPress={() => { client.lock(); onLogout(); }}>
          <Feather name="log-out" size={19} color="#667185" />
        </Pressable>
      </View>
      <Text style={styles.readOnly}>WhatsApp · consulta de solo lectura · no se envían mensajes</Text>
    </View>
    {state.locked ? <View style={styles.center}>
      <Feather name="lock" size={27} color="#625AE2" />
      <Text accessibilityRole="alert" style={styles.help}>{state.busy ? 'Verificando acceso y actualizando…' : state.notice || 'Los datos están bloqueados hasta verificar la conexión.'}</Text>
      {!state.busy ? <Pressable accessibilityRole="button" onPress={() => action(() => void client.refresh())} style={styles.button}><Text style={styles.buttonText}>Reintentar</Text></Pressable> : null}
    </View> : state.selected ? <>
      <View style={crm.chatHeader}>
        <Pressable accessibilityRole="button" accessibilityLabel="Volver a conversaciones" onPress={() => action(() => client.close())} style={crm.chatBack}><Feather name="arrow-left" size={21} color="#536078" /></Pressable>
        <View style={crm.avatar}><Text style={crm.avatarText}>{label(state.selected.contact.name, state.selected.contact.phone).slice(0, 1).toUpperCase()}</Text></View>
        <View style={crm.chatIdentity}>
          <Text style={crm.name} numberOfLines={1}>{label(state.selected.contact.name, state.selected.contact.phone)}</Text>
          {state.selected.contact.phone ? <Text style={crm.helper}>{state.selected.contact.phone}</Text> : null}
        </View>
        <Text style={crm.badge}>{state.selected.status}</Text>
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="Actualizar y volver a conversaciones" style={styles.detailRefresh} onPress={() => action(() => void client.refresh())}>
        <Feather name="refresh-cw" size={14} color="#625AE2" /><Text style={styles.moreText}>Actualizar · volver a chats</Text>
      </Pressable>
      <MessageHistory key={state.selected.id} state={state} loadOlder={() => action(() => void client.moreMessages())} />
    </> : <>
      <View style={styles.toolbar}>
        <Text style={crm.listMeta}>{state.conversations.length} conversaciones cargadas</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Actualizar conversaciones" onPress={() => action(() => void client.refresh())} style={crm.iconButton}><Feather name="refresh-cw" size={18} color="#625AE2" /></Pressable>
      </View>
      <ScrollView style={crm.list}>
        {state.conversations.map((row) => <Pressable key={row.id} accessibilityRole="button" accessibilityLabel={`Abrir conversación de ${label(row.contact.name, row.contact.phone)}`} onPress={() => action(() => void client.open(row.id))} style={crm.conversation}>
          <View style={crm.avatar}><Text style={crm.avatarText}>{label(row.contact.name, row.contact.phone).slice(0, 1).toUpperCase()}</Text></View>
          <View style={crm.conversationContent}>
            <View style={crm.between}><Text style={crm.name} numberOfLines={1}>{label(row.contact.name, row.contact.phone)}</Text><Text style={crm.time}>{timestamp(row.updatedAt)}</Text></View>
            <Text style={crm.preview} numberOfLines={1}>{text(row.latestMessage)}</Text>
            <Text style={crm.status}>{row.status}</Text>
          </View>
        </Pressable>)}
        {!state.conversations.length && !state.busy ? <Text style={crm.empty}>No hay conversaciones disponibles.</Text> : null}
        {state.busy ? <Text style={crm.empty}>Cargando conversación…</Text> : null}
        {state.nextCursor ? <Pressable accessibilityRole="button" accessibilityState={{ disabled: state.loadingMore || state.busy }} disabled={state.loadingMore || state.busy} style={styles.more} onPress={() => action(() => void client.moreConversations())}><Text style={styles.moreText}>{state.loadingMore ? 'Cargando…' : 'Cargar más conversaciones'}</Text></Pressable> : null}
      </ScrollView>
    </>}
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F4F5F8' },
  environment: { color: '#635BDF', backgroundColor: '#F0EFFF', fontSize: 9, fontWeight: '800', paddingHorizontal: 8, paddingVertical: 6, borderRadius: 7, overflow: 'hidden' },
  readOnly: { color: '#687487', fontSize: 11, marginBottom: 9 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 20 },
  help: { color: '#374262', fontSize: 14, textAlign: 'center', lineHeight: 22 },
  button: { backgroundColor: '#635BDF', borderRadius: 12, paddingHorizontal: 23, paddingVertical: 13 },
  buttonText: { color: '#FFFFFF', fontWeight: '700' },
  toolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingRight: 14, backgroundColor: '#FFFFFF' },
  detailRefresh: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 10, backgroundColor: '#EEEDFF' },
  more: { margin: 16, padding: 14, alignItems: 'center', borderRadius: 12, backgroundColor: '#E4E1FF' },
  moreText: { color: '#625AE2', fontWeight: '700', fontSize: 12 },
});
