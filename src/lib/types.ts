export type TransactionType = 'sent' | 'received' | 'topup';

export type Transaction = {
  id: string;
  type: TransactionType;
  amount: number;
  fee: number;
  counterpartyName: string;
  counterpartyPhone: string;
  note?: string;
  createdAt: string;
};

export type Contact = {
  id: string;
  name: string;
  phone: string;
};

export type User = {
  name: string;
  phone: string;
  pin: string;
};

export type WalletState = {
  user: User | null;
  balance: number;
  transactions: Transaction[];
  contacts: Contact[];
};
