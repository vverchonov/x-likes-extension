import { BE_ENDPOINT } from "./config.ts";
import { SIGNED_IN_ACCOUNTS_KEY, forgetAccount, rememberAccount, rememberedAccounts, sameAccounts } from "./lib/accounts.ts";
import { isCaptureEnabled } from "./lib/capture.ts";
import { httpsUrl } from "./lib/extract.ts";
import {
  type AccountEarning,
  isLikedUsername,
  likesUrl,
  parseLikesList,
  payoutClaim,
  readLikesCache,
} from "./lib/likes.ts";
import type { LikedPost, LikedPostPayload, MediaItem } from "./lib/types.ts";

const LIKES_CACHE_KEY = "likesCache";

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const payload = likedPostPayload(message);
  if (payload) {
    void deliver(payload);
    return;
  }

  const seen = seenAccount(message);
  if (seen) {
    void storeAccount(seen);
    return;
  }

  const forgotten = forgetRequest(message);
  if (forgotten) {
    void forgetStored(forgotten).then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }

  const request = likesRequest(message);
  if (request) {
    void loadLikes(request.username, request.force).then((response) => {
      sendResponse(response);
    });
    return true;
  }

  const claim = claimRequest(message);
  if (!claim) return;
  void sendClaim(claim).then((ok) => {
    sendResponse({ ok });
  });
  return true;
});

async function deliver(payload: LikedPostPayload): Promise<void> {
  await storeAccount(payload.username);
  if (!(await isCaptureEnabled())) return;
  const delivered = await postOnce(payload);
  if (!delivered) {
    const retried = await postOnce(payload);
    if (!retried) {
      console.error("Failed to send liked post", payload.postId);
      return;
    }
  }
  await chrome.storage.local.remove(LIKES_CACHE_KEY);
}

async function loadLikes(
  username: string | null,
  force: boolean,
): Promise<
  | { ok: true; username: string; accounts: string[]; balance: number; balances: AccountEarning[]; likes: LikedPost[] }
  | { ok: false; reason: "no-account" | "failed"; accounts: string[] }
> {
  const accounts = await readAccounts();
  const current = listedAccount(username, accounts) ?? accounts.at(-1) ?? null;
  if (!current || accounts.length === 0) return { ok: false, reason: "no-account", accounts };

  if (!force) {
    const stored = await chrome.storage.local.get(LIKES_CACHE_KEY);
    const cached = readLikesCache(stored[LIKES_CACHE_KEY], accounts, Date.now());
    if (cached) {
      return {
        ok: true,
        username: current,
        accounts,
        balance: cached.balance,
        balances: cached.balances,
        likes: cached.likes,
      };
    }
  }

  try {
    const response = await fetch(likesUrl(BE_ENDPOINT, accounts), {
      headers: { accept: "application/json" },
    });
    if (!response.ok) return { ok: false, reason: "failed", accounts };
    const list = parseLikesList(await response.json());
    await chrome.storage.local.set({
      [LIKES_CACHE_KEY]: {
        username: current,
        accounts,
        fetchedAt: Date.now(),
        balance: list.balance,
        balances: list.balances,
        likes: list.likes,
      },
    });
    return {
      ok: true,
      username: current,
      accounts,
      balance: list.balance,
      balances: list.balances,
      likes: list.likes,
    };
  } catch (error) {
    console.error("Like list request failed", error);
    return { ok: false, reason: "failed", accounts };
  }
}

async function readAccounts(): Promise<string[]> {
  const stored = await chrome.storage.local.get(SIGNED_IN_ACCOUNTS_KEY);
  return rememberedAccounts(stored[SIGNED_IN_ACCOUNTS_KEY]);
}

async function storeAccount(username: string): Promise<void> {
  const previous = await readAccounts();
  const next = rememberAccount(previous, username);
  if (!next.added) {
    if (previous.at(-1) !== next.accounts.at(-1)) {
      await chrome.storage.local.set({ [SIGNED_IN_ACCOUNTS_KEY]: next.accounts });
    }
    return;
  }
  await chrome.storage.local.remove(LIKES_CACHE_KEY);
  await chrome.storage.local.set({ [SIGNED_IN_ACCOUNTS_KEY]: next.accounts });
}

async function forgetStored(username: string): Promise<void> {
  const previous = await readAccounts();
  const next = forgetAccount(previous, username);
  if (sameAccounts(previous, next)) return;
  await chrome.storage.local.remove(LIKES_CACHE_KEY);
  await chrome.storage.local.set({ [SIGNED_IN_ACCOUNTS_KEY]: next });
}

function listedAccount(username: string | null, accounts: readonly string[]): string | null {
  if (!username) return null;
  const key = username.toLowerCase();
  return accounts.find((account) => account.toLowerCase() === key) ?? null;
}

async function postOnce(payload: LikedPostPayload): Promise<boolean> {
  try {
    const response = await fetch(BE_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      console.error("Like endpoint returned", response.status);
      return false;
    }
    return true;
  } catch (error) {
    console.error("Like endpoint request failed", error);
    return false;
  }
}

async function sendClaim(claim: {
  username: string;
  wallet: string;
  balance: number;
  accounts: string[];
}): Promise<boolean> {
  const accounts = claim.accounts.length > 0 ? claim.accounts : await readAccounts();
  const body = payoutClaim(claim.username, claim.wallet, claim.balance, accounts);
  if (!body) return false;
  try {
    const response = await fetch(BE_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      console.error("Payout endpoint returned", response.status);
      return false;
    }
    await chrome.storage.local.remove(LIKES_CACHE_KEY);
    return true;
  } catch (error) {
    console.error("Payout endpoint request failed", error);
    return false;
  }
}

function claimRequest(message: unknown): {
  username: string;
  wallet: string;
  balance: number;
  accounts: string[];
} | null {
  if (!message || typeof message !== "object") return null;
  const record = message as Record<string, unknown>;
  if (record.type !== "claim-payout") return null;
  if (!isLikedUsername(record.username) || typeof record.wallet !== "string") return null;
  if (typeof record.balance !== "number" || !Number.isFinite(record.balance)) return null;
  return {
    username: record.username,
    wallet: record.wallet,
    balance: record.balance,
    accounts: rememberedAccounts(record.usernames),
  };
}

function likesRequest(message: unknown): { username: string | null; force: boolean } | null {
  if (!message || typeof message !== "object") return null;
  const record = message as Record<string, unknown>;
  if (record.type !== "load-likes") return null;
  return { username: isLikedUsername(record.username) ? record.username : null, force: record.force === true };
}

function forgetRequest(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const record = message as Record<string, unknown>;
  if (record.type !== "forget-account" || !isLikedUsername(record.username)) return null;
  return record.username;
}

function seenAccount(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const record = message as Record<string, unknown>;
  if (record.type !== "seen-account" || !isLikedUsername(record.username)) return null;
  return record.username;
}

function likedPostPayload(message: unknown): LikedPostPayload | null {
  if (!message || typeof message !== "object") return null;
  const record = message as Record<string, unknown>;
  if (record.type !== "liked-post") return null;
  return asPayload(record.payload);
}

function asPayload(value: unknown): LikedPostPayload | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.postId !== "string" ||
    typeof record.username !== "string" ||
    typeof record.url !== "string" ||
    typeof record.likedAt !== "string"
  ) {
    return null;
  }
  if (!record.username) return null;
  if (!(record.text === null || typeof record.text === "string")) return null;
  if (!Array.isArray(record.media)) return null;

  const media: MediaItem[] = [];
  for (const entry of record.media) {
    if (!entry || typeof entry !== "object") return null;
    const item = entry as Record<string, unknown>;
    if ((item.type !== "image" && item.type !== "video") || typeof item.url !== "string") return null;
    media.push({ type: item.type, url: item.url });
  }

  return {
    postId: record.postId,
    username: record.username,
    avatarUrl: httpsUrl(record.avatarUrl),
    text: record.text,
    media,
    url: record.url,
    likedAt: record.likedAt,
  };
}
