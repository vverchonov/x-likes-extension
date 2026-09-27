import { CAPTURE_CONSENT_ATTR, DISCLAIMER_ACCEPTED_KEY, isDisclaimerAccepted } from "./lib/consent.ts";
import { findArticleByStatusId, observeArticle, rootPostOnStatusPage, type DomObservation } from "./lib/dom.ts";
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
import type { CachedTweet, EngagementKind, LikedPostPayload, MediaItem } from "./lib/types.ts";
import { PAGE_MESSAGE_SOURCE } from "./lib/types.ts";

const recentArticles = new Map<string, DomObservation>();

let watching = false;

void boot();

async function boot(): Promise<void> {
  if (await isDisclaimerAccepted()) startWatching();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[DISCLAIMER_ACCEPTED_KEY]?.newValue === true) startWatching();
  });
}

function startWatching(): void {
  if (watching) return;
  watching = true;
  document.documentElement?.setAttribute(CAPTURE_CONSENT_ATTR, "on");
  document.addEventListener("click", onPostActionClick, true);
  window.addEventListener("message", onPageMessage);
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  watchSignedInAccount();
}

function onPostActionClick(event: Event): void {
  const button = actionButtonFromEvent(event);
  if (!button) return;
  const article = button.closest('article[data-testid="tweet"]');
  if (!article) return;
  const observation = observeArticle(article);
  if (observation.postId) recentArticles.set(observation.postId, observation);
}

function onPageMessage(event: MessageEvent): void {
  if (event.origin !== window.location.origin || event.source !== window) return;
  const engagement = pageEngagement(event.data);
  if (!engagement) return;
  void onEngagement(engagement);
}

function onRuntimeMessage(message: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void): void {
  if (!isUsernameRequest(message)) return;
  const account = currentAccount();
  sendResponse({ username: account?.username ?? null });
}

async function onEngagement(engagement: PageEngagement): Promise<void> {
  if (!(await isDisclaimerAccepted())) return;

  const account = currentAccount();
  if (!account) return;

  switch (engagement.kind) {
    case "like":
      await sendLikedPost(engagement.tweetId, engagement.tweet, account);
      return;
    case "repost":
    case "comment":
      await sendEngagedPost(engagement, account);
      return;
    default: {
      const unreachable: never = engagement.kind;
      throw new Error(`Unhandled engagement: ${JSON.stringify(unreachable)}`);
    }
  }
}

async function sendLikedPost(
  tweetId: string,
  tweetValue: unknown,
  account: { username: string; avatarUrl: string | null },
): Promise<void> {
  const tweet = readCachedTweet(tweetValue);
  if (tweet && tweet.postId === tweetId) {
    if (tweet.isReply) return;
    await sendPayload(payloadFromCached(tweet, new Date().toISOString(), account.username, account.avatarUrl));
    return;
  }

  const observation = observationFor(tweetId);
  if (!observation) return;
  await sendObservation(observation, account, statusIdFromHref(location.pathname));
}

async function sendEngagedPost(
  engagement: PageEngagement,
  account: { username: string; avatarUrl: string | null },
): Promise<void> {
  const tweet = readCachedTweet(engagement.tweet);
  if (tweet && tweet.postId === engagement.tweetId && !tweet.isReply) {
    await sendPayload(payloadFromCached(tweet, new Date().toISOString(), account.username, account.avatarUrl));
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
  });
}

async function sendObservation(
  observation: DomObservation,
  account: { username: string; avatarUrl: string | null },
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
      });
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
