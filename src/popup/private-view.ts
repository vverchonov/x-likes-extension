import { type Balances, type Claim, type EventRow, type TrackedAccount, formatSol, parseBalances, parseClaim, parseEvents, trackedAccounts } from "../lib/private-data.ts";

type Selection = { xUserIds: string[]; balance: string };
type Snapshot = { accounts: TrackedAccount[]; events: EventRow[] | null; nextCursor: string | null; balances: Balances | null };

let snapshot: Snapshot | null = null;
let claim: Claim | null = null;
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
export function setClaim(next: Claim): void { claim = next; paintClaim(); }

export function mountPrivateView(): void {
  document.querySelector("#refresh")?.addEventListener("click", () => { void refreshPrivateView(true); });
  void refreshPrivateView(false);
  void refreshClaimStatus();
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
    const response = result as { ok?: unknown; reason?: unknown; data?: unknown; accounts?: unknown; claim?: unknown };
    if (response.ok !== true) {
      snapshot = null;
      claim = null;
      cursor = null;
      selected = null;
      const saved = trackedAccounts(response.accounts);
      paintMessage(timeline, response.reason === "no-account" ? "Open X to load likes" : "Couldn't load likes");
      paintMessage(accounts, response.reason === "no-account" ? "No accounts yet" : "Couldn't load accounts or SOL balances");
      if (saved.length) paintAccounts(saved, null);
      paintBalance();
      paintClaim();
      return;
    }
    const data = response.data as Partial<Snapshot>;
    const accountsList = trackedAccounts(data.accounts);
    if (!accountsList.length) throw new Error("Invalid accounts");
    const history = data.events === null ? null : parseEvents(data);
    const balances = data.balances === null ? null : parseBalances(data.balances);
    snapshot = { accounts: accountsList, events: history?.events ?? null, nextCursor: history?.nextCursor ?? null, balances };
    cursor = history?.nextCursor ?? null;
    claim = response.claim ? parseClaim(response.claim) : null;
    selected = null;
    paintBalance();
    paintAccounts(accountsList, balances);
    paintHistory(history?.events ?? null);
    paintClaim();
  } catch {
    if (id !== refreshId) return;
    snapshot = null;
    claim = null;
    cursor = null;
    paintMessage(timeline, "Couldn't load history");
    paintMessage(accounts, "Couldn't load accounts or SOL balances");
    paintBalance();
    paintClaim();
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
  if (balance) balance.textContent = snapshot?.balances ? `${formatSol(snapshot.balances.combined.availableLamports)} available` : "– SOL";
  const selection = homeSelection();
  if (minimum instanceof HTMLElement) {
    minimum.hidden = Boolean(selection);
    minimum.textContent = snapshot?.balances ? eligibilityText(snapshot.balances) : "Balances unavailable";
  }
  if (button instanceof HTMLButtonElement) {
    button.hidden = !selection;
  }
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
    balance.textContent = amount ? formatSol(amount.availableLamports) : "–";
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
    empty.textContent = events === null ? "Couldn't load likes" : "No likes yet";
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
      if (event.creatorEarningsLamports !== null) {
        const earning = document.createElement("span");
        earning.className = "coin-earning";
        earning.textContent = `attributed ${formatSol(event.creatorEarningsLamports)}`;
        earning.title = "Attributed rewards may not be claimable by this key";
        links.append(earning);
      }
    }
    meta.append(who, links);
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

function paintClaim(): void {
  const status = document.querySelector("#latest-claim");
  if (status) status.textContent = claim ? `Claim ${claim.status}: ${formatSol(claim.amountLamports)} to ${claim.destination}${claim.transactionSignature && claim.status === "confirmed" ? ` · signature ${claim.transactionSignature}` : ""}` : "";
}

export async function refreshClaimStatus(): Promise<void> {
  try {
    const response: unknown = await chrome.runtime.sendMessage({ type: "claim-status" });
    if (!response || typeof response !== "object" || (response as { ok?: unknown }).ok !== true) throw new Error("Claim status unavailable");
    const next = (response as { claim?: unknown }).claim;
    if (next) { claim = parseClaim(next); paintClaim(); }
  } catch {
    const status = document.querySelector("#latest-claim");
    if (status && claim) status.textContent = `Claim ${claim.status} (last known). Couldn't refresh claim status.`;
  }
}
