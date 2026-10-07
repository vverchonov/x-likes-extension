const PAGE = "scrollx-page";
const EXTENSION = "scrollx-extension";

if (document.documentElement) document.documentElement.dataset.scrollx = "1";

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const data = event.data as { source?: unknown; id?: unknown; type?: unknown; force?: unknown; cursor?: unknown; xUserId?: unknown; xUserIds?: unknown } | null;
  if (!data || data.source !== PAGE || typeof data.id !== "string" || data.id.length === 0 || data.id.length > 64 || typeof data.type !== "string") return;
  void respond(data.id, { type: data.type, force: data.force, cursor: data.cursor, xUserId: data.xUserId, xUserIds: data.xUserIds });
});

async function respond(id: string, data: { type: string; force?: unknown; cursor?: unknown; xUserId?: unknown; xUserIds?: unknown }): Promise<void> {
  if (data.type === "ping") {
    post(id, { type: "pong" });
    return;
  }
  try {
    if (data.type === "accounts") {
      const result: unknown = await chrome.runtime.sendMessage({ type: "load-private-data", force: data.force === true });
      post(id, { result: stripKey(result) });
      return;
    }
    if (data.type === "feed-more") {
      const result: unknown = await chrome.runtime.sendMessage({ type: "history-next", cursor: data.cursor, xUserId: data.xUserId, xUserIds: data.xUserIds });
      post(id, { result });
    }
  } catch {
    post(id, { result: { ok: false } });
  }
}

function post(id: string, body: Record<string, unknown>): void {
  window.postMessage({ source: EXTENSION, id, ...body }, location.origin);
}

function stripKey(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as { ok?: unknown; data?: unknown };
  if (record.ok !== true || !record.data || typeof record.data !== "object") return value;
  const data = { ...(record.data as Record<string, unknown>) };
  delete data.publicKey;
  return { ...record, data };
}
