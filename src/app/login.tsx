import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '../components/Button';
import { PIN_LENGTH } from '../components/PinPad';
import { useWallet } from '../context/WalletContext';
import { isValidPhone } from '../lib/format';
import { colors, radius, spacing } from '../theme';

export default function LoginScreen() {
  const { user, register, login, resetAll } = useWallet();
  const [mode, setMode] = useState<'login' | 'register'>(
    user ? 'login' : 'register',
  );
  const [name, setName] = useState('');
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);

  const pinValid = new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin);

  const submit = () => {
    setError(null);
    if (!isValidPhone(phone)) {
      setError('Numéro de téléphone invalide.');
      return;
    }
    if (!pinValid) {
      setError(`Le code PIN doit contenir ${PIN_LENGTH} chiffres.`);
      return;
    }
    if (mode === 'register') {
      if (name.trim().length < 2) {
        setError('Veuillez saisir votre nom complet.');
        return;
      }
      register(name, phone, pin);
    } else if (!login(phone, pin)) {
      setError('Numéro ou code PIN incorrect.');
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.container}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.header}>
            <Text style={styles.logo}>💸</Text>
            <Text style={styles.brand}>TransfertPlus</Text>
            <Text style={styles.tagline}>
              Envoyez de l’argent en quelques secondes
            </Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.title}>
              {mode === 'register' ? 'Créer un compte' : 'Connexion'}
            </Text>

            {mode === 'register' && (
              <>
                <Text style={styles.label}>Nom complet</Text>
                <TextInput
                  style={styles.input}
                  value={name}
                  onChangeText={setName}
                  placeholder="Ex. Aminata Ba"
                  autoCapitalize="words"
                />
              </>
            )}

            <Text style={styles.label}>Numéro de téléphone</Text>
            <TextInput
              style={styles.input}
              value={phone}
              onChangeText={setPhone}
              placeholder="+221 77 000 00 00"
              keyboardType="phone-pad"
            />

            <Text style={styles.label}>Code PIN ({PIN_LENGTH} chiffres)</Text>
            <TextInput
              style={styles.input}
              value={pin}
              onChangeText={(v) => setPin(v.replace(/\D/g, '').slice(0, PIN_LENGTH))}
              placeholder="••••"
              keyboardType="number-pad"
              secureTextEntry
              maxLength={PIN_LENGTH}
            />

            {error && <Text style={styles.error}>{error}</Text>}

            <Button
              title={mode === 'register' ? 'Créer mon compte' : 'Se connecter'}
              onPress={submit}
              style={{ marginTop: spacing.md }}
            />

            {user && (
              <Text
                style={styles.switch}
                onPress={() => {
                  setError(null);
                  setMode(mode === 'login' ? 'register' : 'login');
                }}
              >
                {mode === 'login'
                  ? 'Créer un nouveau compte (remplace l’actuel)'
                  : 'J’ai déjà un compte'}
              </Text>
            )}
            {user && mode === 'login' && (
              <Text style={styles.switch} onPress={resetAll}>
                Code oublié ? Réinitialiser l’application
              </Text>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.primary },
  container: { flexGrow: 1, justifyContent: 'center', padding: spacing.lg },
  header: { alignItems: 'center', marginBottom: spacing.xl },
  logo: { fontSize: 56 },
  brand: { fontSize: 30, fontWeight: '800', color: '#fff', marginTop: spacing.sm },
  tagline: { color: '#D4EDE3', marginTop: spacing.xs },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.text,
    marginBottom: spacing.md,
  },
  label: { color: colors.muted, marginTop: spacing.md, marginBottom: spacing.xs },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    fontSize: 16,
    color: colors.text,
  },
  error: { color: colors.danger, marginTop: spacing.md },
  switch: {
    color: colors.primary,
    textAlign: 'center',
    marginTop: spacing.md,
    fontWeight: '500',
  },
});
