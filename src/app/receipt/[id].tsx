import { router, useLocalSearchParams } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button } from '../../components/Button';
import { useWallet } from '../../context/WalletContext';
import { formatAmount, formatDate } from '../../lib/format';
import { colors, radius, spacing } from '../../theme';

const TITLES = {
  sent: 'Transfert envoyé',
  received: 'Argent reçu',
  topup: 'Rechargement',
} as const;

export default function ReceiptScreen() {
  const { id, done } = useLocalSearchParams<{ id: string; done?: string }>();
  const { transactions } = useWallet();
  const tx = transactions.find((t) => t.id === id);

  if (!tx) {
    return (
      <View style={styles.container}>
        <Text style={styles.muted}>Transaction introuvable.</Text>
      </View>
    );
  }

  const outgoing = tx.type === 'sent';

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.card}>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>✓</Text>
        </View>
        <Text style={styles.title}>
          {done ? 'Transfert réussi !' : TITLES[tx.type]}
        </Text>
        <Text style={[styles.amount, { color: outgoing ? colors.danger : colors.success }]}>
          {outgoing ? '-' : '+'}
          {formatAmount(tx.amount)}
        </Text>

        <View style={styles.divider} />

        {tx.type !== 'topup' && (
          <Row
            label={outgoing ? 'Destinataire' : 'Expéditeur'}
            value={tx.counterpartyName}
          />
        )}
        {tx.counterpartyPhone ? <Row label="Téléphone" value={tx.counterpartyPhone} /> : null}
        {outgoing && <Row label="Frais" value={formatAmount(tx.fee)} />}
        {outgoing && <Row label="Total débité" value={formatAmount(tx.amount + tx.fee)} />}
        {tx.note ? <Row label="Motif" value={tx.note} /> : null}
        <Row label="Date" value={formatDate(tx.createdAt)} />
        <Row label="Référence" value={tx.id.toUpperCase()} />
      </View>

      <Button
        title="Retour à l’accueil"
        style={{ marginTop: spacing.lg }}
        onPress={() => router.dismissTo('/')}
      />
    </ScrollView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.muted}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
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
  badge: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontSize: 30, color: colors.primary, fontWeight: '800' },
  title: { fontSize: 20, fontWeight: '700', color: colors.text, marginTop: spacing.md },
  amount: { fontSize: 30, fontWeight: '800', marginTop: spacing.sm },
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
    paddingVertical: spacing.xs,
    gap: spacing.md,
  },
  muted: { color: colors.muted },
  value: { color: colors.text, fontWeight: '500', flexShrink: 1, textAlign: 'right' },
});
