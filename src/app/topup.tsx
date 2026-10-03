import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Button } from '../components/Button';
import { useWallet } from '../context/WalletContext';
import { MAX_TRANSFER, formatAmount, parseAmount } from '../lib/format';
import { colors, radius, spacing } from '../theme';

const METHODS = [
  { key: 'card', label: 'Carte bancaire', emoji: '💳' },
  { key: 'mobile', label: 'Mobile money', emoji: '📱' },
  { key: 'agent', label: 'Agent / guichet', emoji: '🏪' },
] as const;

const QUICK = [5_000, 10_000, 20_000, 50_000];

export default function TopUpScreen() {
  const { topUp } = useWallet();
  const [amountText, setAmountText] = useState('');
  const [method, setMethod] = useState<(typeof METHODS)[number]['key']>('card');
  const [error, setError] = useState<string | null>(null);
  const amount = parseAmount(amountText);

  const submit = () => {
    if (amount < 500) {
      setError(`Le montant minimum est de ${formatAmount(500)}.`);
      return;
    }
    if (amount > MAX_TRANSFER) {
      setError(`Le montant maximum est de ${formatAmount(MAX_TRANSFER)}.`);
      return;
    }
    const tx = topUp(amount);
    router.replace({ pathname: '/receipt/[id]', params: { id: tx.id } });
  };

  return (
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <Text style={styles.section}>Montant à recharger</Text>
      <TextInput
        style={styles.input}
        value={amountText ? amount.toLocaleString('fr-FR') : ''}
        onChangeText={(v) => {
          setAmountText(v);
          setError(null);
        }}
        placeholder="0"
        keyboardType="number-pad"
      />
      <View style={styles.quick}>
        {QUICK.map((q) => (
          <Pressable key={q} style={styles.chip} onPress={() => setAmountText(String(q))}>
            <Text style={styles.chipText}>{q.toLocaleString('fr-FR')}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.section}>Moyen de paiement</Text>
      {METHODS.map((m) => (
        <Pressable
          key={m.key}
          onPress={() => setMethod(m.key)}
          style={[styles.method, method === m.key && styles.methodActive]}
        >
          <Text style={styles.methodEmoji}>{m.emoji}</Text>
          <Text style={styles.methodLabel}>{m.label}</Text>
          <View style={[styles.radio, method === m.key && styles.radioActive]} />
        </Pressable>
      ))}

      {error && <Text style={styles.error}>{error}</Text>}

      <Button
        title={amount ? `Recharger ${formatAmount(amount)}` : 'Recharger'}
        onPress={submit}
        disabled={amount === 0}
        style={{ marginTop: spacing.lg }}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing.lg },
  section: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.text,
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  input: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingVertical: 12,
    fontSize: 28,
    fontWeight: '700',
    textAlign: 'center',
    color: colors.text,
  },
  quick: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  chip: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: 999,
    backgroundColor: colors.primaryLight,
    alignItems: 'center',
  },
  chipText: { color: colors.primary, fontWeight: '600' },
  method: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  methodActive: { borderColor: colors.primary },
  methodEmoji: { fontSize: 22, marginRight: spacing.md },
  methodLabel: { flex: 1, fontSize: 15, color: colors.text, fontWeight: '500' },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: colors.border,
  },
  radioActive: { borderColor: colors.primary, backgroundColor: colors.primary },
  error: { color: colors.danger, marginTop: spacing.md },
});
