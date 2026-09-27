import { isLikedUsername, rememberedAccounts, sameAccounts } from "./accounts.ts";
import { parseLikedPost } from "./history.ts";
import { isSolanaAddress } from "./solana.ts";
import type { LikedPost } from "./types.ts";

export { isLikedUsername };

export const LIKES_CACHE_MS = 60_000;
export const PAYOUT_MINIMUM = 5;

export type AccountEarning = {
  username: string;
  balance: number;
};

export type AccountRow = {
  username: string;
  balance: number | null;
};

export type LikesList = {
  balance: number;
  likes: LikedPost[];
  balances: AccountEarning[];
};

export function likesUrl(endpoint: string, accounts: readonly string[]): string {
  const url = new URL(endpoint);
  url.searchParams.set("usernames", accounts.join(","));
  return url.href;
}

export function payoutBalance(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return value;
}

export function canRequestPayout(balance: number): boolean {
  return balance > PAYOUT_MINIMUM;
}

export function formatPayout(balance: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(balance);
}

export function payoutClaim(
  username: string,
  wallet: string,
  balance: number,
  accounts: readonly string[],
): {
  type: "payout";
  username: string;
  usernames: string[];
  wallet: string;
  balance: number;
} | null {
  const address = wallet.trim();
  const usernames = rememberedAccounts([...accounts, username]);
  if (!isLikedUsername(username) || usernames.length === 0 || !canRequestPayout(balance) || !isSolanaAddress(address)) {
    return null;
  }
  return { type: "payout", username, usernames, wallet: address, balance };
}

export function parseLikesList(value: unknown): LikesList {
  const balance =
    value && typeof value === "object" ? payoutBalance((value as { balance?: unknown }).balance) : 0;
  return { balance, likes: parseLikesResponse(value), balances: parseAccountBalances(value) };
}

export function earningsFor(accounts: readonly string[], balances: readonly AccountEarning[]): AccountRow[] {
  return accounts.map((username) => {
    const reported = balances.find((entry) => entry.username.toLowerCase() === username.toLowerCase());
    return { username, balance: reported ? reported.balance : null };
  });
}

function parseAccountBalances(value: unknown): AccountEarning[] {
  if (!value || typeof value !== "object") return [];
  const balances = (value as { balances?: unknown }).balances;
  if (!Array.isArray(balances)) return [];
  const earnings: AccountEarning[] = [];
  for (const entry of balances) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { username?: unknown; balance?: unknown };
    if (!isLikedUsername(record.username) || hasEarning(earnings, record.username)) continue;
    earnings.push({ username: record.username, balance: payoutBalance(record.balance) });
  }
  return earnings;
}

function hasEarning(earnings: readonly AccountEarning[], username: string): boolean {
  const key = username.toLowerCase();
  return earnings.some((entry) => entry.username.toLowerCase() === key);
}

export function readLikesCache(value: unknown, accounts: readonly string[], now: number): LikesList | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { accounts?: unknown; fetchedAt?: unknown; balance?: unknown; balances?: unknown; likes?: unknown };
  if (!sameAccounts(record.accounts, accounts)) return null;
  if (typeof record.fetchedAt !== "number" || !Number.isFinite(record.fetchedAt)) return null;
  if (now - record.fetchedAt >= LIKES_CACHE_MS) return null;
  if (!Array.isArray(record.likes)) return null;
  return parseLikesList({ balance: record.balance, balances: record.balances, likes: record.likes });
}

export function parseLikesResponse(value: unknown): LikedPost[] {
  if (!value || typeof value !== "object") return [];
  const likes = (value as { likes?: unknown }).likes;
  if (!Array.isArray(likes)) return [];

  const posts: LikedPost[] = [];
  for (const entry of likes) {
    const post = parseLikedPost(entry);
    if (!post) continue;
    posts.push({ ...post, coinUrl: coinUrlFrom(entry), earning: coinEarningFrom(entry) });
  }

  return posts.sort((left, right) => Date.parse(right.likedAt) - Date.parse(left.likedAt));
}

function coinEarningFrom(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const earning = (value as { earning?: unknown }).earning;
  if (typeof earning !== "number" || !Number.isFinite(earning) || earning < 0) return null;
  return earning;
}

function coinUrlFrom(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const coinUrl = (value as { coinUrl?: unknown }).coinUrl;
  if (typeof coinUrl !== "string" || coinUrl.length === 0) return null;
  try {
    const url = new URL(coinUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.href;
  } catch {
    return null;
  }
}
