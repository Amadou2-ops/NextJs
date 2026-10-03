import { router } from 'expo-router';
import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Button } from '../components/Button';
import { useWallet } from '../context/WalletContext';
import {
  computeFee,
  formatAmount,
  initials,
  isValidPhone,
  normalizePhone,
  parseAmount,
  validateTransfer,
} from '../lib/format';
import { colors, radius, spacing } from '../theme';

const QUICK_AMOUNTS = [1_000, 5_000, 10_000, 25_000];

export default function SendScreen() {
  const { contacts, balance, user } = useWallet();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [amountText, setAmountText] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const amount = parseAmount(amountText);
  const fee = computeFee(amount);
  const selectedPhone = normalizePhone(phone);

  const selectContact = (c: { name: string; phone: string }) => {
    setName(c.name);
    setPhone(c.phone);
    setError(null);
  };

  const next = () => {
    if (!isValidPhone(phone)) {
      setError('Veuillez choisir un contact ou saisir un numéro valide.');
      return;
    }
    if (selectedPhone === user?.phone) {
      setError('Vous ne pouvez pas vous envoyer de l’argent.');
      return;
    }
    const amountError = validateTransfer(amount, balance);
    if (amountError) {
      setError(amountError);
      return;
    }
    setError(null);
    router.push({
      pathname: '/confirm',
      params: { name: name.trim(), phone: selectedPhone, amount: String(amount), note },
    });
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.section}>Destinataire</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {contacts.map((c) => {
            const active = c.phone === selectedPhone;
            return (
              <Pressable
                key={c.id}
                onPress={() => selectContact(c)}
                style={styles.contact}
              >
                <View style={[styles.avatar, active && styles.avatarActive]}>
                  <Text style={[styles.avatarText, active && { color: '#fff' }]}>
                    {initials(c.name)}
                  </Text>
                </View>
                <Text style={styles.contactName} numberOfLines={1}>
                  {c.name.split(' ')[0]}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        <TextInput
          style={styles.input}
          value={phone}
          onChangeText={(v) => {
            setPhone(v);
            setName('');
          }}
          placeholder="Numéro du destinataire"
          keyboardType="phone-pad"
        />
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          placeholder="Nom du destinataire (facultatif)"
        />

        <Text style={styles.section}>Montant</Text>
        <TextInput
          style={[styles.input, styles.amountInput]}
          value={amountText ? amount.toLocaleString('fr-FR') : ''}
          onChangeText={setAmountText}
          placeholder="0"
          keyboardType="number-pad"
        />
        <View style={styles.quick}>
          {QUICK_AMOUNTS.map((q) => (
            <Pressable
              key={q}
              style={styles.chip}
              onPress={() => setAmountText(String(q))}
            >
              <Text style={styles.chipText}>{q.toLocaleString('fr-FR')}</Text>
            </Pressable>
          ))}
        </View>

        <TextInput
          style={styles.input}
          value={note}
          onChangeText={setNote}
          placeholder="Motif (facultatif)"
          maxLength={80}
        />

        <View style={styles.summary}>
          <Row label="Solde disponible" value={formatAmount(balance)} />
          <Row label="Frais (1 %)" value={formatAmount(fee)} />
          <Row label="Total débité" value={formatAmount(amount + fee)} bold />
        </View>

        {error && <Text style={styles.error}>{error}</Text>}

        <Button title="Continuer" onPress={next} disabled={amount === 0 || !phone} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, bold && styles.bold]}>{label}</Text>
      <Text style={[styles.rowValue, bold && styles.bold]}>{value}</Text>
    </View>
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
  contact: { alignItems: 'center', marginRight: spacing.md, width: 64 },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarActive: { backgroundColor: colors.primary },
  avatarText: { fontWeight: '700', color: colors.primary },
  contactName: { fontSize: 12, marginTop: spacing.xs, color: colors.text },
  input: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    fontSize: 16,
    marginTop: spacing.sm,
    color: colors.text,
  },
  amountInput: { fontSize: 28, fontWeight: '700', textAlign: 'center' },
  quick: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  chip: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: 999,
    backgroundColor: colors.primaryLight,
    alignItems: 'center',
  },
  chipText: { color: colors.primary, fontWeight: '600' },
  summary: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.lg,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: spacing.xs,
  },
  rowLabel: { color: colors.muted },
  rowValue: { color: colors.text },
  bold: { fontWeight: '700', color: colors.text },
  error: { color: colors.danger, marginTop: spacing.md },
});
