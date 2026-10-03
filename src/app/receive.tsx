import { router } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button } from '../components/Button';
import { useWallet } from '../context/WalletContext';
import { colors, radius, spacing } from '../theme';

export default function ReceiveScreen() {
  const { user, simulateIncoming } = useWallet();

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.card}>
        <Text style={styles.emoji}>📲</Text>
        <Text style={styles.label}>
          Communiquez ce numéro à l’expéditeur
        </Text>
        <Text style={styles.phone} selectable>
          {user?.phone}
        </Text>
        <Text style={styles.name}>{user?.name}</Text>
      </View>

      <Text style={styles.hint}>
        Les fonds reçus sont crédités instantanément sur votre solde, sans frais.
      </Text>

      <Button
        title="Simuler une réception (démo)"
        variant="secondary"
        onPress={() => {
          const tx = simulateIncoming();
          router.replace({ pathname: '/receipt/[id]', params: { id: tx.id } });
        }}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing.lg },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.xl,
    alignItems: 'center',
  },
  emoji: { fontSize: 56 },
  label: { color: colors.muted, marginTop: spacing.md, textAlign: 'center' },
  phone: {
    fontSize: 28,
    fontWeight: '800',
    color: colors.primary,
    marginTop: spacing.sm,
    letterSpacing: 1,
  },
  name: { color: colors.text, fontWeight: '600', marginTop: spacing.xs },
  hint: {
    color: colors.muted,
    textAlign: 'center',
    marginVertical: spacing.lg,
  },
});
