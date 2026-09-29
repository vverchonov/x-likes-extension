import type {
  CachedTweet,
  DomCaptureInput,
  DomDecision,
  LikedPostPayload,
  MediaItem,
  OutgoingEngagement,
} from "./types.ts";

const TWEET_CACHE_LIMIT = 2000;

export function graphqlOperation(url: string): string | null {
  try {
    const parsed = new URL(url, "https://x.com");
    const parts = parsed.pathname.split("/").filter(Boolean);
    const graphqlIndex = parts.indexOf("graphql");
    if (graphqlIndex === -1) return null;
    return parts[graphqlIndex + 2] ?? null;
  } catch {
    return null;
  }
}

export function isFavoriteTweetRequest(url: string): boolean {
  return graphqlOperation(url) === "FavoriteTweet";
}

export function isUnfavoriteTweetRequest(url: string): boolean {
  return graphqlOperation(url) === "UnfavoriteTweet";
}

export function isEngagementOperation(url: string): boolean {
  const operation = graphqlOperation(url);
  return (
    operation === "FavoriteTweet" ||
    operation === "CreateRetweet" ||
    operation === "CreateTweet" ||
    operation === "CreateNoteTweet"
  );
}

export function shouldHarvestTweets(url: string): boolean {
  const operation = graphqlOperation(url);
  if (!operation) return false;
  return operation !== "FavoriteTweet" && operation !== "UnfavoriteTweet";
}

export function postUrl(postId: string): string {
  return `https://x.com/i/status/${postId}`;
}

export function statusIdFromHref(href: string): string | null {
  const match = href.match(/\/status\/(\d+)/);
  return match?.[1] ?? null;
}

export function parseFavoriteTweetId(body: string): string | null {
  const variables = graphqlVariables(body);
  const tweetId = variables?.tweet_id;
  return typeof tweetId === "string" && tweetId.length > 0 ? tweetId : null;
}

export function parseReplyToTweetId(body: string): string | null {
  const variables = graphqlVariables(body);
  if (!variables) return null;
  const reply = asRecord(variables.reply);
  const candidates = [reply?.in_reply_to_tweet_id, reply?.in_reply_to_status_id, variables.in_reply_to_tweet_id];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return null;
}

export function engagementFromRequest(url: string, body: string | null): OutgoingEngagement | null {
  if (!body) return null;
  const operation = graphqlOperation(url);
  if (operation === "FavoriteTweet") {
    const tweetId = parseFavoriteTweetId(body);
    return tweetId ? { kind: "like", tweetId } : null;
  }
  if (operation === "CreateRetweet") {
    const tweetId = parseFavoriteTweetId(body);
    return tweetId ? { kind: "repost", tweetId } : null;
  }
  if (operation === "CreateTweet" || operation === "CreateNoteTweet") {
    const tweetId = parseReplyToTweetId(body);
    return tweetId ? { kind: "comment", tweetId } : null;
  }
  return null;
}

export function originalPostForEngagement(
  cache: ReadonlyMap<string, CachedTweet>,
  startId: string,
): { postId: string; tweet: CachedTweet | null } | null {
  const walked = walkToOriginalPost(cache, startId);
  if (walked) return walked;

  for (const tweet of cache.values()) {
    if (tweet.inReplyToStatusId !== startId || !tweet.conversationId) continue;
    if (tweet.conversationId === startId) return { postId: startId, tweet: cache.get(startId) ?? null };
    const root = cache.get(tweet.conversationId) ?? null;
    if (!root || !root.isReply) return { postId: tweet.conversationId, tweet: root };
  }

  return null;
}

const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

const RESERVED_PATHS = new Set([
  "home",
  "explore",
  "notifications",
  "messages",
  "settings",
  "i",
  "compose",
  "search",
  "jobs",
  "communities",
  "premium",
  "login",
  "signup",
  "tos",
  "privacy",
]);

export function usernameFromProfileHref(href: string): string | null {
  try {
    const segment = new URL(href, "https://x.com").pathname.split("/").filter(Boolean)[0];
    return usernameFromSegment(segment);
  } catch {
    return null;
  }
}

export function usernameFromAccountText(text: string): string | null {
  const match = text.match(/@([A-Za-z0-9_]{1,15})\b/);
  return usernameFromSegment(match?.[1]);
}

export function xUserIdFromTwidCookie(cookies: string): string | null {
  const twid = cookies.split(";").map((entry) => entry.trim()).find((entry) => entry.startsWith("twid="));
  if (!twid) return null;
  try {
    return /^u=([1-9][0-9]{0,19})$/.exec(decodeURIComponent(twid.slice(5)))?.[1] ?? null;
  } catch {
    return null;
  }
}

function usernameFromSegment(segment: string | undefined): string | null {
  if (!segment || !HANDLE.test(segment) || RESERVED_PATHS.has(segment.toLowerCase())) return null;
  return segment;
}

export function profileImageUrl(value: unknown): string | null {
  return httpsUrl(value);
}

export function profileImageUrlFromStyle(style: string): string | null {
  const match = /url\(\s*["']?(https:\/\/[^"')]+)["']?\s*\)/.exec(style);
  return httpsUrl(match?.[1]);
}

export function payloadFromCached(
  tweet: CachedTweet,
  likedAt: string,
  username: string,
  avatarUrl: string | null,
): LikedPostPayload {
  return {
    postId: tweet.postId,
    username,
    avatarUrl,
    text: tweet.text,
    media: tweet.media,
    url: postUrl(tweet.postId),
    likedAt,
  };
}

export function decideDomCapture(input: DomCaptureInput): DomDecision {
  if (!input.postId) return { action: "drop" };
  if (input.hasReplyingTo) return { action: "drop" };
  if (input.pageStatusId && input.pageStatusId !== input.postId) return { action: "drop" };
  return { action: "send", postId: input.postId };
}

export function collectTweets(value: unknown): CachedTweet[] {
  const tweets: CachedTweet[] = [];
  const seenObjects = new Set<object>();
  const seenIds = new Set<string>();

  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (seenObjects.has(node)) return;
    seenObjects.add(node);

    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }

    const tweet = readTweet(node as Record<string, unknown>);
    if (tweet && !seenIds.has(tweet.postId)) {
      seenIds.add(tweet.postId);
      tweets.push(tweet);
    }

    for (const entry of Object.values(node as Record<string, unknown>)) visit(entry);
  };

  visit(value);
  return tweets;
}

export function collectAccountIds(value: unknown): { username: string; xUserId: string }[] {
  const accounts: { username: string; xUserId: string }[] = [];
  const seen = new Set<object>();
  const stack: unknown[] = [value];
  while (stack.length && seen.size < 10_000 && accounts.length < 100) {
    const node = stack.pop();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      for (let i = 0; i < Math.min(node.length, 10_000 - seen.size); i++) stack.push(node[i]);
      continue;
    }
    const record = node as Record<string, unknown>;
    const legacy = asRecord(record.legacy);
    const core = asRecord(record.core);
    const id = typeof record.rest_id === "string" ? record.rest_id : record.id_str;
    const username = core?.screen_name ?? legacy?.screen_name ?? record.screen_name;
    const userRecord = record.__typename === "User" ||
      (typeof record.rest_id === "string" && typeof core?.screen_name === "string") ||
      (typeof record.rest_id === "string" && typeof legacy?.screen_name === "string") ||
      (typeof record.id_str === "string" && typeof record.screen_name === "string");
    if (typeof id === "string" && /^[1-9][0-9]{0,19}$/.test(id) &&
        typeof username === "string" && HANDLE.test(username) && userRecord) {
      accounts.push({ username, xUserId: id });
    }
    stack.push(...Object.values(record));
  }
  return accounts;
}

export function rememberTweets(cache: Map<string, CachedTweet>, tweets: CachedTweet[]): void {
  for (const tweet of tweets) {
    cache.set(tweet.postId, tweet);
    while (cache.size > TWEET_CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }
}

export function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

export function preferOriginalImage(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "pbs.twimg.com" && parsed.searchParams.has("name")) {
      parsed.searchParams.set("name", "orig");
    }
    return parsed.href;
  } catch {
    return url;
  }
}

function walkToOriginalPost(
  cache: ReadonlyMap<string, CachedTweet>,
  startId: string,
): { postId: string; tweet: CachedTweet | null } | null {
  const seen = new Set<string>();
  let id = startId;

  while (!seen.has(id)) {
    seen.add(id);
    const tweet = cache.get(id);
    if (!tweet) return null;
    if (!tweet.isReply) return { postId: tweet.postId, tweet };
    if (tweet.conversationId && tweet.conversationId !== tweet.postId) {
      const root = cache.get(tweet.conversationId) ?? null;
      if (!root || !root.isReply) return { postId: tweet.conversationId, tweet: root };
    }
    if (!tweet.inReplyToStatusId || seen.has(tweet.inReplyToStatusId)) return null;
    id = tweet.inReplyToStatusId;
  }

  return null;
}

function graphqlVariables(body: string): Record<string, unknown> | null {
  const trimmed = body.trim();
  if (!trimmed) return null;

  const direct = parseJsonRecord(trimmed);
  if (direct) return asRecord(direct.variables) ?? direct;

  try {
    const variables = new URLSearchParams(trimmed).get("variables");
    return variables ? parseJsonRecord(variables) : null;
  } catch {
    return null;
  }
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function readTweet(node: Record<string, unknown>): CachedTweet | null {
  if (typeof node.rest_id !== "string" || node.rest_id.length === 0) return null;
  const legacy = asRecord(node.legacy);
  if (!legacy) return null;
  if (!("full_text" in legacy) && !("in_reply_to_status_id_str" in legacy) && typeof legacy.id_str !== "string") {
    return null;
  }

  const replyId = legacy.in_reply_to_status_id_str;
  const fullText = typeof legacy.full_text === "string" ? legacy.full_text : null;
  const conversationId = legacy.conversation_id_str;

  return {
    postId: node.rest_id,
    text: readNoteText(node) ?? fullText,
    media: readMedia(legacy),
    isReply: typeof replyId === "string" && replyId.length > 0,
    conversationId: typeof conversationId === "string" && conversationId.length > 0 ? conversationId : null,
    inReplyToStatusId: typeof replyId === "string" && replyId.length > 0 ? replyId : null,
  };
}

function readNoteText(node: Record<string, unknown>): string | null {
  const noteTweet = asRecord(node.note_tweet);
  const noteResults = asRecord(noteTweet?.note_tweet_results);
  const result = asRecord(noteResults?.result) ?? asRecord(noteTweet?.result);
  const text = result?.text;
  return typeof text === "string" && text.length > 0 ? text : null;
}

function readMedia(legacy: Record<string, unknown>): MediaItem[] {
  const extended = asRecord(legacy.extended_entities);
  const entities = asRecord(legacy.entities);
  const list = asArray(extended?.media) ?? asArray(entities?.media) ?? [];
  const items: MediaItem[] = [];

  for (const entry of list) {
    const media = asRecord(entry);
    if (!media) continue;
    const item = mediaItem(media);
    if (item) items.push(item);
  }

  return items;
}

function mediaItem(media: Record<string, unknown>): MediaItem | null {
  if (media.type === "photo") {
    const url = httpsUrl(media.media_url_https) ?? httpsUrl(media.url);
    return url ? { type: "image", url: preferOriginalImage(url) } : null;
  }

  if (media.type === "video" || media.type === "animated_gif") {
    const videoUrl = bestMp4(media);
    if (videoUrl) return { type: "video", url: videoUrl };
    const thumb = httpsUrl(media.media_url_https);
    return thumb ? { type: "image", url: preferOriginalImage(thumb) } : null;
  }

  return null;
}

function bestMp4(media: Record<string, unknown>): string | null {
  const videoInfo = asRecord(media.video_info);
  const variants = asArray(videoInfo?.variants) ?? [];
  let best: { url: string; bitrate: number } | null = null;

  for (const entry of variants) {
    const variant = asRecord(entry);
    if (!variant || variant.content_type !== "video/mp4") continue;
    const url = httpsUrl(variant.url);
    if (!url) continue;
    const bitrate = typeof variant.bitrate === "number" ? variant.bitrate : 0;
    if (!best || bitrate > best.bitrate) best = { url, bitrate };
  }

  return best?.url ?? null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}
