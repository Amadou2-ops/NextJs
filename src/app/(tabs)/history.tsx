import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { TransactionItem } from '../../components/TransactionItem';
import { useWallet } from '../../context/WalletContext';
import { formatAmount } from '../../lib/format';
import type { TransactionType } from '../../lib/types';
import { colors, radius, spacing } from '../../theme';

type Filter = 'all' | TransactionType;

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'Tout' },
  { key: 'sent', label: 'Envoyés' },
  { key: 'received', label: 'Reçus' },
  { key: 'topup', label: 'Dépôts' },
];

export default function HistoryScreen() {
  const { transactions } = useWallet();
  const [filter, setFilter] = useState<Filter>('all');

  const filtered = useMemo(
    () =>
      filter === 'all'
        ? transactions
        : transactions.filter((t) => t.type === filter),
    [transactions, filter],
  );

  const totals = useMemo(() => {
    let inflow = 0;
    let outflow = 0;
    for (const t of transactions) {
      if (t.type === 'sent') outflow += t.amount + t.fee;
      else inflow += t.amount;
    }
    return { inflow, outflow };
  }, [transactions]);

  return (
    <View style={styles.screen}>
      <View style={styles.summary}>
        <View style={styles.summaryBox}>
          <Text style={styles.summaryLabel}>Entrées</Text>
          <Text style={[styles.summaryValue, { color: colors.success }]}>
            {formatAmount(totals.inflow)}
          </Text>
        </View>
        <View style={styles.summaryBox}>
          <Text style={styles.summaryLabel}>Sorties</Text>
          <Text style={[styles.summaryValue, { color: colors.danger }]}>
            {formatAmount(totals.outflow)}
          </Text>
        </View>
      </View>

      <View style={styles.filters}>
        {FILTERS.map((f) => (
          <Pressable
            key={f.key}
            onPress={() => setFilter(f.key)}
            style={[styles.chip, filter === f.key && styles.chipActive]}
          >
            <Text
              style={[styles.chipText, filter === f.key && styles.chipTextActive]}
            >
              {f.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(t) => t.id}
        renderItem={({ item }) => <TransactionItem tx={item} />}
        contentContainerStyle={{ padding: spacing.md }}
        ListEmptyComponent={
          <Text style={styles.empty}>Aucune transaction.</Text>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  summary: { flexDirection: 'row', gap: spacing.sm, padding: spacing.md, paddingBottom: 0 },
  summaryBox: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  summaryLabel: { color: colors.muted, fontSize: 13 },
  summaryValue: { fontSize: 16, fontWeight: '700', marginTop: spacing.xs },
  filters: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
  },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 999,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { color: colors.text, fontWeight: '500' },
  chipTextActive: { color: '#fff' },
  empty: { color: colors.muted, textAlign: 'center', marginTop: spacing.xl },
});
