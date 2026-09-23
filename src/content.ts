import { isCaptureEnabled } from "./lib/capture.ts";
import { findArticleByStatusId, observeArticle, type DomObservation } from "./lib/dom.ts";
import {
  decideDomCapture,
  payloadFromCached,
  postUrl,
  profileImageUrl,
  profileImageUrlFromStyle,
  statusIdFromHref,
  usernameFromAccountText,
  usernameFromProfileHref,
} from "./lib/extract.ts";
import type { CachedTweet, LikedPostPayload, MediaItem } from "./lib/types.ts";
import { PAGE_MESSAGE_SOURCE } from "./lib/types.ts";

const recentArticles = new Map<string, DomObservation>();

document.addEventListener(
  "click",
  (event) => {
    const button = likeButtonFromEvent(event);
    if (!button) return;
    const article = button.closest('article[data-testid="tweet"]');
    if (!article) return;
    const observation = observeArticle(article);
    if (observation.postId) recentArticles.set(observation.postId, observation);
  },
  true,
);

window.addEventListener("message", (event) => {
  if (event.origin !== window.location.origin || event.source !== window) return;
  const tweetId = favoriteTweetId(event.data);
  if (!tweetId) return;
  const tweetValue = event.data && typeof event.data === "object" ? (event.data as { tweet?: unknown }).tweet : null;
  void onFavorite(tweetId, tweetValue);
});

async function onFavorite(tweetId: string, tweetValue: unknown): Promise<void> {
  if (!(await isCaptureEnabled())) return;

  const account = currentAccount();
  if (!account) return;

  const tweet = readCachedTweet(tweetValue);
  if (tweet && tweet.postId === tweetId) {
    if (tweet.isReply) return;
    await sendPayload(payloadFromCached(tweet, new Date().toISOString(), account.username, account.avatarUrl));
    return;
  }

  const observation = observationFor(tweetId);
  if (!observation) return;

  const decision = decideDomCapture({
    postId: observation.postId,
    hasReplyingTo: observation.hasReplyingTo,
    pageStatusId: statusIdFromHref(location.pathname),
  });

  switch (decision.action) {
    case "drop":
      return;
    case "send":
      await sendPayload({
        postId: decision.postId,
        username: account.username,
        avatarUrl: account.avatarUrl,
        text: observation.text,
        media: observation.media,
        url: postUrl(decision.postId),
        likedAt: new Date().toISOString(),
      });
      return;
    default: {
      const unreachable: never = decision;
      throw new Error(`Unhandled capture decision: ${JSON.stringify(unreachable)}`);
    }
  }
}

function observationFor(postId: string): DomObservation | null {
  const live = findArticleByStatusId(document, postId);
  if (live) return observeArticle(live);
  return recentArticles.get(postId) ?? null;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isUsernameRequest(message)) return;
  const account = currentAccount();
  sendResponse({ username: account?.username ?? null });
});

watchSignedInAccount();

async function sendPayload(payload: LikedPostPayload): Promise<void> {
  await chrome.runtime.sendMessage({ type: "liked-post", payload });
}

function isUsernameRequest(message: unknown): boolean {
  return Boolean(message) && typeof message === "object" && (message as { type?: unknown }).type === "current-username";
}

function watchSignedInAccount(): void {
  let reported = "";
  const report = () => {
    const username = currentAccount()?.username;
    if (!username || username.toLowerCase() === reported) return;
    reported = username.toLowerCase();
    chrome.runtime.sendMessage({ type: "seen-account", username }, () => {
      void chrome.runtime.lastError;
    });
  };
  report();
  window.setInterval(report, 1000);
}

function currentAccount(): { username: string; avatarUrl: string | null } | null {
  const profile = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
  const switcher = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
  const fromProfile = profile instanceof HTMLAnchorElement ? usernameFromProfileHref(profile.href) : null;
  const username = fromProfile ?? usernameFromAccountText(switcher?.textContent ?? "");
  if (!username) return null;
  return {
    username,
    avatarUrl: avatarWithin(switcher) ?? avatarWithin(profile),
  };
}

function avatarWithin(root: Element | null): string | null {
  if (!root) return null;
  const image = root.querySelector("img");
  if (image instanceof HTMLImageElement) {
    const url = profileImageUrl(image.currentSrc || image.src);
    if (url) return url;
  }
  for (const node of root.querySelectorAll<HTMLElement>("[style]")) {
    const url = profileImageUrlFromStyle(node.getAttribute("style") ?? "");
    if (url) return url;
  }
  return null;
}

function likeButtonFromEvent(event: Event): HTMLElement | null {
  if (!(event.target instanceof Element)) return null;
  const button = event.target.closest('[data-testid="like"]');
  return button instanceof HTMLElement ? button : null;
}

function favoriteTweetId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.source !== PAGE_MESSAGE_SOURCE || record.type !== "favorite") return null;
  return typeof record.tweetId === "string" && record.tweetId.length > 0 ? record.tweetId : null;
}

function readCachedTweet(value: unknown): CachedTweet | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.postId !== "string" || typeof record.isReply !== "boolean") return null;
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
    text: record.text,
    media,
    isReply: record.isReply,
  };
}
