import { WEBSITE_URL } from "../config.ts";
import { isLikedUsername } from "../lib/accounts.ts";
import { stripTrailingMediaLinks } from "../lib/extract.ts";
import { type AccountStatistics, type AccountVerification, type Balances, type Claim, type ClaimHistory, type EventRow, type LaunchCapacity, type TrackedAccount, formatSol, formatUsd, parseAccountStatistics, parseBalances, parseClaim, parseClaimHistory, parseEvents, parseLaunchCapacity, parseVerification, trackedAccounts } from "../lib/private-data.ts";

type Selection = { xUserIds: string[]; balance: string };
type Snapshot = { accounts: TrackedAccount[]; events: EventRow[] | null; nextCursor: string | null; balances: Balances | null; capacity: LaunchCapacity[] | null; statistics: AccountStatistics[] | null; verification: AccountVerification[] | null };
const verificationNotes = new Map<string, string>();

let snapshot: Snapshot | null = null;
let claim: Claim | null = null;
let claims: ClaimHistory[] = [];
let claimCursor: string | null = null;
let claimRefreshId = 0;
let claimLoading = false;
let refreshId = 0;
let activeRefreshes = 0;
let refreshPending = false;
let cursor: string | null = null;
let historyLoading = false;
let historyError = false;
let feedObserver: IntersectionObserver | null = null;
let selected: Selection | null = null;
const forcing = new Set<string>();
const forceErrors = new Map<string, string>();

export function noteVerification(xUserId: string, message: string): void {
  if (message) verificationNotes.set(xUserId, message);
  else verificationNotes.delete(xUserId);
}
export function currentSelection(): Selection | null { return selected; }
export function allAccountsSelection(): Selection | null {
  if (!snapshot?.balances || snapshot.balances.accounts.length !== snapshot.accounts.length || !snapshot.balances.claimEligibility.available || snapshot.balances.accounts.some((account) => account.paused)) return null;
  return { xUserIds: snapshot.accounts.map((account) => account.xUserId), balance: snapshot.balances.combined.availableLamports };
}
export function rowSelection(id: string): Selection | null {
  const account = snapshot?.balances?.accounts.find((entry) => entry.xUserId === id);
  const eligibility = snapshot?.balances?.claimEligibility;
  if (!account || account.paused || !eligibility || eligibility.reason === "quote_unavailable" || eligibility.reason === "quote_stale" || !meetsMinimum(account.availableLamports, eligibility.solUsd)) return null;
  return { xUserIds: [id], balance: account.availableLamports };
}
function meetsMinimum(lamports: string, price: string | null): boolean {
  const product = usdProduct(lamports, price);
  return product !== null && product >= 5n * 10n ** 18n;
}

function aboveMinimum(lamports: string, price: string | null): boolean {
  const product = usdProduct(lamports, price);
  return product !== null && product > 5n * 10n ** 18n;
}

function usdProduct(lamports: string, price: string | null): bigint | null {
  if (!price || !/^\d+(?:\.\d{1,9})?$/.test(price)) return null;
  const [whole = "0", decimal = ""] = price.split(".");
  return BigInt(lamports) * BigInt(whole + decimal.padEnd(9, "0"));
}
export function selectClaim(selection: Selection): void { selected = selection; }
export function lastClaim(): Claim | null { return claim; }
export function setClaim(next: Claim): void { claim = next; paintClaims(); }
export function clearClaimHistory(): void {
  claimRefreshId++;
  claim = null;
  claims = [];
  claimCursor = null;
  claimLoading = false;
  paintClaims();
  paintClaimMore();
  claimMessage("");
}

export function revealFeed(): void {
  requestAnimationFrame(() => { watchFeedEnd(); });
}

export function mountPrivateView(): void {
  chrome.runtime.onMessage.addListener((message: unknown, sender) => {
    if (sender.id !== chrome.runtime.id || sender.tab || !message || typeof message !== "object" ||
        (message as { type?: unknown }).type !== "observation-delivered") return;
    refreshAfterDelivery();
  });
  document.querySelector("#refresh")?.addEventListener("click", () => {
    void refreshPrivateView(true);
    void refreshClaimHistory().then(() => refreshClaimStatus());
  });
  document.querySelector("#activity-more")?.addEventListener("click", () => { void loadMoreClaims(); });
  void refreshPrivateView(true);
  void refreshClaimHistory().then(() => refreshClaimStatus());
  window.setInterval(() => { if (claim && (claim.status === "pending" || claim.status === "held")) void refreshClaimStatus(); }, 15_000);
  window.setInterval(() => {
    const feed = document.querySelector("#home");
    const accounts = document.querySelector("#accounts");
    if (!document.hidden && ((feed instanceof HTMLElement && !feed.hidden) || (accounts instanceof HTMLElement && !accounts.hidden))) void refreshPrivateView(true, true);
  }, 30_000);
}

function refreshAfterDelivery(): void {
  if (activeRefreshes) {
    refreshPending = true;
    return;
  }
  void refreshPrivateView(true, snapshot !== null);
}

export async function refreshPrivateView(force: boolean, quiet = false): Promise<void> {
  if (quiet && (activeRefreshes || !snapshot)) return;
  const id = ++refreshId;
  const oldestVisibleId = quiet ? snapshot?.events?.at(-1)?.id : undefined;
  const timeline = document.querySelector("#timeline");
  const accounts = document.querySelector("#accounts-list");
  const refresh = document.querySelector("#refresh");
  if (!(timeline instanceof HTMLElement) || !(accounts instanceof HTMLElement)) return;
  activeRefreshes++;
  if (!quiet) {
    historyError = false;
    if (refresh instanceof HTMLButtonElement) refresh.disabled = true;
    paintMessage(timeline, "Loading history…");
    paintMessage(accounts, "Loading accounts…");
  }
  try {
    const result: unknown = await chrome.runtime.sendMessage({ type: "load-private-data", force });
    if (id !== refreshId) return;
    if (!result || typeof result !== "object") throw new Error("Invalid response");
    const response = result as { ok?: unknown; reason?: unknown; data?: unknown; accounts?: unknown };
    if (response.ok !== true) {
      if (quiet) return;
      snapshot = null;
      cursor = null;
      selected = null;
      const saved = trackedAccounts(response.accounts);
      paintMessage(timeline, response.reason === "no-account" ? "Open X to load engagements" : "Failed to load");
      paintMessage(accounts, response.reason === "no-account" ? "No accounts yet" : "Couldn't load accounts or balances");
      if (saved.length) paintAccounts(saved, null);
      paintAllAccounts();
      return;
    }
    const data = response.data as Partial<Snapshot>;
    const accountsList = trackedAccounts(data.accounts);
    if (!accountsList.length) throw new Error("Invalid accounts");
    const history = data.events === null ? null : parseEvents(data);
    const balances = data.balances === null ? null : parseBalances(data.balances);
    const capacity = data.capacity == null ? null : parseLaunchCapacity({ accounts: data.capacity });
    const statistics = data.statistics == null ? null : parseAccountStatistics({ accounts: data.statistics });
    const verification = data.verification == null ? null : parseVerification({ accounts: data.verification });
    if (quiet && !history && !balances && !capacity && !statistics && !verification) return;
    if (quiet && history) {
      while (history.nextCursor && oldestVisibleId && !history.events.some((event) => event.id === oldestVisibleId)) {
        const page: unknown = await chrome.runtime.sendMessage({ type: "history-next", cursor: history.nextCursor });
        if (!page || typeof page !== "object" || (page as { ok?: unknown }).ok !== true) return;
        const next = parseEvents(page);
        history.events.push(...next.events);
        history.nextCursor = next.nextCursor;
      }
    }
    if (id !== refreshId) return;
    const previous = snapshot;
    const events = history?.events ?? (quiet ? previous?.events ?? null : null);
    snapshot = { accounts: accountsList, events, nextCursor: history?.nextCursor ?? (quiet ? previous?.nextCursor ?? null : null), balances: quiet ? balances ?? previous?.balances ?? null : balances, capacity: quiet ? capacity ?? previous?.capacity ?? null : capacity, statistics: quiet ? statistics ?? previous?.statistics ?? null : statistics, verification: quiet ? verification ?? previous?.verification ?? null : verification };
    cursor = snapshot.nextCursor;
    if (!quiet) selected = null;
    paintAllAccounts();
    paintAccounts(accountsList, snapshot.balances);
    if (!quiet || JSON.stringify(previous?.events) !== JSON.stringify(events) || previous?.balances?.claimEligibility.solUsd !== snapshot.balances?.claimEligibility.solUsd) paintHistory(events);
  } catch {
    if (id !== refreshId) return;
    if (quiet) return;
    snapshot = null;
    cursor = null;
    paintMessage(timeline, "Failed to load");
    paintMessage(accounts, "Couldn't load accounts or balances");
    paintAllAccounts();
  } finally {
    activeRefreshes--;
    if (id === refreshId && !quiet && refresh instanceof HTMLButtonElement) refresh.disabled = false;
    if (!activeRefreshes && refreshPending) {
      refreshPending = false;
      refreshAfterDelivery();
    }
  }
}

function paintMessage(root: Element, message: string): void {
  const empty = document.createElement("p");
  empty.className = "empty";
  empty.textContent = message;
  root.replaceChildren(empty);
}

const MINIMUM_HINT = "Minimum > $5";

function setMinimumHint(button: HTMLButtonElement, show: boolean): void {
  const wrap = button.parentElement;
  if (!(wrap instanceof HTMLElement)) return;
  if (show) wrap.dataset.hint = MINIMUM_HINT;
  else delete wrap.dataset.hint;
}

function isAccountMinimumBlock(amount: { paused: boolean; availableLamports: string } | undefined, balances: Balances | null): boolean {
  if (amount?.paused || !amount || !balances?.claimEligibility.solUsd) return false;
  const reason = balances.claimEligibility.reason;
  return reason !== "quote_unavailable" && reason !== "quote_stale";
}

function isCombinedMinimumBlock(balances: Balances | null): boolean {
  if (!balances?.claimEligibility.solUsd || balances.accounts.some((account) => account.paused)) return false;
  const reason = balances.claimEligibility.reason;
  return reason !== "quote_unavailable" && reason !== "quote_stale";
}

function availableUsd(lamports: string, quote: string | null): string {
  const usd = formatUsd(lamports, quote);
  return usd ? `${usd} available` : "USD unavailable";
}

function accountClaimLabel(amount: { paused: boolean; availableLamports: string } | undefined, balances: Balances | null): string {
  if (amount?.paused) return "Claims paused";
  if (!amount) return "Balance unavailable";
  if (balances?.claimEligibility.reason === "quote_unavailable") return "SOL price unavailable";
  if (balances?.claimEligibility.reason === "quote_stale") return "Updating SOL price";
  if (balances?.claimEligibility.solUsd) return "Claim";
  return balances ? eligibilityText(balances) : "Balance unavailable";
}

function eligibilityText(balances: Balances): string {
  if (balances.claimEligibility.reason === "disputed") return "Claims paused by dispute";
  if (balances.claimEligibility.reason === "unauthorized") return "Claim unauthorized";
  if (balances.claimEligibility.available) return "Eligible to claim";
  switch (balances.claimEligibility.reason) {
    case "below_minimum": return "Claim";
    case "quote_unavailable": return "SOL price unavailable; try later";
    case "quote_stale": return "Updating SOL price; try soon";
    default: return "Claim unavailable";
  }
}

function paintAllAccounts(): void {
  const balance = document.querySelector("#accounts-total");
  const button = document.querySelector("#claim-all");
  const balances = snapshot?.balances ?? null;
  if (balance) balance.textContent = balances ? availableUsd(balances.combined.availableLamports, balances.claimEligibility.solUsd) : "– USD";
  if (!(button instanceof HTMLButtonElement)) return;
  const canClaim = Boolean(allAccountsSelection() && balances && aboveMinimum(balances.combined.availableLamports, balances.claimEligibility.solUsd));
  button.disabled = !canClaim;
  button.textContent = canClaim || isCombinedMinimumBlock(balances) ? "Claim all" : combinedClaimLabel(balances);
  setMinimumHint(button, !canClaim && isCombinedMinimumBlock(balances));
}

function combinedClaimLabel(balances: Balances | null): string {
  if (!balances) return "Balances unavailable";
  if (balances.accounts.some((account) => account.paused)) return "Claims paused";
  if (balances.claimEligibility.reason === "quote_unavailable") return "SOL price unavailable";
  if (balances.claimEligibility.reason === "quote_stale") return "Updating SOL price";
  if (balances.claimEligibility.solUsd) return "Claim all";
  return eligibilityText(balances);
}

function paintAccounts(accounts: TrackedAccount[], balances: Balances | null): void {
  const root = document.querySelector("#accounts-list");
  if (!(root instanceof HTMLElement)) return;
  const scroll = root.scrollTop;
  root.replaceChildren();
  for (const account of accounts) {
    const amount = balances?.accounts.find((entry) => entry.xUserId === account.xUserId);
    const article = document.createElement("article");
    article.className = "account-row";
    const main = document.createElement("div");
    main.className = "account-main";
    const heading = document.createElement("div");
    heading.className = "account-name";
    const name = document.createElement("a");
    name.className = "label account-profile";
    name.href = new URL(`/creators/id/${account.xUserId}`, WEBSITE_URL).href;
    name.target = "_blank";
    name.rel = "noreferrer";
    name.textContent = `@${account.username}`;
    const verification = snapshot?.verification?.find((entry) => entry.xUserId === account.xUserId)?.status;
    heading.append(name);
    if (verification === "self") heading.append(verifiedBadge());
    const balance = document.createElement("p");
    balance.className = "account-balance";
    balance.textContent = amount ? availableUsd(amount.availableLamports, balances?.claimEligibility.solUsd ?? null) : "– USD";
    const quota = snapshot?.capacity?.find((entry) => entry.xUserId === account.xUserId);
    const statistics = snapshot?.statistics?.find((entry) => entry.xUserId === account.xUserId);
    const facts = document.createElement("dl");
    facts.className = "account-facts";
    appendAccountFact(facts, quota ? `${quota.used}/${quota.limit}` : "–", "Limits");
    appendAccountFact(facts, statistics ? statistics.engagements.toLocaleString() : "–", "Actions");
    appendAccountFact(facts, statistics ? statistics.tokensCreated.toLocaleString() : "–", "Coins");
    const note = verificationNotes.get(account.xUserId);
    const status = document.createElement("p");
    status.className = "account-verification";
    status.textContent = note ?? "";
    main.append(heading, ...(note ? [status] : []), balance, facts);
    const actions = document.createElement("div");
    actions.className = "account-actions";
    if (verification === "none") {
      const verifyButton = document.createElement("button");
      verifyButton.className = "payout-button account-verify";
      verifyButton.type = "button";
      verifyButton.dataset.action = "verify";
      verifyButton.dataset.xUserId = account.xUserId;
      verifyButton.textContent = "Verify";
      actions.append(verifyButton);
    }
    const claimButton = document.createElement("button");
    claimButton.className = "payout-button account-claim";
    claimButton.type = "button";
    claimButton.dataset.action = "claim";
    claimButton.dataset.xUserId = account.xUserId;
    const canClaim = Boolean(amount && rowSelection(account.xUserId) && aboveMinimum(amount.availableLamports, balances?.claimEligibility.solUsd ?? null));
    claimButton.disabled = !canClaim;
    const minimumBlocked = !canClaim && isAccountMinimumBlock(amount, balances);
    claimButton.textContent = canClaim || minimumBlocked ? "Claim" : accountClaimLabel(amount, balances);
    const wrap = document.createElement("span");
    wrap.className = "claim-wrap";
    wrap.append(claimButton);
    setMinimumHint(claimButton, minimumBlocked);
    actions.append(wrap);
    article.append(main, actions);
    root.append(article);
  }
  root.scrollTop = scroll;
}

function verifiedBadge(): HTMLElement {
  const badge = document.createElement("span");
  badge.className = "verified-badge";
  badge.setAttribute("role", "img");
  badge.setAttribute("aria-label", "Verified");
  badge.innerHTML = `<svg viewBox="0 0 22 22" aria-hidden="true"><path fill="currentColor" d="M20.396 11c-.018-.646-.215-1.275-.57-1.816-.354-.54-.852-.972-1.438-1.246.223-.607.27-1.264.14-1.897-.131-.634-.437-1.218-.882-1.687-.47-.445-1.053-.75-1.687-.882-.633-.13-1.29-.083-1.897.14-.273-.587-.704-1.086-1.245-1.44S11.647 1.62 11 1.604c-.646.017-1.273.213-1.813.568s-.969.854-1.24 1.44c-.608-.223-1.267-.272-1.902-.14-.635.13-1.22.436-1.69.882-.445.47-.749 1.055-.878 1.688-.13.633-.08 1.29.144 1.896-.587.274-1.087.705-1.443 1.245-.356.54-.555 1.17-.574 1.817.02.647.218 1.276.574 1.817.356.54.856.972 1.443 1.245-.224.606-.274 1.263-.144 1.896.13.634.433 1.218.877 1.688.47.443 1.054.747 1.687.878.633.132 1.29.084 1.897-.136.274.586.705 1.084 1.246 1.439.54.354 1.17.551 1.816.569.647-.016 1.276-.213 1.817-.567s.972-.854 1.245-1.44c.604.239 1.266.296 1.903.164.636-.132 1.22-.447 1.68-.907.46-.46.776-1.044.908-1.681s.075-1.299-.165-1.903c.586-.274 1.084-.705 1.439-1.246.354-.54.551-1.17.569-1.816zM9.662 14.85l-3.429-3.428 1.293-1.302 2.072 2.072 4.4-4.794 1.347 1.246z"></path></svg>`;
  return badge;
}

function appendAccountFact(list: HTMLDListElement, value: string, label: string): void {
  const item = document.createElement("div");
  const amount = document.createElement("dd");
  amount.textContent = value;
  const caption = document.createElement("dt");
  caption.textContent = label;
  item.append(amount, caption);
  list.append(item);
}

function paintHistory(events: EventRow[] | null): void {
  feedObserver?.disconnect();
  const root = document.querySelector("#timeline");
  if (!(root instanceof HTMLElement)) return;
  const scroll = root.scrollTop;
  root.replaceChildren();
  if (!events?.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = events === null ? "Failed to load" : "No engagements yet";
    root.append(empty);
  }
  if (events === null) return;
  for (const event of events) {
    const article = document.createElement("article");
    article.className = "post";
    article.dataset.eventId = event.id;
    const visibleText = event.text ? stripTrailingMediaLinks(event.text, event.media.length) : null;
    if (visibleText) { const text = document.createElement("p"); text.className = "text"; text.textContent = visibleText; article.append(text); }
    if (event.media.length) {
      const media = document.createElement("div");
      media.className = "media";
      for (const item of event.media) {
        const element = document.createElement(item.type === "image" ? "img" : "video");
        element.src = item.url;
        if (element instanceof HTMLVideoElement) element.controls = true;
        media.append(element);
      }
      article.append(media);
    }
    const meta = document.createElement("div");
    meta.className = "meta";
    const time = document.createElement("time");
    time.dateTime = event.likedAt;
    const date = new Date(event.likedAt);
    time.textContent = Number.isNaN(date.getTime()) ? event.likedAt : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
    meta.append(time);
    const links = document.createElement("div");
    links.className = "links";
    const link = document.createElement("a");
    link.href = event.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = "view post";
    links.append(link);
    const quota = forceQuota(event);
    if (quota || forcing.has(event.id)) {
      const limitReached = quota != null && quota.used >= quota.limit && !forcing.has(event.id);
      const wrap = document.createElement("span");
      wrap.className = "force-create-wrap";
      if (limitReached) wrap.title = "This hour's coin limit is reached. Try again later.";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "force-create";
      button.textContent = forcing.has(event.id) ? "Creating coin…" : "Create coin anyway";
      button.disabled = forcing.has(event.id) || limitReached;
      button.addEventListener("click", () => { void forceCreate(event.id); });
      wrap.append(button);
      links.append(wrap);
    }
    if (event.tokenUrl) {
      const token = link.cloneNode() as HTMLAnchorElement;
      token.href = event.tokenUrl;
      token.textContent = "view coin";
      links.append(token);
      if (event.creatorEarningsLamports !== null) {
        const earning = document.createElement("span");
        earning.className = "coin-earning";
        earning.textContent = `Attributed coin rewards: ${formatUsd(event.creatorEarningsLamports, snapshot?.balances?.claimEligibility.solUsd ?? null) ?? formatSol(event.creatorEarningsLamports)}`;
        earning.title = "Attributed rewards may not be claimable by this key";
        links.append(earning);
      }
    }
    meta.append(links);
    const statusText = activityStatus(event.processingStatus);
    if (statusText) {
      const status = document.createElement("p");
      status.className = "activity-status";
      status.textContent = statusText;
      meta.append(status);
    }
    const message = forceErrors.get(event.id);
    if (message) {
      const error = document.createElement("p");
      error.className = "activity-status";
      error.textContent = message;
      meta.append(error);
    }
    article.append(meta);
    if (event.avatarUrl && isLikedUsername(event.username)) {
      const profile = document.createElement("a");
      profile.className = "liker";
      profile.href = `https://x.com/${event.username}`;
      profile.target = "_blank";
      profile.rel = "noreferrer";
      profile.title = `@${event.username}`;
      const avatar = document.createElement("img");
      avatar.className = "avatar";
      avatar.src = event.avatarUrl;
      avatar.alt = "";
      profile.append(avatar);
      article.append(profile);
    }
    root.append(article);
  }
  paintFeedMore(root);
  root.scrollTop = scroll;
  watchFeedEnd();
}

function watchFeedEnd(): void {
  feedObserver?.disconnect();
  if (!cursor || historyLoading || historyError) return;
  const timeline = document.querySelector("#timeline");
  const last = timeline?.querySelector(".post:last-of-type");
  if (!(timeline instanceof HTMLElement) || !(last instanceof HTMLElement)) return;
  if (!feedObserver) {
    feedObserver = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    }, { root: timeline, threshold: 0.01 });
  }
  feedObserver.observe(last);
}

function paintFeedMore(root: HTMLElement): void {
  if (!cursor || (!historyLoading && !historyError)) return;
  const more = document.createElement("p");
  more.className = "feed-more";
  more.textContent = historyLoading ? "Loading…" : "Couldn't load more";
  if (historyError) {
    more.tabIndex = 0;
    more.setAttribute("role", "button");
    more.addEventListener("click", () => { void loadMore(); });
  }
  root.append(more);
}

function forceQuota(event: EventRow): { used: number; limit: number } | null {
  if (!event.canForceCreate || event.processingStatus !== "rejected" || !event.intentId) return null;
  const quota = snapshot?.capacity?.find((entry) => entry.xUserId === event.xUserId);
  return quota ?? null;
}

function canOfferForce(event: EventRow): boolean {
  const quota = forceQuota(event);
  return quota != null && quota.used < quota.limit;
}

async function forceCreate(eventId: string): Promise<void> {
  const events = snapshot?.events;
  if (forcing.has(eventId) || !events?.some((event) => event.id === eventId && canOfferForce(event))) return;
  forcing.add(eventId);
  forceErrors.delete(eventId);
  const anchor = timelineAnchor();
  paintHistory(events);
  restoreTimelineAnchor(anchor);
  try {
    const response: unknown = await chrome.runtime.sendMessage({ type: "force-create", eventId });
    const result = response && typeof response === "object" ? response as { ok?: unknown; reason?: unknown } : null;
    if (!result || result.ok !== true) {
      const reason = result?.reason;
      forceErrors.set(eventId, reason === "capacity" ? "This account is at its coin limit for this hour." : reason === "conflict" ? "This post can't be forced into a coin." : "Couldn't create the coin. Try again.");
      return;
    }
    if (activeRefreshes) refreshPending = true;
    else await refreshPrivateView(true, true);
  } catch {
    forceErrors.set(eventId, "Couldn't create the coin. Try again.");
  } finally {
    forcing.delete(eventId);
    if (snapshot?.events) paintHistory(snapshot.events);
    restoreTimelineAnchor(anchor);
  }
}

function timelineAnchor(): { id: string; offset: number } | null {
  const root = document.querySelector("#timeline");
  if (!(root instanceof HTMLElement)) return null;
  const top = root.getBoundingClientRect().top;
  const posts = [...root.querySelectorAll<HTMLElement>(".post")];
  const current = posts.find((post) => post.getBoundingClientRect().bottom > top + 1);
  const id = current?.dataset.eventId;
  if (!current || !id) return null;
  return { id, offset: current.getBoundingClientRect().top - top };
}

function restoreTimelineAnchor(anchor: { id: string; offset: number } | null): void {
  if (!anchor) return;
  const root = document.querySelector("#timeline");
  const post = root?.querySelector<HTMLElement>(`[data-event-id="${CSS.escape(anchor.id)}"]`);
  if (!(root instanceof HTMLElement) || !post) return;
  root.scrollTop += post.getBoundingClientRect().top - root.getBoundingClientRect().top - anchor.offset;
}

function activityStatus(status: EventRow["processingStatus"]): string | null {
  switch (status) {
    case "finalized": return null;
    case "already_claimed": return "Someone already submitted this post for a coin.";
    case "rejected": return "This post wasn't selected for a coin.";
    case "failed": return "We couldn't create a coin for this post.";
    case "deferred": return "Recorded; waiting for launch capacity.";
    case "pending":
    case "grounding":
    case "filtering":
    case "generating":
    case "ready":
    case "sending":
    case "unresolved": return "Pending";
    default: return "Status unavailable";
  }
}

async function loadMore(): Promise<void> {
  const page = cursor;
  if (!page || !snapshot || historyLoading) return;
  const requestedRefresh = refreshId;
  historyLoading = true;
  historyError = false;
  feedObserver?.disconnect();
  const timeline = document.querySelector("#timeline");
  if (timeline instanceof HTMLElement && snapshot.events) {
    timeline.querySelector(".feed-more")?.remove();
    paintFeedMore(timeline);
  }
  try {
    const response: unknown = await chrome.runtime.sendMessage({ type: "history-next", cursor: page });
    if (!snapshot || refreshId !== requestedRefresh || cursor !== page || !response || typeof response !== "object" || (response as { ok?: unknown }).ok !== true) throw new Error("History unavailable");
    const history = parseEvents(response);
    if (!snapshot.events) throw new Error("History unavailable");
    snapshot.events.push(...history.events);
    cursor = history.nextCursor;
    snapshot.nextCursor = history.nextCursor;
    historyLoading = false;
    paintHistory(snapshot.events);
  } catch {
    if (refreshId === requestedRefresh && cursor === page) {
      historyLoading = false;
      historyError = true;
      const root = document.querySelector("#timeline");
      if (root instanceof HTMLElement) {
        root.querySelector(".feed-more")?.remove();
        paintFeedMore(root);
      }
    }
  } finally {
    if (refreshId === requestedRefresh) historyLoading = false;
  }
}

function claimMessage(message: string): void {
  const error = document.querySelector("#activity-refresh-error");
  if (!(error instanceof HTMLElement)) return;
  error.textContent = message;
  error.hidden = !message;
}

export async function refreshClaimHistory(): Promise<void> {
  const id = ++claimRefreshId;
  claimLoading = true;
  claimMessage("");
  paintClaimMore();
  if (!claims.length) {
    const root = document.querySelector("#activity-list");
    if (root instanceof HTMLElement && !claim) paintMessage(root, "Loading claims…");
  }
  try {
    const response: unknown = await chrome.runtime.sendMessage({ type: "claim-history" });
    if (!response || typeof response !== "object" || (response as { ok?: unknown }).ok !== true) throw new Error("Claim activity unavailable");
    const page = parseClaimHistory(response);
    if (id !== claimRefreshId) return;
    claims = page.claims;
    claim = claims.find((item) => item.status === "pending" || item.status === "held") ?? claims[0] ?? null;
    claimCursor = page.nextCursor;
    paintClaims();
  } catch {
    if (id === claimRefreshId) {
      if (claim || claims.length) paintClaims();
      else {
        const root = document.querySelector("#activity-list");
        if (root instanceof HTMLElement) paintMessage(root, "Failed to load");
      }
      claimMessage(claim || claims.length ? "Couldn't load claim activity. Showing the last known data." : "");
    }
  } finally {
    if (id === claimRefreshId) { claimLoading = false; paintClaimMore(); }
  }
}

async function loadMoreClaims(): Promise<void> {
  const cursor = claimCursor;
  if (!cursor || claimLoading) return;
  const id = claimRefreshId;
  claimLoading = true;
  claimMessage("");
  paintClaimMore();
  try {
    const response: unknown = await chrome.runtime.sendMessage({ type: "claim-history", cursor });
    if (!response || typeof response !== "object" || (response as { ok?: unknown }).ok !== true) throw new Error("Claim activity unavailable");
    const page = parseClaimHistory(response);
    if (id !== claimRefreshId) return;
    for (const item of page.claims) {
      const index = claims.findIndex((existing) => existing.id === item.id);
      if (index === -1) claims.push(item);
      else if (claims[index]!.status === item.status) claims[index] = item;
    }
    claimCursor = page.nextCursor;
    paintClaims();
  } catch {
    if (id === claimRefreshId) claimMessage("Couldn't load older claims. Try again.");
  } finally {
    if (id === claimRefreshId) { claimLoading = false; paintClaimMore(); }
  }
}

function isTransactionSignature(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(value);
}

function paintClaimMore(): void {
  const more = document.querySelector("#activity-more");
  if (!(more instanceof HTMLButtonElement)) return;
  more.hidden = !claimCursor;
  more.disabled = claimLoading;
  more.textContent = claimLoading ? "Loading…" : "Load more";
}

function paintClaims(): void {
  const root = document.querySelector("#activity-list");
  if (!(root instanceof HTMLElement)) return;
  root.replaceChildren();
  const current = claim;
  const recent = current && !claims.some((item) => item.id === current.id) ? current : null;
  const shown: (Claim | ClaimHistory)[] = recent ? [recent, ...claims] : claims;
  if (!shown.length) { paintMessage(root, "No claims yet"); return; }
  const details: Record<Claim["status"], string> = {
    pending: "Your claim is being processed. Payment is not confirmed yet.",
    held: "Your claim is on hold. Payment is not confirmed yet.",
    confirmed: "Your claim has been paid to this wallet.",
    failed: "This claim failed. No payment was confirmed.",
    canceled: "This claim was canceled. No payment was confirmed.",
  };
  for (const item of shown) {
    const card = document.createElement("article");
    card.className = "activity-card";
    const date = document.createElement("time");
    if ("createdAt" in item && typeof item.createdAt === "string") {
      date.dateTime = item.createdAt;
      date.textContent = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(item.createdAt));
    } else date.textContent = "Latest claim";
    const summary = document.createElement("div");
    summary.className = "activity-summary";
    const status = document.createElement("span");
    status.className = "activity-badge";
    status.dataset.status = item.status;
    status.textContent = item.status[0]!.toUpperCase() + item.status.slice(1);
    const amount = document.createElement("strong");
    amount.className = "activity-amount";
    amount.textContent = formatSol(item.amountLamports);
    summary.append(status, amount);
    const description = document.createElement("p");
    description.className = "activity-description";
    description.textContent = details[item.status];
    const destination = document.createElement("div");
    destination.className = "activity-destination";
    const label = document.createElement("span");
    label.className = "activity-label";
    label.textContent = "Destination wallet";
    const address = document.createElement("code");
    address.textContent = item.destination;
    destination.append(label, address);
    card.append(date, summary, description, destination);
    const signature = item.transactionSignature;
    if (signature && isTransactionSignature(signature)) {
      const link = document.createElement("a");
      link.className = "activity-solscan";
      link.href = `https://solscan.io/tx/${signature}`;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = "view on solscan";
      card.append(link);
    }
    root.append(card);
  }
}

export async function refreshClaimStatus(): Promise<void> {
  const active = claims.find((item) => item.status === "pending" || item.status === "held") ?? (claim && (claim.status === "pending" || claim.status === "held") ? claim : null);
  if (!active) return;
  const id = active.id;
  try {
    const response: unknown = await chrome.runtime.sendMessage({ type: "claim-status", id });
    if (!response || typeof response !== "object" || (response as { ok?: unknown }).ok !== true) throw new Error("Claim status unavailable");
    const next = (response as { claim?: unknown }).claim;
    if (!next) return;
    const updated = parseClaim(next);
    if (updated.id !== id) return;
    const changed = active.status !== updated.status;
    if (claim?.id === id) claim = updated;
    const index = claims.findIndex((item) => item.id === id);
    if (index !== -1) claims[index] = { ...claims[index]!, ...updated };
    paintClaims();
    if (changed) void refreshPrivateView(true);
    const error = document.querySelector("#activity-refresh-error");
    if (error?.textContent === "Couldn't refresh claim status. Showing the last known status.") claimMessage("");
  } catch {
    const error = document.querySelector("#activity-refresh-error");
    if (error instanceof HTMLElement && error.hidden) claimMessage("Couldn't refresh claim status. Showing the last known status.");
  }
}
