import { type Balances, type Claim, type ClaimHistory, type EventRow, type TrackedAccount, formatSol, formatUsd, parseBalances, parseClaim, parseClaimHistory, parseEvents, trackedAccounts } from "../lib/private-data.ts";

type Selection = { xUserIds: string[]; balance: string };
type Snapshot = { accounts: TrackedAccount[]; events: EventRow[] | null; nextCursor: string | null; balances: Balances | null };

let snapshot: Snapshot | null = null;
let claim: Claim | null = null;
let claims: ClaimHistory[] = [];
let claimCursor: string | null = null;
let claimRefreshId = 0;
let claimLoading = false;
let refreshId = 0;
let cursor: string | null = null;
let selected: Selection | null = null;

export function currentSelection(): Selection | null { return selected; }
export function homeSelection(): Selection | null {
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
  if (!price || !/^\d+(?:\.\d{1,9})?$/.test(price)) return false;
  const [whole = "0", decimal = ""] = price.split(".");
  return BigInt(lamports) * BigInt(whole + decimal.padEnd(9, "0")) >= 5n * 10n ** 18n;
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

export function mountPrivateView(): void {
  document.querySelector("#refresh")?.addEventListener("click", () => {
    void refreshPrivateView(true);
    void refreshClaimHistory().then(() => refreshClaimStatus());
  });
  document.querySelector("#activity-more")?.addEventListener("click", () => { void loadMoreClaims(); });
  void refreshPrivateView(true);
  void refreshClaimHistory().then(() => refreshClaimStatus());
  window.setInterval(() => { if (claim && (claim.status === "pending" || claim.status === "held")) void refreshClaimStatus(); }, 15_000);
}

export async function refreshPrivateView(force: boolean): Promise<void> {
  const id = ++refreshId;
  const timeline = document.querySelector("#timeline");
  const accounts = document.querySelector("#accounts-list");
  const refresh = document.querySelector("#refresh");
  if (!(timeline instanceof HTMLElement) || !(accounts instanceof HTMLElement)) return;
  if (refresh instanceof HTMLButtonElement) refresh.disabled = true;
  paintMessage(timeline, "Loading history…");
  paintMessage(accounts, "Loading accounts…");
  try {
    const result: unknown = await chrome.runtime.sendMessage({ type: "load-private-data", force });
    if (id !== refreshId) return;
    if (!result || typeof result !== "object") throw new Error("Invalid response");
    const response = result as { ok?: unknown; reason?: unknown; data?: unknown; accounts?: unknown };
    if (response.ok !== true) {
      snapshot = null;
      cursor = null;
      selected = null;
      const saved = trackedAccounts(response.accounts);
      paintMessage(timeline, response.reason === "no-account" ? "Open X to load engagements" : "Failed to load");
      paintMessage(accounts, response.reason === "no-account" ? "No accounts yet" : "Couldn't load accounts or balances");
      if (saved.length) paintAccounts(saved, null);
      paintBalance();
      return;
    }
    const data = response.data as Partial<Snapshot>;
    const accountsList = trackedAccounts(data.accounts);
    if (!accountsList.length) throw new Error("Invalid accounts");
    const history = data.events === null ? null : parseEvents(data);
    const balances = data.balances === null ? null : parseBalances(data.balances);
    snapshot = { accounts: accountsList, events: history?.events ?? null, nextCursor: history?.nextCursor ?? null, balances };
    cursor = history?.nextCursor ?? null;
    selected = null;
    paintBalance();
    paintAccounts(accountsList, balances);
    paintHistory(history?.events ?? null);
  } catch {
    if (id !== refreshId) return;
    snapshot = null;
    cursor = null;
    paintMessage(timeline, "Failed to load");
    paintMessage(accounts, "Couldn't load accounts or balances");
    paintBalance();
  } finally {
    if (id === refreshId && refresh instanceof HTMLButtonElement) refresh.disabled = false;
  }
}

function paintMessage(root: Element, message: string): void {
  const empty = document.createElement("p");
  empty.className = "empty";
  empty.textContent = message;
  root.replaceChildren(empty);
}

function paintBalance(): void {
  const balance = document.querySelector("#payout-balance");
  const minimum = document.querySelector("#payout-minimum");
  const button = document.querySelector("#payout-button");
  if (balance) balance.textContent = snapshot?.balances ? availableUsd(snapshot.balances.combined.availableLamports, snapshot.balances.claimEligibility.solUsd) : "– USD";
  const selection = homeSelection();
  if (minimum instanceof HTMLElement) {
    minimum.hidden = Boolean(selection);
    minimum.textContent = snapshot?.balances ? eligibilityText(snapshot.balances) : "Balances unavailable";
  }
  if (button instanceof HTMLButtonElement) {
    button.hidden = !selection;
  }
}

function availableUsd(lamports: string, quote: string | null): string {
  const usd = formatUsd(lamports, quote);
  return usd ? `${usd} available` : "USD unavailable";
}

function eligibilityText(balances: Balances): string {
  if (balances.claimEligibility.reason === "disputed") return "Claims paused by dispute";
  if (balances.claimEligibility.reason === "unauthorized") return "Claim unauthorized";
  if (balances.claimEligibility.available) return "Eligible to claim";
  switch (balances.claimEligibility.reason) {
    case "below_minimum": return "Minimum to claim: $5";
    case "quote_unavailable": return "SOL price unavailable; try later";
    case "quote_stale": return "Updating SOL price; try soon";
    default: return "Claim unavailable";
  }
}

function paintAccounts(accounts: TrackedAccount[], balances: Balances | null): void {
  const root = document.querySelector("#accounts-list");
  if (!(root instanceof HTMLElement)) return;
  root.replaceChildren();
  for (const account of accounts) {
    const amount = balances?.accounts.find((entry) => entry.xUserId === account.xUserId);
    const article = document.createElement("article");
    article.className = "account-row";
    const main = document.createElement("div");
    main.className = "account-main";
    const name = document.createElement("p");
    name.className = "label";
    name.textContent = `@${account.username}`;
    const balance = document.createElement("p");
    balance.className = "account-balance";
    balance.textContent = amount ? availableUsd(amount.availableLamports, balances?.claimEligibility.solUsd ?? null) : "– USD";
    main.append(name, balance);
    const actions = document.createElement("div");
    actions.className = "account-actions";
    const claimButton = document.createElement("button");
    claimButton.className = "payout-button";
    claimButton.type = "button";
    claimButton.dataset.action = "claim";
    claimButton.dataset.xUserId = account.xUserId;
    claimButton.textContent = "Claim";
    if (rowSelection(account.xUserId)) actions.append(claimButton);
    else {
      const reason = document.createElement("p");
      reason.className = "payout-minimum";
      reason.textContent = amount?.paused ? "Claims paused" : !amount ? "Balance unavailable" : balances?.claimEligibility.reason === "quote_unavailable" ? "SOL price unavailable" : balances?.claimEligibility.reason === "quote_stale" ? "Updating SOL price" : balances?.claimEligibility.solUsd ? "Minimum to claim: $5" : balances ? eligibilityText(balances) : "Balance unavailable";
      actions.append(reason);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-account";
    remove.dataset.action = "remove";
    remove.dataset.xUserId = account.xUserId;
    remove.setAttribute("aria-label", `Remove @${account.username}`);
    remove.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
    actions.append(remove);
    article.append(main, actions);
    root.append(article);
  }
}

function paintHistory(events: EventRow[] | null): void {
  const root = document.querySelector("#timeline");
  if (!(root instanceof HTMLElement)) return;
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
    if (event.text) { const text = document.createElement("p"); text.className = "text"; text.textContent = event.text; article.append(text); }
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
    const who = document.createElement("div");
    who.className = "who";
    if (event.avatarUrl) {
      const avatar = document.createElement("img");
      avatar.className = "avatar";
      avatar.src = event.avatarUrl;
      avatar.alt = "";
      who.append(avatar);
    }
    const account = document.createElement("span");
    account.className = "account";
    account.textContent = `@${event.username}`;
    const time = document.createElement("time");
    time.dateTime = event.likedAt;
    const date = new Date(event.likedAt);
    time.textContent = Number.isNaN(date.getTime()) ? event.likedAt : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
    who.append(account, time);
    const links = document.createElement("div");
    links.className = "links";
    const link = document.createElement("a");
    link.href = event.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = "view post";
    links.append(link);
    if (event.tokenUrl) {
      const token = link.cloneNode() as HTMLAnchorElement;
      token.href = event.tokenUrl;
      token.textContent = "view coin";
      links.append(token);
      if (event.creatorEarningsLamports !== null && BigInt(event.creatorEarningsLamports) > 0n) {
        const earning = document.createElement("span");
        earning.className = "coin-earning";
        earning.textContent = `Attributed coin rewards: ${formatUsd(event.creatorEarningsLamports, snapshot?.balances?.claimEligibility.solUsd ?? null) ?? formatSol(event.creatorEarningsLamports)}`;
        earning.title = "Attributed rewards may not be claimable by this key";
        links.append(earning);
      }
    }
    meta.append(who, links);
    const statusText = activityStatus(event.processingStatus);
    if (statusText) {
      const status = document.createElement("p");
      status.className = "activity-status";
      status.textContent = statusText;
      meta.append(status);
    }
    article.append(meta);
    root.append(article);
  }
  if (cursor) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "payout-button";
    more.textContent = "Load more";
    more.addEventListener("click", () => { void loadMore(more); });
    root.append(more);
  }
}

function activityStatus(status: EventRow["processingStatus"]): string | null {
  switch (status) {
    case "finalized": return null;
    case "rejected": return "This post wasn't selected for a coin.";
    case "failed": return "We couldn't create a coin for this post.";
    case "pending":
    case "deferred":
    case "grounding":
    case "filtering":
    case "generating":
    case "ready":
    case "sending":
    case "unresolved": return "Pending";
    default: return "Status unavailable";
  }
}

async function loadMore(button: HTMLButtonElement): Promise<void> {
  const page = cursor;
  if (!page || !snapshot) return;
  const requestedRefresh = refreshId;
  button.disabled = true;
  button.textContent = "Loading…";
  try {
    const response: unknown = await chrome.runtime.sendMessage({ type: "history-next", cursor: page });
    if (!snapshot || refreshId !== requestedRefresh || cursor !== page || !response || typeof response !== "object" || (response as { ok?: unknown }).ok !== true) throw new Error("History unavailable");
    const history = parseEvents(response);
    if (!snapshot.events) throw new Error("History unavailable");
    snapshot.events.push(...history.events);
    cursor = history.nextCursor;
    paintHistory(snapshot.events);
  } catch { if (refreshId === requestedRefresh) { button.disabled = false; button.textContent = "Retry load more"; } }
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
    if (item.transactionSignature) {
      const transaction = destination.cloneNode(true) as HTMLElement;
      transaction.querySelector(".activity-label")!.textContent = "Transaction signature";
      transaction.querySelector("code")!.textContent = item.transactionSignature;
      card.append(transaction);
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
