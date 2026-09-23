const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

export const SIGNED_IN_ACCOUNTS_KEY = "signedInAccounts";

export function isLikedUsername(value: unknown): value is string {
  return typeof value === "string" && HANDLE.test(value);
}

export function rememberedAccounts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const accounts: string[] = [];
  for (const entry of value) {
    if (!isLikedUsername(entry) || hasAccount(accounts, entry)) continue;
    accounts.push(entry);
  }
  return accounts;
}

export function rememberAccount(existing: unknown, username: string): { accounts: string[]; added: boolean } {
  const accounts = rememberedAccounts(existing);
  if (!isLikedUsername(username)) return { accounts, added: false };
  const without = accounts.filter((account) => account.toLowerCase() !== username.toLowerCase());
  return { accounts: [...without, username], added: without.length === accounts.length };
}

export function forgetAccount(existing: unknown, username: string): string[] {
  if (!isLikedUsername(username)) return rememberedAccounts(existing);
  return rememberedAccounts(existing).filter((account) => account.toLowerCase() !== username.toLowerCase());
}

export function sameAccounts(left: unknown, right: unknown): boolean {
  const stored = rememberedAccounts(left);
  const other = rememberedAccounts(right);
  if (stored.length !== other.length) return false;
  return other.every((account) => hasAccount(stored, account));
}

function hasAccount(accounts: readonly string[], username: string): boolean {
  const key = username.toLowerCase();
  return accounts.some((account) => account.toLowerCase() === key);
}
