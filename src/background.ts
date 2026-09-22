import { BE_ENDPOINT } from "./config.ts";
import { isCaptureEnabled } from "./lib/capture.ts";
import { LIKED_POSTS_KEY, parseLikedPosts, upsertLikedPost } from "./lib/history.ts";
import type { LikedPostPayload, MediaItem } from "./lib/types.ts";

chrome.runtime.onMessage.addListener((message: unknown) => {
  const payload = likedPostPayload(message);
  if (!payload) return;
  void deliver(payload);
});

async function deliver(payload: LikedPostPayload): Promise<void> {
  if (!(await isCaptureEnabled())) return;
  await rememberLikedPost(payload);
  const delivered = await postOnce(payload);
  if (delivered) return;
  const retried = await postOnce(payload);
  if (!retried) console.error("Failed to send liked post", payload.postId);
}

async function rememberLikedPost(payload: LikedPostPayload): Promise<void> {
  const stored = await chrome.storage.local.get(LIKED_POSTS_KEY);
  const posts = upsertLikedPost(parseLikedPosts(stored[LIKED_POSTS_KEY]), payload);
  await chrome.storage.local.set({ [LIKED_POSTS_KEY]: posts });
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
    text: record.text,
    media,
    url: record.url,
    likedAt: record.likedAt,
  };
}
