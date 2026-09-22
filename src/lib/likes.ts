import { parseLikedPost } from "./history.ts";
import type { LikedPost } from "./types.ts";

const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

export const LIKES_CACHE_MS = 60_000;

export function isLikedUsername(value: unknown): value is string {
  return typeof value === "string" && HANDLE.test(value);
}

export function likesUrl(endpoint: string, username: string): string {
  const url = new URL(endpoint);
  url.searchParams.set("username", username);
  return url.href;
}

export function readLikesCache(value: unknown, username: string, now: number): LikedPost[] | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { username?: unknown; fetchedAt?: unknown; likes?: unknown };
  if (record.username !== username) return null;
  if (typeof record.fetchedAt !== "number" || !Number.isFinite(record.fetchedAt)) return null;
  if (now - record.fetchedAt >= LIKES_CACHE_MS) return null;
  if (!Array.isArray(record.likes)) return null;
  return parseLikesResponse({ likes: record.likes });
}

export function parseLikesResponse(value: unknown): LikedPost[] {
  if (!value || typeof value !== "object") return [];
  const likes = (value as { likes?: unknown }).likes;
  if (!Array.isArray(likes)) return [];

  const posts: LikedPost[] = [];
  for (const entry of likes) {
    const post = parseLikedPost(entry);
    if (!post) continue;
    posts.push({ ...post, coinUrl: coinUrlFrom(entry) });
  }

  return posts.sort((left, right) => Date.parse(right.likedAt) - Date.parse(left.likedAt));
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
