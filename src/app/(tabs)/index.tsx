import { router, type Href } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { TransactionItem } from '../../components/TransactionItem';
import { useWallet } from '../../context/WalletContext';
import { formatAmount } from '../../lib/format';
import { colors, radius, spacing } from '../../theme';

const ACTIONS: { label: string; emoji: string; href: Href }[] = [
  { label: 'Envoyer', emoji: '📤', href: '/send' },
  { label: 'Recevoir', emoji: '📥', href: '/receive' },
  { label: 'Recharger', emoji: '💳', href: '/topup' },
];

export default function HomeScreen() {
  const { user, balance, transactions } = useWallet();
  const [hidden, setHidden] = useState(false);
  const firstName = user?.name.split(' ')[0] ?? '';

  return (
    <View style={styles.screen}>
      <SafeAreaView edges={['top']} style={styles.hero}>
        <Text style={styles.greeting}>Bonjour {firstName} 👋</Text>
        <Text style={styles.balanceLabel}>Solde disponible</Text>
        <Pressable onPress={() => setHidden((h) => !h)}>
          <Text style={styles.balance}>
            {hidden ? '••••••' : formatAmount(balance)}
          </Text>
          <Text style={styles.toggle}>
            {hidden ? 'Afficher le solde' : 'Masquer le solde'}
          </Text>
        </Pressable>
      </SafeAreaView>

      <View style={styles.actions}>
        {ACTIONS.map((a) => (
          <Pressable
            key={a.label}
            style={({ pressed }) => [styles.action, pressed && { opacity: 0.7 }]}
            onPress={() => router.push(a.href)}
          >
            <Text style={styles.actionEmoji}>{a.emoji}</Text>
            <Text style={styles.actionLabel}>{a.label}</Text>
          </Pressable>
        ))}
      </View>

      <ScrollView contentContainerStyle={styles.list}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Transactions récentes</Text>
          {transactions.length > 5 && (
            <Text style={styles.link} onPress={() => router.push('/history')}>
              Tout voir
            </Text>
          )}
        </View>
        {transactions.length === 0 ? (
          <Text style={styles.empty}>Aucune transaction pour le moment.</Text>
        ) : (
          transactions.slice(0, 5).map((tx) => <TransactionItem key={tx.id} tx={tx} />)
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  hero: {
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.lg,
    paddingBottom: 56,
    borderBottomLeftRadius: radius.lg,
    borderBottomRightRadius: radius.lg,
  },
  greeting: { color: '#fff', fontSize: 18, fontWeight: '600', marginTop: spacing.md },
  balanceLabel: { color: '#D4EDE3', marginTop: spacing.lg },
  balance: { color: '#fff', fontSize: 36, fontWeight: '800', marginTop: spacing.xs },
  toggle: { color: '#D4EDE3', fontSize: 13, marginTop: spacing.xs },
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginHorizontal: spacing.lg,
    marginTop: -36,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: spacing.md,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  action: { flex: 1, alignItems: 'center', paddingVertical: spacing.sm },
  actionEmoji: { fontSize: 28 },
  actionLabel: { marginTop: spacing.xs, fontWeight: '600', color: colors.text },
  list: { padding: spacing.lg },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  sectionTitle: { fontSize: 17, fontWeight: '700', color: colors.text },
  link: { color: colors.primary, fontWeight: '600' },
  empty: { color: colors.muted, textAlign: 'center', marginTop: spacing.lg },
});
