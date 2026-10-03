export const CURRENCY = 'FCFA';

// Frais de transfert : 1 % du montant, arrondi à l'unité supérieure.
export const FEE_RATE = 0.01;
export const MIN_TRANSFER = 100;
export const MAX_TRANSFER = 2_000_000;

export function computeFee(amount: number): number {
  if (amount <= 0) return 0;
  return Math.ceil(amount * FEE_RATE);
}

export function formatAmount(amount: number): string {
  const rounded = Math.round(amount);
  const sign = rounded < 0 ? '-' : '';
  const digits = Math.abs(rounded)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${sign}${digits} ${CURRENCY}`;
}

export function parseAmount(input: string): number {
  const digits = input.replace(/\D/g, '');
  return digits ? parseInt(digits, 10) : 0;
}

export function normalizePhone(input: string): string {
  return input.replace(/[^\d+]/g, '');
}

export function isValidPhone(input: string): boolean {
  const digits = normalizePhone(input).replace(/^\+/, '');
  return digits.length >= 8 && digits.length <= 15;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('');
}

export function validateTransfer(
  amount: number,
  balance: number,
): string | null {
  if (amount < MIN_TRANSFER) {
    return `Le montant minimum est de ${formatAmount(MIN_TRANSFER)}.`;
  }
  if (amount > MAX_TRANSFER) {
    return `Le montant maximum est de ${formatAmount(MAX_TRANSFER)}.`;
  }
  if (amount + computeFee(amount) > balance) {
    return 'Solde insuffisant (frais inclus).';
  }
  return null;
}
