import { BE_ENDPOINT } from "../config.ts";
import { applicationPublicKey, sign } from "./identity.ts";

const origin = new URL(BE_ENDPOINT).origin;
const encoder = new TextEncoder();

interface Session {
  token: string;
  expiresAt: number;
}

let session: Session | undefined;
let renewal: Promise<Session> | undefined;
let identityVersion = 0;

export function forgetSession(): void {
  identityVersion++;
  session = undefined;
  renewal = undefined;
}

async function openSession(): Promise<Session> {
  const publicKey = await applicationPublicKey();
  const challengeResponse = await fetch(`${origin}/v1/auth/challenges`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ publicKey }),
  });
  if (!challengeResponse.ok) throw new Error(`Challenge failed: ${challengeResponse.status}`);
  const challenge = (await challengeResponse.json()) as { challengeId: string; message: string };
  const signature = await sign(challenge.message);
  const response = await fetch(`${origin}/v1/auth/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId: challenge.challengeId, signature }),
  });
  if (!response.ok) throw new Error(`Session failed: ${response.status}`);
  const result = (await response.json()) as { token: string; expiresAt: string };
  return { token: result.token, expiresAt: Date.parse(result.expiresAt) };
}

async function currentSession(): Promise<Session> {
  if (session && session.expiresAt > Date.now() + 60_000) return session;
  if (!renewal) {
    const version = identityVersion;
    const attempt = openSession().then((created) => {
      if (identityVersion !== version) throw new Error("Identity changed during session renewal");
      session = created;
      return created;
    });
    const active = attempt.finally(() => {
      if (renewal === active) renewal = undefined;
    });
    renewal = active;
  }
  return renewal;
}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function privateRequest(method: string, target: string, payload?: unknown): Promise<Response> {
  if (!target.startsWith("/v1/") || target.startsWith("//")) throw new Error("Invalid private endpoint");
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const version = identityVersion;
  let active = await currentSession();
  if (identityVersion !== version) throw new Error("Identity changed during signed request");
  let response = await signedFetch(active);
  if (response.status === 401 && identityVersion === version) {
    forgetSession();
    active = await currentSession();
    response = await signedFetch(active);
  }
  return response;

  async function signedFetch(current: Session): Promise<Response> {
    const requestVersion = identityVersion;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomUUID();
    const message = [
      "x-extension-request-v1", origin, method, target, timestamp, nonce,
      await hash(current.token), await hash(body),
    ].join("\n");
    const signature = await sign(message);
    if (identityVersion !== requestVersion) throw new Error("Identity changed during signed request");
    return fetch(`${origin}${target}`, {
      method,
      headers: {
        authorization: `Bearer ${current.token}`,
        "x-request-timestamp": timestamp,
        "x-request-nonce": nonce,
        "x-request-signature": signature,
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(payload === undefined ? {} : { body }),
    });
  }
}
