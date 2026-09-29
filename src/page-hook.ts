import { CAPTURE_CONSENT_ATTR } from "./lib/consent.ts";
import {
  collectAccountIds,
  collectTweets,
  engagementFromRequest,
  isEngagementOperation,
  originalPostForEngagement,
  rememberTweets,
  shouldHarvestTweets,
} from "./lib/extract.ts";
import {
  PAGE_MESSAGE_SOURCE,
  type CachedTweet,
  type EngagementKind,
  type FavoritePageMessage,
  type OutgoingEngagement,
} from "./lib/types.ts";

const cache = new Map<string, CachedTweet>();
const xhrUrls = new WeakMap<XMLHttpRequest, string>();

const originalFetch = window.fetch.bind(window);
const originalOpen = XMLHttpRequest.prototype.open;
const originalSend = XMLHttpRequest.prototype.send;

let installed = false;

watchConsent();

function watchConsent(): void {
  const root = document.documentElement;
  if (!root) {
    document.addEventListener("DOMContentLoaded", watchConsent, { once: true });
    return;
  }
  if (root.getAttribute(CAPTURE_CONSENT_ATTR) === "on") {
    install();
    return;
  }
  const observer = new MutationObserver(() => {
    if (root.getAttribute(CAPTURE_CONSENT_ATTR) !== "on") return;
    observer.disconnect();
    install();
  });
  observer.observe(root, { attributes: true, attributeFilter: [CAPTURE_CONSENT_ATTR] });
  if (root.getAttribute(CAPTURE_CONSENT_ATTR) === "on") {
    observer.disconnect();
    install();
  }
}

function install(): void {
  if (installed) return;
  installed = true;
  window.fetch = captureFetch;
  XMLHttpRequest.prototype.open = captureOpen;
  XMLHttpRequest.prototype.send = captureSend;
  // X may have loaded the signed-in account before consent enabled interception.
  const initialState = (window as Window & { __INITIAL_STATE__?: unknown }).__INITIAL_STATE__;
  if (initialState && typeof initialState === "object") {
    const state = initialState as { session?: { user_id?: unknown }; entities?: { users?: { entities?: Record<string, unknown> } } };
    const id = state.session?.user_id;
    if (typeof id === "string" && /^[1-9][0-9]{0,19}$/.test(id)) {
      publishAccounts(state.entities?.users?.entities?.[id]);
    }
    publishAccounts(initialState);
  }
}

async function captureFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = requestUrl(input);
  const engagement = isEngagementOperation(url) ? await readEngagement(input, init, url) : null;
  const response = await originalFetch(input, init);
  if (engagement && response.ok) await publishEngagement(engagement, response);
  else if (shouldHarvestTweets(url)) harvestResponse(response);
  return response;
}

function captureOpen(
  this: XMLHttpRequest,
  method: string,
  url: string | URL,
  async?: boolean,
  username?: string | null,
  password?: string | null,
): void {
  xhrUrls.set(this, new URL(String(url), location.href).href);
  originalOpen.call(this, method, url, async ?? true, username, password);
}

function captureSend(
  this: XMLHttpRequest,
  body?: Document | XMLHttpRequestBodyInit | null,
): void {
  const url = xhrUrls.get(this) ?? "";
  if (isEngagementOperation(url)) {
    const xhr = this;
    const pendingBody = readBody(body);
    xhr.addEventListener("load", () => {
      void pendingBody.then((text) => {
        if (xhr.status < 200 || xhr.status >= 300) return;
        const engagement = engagementFromRequest(url, text);
        if (!engagement) return;
        if (engagement.kind !== "like") {
          try {
            harvestText(xhr.responseText);
          } catch {
            // responseText throws when the response type is not text.
          }
        }
        publishResolvedEngagement(engagement);
      });
    });
  } else if (shouldHarvestTweets(url)) {
    this.addEventListener("load", () => {
      try {
        harvestText(this.responseText);
      } catch {
        // responseText throws when the response type is not text.
      }
    });
  }
  originalSend.call(this, body);
}

async function publishEngagement(engagement: OutgoingEngagement, response: Response): Promise<void> {
  if (engagement.kind !== "like") await harvestResponseNow(response);
  publishResolvedEngagement(engagement);
}

function publishResolvedEngagement(engagement: OutgoingEngagement): void {
  switch (engagement.kind) {
    case "like":
      {
        const resolved = originalPostForEngagement(cache, engagement.tweetId);
        publishFavorite(resolved?.postId ?? engagement.tweetId, resolved?.tweet ?? null, "like", Boolean(resolved));
      }
      return;
    case "repost":
    case "comment": {
      const resolved = originalPostForEngagement(cache, engagement.tweetId);
      if (resolved) {
        publishFavorite(resolved.postId, resolved.tweet, engagement.kind, true);
        return;
      }
      publishFavorite(engagement.tweetId, null, engagement.kind, false);
      return;
    }
    default: {
      const unreachable: never = engagement.kind;
      throw new Error(`Unhandled engagement: ${JSON.stringify(unreachable)}`);
    }
  }
}

function publishFavorite(tweetId: string, tweet: CachedTweet | null, kind: EngagementKind, original: boolean): void {
  const message: FavoritePageMessage = {
    source: PAGE_MESSAGE_SOURCE,
    type: "favorite",
    tweetId,
    tweet,
    kind,
    original,
  };
  window.postMessage(message, window.location.origin);
}

function harvestResponse(response: Response): void {
  void harvestResponseNow(response);
}

async function harvestResponseNow(response: Response): Promise<void> {
  try {
    harvestValue(await response.clone().json());
  } catch {
    // The response was not JSON, or it was already consumed.
  }
}

function harvestText(text: string): void {
  harvestValue(JSON.parse(text) as unknown);
}

function harvestValue(value: unknown): void {
  rememberTweets(cache, collectTweets(value));
  publishAccounts(value);
}

function publishAccounts(value: unknown): void {
  for (const account of collectAccountIds(value)) {
    window.postMessage({ source: PAGE_MESSAGE_SOURCE, type: "account-id", ...account }, window.location.origin);
  }
}

async function readEngagement(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  url: string,
): Promise<OutgoingEngagement | null> {
  try {
    if (init?.body != null) {
      const text = await readBody(init.body);
      return engagementFromRequest(url, text);
    }
    if (input instanceof Request) {
      const text = await input.clone().text();
      return engagementFromRequest(url, text);
    }
  } catch {
    return null;
  }
  return null;
}

async function readBody(body: BodyInit | Document | null | undefined): Promise<string | null> {
  if (body == null || typeof body === "string") return body ?? null;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Blob) return body.text();
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body);
  if (body instanceof FormData) {
    const variables = body.get("variables");
    return typeof variables === "string" ? variables : null;
  }
  if (body instanceof ReadableStream) return null;
  return null;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return new URL(input, location.href).href;
  if (input instanceof URL) return input.href;
  return input.url;
}
