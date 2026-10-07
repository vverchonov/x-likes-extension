import assert from "node:assert/strict";
import { it } from "node:test";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";

class ElementFixture {
  children: ElementFixture[] = [];
  parent: ElementFixture | null = null;
  dataset: Record<string, string> = {};
  className = "";
  textContent = "";
  scrollTop = 0;
  get childElementCount() { return this.children.length; }
  append(...children: ElementFixture[]) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children: ElementFixture[]) { this.children = []; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
  querySelector(selector: string) {
    if (selector === ".post:last-of-type") return this.children.filter((child) => child.className === "post").at(-1) ?? null;
    return this.children.find((child) => `.${child.className}` === selector) ?? null;
  }
  addEventListener() {}
  setAttribute() {}
}

it("refresh during pagination releases stale loading state so the new cursor can load", { timeout: 5000 }, async () => {
  const timeline = new ElementFixture();
  const accounts = new ElementFixture();
  let intersection!: (entries: { isIntersecting: boolean }[]) => void;
  let refreshes = 0;
  const pages: { cursor: string; resolve: (value: unknown) => void }[] = [];
  const post = (id: string) => ({ id, intentId: `intent-${id}`, xUserId: "12345", postId: id, username: "alice", avatarUrl: null, text: null, media: [], url: `https://x.com/i/status/${id}`, likedAt: "2026-10-07T19:20:00.000Z", receivedAt: "2026-10-07T19:20:00.000Z", status: "received", processingStatus: "pending", canForceCreate: false, tokenUrl: null, creatorEarningsLamports: null });
  const output = await build({ entryPoints: ["src/popup/private-view.ts"], bundle: true, write: false, platform: "browser", format: "cjs", define: { __BE_ENDPOINT__: '"https://api.example.test"', __X_PROFILE_URL__: '"https://x.com/example"', __WEBSITE_URL__: '"https://example.test"', __SITE_ORIGINS__: '[]' } });
  const module = { exports: {} as { refreshPrivateView: (force: boolean, quiet?: boolean) => Promise<void> } };
  runInNewContext(output.outputFiles[0]!.text, {
    module, URL, URLSearchParams, Intl, HTMLElement: ElementFixture, HTMLButtonElement: class {}, HTMLVideoElement: class {},
    document: { querySelector: (selector: string) => selector === "#timeline" ? timeline : selector === "#accounts-list" ? accounts : null, createElement: () => new ElementFixture() },
    IntersectionObserver: class { constructor(callback: typeof intersection) { intersection = callback; } observe() {} disconnect() {} },
    chrome: { runtime: { async sendMessage(message: { type: string; cursor?: string }) {
      if (message.type === "load-private-data") {
        refreshes++;
        return { ok: true, data: { accounts: [{ xUserId: "12345", username: "alice" }], events: [post("1")], nextCursor: `cursor-${refreshes}`, balances: null, capacity: null, statistics: null, verification: null } };
      }
      return new Promise((resolve) => { pages.push({ cursor: message.cursor!, resolve }); });
    } } }
  });
  await module.exports.refreshPrivateView(true);
  intersection([{ isIntersecting: true }]);
  assert.equal(pages[0]?.cursor, "cursor-1");
  await module.exports.refreshPrivateView(true, true);
  assert.equal(refreshes, 1, "Quiet refresh must not interrupt a page request");
  await module.exports.refreshPrivateView(true);
  pages[0]!.resolve({ ok: true, events: [post("2")], nextCursor: null });
  await new Promise<void>((resolve) => setImmediate(resolve));
  intersection([{ isIntersecting: true }]);
  assert.equal(pages[1]?.cursor, "cursor-2", "Stale response must release loading and preserve the refreshed cursor");
  pages[1]!.resolve({ ok: true, events: [post("2")], nextCursor: null });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(timeline.children.filter((child) => child.className === "post").length, 2);
  assert.equal(timeline.children.some((child) => child.className === "feed-more"), false);
});
