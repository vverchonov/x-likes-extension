import { LIKED_POSTS_KEY, parseLikedPosts } from "../lib/history.ts";
import type { LikedPostPayload, MediaItem } from "../lib/types.ts";

export function mountTimeline(root: HTMLElement): void {
  void readLikedPosts().then((posts) => {
    renderPosts(root, posts);
  });
  watchLikedPosts(root);
}

async function readLikedPosts(): Promise<LikedPostPayload[]> {
  if (hasExtensionStorage()) {
    const stored = await chrome.storage.local.get(LIKED_POSTS_KEY);
    return parseLikedPosts(stored[LIKED_POSTS_KEY]);
  }
  return readPreviewPosts();
}

function watchLikedPosts(root: HTMLElement): void {
  if (hasExtensionStorage()) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !(LIKED_POSTS_KEY in changes)) return;
      renderPosts(root, parseLikedPosts(changes[LIKED_POSTS_KEY]?.newValue));
    });
    return;
  }

  window.addEventListener("storage", (event) => {
    if (event.key !== LIKED_POSTS_KEY) return;
    renderPosts(root, readPreviewPosts());
  });
}

function renderPosts(root: HTMLElement, posts: LikedPostPayload[]): void {
  root.replaceChildren();
  if (posts.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No likes yet";
    root.append(empty);
    return;
  }

  for (const post of posts) root.append(renderPost(post));
}

function renderPost(post: LikedPostPayload): HTMLElement {
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
  const account = document.createElement("span");
  account.className = "account";
  account.textContent = `@${post.username}`;
  const time = document.createElement("time");
  time.dateTime = post.likedAt;
  time.textContent = formatLikedAt(post.likedAt);
  who.append(account, time);
  const link = document.createElement("a");
  link.href = post.url;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = "View post";
  meta.append(who, link);
  article.append(meta);
  return article;
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

function readPreviewPosts(): LikedPostPayload[] {
  const raw = localStorage.getItem(LIKED_POSTS_KEY);
  if (!raw) return [];
  try {
    return parseLikedPosts(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

function hasExtensionStorage(): boolean {
  return typeof chrome !== "undefined" && Boolean(chrome.storage?.local);
}
