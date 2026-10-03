import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { formatAmount, formatDate } from '../lib/format';
import type { Transaction } from '../lib/types';
import { colors, radius, spacing } from '../theme';

const LABELS: Record<Transaction['type'], string> = {
  sent: 'Envoyé à',
  received: 'Reçu de',
  topup: 'Dépôt',
};

const ICONS: Record<Transaction['type'], string> = {
  sent: '↑',
  received: '↓',
  topup: '+',
};

export function TransactionItem({ tx }: { tx: Transaction }) {
  const outgoing = tx.type === 'sent';
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
      onPress={() => router.push(`/receipt/${tx.id}`)}
    >
      <View style={[styles.icon, outgoing ? styles.iconOut : styles.iconIn]}>
        <Text style={[styles.iconText, { color: outgoing ? colors.danger : colors.success }]}>
          {ICONS[tx.type]}
        </Text>
      </View>
      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={1}>
          {tx.type === 'topup' ? tx.counterpartyName : `${LABELS[tx.type]} ${tx.counterpartyName}`}
        </Text>
        <Text style={styles.date}>{formatDate(tx.createdAt)}</Text>
      </View>
      <Text style={[styles.amount, { color: outgoing ? colors.danger : colors.success }]}>
        {outgoing ? '-' : '+'}
        {formatAmount(tx.amount + (outgoing ? tx.fee : 0))}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    marginBottom: spacing.sm,
  },
  icon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
  },
  iconOut: { backgroundColor: '#FDECEC' },
  iconIn: { backgroundColor: colors.primaryLight },
  iconText: { fontSize: 18, fontWeight: '700' },
  body: { flex: 1, marginRight: spacing.sm },
  title: { fontSize: 15, fontWeight: '600', color: colors.text },
  date: { fontSize: 12, color: colors.muted, marginTop: 2 },
  amount: { fontSize: 15, fontWeight: '700' },
});
