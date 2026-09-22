import type { LikedPostPayload, MediaItem } from "./types.ts";

export const LIKED_POSTS_KEY = "likedPosts";
export const LIKED_POSTS_LIMIT = 200;

export function upsertLikedPost(posts: LikedPostPayload[], next: LikedPostPayload): LikedPostPayload[] {
  const rest = posts.filter((post) => post.postId !== next.postId);
  return [next, ...rest].slice(0, LIKED_POSTS_LIMIT);
}

export function parseLikedPosts(value: unknown): LikedPostPayload[] {
  if (!Array.isArray(value)) return [];
  const posts: LikedPostPayload[] = [];
  for (const entry of value) {
    const post = parseLikedPost(entry);
    if (post) posts.push(post);
  }
  return posts;
}

export function parseLikedPost(value: unknown): LikedPostPayload | null {
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
    text: record.text,
    media,
    url: record.url,
    likedAt: record.likedAt,
  };
}
