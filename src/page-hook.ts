import { CAPTURE_CONSENT_ATTR } from "./lib/consent.ts";
import {
  collectTweets,
  isFavoriteTweetRequest,
  parseFavoriteTweetId,
  rememberTweets,
  shouldHarvestTweets,
} from "./lib/extract.ts";
import { PAGE_MESSAGE_SOURCE, type CachedTweet, type FavoritePageMessage } from "./lib/types.ts";

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
}

async function captureFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = requestUrl(input);
  const favoriteId = isFavoriteTweetRequest(url) ? await readFavoriteId(input, init) : null;
  const response = await originalFetch(input, init);
  if (favoriteId && response.ok) publishFavorite(favoriteId);
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
  if (isFavoriteTweetRequest(url)) {
    const xhr = this;
    const pendingId = readBody(body).then((text) => (text ? parseFavoriteTweetId(text) : null));
    xhr.addEventListener("load", () => {
      void pendingId.then((tweetId) => {
        if (tweetId && xhr.status >= 200 && xhr.status < 300) publishFavorite(tweetId);
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

function publishFavorite(tweetId: string): void {
  const message: FavoritePageMessage = {
    source: PAGE_MESSAGE_SOURCE,
    type: "favorite",
    tweetId,
    tweet: cache.get(tweetId) ?? null,
  };
  window.postMessage(message, window.location.origin);
}

function harvestResponse(response: Response): void {
  void response
    .clone()
    .json()
    .then((data: unknown) => {
      harvestValue(data);
    })
    .catch(() => undefined);
}

function harvestText(text: string): void {
  harvestValue(JSON.parse(text) as unknown);
}

function harvestValue(value: unknown): void {
  rememberTweets(cache, collectTweets(value));
}

async function readFavoriteId(input: RequestInfo | URL, init?: RequestInit): Promise<string | null> {
  try {
    if (init?.body != null) {
      const text = await readBody(init.body);
      if (text) return parseFavoriteTweetId(text);
    }
    if (input instanceof Request) {
      const text = await input.clone().text();
      return parseFavoriteTweetId(text);
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
