import { SITE_ORIGINS } from "./config.ts";
import { isCaptureEnabled } from "./lib/capture.ts";
import { isDisclaimerAccepted } from "./lib/consent.ts";
import { httpsUrl } from "./lib/extract.ts";
import { forgetSession, privateRequest } from "./lib/api.ts";
import { applicationPublicKey, exportBackup, importBackup } from "./lib/identity.ts";
import { isLikedUsername } from "./lib/accounts.ts";
import { type AccountStatistics, type AccountVerification, type Balances, type Claim, type ClaimHistory, type EventRow, type LaunchCapacity, type TrackedAccount, isXUserId, parseAccountStatistics, parseBalances, parseClaim, parseClaimHistory, parseEvents, parseLaunchCapacity, parseVerification, trackedAccounts, validIds } from "./lib/private-data.ts";
import { isSolanaAddress } from "./lib/solana.ts";
import type { LikedPostPayload, MediaItem } from "./lib/types.ts";

const ACCOUNTS_KEY = "trackedXAccounts";
const CACHE_KEY = "privateHistoryV1";
const CLAIM_KEY = "activeClaimV1";
const CLAIM_ATTEMPT_KEY = "claimAttemptV1";
const PENDING_PREFIX = "pendingObservation:";
const CACHE_MS = 60_000;
const OBSERVATION_RETRY_ALARM = "retry-observations";
type SignedObservation = LikedPostPayload & { xUserId: string };
type Snapshot = { publicKey: string; accounts: TrackedAccount[]; historyIds: string[]; events: EventRow[] | null; nextCursor: string | null; balances: Balances | null; capacity: LaunchCapacity[] | null; statistics: AccountStatistics[] | null; verification: AccountVerification[] | null; fetchedAt: number };
let claimInFlight: Promise<unknown> = Promise.resolve();
let accountUpdates: Promise<unknown> = Promise.resolve();
let observationUpdates: Promise<unknown> = Promise.resolve();
let observationRetry: Promise<void> | undefined;
const deliveries = new Map<string, Promise<void>>();

void chrome.alarms.create(OBSERVATION_RETRY_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === OBSERVATION_RETRY_ALARM) void retryObservations().catch((error) => console.error("Observation retry failed", error));
});
void retryObservations().catch((error) => console.error("Observation retry failed", error));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.captureEnabled?.newValue === true) {
    void retryObservations().catch((error) => console.error("Observation retry failed", error));
  }
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (isPopupSender(sender) && message && typeof message === "object") {
    const request = message as { type?: unknown; backup?: unknown };
    if (request.type === "identity-setup" || request.type === "identity-backup" || request.type === "identity-import") {
      void (async () => {
        if (!(await isDisclaimerAccepted())) throw new Error("Consent required");
        if (request.type === "identity-import") {
          if (typeof request.backup !== "string" || request.backup.length > 16_384) throw new Error("Invalid identity backup");
          const oldKey = await applicationPublicKey();
          forgetSession();
          const restored = await importBackup(request.backup);
          const changed = oldKey !== await applicationPublicKey();
          const stored = await chrome.storage.local.get(null);
          await chrome.storage.local.remove([CACHE_KEY, CLAIM_KEY, CLAIM_ATTEMPT_KEY, ...(changed ? Object.keys(stored).filter((key) => key.startsWith(PENDING_PREFIX)) : [])]);
          if (changed || restored.length) await chrome.storage.local.set({ [ACCOUNTS_KEY]: restored });
        }
        const publicKey = await applicationPublicKey();
        const backup = request.type === "identity-backup" ? await exportBackup(await readAccounts()) : undefined;
        sendResponse({ ok: true, publicKey, backup });
      })().catch(() => sendResponse({ ok: false }));
      return true;
    }
  }
  const payload = likedPostPayload(message);
  if (payload) {
    if (!isContentSender(sender)) return;
    void deliver(payload).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }

  const seen = seenAccount(message);
  if (seen) {
    if (!isContentSender(sender)) return;
    void rememberSeenAccount(seen).catch((error) => console.error("Account tracking failed", error));
    return;
  }

  if (isSiteSender(sender)) {
    const request = dataRequest(message);
    if (request) {
      void loadData(request.force, request.xUserId).then((response) => sendResponse(response)).catch(() => sendResponse({ ok: false, reason: "failed", accounts: [] }));
      return true;
    }
    if (message && typeof message === "object" && (message as { type?: unknown }).type === "history-next") {
      const page = message as { cursor?: unknown; xUserId?: unknown; xUserIds?: unknown };
      void nextHistory(page.cursor, page.xUserId, page.xUserIds).then((response) => sendResponse(response)).catch(() => sendResponse({ ok: false }));
      return true;
    }
    return;
  }

  if (!isPopupSender(sender)) return;

  const forgotten = forgetRequest(message);
  if (forgotten) {
    void forgetStored(forgotten).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }

  const request = dataRequest(message);
  if (request) {
    void loadData(request.force, request.xUserId).then((response) => sendResponse(response)).catch(() => sendResponse({ ok: false, reason: "failed" }));
    return true;
  }

  if (message && typeof message === "object" && (message as { type?: unknown }).type === "force-create") {
    void forceCreate((message as { eventId?: unknown }).eventId).then((response) => sendResponse(response)).catch(() => sendResponse({ ok: false, reason: "failed" }));
    return true;
  }

  if (message && typeof message === "object" && (message as { type?: unknown }).type === "history-next") {
    const page = message as { cursor?: unknown; xUserId?: unknown; xUserIds?: unknown };
    void nextHistory(page.cursor, page.xUserId, page.xUserIds).then((response) => sendResponse(response)).catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message && typeof message === "object" && (message as { type?: unknown }).type === "claim-status") {
    void claimStatus((message as { id?: unknown }).id).then((response) => sendResponse(response)).catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message && typeof message === "object" && (message as { type?: unknown }).type === "claim-history") {
    void claimHistory((message as { cursor?: unknown }).cursor).then((response) => sendResponse(response)).catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message && typeof message === "object" && (message as { type?: unknown }).type === "verify-account") {
    void verifyAccount((message as { xUserId?: unknown }).xUserId).then((response) => sendResponse(response)).catch(() => sendResponse({ ok: false, reason: "Verification failed" }));
    return true;
  }

  if (message && typeof message === "object" && (message as { type?: unknown }).type === "check-claim") {
    const ids = validIds((message as { xUserIds?: unknown }).xUserIds);
    void (async () => {
      if (!(await isDisclaimerAccepted()) || !ids.length) return { ok: false };
      const publicKey = await applicationPublicKey();
      const accounts = await readAccounts();
      if (!ids.every((id) => accounts.some((account) => account.xUserId === id))) return { ok: false };
      const response = await privateRequest("GET", `/v1/rewards/balances?xUserIds=${ids.join(",")}`);
      if (!response.ok || publicKey !== await applicationPublicKey()) return { ok: false };
      const balances = parseBalances(await response.json());
      return { ok: true, eligible: balances.claimEligibility.available && !balances.accounts.some((account) => account.paused), reason: balances.claimEligibility.reason };
    })().then(sendResponse).catch(() => sendResponse({ ok: false }));
    return true;
  }

  const claim = claimRequest(message);
  if (!claim) return;
  const operation = claimInFlight.then(() => sendClaim(claim));
  claimInFlight = operation.catch(() => undefined);
  void operation.then((response) => sendResponse(response)).catch(() => sendResponse({ ok: false }));
  return true;
});

function isPopupSender(sender: chrome.runtime.MessageSender): boolean {
  const popup = chrome.runtime.getURL("popup.html");
  const panel = chrome.runtime.getURL("sidepanel.html");
  return sender.id === chrome.runtime.id && (sender.url === popup || sender.url === panel);
}

function isContentSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && typeof sender.url === "string" && sender.url.startsWith("https://x.com/") && sender.tab?.id != null;
}

function isSiteSender(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id || typeof sender.url !== "string" || sender.tab?.id == null) return false;
  let url: URL;
  try {
    url = new URL(sender.url);
  } catch {
    return false;
  }
  if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) return true;
  return SITE_ORIGINS.includes(url.origin);
}

async function deliver(payload: SignedObservation): Promise<void> {
  if (!(await isDisclaimerAccepted())) return;
  await storeAccount({ xUserId: payload.xUserId, username: payload.username });
  if (!(await isCaptureEnabled())) return;
  const key = `${PENDING_PREFIX}${payload.xUserId}:${payload.postId}`;
  const publicKey = await applicationPublicKey();
  // Preserve the first undelivered observation even when another engagement
  // reaches the background worker while its signed request is in flight.
  const staged = observationUpdates.then(async () => {
    if (await applicationPublicKey() !== publicKey) return null;
    const existing = (await chrome.storage.local.get(key))[key] as { publicKey?: unknown; payload?: unknown } | undefined;
    if (existing?.publicKey === publicKey) {
      const first = asPayload(existing.payload);
      if (first) return first;
    }
    await chrome.storage.local.set({ [key]: { publicKey, payload } });
    return payload;
  });
  observationUpdates = staged.catch(() => undefined);
  const first = await staged;
  if (first) await flushObservation(key, first, publicKey);
}

async function flushObservation(key: string, payload: SignedObservation, publicKey: string): Promise<void> {
  const inFlight = deliveries.get(key);
  if (inFlight) return inFlight;
  const delivery = sendObservation().finally(() => { deliveries.delete(key); });
  deliveries.set(key, delivery);
  return delivery;

  async function sendObservation(): Promise<void> {
    if (!(await isDisclaimerAccepted()) || !(await isCaptureEnabled())) return;
    if (await applicationPublicKey() !== publicKey) return;
    const delivered = await postOnce(payload);
    if (!delivered) {
      console.error("Observation queued for retry", payload.postId);
      return;
    }
    if (await applicationPublicKey() !== publicKey) return;
    const current = (await chrome.storage.local.get(key))[key] as { publicKey?: unknown; payload?: unknown } | undefined;
    if (current?.publicKey === publicKey && JSON.stringify(asPayload(current.payload)) === JSON.stringify(payload)) await chrome.storage.local.remove(key);
    await chrome.storage.local.remove(CACHE_KEY);
    // The popup/side panel may already be open with an older history snapshot.
    await chrome.runtime.sendMessage({ type: "observation-delivered" }).catch(() => undefined);
  }
}

async function retryObservations(): Promise<void> {
  if (observationRetry) return observationRetry;
  const retry = retryPending().finally(() => { observationRetry = undefined; });
  observationRetry = retry;
  return retry;
}

async function retryPending(): Promise<void> {
  if (!(await isDisclaimerAccepted()) || !(await isCaptureEnabled())) return;
  const stored = await chrome.storage.local.get(null);
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(PENDING_PREFIX)) continue;
    if (!value || typeof value !== "object") continue;
    const entry = value as { publicKey?: unknown; payload?: unknown };
    const payload = asPayload(entry.payload);
    if (payload && typeof entry.publicKey === "string") await flushObservation(key, payload, entry.publicKey);
  }
}

async function rememberSeenAccount(account: TrackedAccount): Promise<void> {
  if (!(await isDisclaimerAccepted())) return;
  await storeAccount(account);
}

async function readAccounts(): Promise<TrackedAccount[]> {
  return trackedAccounts((await chrome.storage.local.get(ACCOUNTS_KEY))[ACCOUNTS_KEY]);
}

async function storeAccount(account: TrackedAccount): Promise<void> {
  const update = accountUpdates.then(async () => {
    const previous = await readAccounts();
    const next = [...previous.filter((entry) => entry.xUserId !== account.xUserId), account];
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    await chrome.storage.local.set({ [ACCOUNTS_KEY]: next });
    if (!previous.some((entry) => entry.xUserId === account.xUserId)) await chrome.storage.local.remove(CACHE_KEY);
  });
  accountUpdates = update.catch(() => undefined);
  await update;
}

async function forgetStored(xUserId: string): Promise<void> {
  if (!(await isDisclaimerAccepted())) return;
  const update = accountUpdates.then(async () => {
    const previous = await readAccounts();
    await chrome.storage.local.set({ [ACCOUNTS_KEY]: previous.filter((account) => account.xUserId !== xUserId) });
    await chrome.storage.local.remove(CACHE_KEY);
  });
  accountUpdates = update.catch(() => undefined);
  await update;
}

function idsFor(accounts: TrackedAccount[]): string[] {
  return accounts.map((account) => account.xUserId).sort();
}

const FEED_PAGE = "10";
const FEED_MORE = "20";

function query(ids: string[], cursor?: string, limit = FEED_PAGE): string {
  const params = new URLSearchParams({ xUserIds: ids.join(","), limit });
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

async function loadData(force: boolean, xUserId?: string): Promise<{ ok: true; data: Snapshot } | { ok: false; reason: "no-account" | "failed"; accounts: TrackedAccount[] }> {
  if (!(await isDisclaimerAccepted())) return { ok: false, reason: "failed", accounts: [] };
  const accounts = await readAccounts();
  if (!accounts.length) return { ok: false, reason: "no-account", accounts };
  const ids = idsFor(accounts);
  if (xUserId && !ids.includes(xUserId)) return { ok: false, reason: "failed", accounts };
  const historyIds = xUserId ? [xUserId] : ids;
  const publicKey = await applicationPublicKey();
  const stored = await chrome.storage.local.get(CACHE_KEY);
  const cached = stored[CACHE_KEY] as Snapshot | undefined;
  if (!force && cached && cached.publicKey === publicKey && Date.now() - cached.fetchedAt < CACHE_MS && Array.isArray(cached.verification) && JSON.stringify(ids) === JSON.stringify(idsFor(trackedAccounts(cached.accounts))) && JSON.stringify(historyIds) === JSON.stringify(cached.historyIds)) {
    try {
      if (publicKey !== await applicationPublicKey()) throw new Error("Identity changed during history read");
      return { ok: true, data: { ...cached, accounts, ...(cached.events === null ? {} : parseEvents({ events: cached.events, nextCursor: cached.nextCursor })), balances: cached.balances === null ? null : parseBalances(cached.balances), capacity: cached.capacity == null ? null : parseLaunchCapacity({ accounts: cached.capacity }), statistics: cached.statistics == null ? null : parseAccountStatistics({ accounts: cached.statistics }), verification: parseVerification({ accounts: cached.verification }) } };
    } catch { /* Fetch fresh data. */ }
  }
  try {
    const target = query(historyIds);
    const [history, balances, capacity, statistics, verification] = await Promise.all([
      privateRequest("GET", `/v1/events?${target}`).then(async (response) => response.ok ? parseEvents(await response.json()) : null).catch(() => null),
      privateRequest("GET", `/v1/rewards/balances?xUserIds=${ids.join(",")}`).then(async (response) => response.ok ? parseBalances(await response.json()) : null).catch(() => null),
      privateRequest("GET", `/v1/events/capacity?xUserIds=${ids.join(",")}`).then(async (response) => response.ok ? parseLaunchCapacity(await response.json()) : null).catch(() => null),
      privateRequest("GET", `/v1/events/statistics?xUserIds=${ids.join(",")}`).then(async (response) => response.ok ? parseAccountStatistics(await response.json()) : null).catch(() => null),
      privateRequest("GET", `/v1/x/verification?xUserIds=${ids.join(",")}`).then(async (response) => response.ok ? parseVerification(await response.json()) : null).catch(() => null),
    ]);
    if (publicKey !== await applicationPublicKey()) throw new Error("Identity changed during history read");
    const data = { publicKey, accounts, historyIds, events: history?.events ?? null, nextCursor: history?.nextCursor ?? null, balances, capacity, statistics, verification, fetchedAt: Date.now() };
    if (history && balances && capacity && statistics && verification) await chrome.storage.local.set({ [CACHE_KEY]: data });
    return { ok: true, data };
  } catch (error) {
    console.error("Private data request failed", error);
    return { ok: false, reason: "failed", accounts };
  }
}

async function forceCreate(eventId: unknown): Promise<{ ok: true } | { ok: false; reason: "capacity" | "conflict" | "failed" }> {
  if (!(await isDisclaimerAccepted()) || typeof eventId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(eventId)) return { ok: false, reason: "failed" };
  const response = await privateRequest("POST", `/v1/events/${eventId}/force`, {});
  if (response.status === 409) {
    const body: unknown = await response.json().catch(() => null);
    const code = body && typeof body === "object" ? (body as { error?: { code?: unknown } }).error?.code : undefined;
    return { ok: false, reason: code === "capacity" ? "capacity" : "conflict" };
  }
  if (!response.ok) return { ok: false, reason: "failed" };
  await chrome.storage.local.remove(CACHE_KEY);
  return { ok: true };
}

async function nextHistory(value: unknown, xUserId?: unknown, xUserIds?: unknown): Promise<{ ok: true; events: EventRow[]; nextCursor: string | null } | { ok: false }> {
  if (!(await isDisclaimerAccepted()) || typeof value !== "string" || !value) return { ok: false };
  const publicKey = await applicationPublicKey();
  const accounts = await readAccounts();
  if (!accounts.length) return { ok: false };
  if (xUserId !== undefined && (!isXUserId(xUserId) || !accounts.some((account) => account.xUserId === xUserId))) return { ok: false };
  const ids = xUserIds === undefined ? (xUserId ? [xUserId] : idsFor(accounts)) : validIds(xUserIds);
  if (!ids.length || !ids.every((id) => accounts.some((account) => account.xUserId === id)) || (xUserId !== undefined && (ids.length !== 1 || ids[0] !== xUserId))) return { ok: false };
  const response = await privateRequest("GET", `/v1/events?${query(ids, value, FEED_MORE)}`);
  if (!response.ok || publicKey !== await applicationPublicKey()) return { ok: false };
  return { ok: true, ...parseEvents(await response.json()) };
}

async function readClaim(): Promise<Claim | null> {
  const stored = (await chrome.storage.local.get(CLAIM_KEY))[CLAIM_KEY] as { publicKey?: string; claim?: unknown } | undefined;
  if (!stored) return null;
  try {
    if (stored.publicKey !== await applicationPublicKey()) return null;
    return parseClaim(stored.claim);
  } catch { return null; }
}

async function claimStatus(id: unknown): Promise<{ ok: true; claim: Claim | null } | { ok: false }> {
  if (!(await isDisclaimerAccepted()) || typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return { ok: false };
  const existing = await readClaim();
  const publicKey = await applicationPublicKey();
  const response = await privateRequest("GET", `/v1/rewards/claims/${encodeURIComponent(id)}`);
  if (!response.ok || publicKey !== await applicationPublicKey()) return { ok: false };
  const claim = parseClaim(await response.json());
  if (claim.id !== id || publicKey !== await applicationPublicKey()) return { ok: false };
  if (existing?.id === id) {
    await chrome.storage.local.set({ [CLAIM_KEY]: { publicKey, claim } });
    if (claim.status !== existing.status) await chrome.storage.local.remove(CACHE_KEY);
  }
  return { ok: true, claim };
}

async function claimHistory(cursor: unknown): Promise<{ ok: true; claims: ClaimHistory[]; nextCursor: string | null } | { ok: false }> {
  if (!(await isDisclaimerAccepted()) || !(cursor === undefined || typeof cursor === "string" && cursor.length > 0)) return { ok: false };
  const publicKey = await applicationPublicKey();
  const params = new URLSearchParams({ limit: "20" });
  if (typeof cursor === "string") params.set("cursor", cursor);
  const response = await privateRequest("GET", `/v1/rewards/claims?${params}`);
  if (!response.ok || publicKey !== await applicationPublicKey()) return { ok: false };
  return { ok: true, ...parseClaimHistory(await response.json()) };
}

async function verifyAccount(xUserId: unknown): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!(await isDisclaimerAccepted()) || !isXUserId(xUserId)) return { ok: false, reason: "Verification failed" };
  const accounts = await readAccounts();
  if (!accounts.some((account) => account.xUserId === xUserId)) return { ok: false, reason: "Verification failed" };
  const publicKey = await applicationPublicKey();
  const redirectUri = chrome.identity.getRedirectURL();
  const started = await privateRequest("POST", "/v1/x/verification", { xUserId, redirectUri });
  if (!started.ok) return { ok: false, reason: await verificationFailure(started) };
  const startBody: unknown = await started.json();
  if (!startBody || typeof startBody !== "object") return { ok: false, reason: "Verification failed" };
  const { authorizationUrl, state } = startBody as { authorizationUrl?: unknown; state?: unknown };
  if (typeof authorizationUrl !== "string" || !authorizationUrl.startsWith("https://") || typeof state !== "string") return { ok: false, reason: "Verification failed" };
  let redirected: string;
  try {
    redirected = await launchXAuth(authorizationUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return { ok: false, reason: /cancel|denied|closed|did not approve/i.test(message) ? "Verification was canceled" : "Verification failed" };
  }
  let callback: URL;
  try {
    callback = new URL(redirected);
  } catch {
    return { ok: false, reason: "Verification failed" };
  }
  if (callback.searchParams.get("error")) return { ok: false, reason: "Verification was canceled" };
  if (callback.origin + callback.pathname !== redirectUri) return { ok: false, reason: "Verification failed" };
  const code = callback.searchParams.get("code");
  if (!code || callback.searchParams.get("state") !== state) return { ok: false, reason: "Verification failed" };
  if (publicKey !== await applicationPublicKey()) return { ok: false, reason: "Identity changed during verification" };
  const completed = await privateRequest("POST", "/v1/x/verification/complete", { state, code });
  if (!completed.ok) return { ok: false, reason: await verificationFailure(completed) };
  if (publicKey !== await applicationPublicKey()) return { ok: false, reason: "Identity changed during verification" };
  await chrome.storage.local.remove(CACHE_KEY);
  return { ok: true };
}

function launchXAuth(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url, interactive: true }, (redirectUrl) => {
      const message = chrome.runtime.lastError?.message;
      if (message || !redirectUrl) {
        reject(new Error(message || "Verification was canceled"));
        return;
      }
      resolve(redirectUrl);
    });
  });
}

async function verificationFailure(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  const code = body && typeof body === "object" && "error" in body && body.error && typeof body.error === "object" && "code" in body.error
    ? (body.error as { code?: unknown }).code
    : null;
  const reasons: Record<string, string> = {
    verification_unavailable: "Verification is unavailable",
    account_held: "This X account is verified to another identity",
    account_disputed: "Ownership of this X account is under review",
    account_mismatch: "The X account did not match",
    verification_expired: "Verification expired. Try again",
    verification_failed: "X did not confirm this account",
  };
  return typeof code === "string" ? reasons[code] ?? "Verification failed" : "Verification failed";
}

async function postOnce(payload: SignedObservation): Promise<boolean> {
  try {
    const response = await privateRequest("POST", "/v1/events", payload);
    if (!response.ok) {
      console.error("Observation endpoint returned", response.status);
      return false;
    }
    return true;
  } catch (error) {
    console.error("Observation endpoint request failed", error);
    return false;
  }
}

async function sendClaim(claim: {
  xUserIds: string[];
  destination: string;
}): Promise<{ ok: true; claim: Claim } | { ok: false; reason?: string }> {
  if (!(await isDisclaimerAccepted())) return { ok: false };
  const accounts = await readAccounts();
  if (!claim.xUserIds.length || !claim.xUserIds.every((id) => accounts.some((account) => account.xUserId === id))) return { ok: false };
  try {
    const publicKey = await applicationPublicKey();
    const saved = (await chrome.storage.local.get([CLAIM_ATTEMPT_KEY, CLAIM_KEY]));
    const storedAttempt = saved[CLAIM_ATTEMPT_KEY] as { publicKey?: string; xUserIds?: string[]; destination?: string; idempotencyKey?: string } | undefined;
    const previous = storedAttempt?.publicKey === publicKey ? storedAttempt : undefined;
    const storedClaim = saved[CLAIM_KEY] as { publicKey?: string; claim?: unknown } | undefined;
    const active = storedClaim?.publicKey === publicKey ? parseClaim(storedClaim.claim) : null;
    if (active && (active.status === "pending" || active.status === "held") && (active.destination !== claim.destination || JSON.stringify(previous?.xUserIds) !== JSON.stringify(claim.xUserIds))) return { ok: false, reason: "A claim is still pending or held" };
    if (previous && !active && (previous.destination !== claim.destination || JSON.stringify(previous.xUserIds) !== JSON.stringify(claim.xUserIds))) return { ok: false, reason: "Retry the previous claim with its original destination and accounts until its outcome is known" };
    const idempotencyKey = previous?.destination === claim.destination && JSON.stringify(previous.xUserIds) === JSON.stringify(claim.xUserIds) && (!active || active.status === "pending" || active.status === "held") && previous.idempotencyKey || crypto.randomUUID();
    await chrome.storage.local.set({ [CLAIM_ATTEMPT_KEY]: { ...claim, idempotencyKey, publicKey } });
    const response = await privateRequest("POST", "/v1/rewards/claims", { ...claim, idempotencyKey, confirmedDestination: true });
    if (publicKey !== await applicationPublicKey()) return { ok: false, reason: "Identity changed during claim" };
    if (!response.ok) {
      if ([400, 403, 409].includes(response.status)) await chrome.storage.local.remove(CLAIM_ATTEMPT_KEY);
      const body: unknown = await response.json().catch(() => null);
      const code = body && typeof body === "object" && "error" in body && body.error && typeof body.error === "object" && "code" in body.error ? body.error.code : null;
      const reasons: Record<string, string> = {
        below_minimum: "Available rewards are below $5",
        disputed: "Claims for this X account are paused",
        quote_stale: "Waiting for an updated SOL price; try again soon",
        quote_unavailable: "SOL price is unavailable; try again later",
        unauthorized: "This X account is not authorized for rewards",
        claim_conflict: "Claim destination or account selection conflicts with the previous request",
        destination_unconfirmed: "Confirm the payout destination",
      };
      return { ok: false, reason: typeof code === "string" ? reasons[code] ?? `Claim unavailable (${response.status})` : `Claim unavailable (${response.status})` };
    }
    const accepted = parseClaim(await response.json());
    if (accepted.destination !== claim.destination || publicKey !== await applicationPublicKey()) return { ok: false };
    await chrome.storage.local.set({ [CLAIM_KEY]: { publicKey, claim: accepted } });
    await chrome.storage.local.remove(CACHE_KEY);
    return { ok: true, claim: accepted };
  } catch (error) {
    console.error("Claim request failed", error);
    return { ok: false };
  }
}

function claimRequest(message: unknown): {
  xUserIds: string[];
  destination: string;
} | null {
  if (!message || typeof message !== "object") return null;
  const record = message as Record<string, unknown>;
  if (record.type !== "claim-payout") return null;
  const xUserIds = validIds(record.xUserIds);
  if (!xUserIds.length || typeof record.destination !== "string" || !isSolanaAddress(record.destination) || record.confirmedDestination !== true) return null;
  return {
    xUserIds: xUserIds.sort(),
    destination: record.destination.trim(),
  };
}

function dataRequest(message: unknown): { force: boolean; xUserId?: string } | null {
  if (!message || typeof message !== "object") return null;
  const record = message as Record<string, unknown>;
  if (record.type !== "load-private-data") return null;
  return { force: record.force === true, xUserId: isXUserId(record.xUserId) ? record.xUserId : undefined };
}

function forgetRequest(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const record = message as Record<string, unknown>;
  if (record.type !== "forget-account" || !isXUserId(record.xUserId)) return null;
  return record.xUserId;
}

function seenAccount(message: unknown): TrackedAccount | null {
  if (!message || typeof message !== "object") return null;
  const record = message as Record<string, unknown>;
  if (record.type !== "seen-account" || !isLikedUsername(record.username) || !isXUserId(record.xUserId)) return null;
  return { xUserId: record.xUserId, username: record.username };
}

function likedPostPayload(message: unknown): SignedObservation | null {
  if (!message || typeof message !== "object") return null;
  const record = message as Record<string, unknown>;
  if (record.type !== "liked-post") return null;
  return asPayload(record.payload);
}

function asPayload(value: unknown): SignedObservation | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.xUserId !== "string" || !/^[1-9][0-9]{0,19}$/.test(record.xUserId) ||
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
    xUserId: record.xUserId,
    postId: record.postId,
    username: record.username,
    avatarUrl: httpsUrl(record.avatarUrl),
    text: record.text,
    media,
    url: record.url,
    likedAt: record.likedAt,
  };
}
