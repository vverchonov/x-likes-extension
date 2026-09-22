import { BE_ENDPOINT } from "./config.ts";
import { isCaptureEnabled } from "./lib/capture.ts";
import { httpsUrl } from "./lib/extract.ts";
import { isLikedUsername, likesUrl, parseLikesResponse } from "./lib/likes.ts";
import type { LikedPost, LikedPostPayload, MediaItem } from "./lib/types.ts";

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const payload = likedPostPayload(message);
  if (payload) {
    void deliver(payload);
    return;
  }

  const username = likesRequestUsername(message);
  if (!username) return;
  void loadLikes(username).then((response) => {
    sendResponse(response);
  });
  return true;
});

async function deliver(payload: LikedPostPayload): Promise<void> {
  if (!(await isCaptureEnabled())) return;
  const delivered = await postOnce(payload);
  if (!delivered) {
    const retried = await postOnce(payload);
    if (!retried) {
      console.error("Failed to send liked post", payload.postId);
      return;
    }
  }
  void chrome.runtime.sendMessage({ type: "likes-changed" }).catch(() => undefined);
}

async function loadLikes(username: string): Promise<{ ok: true; likes: LikedPost[] } | { ok: false }> {
  try {
    const response = await fetch(likesUrl(BE_ENDPOINT, username), {
      headers: { accept: "application/json" },
    });
    if (!response.ok) return { ok: false };
    return { ok: true, likes: parseLikesResponse(await response.json()) };
  } catch (error) {
    console.error("Like list request failed", error);
    return { ok: false };
  }
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

function likesRequestUsername(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const record = message as Record<string, unknown>;
  if (record.type !== "load-likes") return null;
  return isLikedUsername(record.username) ? record.username : null;
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
