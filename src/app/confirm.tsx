import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { PIN_LENGTH, PinPad } from '../components/PinPad';
import { useWallet } from '../context/WalletContext';
import { computeFee, formatAmount } from '../lib/format';
import { colors, radius, spacing } from '../theme';

const MAX_ATTEMPTS = 3;

export default function ConfirmScreen() {
  const params = useLocalSearchParams<{
    name?: string;
    phone: string;
    amount: string;
    note?: string;
  }>();
  const { verifyPin, sendMoney } = useWallet();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);

  const amount = Number(params.amount) || 0;
  const fee = computeFee(amount);
  const recipient = params.name || params.phone;

  useEffect(() => {
    if (pin.length < PIN_LENGTH) return;

    if (!verifyPin(pin)) {
      const used = attempts + 1;
      setAttempts(used);
      setPin('');
      if (used >= MAX_ATTEMPTS) {
        setError('Trop de tentatives. Transfert annulé.');
        setTimeout(() => router.back(), 1200);
      } else {
        setError(`Code PIN incorrect (${MAX_ATTEMPTS - used} essai(s) restant(s)).`);
      }
      return;
    }

    try {
      const tx = sendMoney({
        name: params.name ?? '',
        phone: params.phone,
        amount,
        note: params.note,
      });
      router.replace({ pathname: '/receipt/[id]', params: { id: tx.id, done: '1' } });
    } catch (e) {
      setPin('');
      setError(e instanceof Error ? e.message : 'Le transfert a échoué.');
    }
  }, [pin]);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.card}>
        <Text style={styles.label}>Vous envoyez</Text>
        <Text style={styles.amount}>{formatAmount(amount)}</Text>
        <Text style={styles.label}>à</Text>
        <Text style={styles.recipient}>{recipient}</Text>
        {params.name ? <Text style={styles.phone}>{params.phone}</Text> : null}
        <View style={styles.divider} />
        <View style={styles.row}>
          <Text style={styles.label}>Frais</Text>
          <Text style={styles.value}>{formatAmount(fee)}</Text>
        </View>
        <View style={styles.row}>
          <Text style={[styles.label, styles.bold]}>Total</Text>
          <Text style={[styles.value, styles.bold]}>{formatAmount(amount + fee)}</Text>
        </View>
        {params.note ? (
          <View style={styles.row}>
            <Text style={styles.label}>Motif</Text>
            <Text style={styles.value}>{params.note}</Text>
          </View>
        ) : null}
      </View>

      <Text style={styles.prompt}>Saisissez votre code PIN pour confirmer</Text>
      <PinPad
        value={pin}
        onChange={(v) => {
          if (attempts >= MAX_ATTEMPTS) return;
          setError(null);
          setPin(v);
        }}
        error={error}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing.lg },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    alignItems: 'center',
  },
  label: { color: colors.muted },
  amount: { fontSize: 32, fontWeight: '800', color: colors.text, marginVertical: spacing.xs },
  recipient: { fontSize: 18, fontWeight: '700', color: colors.text, marginTop: spacing.xs },
  phone: { color: colors.muted, marginTop: 2 },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    alignSelf: 'stretch',
    marginVertical: spacing.md,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignSelf: 'stretch',
    paddingVertical: 2,
  },
  value: { color: colors.text, flexShrink: 1, textAlign: 'right' },
  bold: { fontWeight: '700', color: colors.text },
  prompt: {
    textAlign: 'center',
    color: colors.text,
    fontWeight: '600',
    marginTop: spacing.lg,
    marginBottom: spacing.md,
  },
});
