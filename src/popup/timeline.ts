import { parseLikesResponse } from "../lib/likes.ts";
import type { LikedPost, MediaItem } from "../lib/types.ts";

export function mountTimeline(root: HTMLElement): void {
  void refresh(root);
  if (!hasExtensionRuntime()) return;
  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (!message || typeof message !== "object") return;
    if ((message as { type?: unknown }).type !== "likes-changed") return;
    void refresh(root);
  });
}

let requestId = 0;

async function refresh(root: HTMLElement): Promise<void> {
  const id = ++requestId;
  if (root.childElementCount === 0) renderStatus(root, "Loading");

  const username = await signedInUsername();
  if (id !== requestId) return;
  if (!username) {
    renderStatus(root, "Open X to load likes");
    return;
  }

  const likes = await loadLikes(username);
  if (id !== requestId) return;
  if (!likes) {
    renderStatus(root, "Couldn't load likes");
    return;
  }
  renderPosts(root, likes);
}

async function signedInUsername(): Promise<string | null> {
  if (!hasExtensionTabs()) return null;
  const tabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
  const tab = tabs.find((item) => item.active) ?? tabs[0];
  if (tab?.id == null) return null;
  try {
    const response: unknown = await chrome.tabs.sendMessage(tab.id, { type: "current-username" });
    if (!response || typeof response !== "object") return null;
    const username = (response as { username?: unknown }).username;
    return typeof username === "string" && username.length > 0 ? username : null;
  } catch {
    return null;
  }
}

async function loadLikes(username: string): Promise<LikedPost[] | null> {
  if (!hasExtensionRuntime()) return null;
  const response: unknown = await chrome.runtime.sendMessage({ type: "load-likes", username });
  if (!response || typeof response !== "object") return null;
  const record = response as { ok?: unknown; likes?: unknown };
  if (record.ok !== true) return null;
  return parseLikesResponse({ likes: record.likes });
}

function renderPosts(root: HTMLElement, posts: LikedPost[]): void {
  root.replaceChildren();
  if (posts.length === 0) {
    renderStatus(root, "No likes yet");
    return;
  }

  for (const post of posts) root.append(renderPost(post));
}

function renderStatus(root: HTMLElement, text: string): void {
  root.replaceChildren();
  const empty = document.createElement("p");
  empty.className = "empty";
  empty.textContent = text;
  root.append(empty);
}

function renderPost(post: LikedPost): HTMLElement {
  const article = document.createElement("article");
  article.className = "post";

  if (post.text) {
    const text = document.createElement("p");
    text.className = "text";
    text.textContent = post.text;
    article.append(text);
  }

  if (post.media.length > 0) {
    const media = document.createElement("div");
    media.className = "media";
    for (const item of post.media) media.append(renderMedia(item));
    article.append(media);
  }

  const meta = document.createElement("div");
  meta.className = "meta";
  const who = document.createElement("div");
  who.className = "who";
  if (post.avatarUrl) {
    const avatar = document.createElement("img");
    avatar.className = "avatar";
    avatar.src = post.avatarUrl;
    avatar.alt = "";
    who.append(avatar);
  }
  const account = document.createElement("span");
  account.className = "account";
  account.textContent = `@${post.username}`;
  const time = document.createElement("time");
  time.dateTime = post.likedAt;
  time.textContent = formatLikedAt(post.likedAt);
  who.append(account, time);

  const links = document.createElement("div");
  links.className = "links";
  links.append(postLink(post.url, "View post"));
  if (post.coinUrl) links.append(postLink(post.coinUrl, "View coin"));

  meta.append(who, links);
  article.append(meta);
  return article;
}

function postLink(href: string, label: string): HTMLAnchorElement {
  const link = document.createElement("a");
  link.href = href;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = label;
  return link;
}

function renderMedia(item: MediaItem): HTMLElement {
  switch (item.type) {
    case "image": {
      const image = document.createElement("img");
      image.src = item.url;
      image.alt = "";
      return image;
    }
    case "video": {
      const video = document.createElement("video");
      video.src = item.url;
      video.controls = true;
      return video;
    }
    default: {
      const unreachable: never = item.type;
      throw new Error(`Unhandled media type: ${String(unreachable)}`);
    }
  }
}

function formatLikedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function hasExtensionRuntime(): boolean {
  return typeof chrome !== "undefined" && Boolean(chrome.runtime?.sendMessage);
}

function hasExtensionTabs(): boolean {
  return typeof chrome !== "undefined" && Boolean(chrome.tabs?.query) && Boolean(chrome.tabs?.sendMessage);
}
