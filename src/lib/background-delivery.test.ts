import assert from "node:assert/strict";
import { it } from "node:test";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";

it("persists an undelivered observation and an alarm delivers its original payload", { timeout: 5000 }, async () => {
  const stored: Record<string, unknown> = { disclaimerAcceptedV2: true, captureEnabled: true };
  const requests: unknown[] = [];
  let receive!: (message: unknown, sender: chrome.runtime.MessageSender, reply: (value: unknown) => void) => unknown;
  let alarm!: (value: { name: string }) => void;
  let retryAlarm = "";
  let notify!: () => void;
  const delivered = new Promise<void>((resolve) => { notify = resolve; });
  const result = await build({
    entryPoints: ["src/background.ts"], bundle: true, write: false, platform: "browser", format: "iife",
    define: { __BE_ENDPOINT__: '"https://api.example.test"', __X_PROFILE_URL__: '"https://x.com/example"', __WEBSITE_URL__: '"https://example.test"', __SITE_ORIGINS__: '[]' },
    plugins: [{ name: "signed-transport-fixture", setup(builder) {
      builder.onLoad({ filter: /\/lib\/api\.ts$/ }, () => ({ contents: "export const privateRequest = globalThis.testRequest; export function forgetSession() {}", loader: "js" }));
      builder.onLoad({ filter: /\/lib\/identity\.ts$/ }, () => ({ contents: "export async function applicationPublicKey() { return 'identity-fixture'; } export async function exportBackup() {} export async function importBackup() { return []; }", loader: "js" }));
    } }]
  });
  runInNewContext(result.outputFiles[0]!.text, {
    URL, URLSearchParams, Response, console: { error() {} },
    testRequest: async (_method: string, _target: string, payload: unknown) => {
      requests.push(payload);
      return new Response(null, { status: requests.length === 1 ? 503 : 201 });
    },
    chrome: {
      alarms: { create(name: string) { retryAlarm = name; }, onAlarm: { addListener(listener: typeof alarm) { alarm = listener; } } },
      storage: { onChanged: { addListener() {} }, local: {
        async get(keys: string | string[] | Record<string, unknown> | null) {
          if (keys === null) return { ...stored };
          if (typeof keys === "string") return { [keys]: stored[keys] };
          if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, stored[key]]));
          return { ...keys, ...Object.fromEntries(Object.keys(keys).filter((key) => key in stored).map((key) => [key, stored[key]])) };
        },
        async set(value: Record<string, unknown>) { Object.assign(stored, value); },
        async remove(keys: string | string[]) { for (const key of typeof keys === "string" ? [keys] : keys) delete stored[key]; }
      } },
      runtime: {
        id: "extension-fixture", getURL: (path: string) => `chrome-extension://extension-fixture/${path}`,
        onMessage: { addListener(listener: typeof receive) { receive = listener; } },
        async sendMessage(message: { type: string }) { if (message.type === "observation-delivered") notify(); }
      }
    }
  });
  const payload = { xUserId: "12345", postId: "67890", username: "alice", avatarUrl: null, text: "First observation", media: [], url: "https://x.com/i/status/67890", likedAt: "2026-10-07T19:20:00.000Z" };
  const sender = { id: "extension-fixture", url: "https://x.com/home", tab: { id: 1 } } as chrome.runtime.MessageSender;
  await new Promise((resolve) => { assert.equal(receive({ type: "liked-post", payload }, sender, resolve), true); });
  const pendingKey = "pendingObservation:12345:67890";
  assert.ok(stored[pendingKey]);
  assert.equal(requests.length, 1);
  alarm({ name: retryAlarm });
  await delivered;
  assert.equal(stored[pendingKey], undefined);
  assert.equal(requests.length, 2);
  assert.equal(JSON.stringify(requests[0]), JSON.stringify(payload));
  assert.equal(JSON.stringify(requests[1]), JSON.stringify(payload));
});
