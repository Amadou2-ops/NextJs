import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import {
  computeFee,
  isValidPhone,
  normalizePhone,
  validateTransfer,
} from '../lib/format';
import type { Contact, Transaction, User, WalletState } from '../lib/types';

const STORAGE_KEY = 'transfertplus:wallet:v1';

const DEMO_CONTACTS: Contact[] = [
  { id: 'c1', name: 'Awa Diop', phone: '+221770000001' },
  { id: 'c2', name: 'Moussa Ndiaye', phone: '+221770000002' },
  { id: 'c3', name: 'Fatou Sow', phone: '+221770000003' },
  { id: 'c4', name: 'Ibrahima Fall', phone: '+221770000004' },
];

const WELCOME_BONUS = 50_000;

const EMPTY_STATE: WalletState = {
  user: null,
  balance: 0,
  transactions: [],
  contacts: DEMO_CONTACTS,
};

type SendInput = {
  name: string;
  phone: string;
  amount: number;
  note?: string;
};

type WalletContextValue = WalletState & {
  ready: boolean;
  loggedIn: boolean;
  register: (name: string, phone: string, pin: string) => void;
  login: (phone: string, pin: string) => boolean;
  logout: () => void;
  verifyPin: (pin: string) => boolean;
  sendMoney: (input: SendInput) => Transaction;
  topUp: (amount: number) => Transaction;
  simulateIncoming: () => Transaction;
  resetAll: () => Promise<void>;
};

const WalletContext = createContext<WalletContextValue | null>(null);

function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WalletState>(EMPTY_STATE);
  const [ready, setReady] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (raw) setState({ ...EMPTY_STATE, ...JSON.parse(raw) });
      })
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);

  useEffect(() => {
    if (!ready) return;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state)).catch(() => {});
  }, [state, ready]);

  const register = useCallback((name: string, phone: string, pin: string) => {
    const user: User = { name: name.trim(), phone: normalizePhone(phone), pin };
    const bonus: Transaction = {
      id: newId(),
      type: 'topup',
      amount: WELCOME_BONUS,
      fee: 0,
      counterpartyName: 'Bonus de bienvenue',
      counterpartyPhone: '',
      createdAt: new Date().toISOString(),
    };
    setState({
      user,
      balance: WELCOME_BONUS,
      transactions: [bonus],
      contacts: DEMO_CONTACTS,
    });
    setLoggedIn(true);
  }, []);

  const login = useCallback(
    (phone: string, pin: string) => {
      const ok =
        state.user !== null &&
        state.user.phone === normalizePhone(phone) &&
        state.user.pin === pin;
      if (ok) setLoggedIn(true);
      return ok;
    },
    [state.user],
  );

  const logout = useCallback(() => setLoggedIn(false), []);

  const verifyPin = useCallback(
    (pin: string) => state.user?.pin === pin,
    [state.user],
  );

  const sendMoney = useCallback(
    ({ name, phone, amount, note }: SendInput) => {
      const normalized = normalizePhone(phone);
      if (!isValidPhone(normalized)) {
        throw new Error('Numéro de téléphone invalide.');
      }
      if (normalized === state.user?.phone) {
        throw new Error('Vous ne pouvez pas vous envoyer de l’argent.');
      }
      const error = validateTransfer(amount, state.balance);
      if (error) throw new Error(error);

      const fee = computeFee(amount);
      const tx: Transaction = {
        id: newId(),
        type: 'sent',
        amount,
        fee,
        counterpartyName: name.trim() || normalized,
        counterpartyPhone: normalized,
        note: note?.trim() || undefined,
        createdAt: new Date().toISOString(),
      };
      setState((s) => {
        const known = s.contacts.some((c) => c.phone === normalized);
        return {
          ...s,
          balance: s.balance - amount - fee,
          transactions: [tx, ...s.transactions],
          contacts: known
            ? s.contacts
            : [
                ...s.contacts,
                { id: newId(), name: tx.counterpartyName, phone: normalized },
              ],
        };
      });
      return tx;
    },
    [state.balance, state.user],
  );

  const topUp = useCallback((amount: number) => {
    if (amount <= 0) throw new Error('Montant invalide.');
    const tx: Transaction = {
      id: newId(),
      type: 'topup',
      amount,
      fee: 0,
      counterpartyName: 'Rechargement',
      counterpartyPhone: '',
      createdAt: new Date().toISOString(),
    };
    setState((s) => ({
      ...s,
      balance: s.balance + amount,
      transactions: [tx, ...s.transactions],
    }));
    return tx;
  }, []);

  const simulateIncoming = useCallback(() => {
    const from = DEMO_CONTACTS[Math.floor(Math.random() * DEMO_CONTACTS.length)]!;
    const amount = (Math.floor(Math.random() * 20) + 1) * 1_000;
    const tx: Transaction = {
      id: newId(),
      type: 'received',
      amount,
      fee: 0,
      counterpartyName: from.name,
      counterpartyPhone: from.phone,
      createdAt: new Date().toISOString(),
    };
    setState((s) => ({
      ...s,
      balance: s.balance + amount,
      transactions: [tx, ...s.transactions],
    }));
    return tx;
  }, []);

  const resetAll = useCallback(async () => {
    await AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
    setState(EMPTY_STATE);
    setLoggedIn(false);
  }, []);

  const value = useMemo<WalletContextValue>(
    () => ({
      ...state,
      ready,
      loggedIn,
      register,
      login,
      logout,
      verifyPin,
      sendMoney,
      topUp,
      simulateIncoming,
      resetAll,
    }),
    [
      state,
      ready,
      loggedIn,
      register,
      login,
      logout,
      verifyPin,
      sendMoney,
      topUp,
      simulateIncoming,
      resetAll,
    ],
  );

  return (
    <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
  );
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet doit être utilisé dans WalletProvider');
  return ctx;
}
