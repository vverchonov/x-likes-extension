import { CAPTURE_CONSENT_ATTR, DISCLAIMER_ACCEPTED_KEY, isDisclaimerAccepted } from "./lib/consent.ts";
import { isCaptureEnabled } from "./lib/capture.ts";
import { findArticleByStatusId, observeArticle, rootPostOnStatusPage, type DomObservation } from "./lib/dom.ts";
import {
  decideDomCapture,
  payloadFromCached,
  postUrl,
  profileImageUrl,
  profileImageUrlFromStyle,
  usernameFromAccountText,
  usernameFromProfileHref,
  xUserIdFromTwidCookie,
} from "./lib/extract.ts";
import type { CachedTweet, EngagementKind, LikedPostPayload, MediaItem } from "./lib/types.ts";
import { PAGE_MESSAGE_SOURCE } from "./lib/types.ts";

const recentArticles = new Map<string, DomObservation>();
const accountIds = new Map<string, string>();
const pendingEngagements: { engagement: PageEngagement; username: string; avatarUrl: string | null }[] = [];

let watching = false;
let accountTimer: number | undefined;
let contextInvalidated = false;

void boot().catch(onCaptureError);

async function boot(): Promise<void> {
  if (await isDisclaimerAccepted()) startWatching();
  chrome.storage.onChanged.addListener(onStorageChanged);
}

function onStorageChanged(changes: Record<string, chrome.storage.StorageChange>, area: string): void {
  if (!hasActiveContext() || area !== "local") return;
  if (changes[DISCLAIMER_ACCEPTED_KEY]?.newValue === true) startWatching();
  if (changes.captureEnabled?.newValue === false) pendingEngagements.length = 0;
}

function hasActiveContext(): boolean {
  if (contextInvalidated) return false;
  if (chrome.runtime?.id) return true;
  stopWatching();
  return false;
}

function stopWatching(): void {
  contextInvalidated = true;
  watching = false;
  if (accountTimer !== undefined) window.clearInterval(accountTimer);
  document.removeEventListener("click", onPostActionClick, true);
  window.removeEventListener("message", onPageMessage);
  document.documentElement?.removeAttribute(CAPTURE_CONSENT_ATTR);
  pendingEngagements.length = 0;
  recentArticles.clear();
  accountIds.clear();
}

function onCaptureError(error: unknown): void {
  if (!hasActiveContext() || (error instanceof Error && error.message.includes("Extension context invalidated"))) {
    stopWatching();
    return;
  }
  console.error("Observation capture failed", error);
}

function startWatching(): void {
  if (!hasActiveContext() || watching) return;
  watching = true;
  document.documentElement?.setAttribute(CAPTURE_CONSENT_ATTR, "on");
  document.addEventListener("click", onPostActionClick, true);
  window.addEventListener("message", onPageMessage);
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  watchSignedInAccount();
}

function onPostActionClick(event: Event): void {
  if (!hasActiveContext()) return;
  const button = actionButtonFromEvent(event);
  if (!button) return;
  const article = button.closest('article[data-testid="tweet"]');
  if (!article) return;
  const observation = observeArticle(article);
  if (observation.postId) recentArticles.set(observation.postId, observation);
}

function onPageMessage(event: MessageEvent): void {
  if (!hasActiveContext()) return;
  if (event.origin !== window.location.origin || event.source !== window) return;
  const account = pageAccountId(event.data);
  if (account) {
    accountIds.set(account.username.toLowerCase(), account.xUserId);
    const current = currentAccount();
    if (current?.username.toLowerCase() === account.username.toLowerCase()) {
      for (let i = 0; i < pendingEngagements.length;) {
        const pending = pendingEngagements[i];
        if (pending.username.toLowerCase() !== account.username.toLowerCase()) { i++; continue; }
        pendingEngagements.splice(i, 1);
        void sendEngagedPost(pending.engagement, { username: pending.username, avatarUrl: pending.avatarUrl, xUserId: account.xUserId })
          .catch(onCaptureError);
      }
    }
    return;
  }
  const engagement = pageEngagement(event.data);
  if (!engagement) return;
  void onEngagement(engagement).catch(onCaptureError);
}

function onRuntimeMessage(message: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void): void {
  if (!isUsernameRequest(message)) return;
  const account = currentAccount();
  sendResponse({ username: account?.username ?? null, xUserId: account?.xUserId ?? null });
}

async function onEngagement(engagement: PageEngagement): Promise<void> {
  if (!(await isDisclaimerAccepted())) return;

  const account = currentAccount();
  if (!account) return;
  if (!account.xUserId) {
    if (!(await isCaptureEnabled())) return;
    const resolved = currentAccount();
    if (resolved?.username.toLowerCase() === account.username.toLowerCase() && resolved.xUserId) {
      await sendEngagedPost(engagement, { username: account.username, avatarUrl: account.avatarUrl, xUserId: resolved.xUserId });
      return;
    }
    if (pendingEngagements.length === 50) pendingEngagements.shift();
    pendingEngagements.push({ engagement, username: account.username, avatarUrl: account.avatarUrl });
    return;
  }
  const observed = { ...account, xUserId: account.xUserId };

  switch (engagement.kind) {
    case "like":
    case "repost":
    case "comment":
      await sendEngagedPost(engagement, observed);
      return;
    default: {
      const unreachable: never = engagement.kind;
      throw new Error(`Unhandled engagement: ${JSON.stringify(unreachable)}`);
    }
  }
}

async function sendEngagedPost(
  engagement: PageEngagement,
  account: { username: string; avatarUrl: string | null; xUserId: string },
): Promise<void> {
  const tweet = readCachedTweet(engagement.tweet);
  if (tweet && tweet.postId === engagement.tweetId && !tweet.isReply) {
    await sendPayload(payloadFromCached(tweet, new Date().toISOString(), account.username, account.avatarUrl), account.xUserId);
    return;
  }

  const clicked = observationFor(engagement.tweetId);
  if (clicked && (await sendObservation(clicked, account, null))) return;

  const pageRoot = rootPostOnStatusPage(document, location.pathname);
  const clickedIsReply = clicked?.hasReplyingTo === true;
  const pageRootIsTarget = pageRoot?.postId === engagement.tweetId;
  const replyOnThisPost = !engagement.original && (clickedIsReply || !clicked);
  if (pageRoot && (pageRootIsTarget || replyOnThisPost) && (await sendObservation(pageRoot, account, null))) return;

  if (!engagement.original) return;
  await sendPayload({
    postId: engagement.tweetId,
    username: account.username,
    avatarUrl: account.avatarUrl,
    text: null,
    media: [],
    url: postUrl(engagement.tweetId),
    likedAt: new Date().toISOString(),
  }, account.xUserId);
}

async function sendObservation(
  observation: DomObservation,
  account: { username: string; avatarUrl: string | null; xUserId: string },
  pageStatusId: string | null,
): Promise<boolean> {
  const decision = decideDomCapture({
    postId: observation.postId,
    hasReplyingTo: observation.hasReplyingTo,
    pageStatusId,
  });

  switch (decision.action) {
    case "drop":
      return false;
    case "send":
      await sendPayload({
        postId: decision.postId,
        username: account.username,
        avatarUrl: account.avatarUrl,
        text: observation.text,
        media: observation.media,
        url: postUrl(decision.postId),
        likedAt: new Date().toISOString(),
      }, account.xUserId);
      return true;
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

async function sendPayload(payload: LikedPostPayload, xUserId: string): Promise<void> {
  if (!hasActiveContext()) return;
  await chrome.runtime.sendMessage({ type: "liked-post", payload: { ...payload, xUserId } });
}

function isUsernameRequest(message: unknown): boolean {
  return Boolean(message) && typeof message === "object" && (message as { type?: unknown }).type === "current-username";
}

function watchSignedInAccount(): void {
  let reported = "";
  const report = () => {
    if (!hasActiveContext()) return;
    const account = currentAccount();
    if (!account?.xUserId) return;
    // Cookie resolution can arrive without another page-hook account message.
    for (let i = 0; i < pendingEngagements.length;) {
      const pending = pendingEngagements[i]!;
      if (pending.username.toLowerCase() !== account.username.toLowerCase()) { i++; continue; }
      pendingEngagements.splice(i, 1);
      void sendEngagedPost(pending.engagement, { username: pending.username, avatarUrl: pending.avatarUrl, xUserId: account.xUserId }).catch(onCaptureError);
    }
    const key = `${account.xUserId}:${account.username}`;
    if (key === reported) return;
    reported = key;
    void chrome.runtime.sendMessage({ type: "seen-account", username: account.username, xUserId: account.xUserId })
      .catch(onCaptureError);
  };
  report();
  accountTimer = window.setInterval(report, 1000);
}

function currentAccount(): { username: string; avatarUrl: string | null; xUserId: string | null } | null {
  const profile = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
  const switcher = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
  const fromProfile = profile instanceof HTMLAnchorElement ? usernameFromProfileHref(profile.href) : null;
  const username = fromProfile ?? usernameFromAccountText(switcher?.textContent ?? "");
  if (!username) return null;
  return {
    username,
    xUserId: xUserIdFromTwidCookie(document.cookie) ?? accountIds.get(username.toLowerCase()) ?? null,
    avatarUrl: avatarWithin(switcher) ?? avatarWithin(profile),
  };
}

function pageAccountId(value: unknown): { username: string; xUserId: string } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.source !== PAGE_MESSAGE_SOURCE || record.type !== "account-id" ||
      typeof record.username !== "string" || !/^[A-Za-z0-9_]{1,15}$/.test(record.username) ||
      typeof record.xUserId !== "string" || !/^[1-9][0-9]{0,19}$/.test(record.xUserId)) return null;
  return { username: record.username, xUserId: record.xUserId };
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

function actionButtonFromEvent(event: Event): HTMLElement | null {
  if (!(event.target instanceof Element)) return null;
  const button = event.target.closest('[data-testid="like"], [data-testid="retweet"], [data-testid="reply"]');
  return button instanceof HTMLElement ? button : null;
}

type PageEngagement = {
  tweetId: string;
  tweet: unknown;
  kind: EngagementKind;
  original: boolean;
};

function pageEngagement(value: unknown): PageEngagement | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.source !== PAGE_MESSAGE_SOURCE || record.type !== "favorite") return null;
  if (typeof record.tweetId !== "string" || record.tweetId.length === 0) return null;
  return {
    tweetId: record.tweetId,
    tweet: record.tweet,
    kind: engagementKind(record.kind),
    original: record.original === true,
  };
}

function engagementKind(value: unknown): EngagementKind {
  switch (value) {
    case "like":
    case "repost":
    case "comment":
      return value;
    default:
      return "like";
  }
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
    conversationId: typeof record.conversationId === "string" && record.conversationId.length > 0 ? record.conversationId : null,
    inReplyToStatusId:
      typeof record.inReplyToStatusId === "string" && record.inReplyToStatusId.length > 0 ? record.inReplyToStatusId : null,
  };
}
