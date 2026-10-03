import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button } from '../../components/Button';
import { useWallet } from '../../context/WalletContext';
import { formatAmount, initials } from '../../lib/format';
import { colors, radius, spacing } from '../../theme';

export default function ProfileScreen() {
  const { user, balance, transactions, contacts, logout, resetAll } = useWallet();
  const [confirmingReset, setConfirmingReset] = useState(false);
  if (!user) return null;

  const sentCount = transactions.filter((t) => t.type === 'sent').length;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.card}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials(user.name)}</Text>
        </View>
        <Text style={styles.name}>{user.name}</Text>
        <Text style={styles.phone}>{user.phone}</Text>
      </View>

      <View style={styles.stats}>
        <Stat label="Solde" value={formatAmount(balance)} />
        <Stat label="Transferts" value={String(sentCount)} />
        <Stat label="Contacts" value={String(contacts.length)} />
      </View>

      <Button title="Se déconnecter" variant="secondary" onPress={logout} />
      {confirmingReset ? (
        <View style={styles.confirmBox}>
          <Text style={styles.confirmText}>
            Toutes vos données (compte, solde, historique) seront effacées.
          </Text>
          <Button title="Oui, tout effacer" variant="danger" onPress={resetAll} />
          <Button
            title="Annuler"
            variant="secondary"
            style={{ marginTop: spacing.sm }}
            onPress={() => setConfirmingReset(false)}
          />
        </View>
      ) : (
        <Button
          title="Réinitialiser l’application"
          variant="danger"
          style={{ marginTop: spacing.md }}
          onPress={() => setConfirmingReset(true)}
        />
      )}
      <Text style={styles.note}>
        Application de démonstration : les fonds sont fictifs et les données sont
        stockées uniquement sur cet appareil.
      </Text>
    </ScrollView>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>
        {value}
      </Text>
      <Text style={styles.statLabel}>{label}</Text>
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
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: 26, fontWeight: '700', color: colors.primary },
  name: { fontSize: 20, fontWeight: '700', color: colors.text, marginTop: spacing.md },
  phone: { color: colors.muted, marginTop: spacing.xs },
  stats: { flexDirection: 'row', gap: spacing.sm, marginVertical: spacing.lg },
  stat: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: spacing.md,
    alignItems: 'center',
  },
  statValue: { fontSize: 15, textAlign: 'center', fontWeight: '700', color: colors.text },
  statLabel: { color: colors.muted, fontSize: 12, marginTop: spacing.xs },
  confirmBox: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.md,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  confirmText: { color: colors.text, marginBottom: spacing.md },
  note: {
    color: colors.muted,
    fontSize: 12,
    textAlign: 'center',
    marginTop: spacing.lg,
  },
});
