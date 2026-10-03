import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, View } from 'react-native';

import { WalletProvider, useWallet } from '../context/WalletContext';
import { colors } from '../theme';

function RootNavigator() {
  const { ready, loggedIn } = useWallet();

  if (!ready) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.primary },
        headerTintColor: '#fff',
        headerTitleStyle: { fontWeight: '600' },
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Protected guard={!loggedIn}>
        <Stack.Screen name="login" options={{ headerShown: false }} />
      </Stack.Protected>
      <Stack.Protected guard={loggedIn}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="send" options={{ title: 'Envoyer de l’argent' }} />
        <Stack.Screen name="confirm" options={{ title: 'Confirmation' }} />
        <Stack.Screen name="receive" options={{ title: 'Recevoir' }} />
        <Stack.Screen name="topup" options={{ title: 'Recharger' }} />
        <Stack.Screen name="receipt/[id]" options={{ title: 'Reçu' }} />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <WalletProvider>
      <StatusBar style="light" />
      <RootNavigator />
    </WalletProvider>
  );
}
