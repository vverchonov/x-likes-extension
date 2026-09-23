import {
  type AccountEarning,
  type AccountRow,
  TEST_PAYOUT_BALANCE,
  canRequestPayout,
  earningsFor,
  formatPayout,
  parseLikesList,
} from "../lib/likes.ts";
import type { LikedPost, MediaItem } from "../lib/types.ts";

const TEST_USERNAME = "test";

type PayoutTarget = { username: string; balance: number; accounts: string[] };

let payoutAccount: PayoutTarget | null = null;
let claimSelection: PayoutTarget | null = null;
let accountRows: AccountRow[] = [];
let testMode = false;
let reload: ((force: boolean) => Promise<void>) | null = null;
let timelineRoot: HTMLElement | null = null;
let latestPosts: LikedPost[] = [];
let timelineMessage: string | null = "Loading";

export function homePayout(): PayoutTarget | null {
  if (testMode) {
    return {
      username: payoutAccount?.username ?? TEST_USERNAME,
      balance: TEST_PAYOUT_BALANCE,
      accounts: payoutAccount?.accounts.length ? payoutAccount.accounts : [TEST_USERNAME],
    };
  }
  return payoutAccount;
}

export function selectClaim(target: PayoutTarget): void {
  claimSelection = target;
}

export function currentPayout(): PayoutTarget | null {
  return claimSelection ?? homePayout();
}

let refreshTimer = 0;

export function refreshEarnings(): Promise<void> {
  window.clearTimeout(refreshTimer);
  return new Promise((resolve) => {
    refreshTimer = window.setTimeout(() => {
      void (reload?.(true) ?? Promise.resolve()).then(resolve);
    }, 50);
  });
}

export function clearEarnings(): void {
  payoutAccount = null;
  claimSelection = null;
  showPayout();
  renderAccounts([]);
}

export function setTestMode(enabled: boolean): void {
  testMode = enabled;
  showPayout();
  renderAccounts(accountRows);
  paintTimeline();
}

export function isTestMode(): boolean {
  return testMode;
}

export function mountTimeline(root: HTMLElement, refreshButton: HTMLButtonElement | null): void {
  timelineRoot = root;
  reload = (force) => refresh(root, refreshButton, force);
  void refresh(root, refreshButton, false);
  refreshButton?.addEventListener("click", () => {
    void refresh(root, refreshButton, true);
  });
}

let requestId = 0;

async function refresh(root: HTMLElement, refreshButton: HTMLButtonElement | null, force: boolean): Promise<void> {
  const id = ++requestId;
  if (refreshButton) refreshButton.disabled = true;
  if (force || root.childElementCount === 0) showTimelineMessage("Loading");

  try {
    const username = await signedInUsername();
    if (id !== requestId) return;
    const list = await loadLikes(username, force);
    if (id !== requestId) return;
    if (!list || !list.ok) {
      const saved = list?.accounts ?? [];
      const latest = saved.at(-1);
      payoutAccount = latest ? { username: latest, balance: 0, accounts: saved } : null;
      claimSelection = null;
      showPayout();
      renderAccounts(
        saved.map((username) => ({ username, balance: null })),
        list?.reason === "no-account" ? "No accounts yet" : "Couldn't load accounts",
      );
      showTimelineMessage(list?.reason === "no-account" ? "Open X to load likes" : "Couldn't load likes");
      return;
    }
    payoutAccount = { username: list.username, balance: list.balance, accounts: list.accounts };
    showPayout();
    renderAccounts(earningsFor(list.accounts, list.balances));
    showTimelinePosts(list.likes);
  } finally {
    if (id === requestId && refreshButton) refreshButton.disabled = false;
  }
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

async function loadLikes(username: string | null, force: boolean): Promise<LikesLoad | null> {
  if (!hasExtensionRuntime()) return null;
  const response: unknown = await chrome.runtime.sendMessage({ type: "load-likes", username, force });
  if (!response || typeof response !== "object") return null;
  const record = response as {
    ok?: unknown;
    reason?: unknown;
    username?: unknown;
    accounts?: unknown;
    balance?: unknown;
    balances?: unknown;
    likes?: unknown;
  };
  if (record.ok !== true) {
    return {
      ok: false,
      reason: record.reason === "no-account" ? "no-account" : "failed",
      accounts: stringList(record.accounts),
    };
  }
  if (typeof record.username !== "string" || !Array.isArray(record.accounts)) {
    return { ok: false, reason: "failed", accounts: stringList(record.accounts) };
  }
  const accounts = stringList(record.accounts);
  const list = parseLikesList({ balance: record.balance, balances: record.balances, likes: record.likes });
  return {
    ok: true,
    username: record.username,
    accounts,
    balance: list.balance,
    balances: list.balances,
    likes: list.likes,
  };
}

type LikesLoad =
  | { ok: true; username: string; accounts: string[]; balance: number; balances: AccountEarning[]; likes: LikedPost[] }
  | { ok: false; reason: "no-account" | "failed"; accounts: string[] };

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((account): account is string => typeof account === "string");
}

function showPayout(): void {
  renderPayout(currentPayout()?.balance ?? 0);
}

function renderPayout(balance: number): void {
  const amount = document.querySelector("#payout-balance");
  const button = document.querySelector("#payout-button");
  const minimum = document.querySelector("#payout-minimum");
  if (amount) amount.textContent = formatPayout(balance);
  const allowed = canRequestPayout(balance);
  if (button instanceof HTMLButtonElement) {
    button.hidden = !allowed;
    button.disabled = !allowed;
  }
  if (minimum instanceof HTMLElement) minimum.hidden = allowed;
}

function shownAccounts(rows: AccountRow[]): AccountRow[] {
  if (!testMode) return rows;
  const source = rows.length > 0 ? rows : [{ username: TEST_USERNAME, balance: null }];
  return source.map((row) => ({
    username: row.username,
    balance: row.balance != null && canRequestPayout(row.balance) ? row.balance : TEST_PAYOUT_BALANCE,
  }));
}

function renderAccounts(rows: AccountRow[], emptyText = "No accounts yet"): void {
  accountRows = rows;
  const shown = shownAccounts(rows);
  const list = document.querySelector("#accounts-list");
  if (!(list instanceof HTMLElement)) return;
  list.replaceChildren();
  if (shown.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = emptyText;
    list.append(empty);
    return;
  }
  for (const row of shown) list.append(renderAccount(row));
}

function renderAccount(row: AccountRow): HTMLElement {
  const article = document.createElement("article");
  article.className = "account-row";

  const main = document.createElement("div");
  main.className = "account-main";
  const name = document.createElement("p");
  name.className = "label";
  name.textContent = `@${row.username}`;
  const amount = document.createElement("p");
  amount.className = "account-balance";
  amount.textContent = row.balance == null ? "-" : formatPayout(row.balance);
  main.append(name, amount);

  const actions = document.createElement("div");
  actions.className = "account-actions";
  if (row.balance != null && canRequestPayout(row.balance)) {
    const claim = document.createElement("button");
    claim.type = "button";
    claim.className = "payout-button";
    claim.dataset.action = "claim";
    claim.dataset.username = row.username;
    claim.dataset.balance = String(row.balance);
    claim.textContent = "Claim";
    actions.append(claim);
  } else if (row.balance != null) {
    const minimum = document.createElement("p");
    minimum.className = "payout-minimum";
    minimum.textContent = "Payouts from $5+";
    actions.append(minimum);
  }

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "remove-account";
  remove.dataset.action = "remove";
  remove.dataset.username = row.username;
  remove.setAttribute("aria-label", `Remove @${row.username}`);
  remove.innerHTML =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
  actions.append(remove);
  article.append(main, actions);
  return article;
}

type PostPreview = {
  post: LikedPost;
  imagePlaceholder: boolean;
  contentPlaceholder: boolean;
};

const TEST_POSTS: PostPreview[] = [
  {
    imagePlaceholder: true,
    contentPlaceholder: false,
    post: {
      postId: "test-coin",
      username: TEST_USERNAME,
      avatarUrl: null,
      text: "Liked a post that created a coin",
      media: [],
      url: "https://x.com/i/status/1",
      likedAt: "2026-09-23T18:00:00.000Z",
      coinUrl: "https://pump.fun/coin/test",
      earning: 18.4,
    },
  },
  {
    imagePlaceholder: false,
    contentPlaceholder: false,
    post: {
      postId: "test-no-earning",
      username: TEST_USERNAME,
      avatarUrl: null,
      text: "Liked a post with a coin and no earnings",
      media: [],
      url: "https://x.com/i/status/2",
      likedAt: "2026-09-23T17:00:00.000Z",
      coinUrl: "https://pump.fun/coin/quiet",
      earning: null,
    },
  },
  {
    imagePlaceholder: true,
    contentPlaceholder: true,
    post: {
      postId: "test-no-coin",
      username: TEST_USERNAME,
      avatarUrl: null,
      text: null,
      media: [],
      url: "https://x.com/i/status/3",
      likedAt: "2026-09-23T16:00:00.000Z",
      coinUrl: null,
      earning: null,
    },
  },
];

function showTimelinePosts(posts: LikedPost[]): void {
  latestPosts = posts;
  timelineMessage = posts.length === 0 ? "No likes yet" : null;
  paintTimeline();
}

function showTimelineMessage(text: string): void {
  latestPosts = [];
  timelineMessage = text;
  paintTimeline();
}

function paintTimeline(): void {
  if (!timelineRoot) return;
  if (!testMode && timelineMessage) {
    renderStatus(timelineRoot, timelineMessage);
    return;
  }
  timelineRoot.replaceChildren();
  if (testMode) {
    for (const preview of TEST_POSTS) {
      timelineRoot.append(renderPost(preview.post, preview.imagePlaceholder, preview.contentPlaceholder));
    }
    return;
  }
  for (const post of latestPosts) timelineRoot.append(renderPost(post, false, false));
}

function renderStatus(root: HTMLElement, text: string): void {
  root.replaceChildren();
  const empty = document.createElement("p");
  empty.className = "empty";
  empty.textContent = text;
  root.append(empty);
}

function renderPost(post: LikedPost, imagePlaceholder: boolean, contentPlaceholder: boolean): HTMLElement {
  const article = document.createElement("article");
  article.className = "post";

  if (contentPlaceholder) {
    article.append(contentSlot());
  } else if (post.text) {
    const text = document.createElement("p");
    text.className = "text";
    text.textContent = post.text;
    article.append(text);
  }

  if (imagePlaceholder) {
    article.append(imageSlot());
  } else if (post.media.length > 0) {
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
  links.append(postLink(post.url, "view post"));
  if (post.coinUrl) links.append(postLink(post.coinUrl, "view coin"));
  if (post.coinUrl && post.earning != null) links.append(earningLabel(post.earning));

  meta.append(who, links);
  article.append(meta);
  return article;
}

function imageSlot(): HTMLElement {
  const slot = document.createElement("div");
  slot.className = "image-placeholder";
  slot.setAttribute("role", "img");
  slot.setAttribute("aria-label", "Image");
  slot.innerHTML =
    '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path fill="currentColor" d="M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>';
  return slot;
}

function contentSlot(): HTMLElement {
  const slot = document.createElement("div");
  slot.className = "content-placeholder";
  slot.setAttribute("aria-label", "Post content");
  for (let index = 0; index < 3; index += 1) {
    slot.append(document.createElement("span"));
  }
  return slot;
}

function earningLabel(amount: number): HTMLElement {
  const earning = document.createElement("span");
  earning.className = "coin-earning";
  earning.textContent = `earned ${formatPayout(amount)}`;
  return earning;
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
