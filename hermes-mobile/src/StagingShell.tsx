import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Image, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as ScreenCapture from 'expo-screen-capture';
import { LinearGradient } from 'expo-linear-gradient';
import { NetworkUnavailable, SessionExpired, stagingConfig, StagingAuth } from './stagingAuth';

type Phase = 'locked' | 'request' | 'verify' | 'ready';
export function StagingShell({ renderDemo }: { renderDemo: (logout: () => void, activity: () => void) => React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>('locked');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lastInteraction = useRef(Date.now());
  const foreground = useRef(true);
  const pending = useRef(false);
  const revision = useRef(0);
  const authenticating = useRef(false);
  const config = useMemo(() => {
    try { return stagingConfig(process.env.EXPO_PUBLIC_CRM_AUTH_BASE_URL, process.env.EXPO_PUBLIC_HERMES_API_BASE_URL); }
    catch { return null; }
  }, []);
  const auth = useMemo(() => config ? new StagingAuth(config, SecureStore) : null, [config]);

  const unlock = useCallback(async () => {
    const current = ++revision.current;
    if (!auth) { setPhase('request'); setError('Configure las URL HTTPS del entorno de prueba antes de iniciar sesión.'); return; }
    setPhase('locked');
    try {
      await ScreenCapture.preventScreenCaptureAsync('hermes-crm-staging');
      await auth.validate();
      if (foreground.current && current === revision.current) { lastInteraction.current = Date.now(); setError(''); setPhase('ready'); }
    }
    catch (failure) {
      if (current !== revision.current) return;
      if (failure instanceof SessionExpired) { await auth.clear(); if (current === revision.current) setPhase('request'); }
      else { setPhase('locked'); setError(failure instanceof NetworkUnavailable ? failure.message : 'No fue posible proteger la pantalla o verificar la sesión.'); }
    }
  }, [auth]);

  useEffect(() => {
    void unlock();
    const subscription = AppState.addEventListener('change', (status) => {
      foreground.current = status === 'active';
      if (!foreground.current) { revision.current++; setPhase((current) => current === 'ready' ? 'locked' : current); return; }
      if (!authenticating.current) void unlock();
    });
    const interval = setInterval(() => {
      if (Date.now() - lastInteraction.current >= 30 * 60_000) { revision.current++; setPhase((current) => current === 'ready' ? 'locked' : current); }
    }, 5_000);
    return () => { subscription.remove(); clearInterval(interval); };
  }, [unlock]);

  const action = async (operation: () => Promise<void>) => {
    if (authenticating.current) return;
    authenticating.current = true;
    const current = revision.current;
    setBusy(true); setError('');
    try { await operation(); }
    catch (failure) {
      if (current !== revision.current) return;
      if (failure instanceof SessionExpired) { await auth?.clear(); setPhase('request'); }
      setError(failure instanceof Error ? failure.message : 'Operación no disponible.');
    } finally { authenticating.current = false; setBusy(false); }
  };

  const activity = () => {
    if (phase !== 'ready' || !foreground.current || !auth || pending.current) return;
    const current = revision.current;
    pending.current = true;
    void auth.activity().then(() => { if (current === revision.current && foreground.current) lastInteraction.current = Date.now(); })
      .catch(async (failure) => {
        if (current !== revision.current) return;
        revision.current++;
        setPhase('locked');
        const locked = revision.current;
        if (failure instanceof SessionExpired) { await auth.clear(); if (locked === revision.current) setPhase('request'); }
        if (locked === revision.current) setError(failure instanceof NetworkUnavailable ? failure.message : 'La sesión requiere una nueva validación.');
      }).finally(() => { pending.current = false; });
  };

  if (phase === 'ready') return <View style={styles.full}>{renderDemo(() => {
    revision.current++;
    setPhase('locked');
    void action(async () => { await auth?.logout(); setPhase('request'); setCode(''); });
  }, activity)}</View>;
  return <SafeAreaView style={styles.full}>
    <LinearGradient colors={['#F8FAFF', '#F0F4FC', '#F8FAFF']} style={styles.full}>
      <ScrollView contentContainerStyle={styles.center} keyboardShouldPersistTaps="handled">
        <View style={styles.card}>
          <Image source={require('../assets/hermes-crm-logo.png')} style={styles.logo} resizeMode="contain" accessibilityLabel="Hermes CRM" />
          <Text style={styles.eyebrow}>ENTORNO DE PRUEBA · ACCESO MÓVIL</Text>
          <Text style={styles.title}>Acceso de gerencia</Text>
          <Text style={styles.disclaimer}>La autenticación se verifica en el entorno configurado. Los chats que se muestran después son ficticios: no se consultan ni envían mensajes reales.</Text>
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          {phase === 'locked' ? <Pressable accessibilityRole="button" style={styles.button} disabled={busy} onPress={() => void unlock()}><Text style={styles.buttonText}>Comprobar sesión</Text></Pressable> : <>
            <Text style={styles.label}>{phase === 'request' ? 'Correo de acceso' : 'Código recibido por correo'}</Text>
            {phase === 'request' ? <TextInput accessibilityLabel="Correo autorizado" autoCapitalize="none" autoComplete="email" keyboardType="email-address" editable={!busy} value={email} onChangeText={setEmail} style={styles.input} />
              : <TextInput accessibilityLabel="Código de ocho dígitos" keyboardType="number-pad" autoComplete="one-time-code" maxLength={8} editable={!busy} value={code} onChangeText={setCode} style={styles.input} />}
            <Pressable accessibilityRole="button" disabled={busy || (phase === 'request' ? !email.trim() : !/^\d{8}$/.test(code))} style={[styles.button, busy && styles.disabled]} onPress={() => void action(async () => {
              if (!auth) throw new Error('Configure el entorno de prueba para continuar.');
              if (phase === 'request') { await auth.requestCode(email); setPhase('verify'); }
              else {
                const current = revision.current;
                await auth.verifyCode(email, code);
                setCode('');
                if (foreground.current && current === revision.current) { lastInteraction.current = Date.now(); setPhase('ready'); }
                else { setPhase('locked'); if (foreground.current) void unlock(); }
              }
            })}><Text style={styles.buttonText}>{phase === 'request' ? 'Solicitar código' : 'Ingresar al CRM de prueba'}</Text></Pressable>
            {phase === 'verify' ? <Pressable accessibilityRole="button" onPress={() => { setCode(''); setPhase('request'); }} style={styles.secondary}><Text style={styles.secondaryText}>Volver a solicitar código</Text></Pressable> : null}
          </>}
        </View>
      </ScrollView>
    </LinearGradient>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  full: { flex: 1 }, center: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 22, paddingVertical: 36 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 27, borderWidth: 1, borderColor: '#DCE4F7', padding: 28, gap: 15 },
  logo: { width: 176, height: 42, marginBottom: 12 }, eyebrow: { color: '#625DE3', fontSize: 11, fontWeight: '800' },
  title: { color: '#11183D', fontSize: 27, fontWeight: '800' }, disclaimer: { color: '#53648A', fontSize: 12, lineHeight: 19, backgroundColor: '#F1F5FF', padding: 12, borderRadius: 10 },
  label: { color: '#374262', fontSize: 13, fontWeight: '700' }, input: { minHeight: 52, padding: 12, borderWidth: 1, borderColor: '#D6DDF3', borderRadius: 13, color: '#11183D' },
  button: { minHeight: 54, backgroundColor: '#635BDF', borderRadius: 14, alignItems: 'center', justifyContent: 'center', padding: 10 }, buttonText: { color: '#FFFFFF', fontWeight: '700' }, disabled: { opacity: 0.4 }, secondary: { minHeight: 44, alignItems: 'center', justifyContent: 'center' }, secondaryText: { color: '#5C63C9', fontWeight: '700' }, error: { color: '#A52635', fontSize: 12 },
});
