const DATABASE = "likes-identity";
const STORE = "keys";
const BACKUP_PREFIX = "scrollx-identity-v1:";

interface Identity {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function storedIdentity(): Promise<Identity | undefined> {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get("application");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result as Identity | undefined);
    });
  } finally {
    db.close();
  }
}

async function saveIdentity(identity: Identity): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite");
      transaction.objectStore(STORE).put(identity, "application");
      transaction.onerror = () => reject(transaction.error);
      transaction.oncomplete = () => resolve();
    });
  } finally {
    db.close();
  }
}

let pending: Promise<Identity> | undefined;
let replacement: Promise<{ xUserId: string; username: string }[]> | undefined;

export async function applicationIdentity(): Promise<Identity> {
  if (replacement) await replacement;
  pending ??= (async () => {
    const existing = await storedIdentity();
    if (existing) return existing;
    const generated = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const identity = { publicKey: generated.publicKey, privateKey: generated.privateKey };
    await saveIdentity(identity);
    return identity;
  })().catch((error: unknown) => {
    pending = undefined;
    throw error;
  });
  return pending;
}

export function encode(bytes: ArrayBuffer): string {
  const data = new Uint8Array(bytes);
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function applicationPublicKey(): Promise<string> {
  return encode(await crypto.subtle.exportKey("raw", (await applicationIdentity()).publicKey));
}

export async function sign(message: string): Promise<string> {
  return encode(await crypto.subtle.sign("Ed25519", (await applicationIdentity()).privateKey, new TextEncoder().encode(message)));
}

export async function exportBackup(accounts: { xUserId: string; username: string }[] = []): Promise<string> {
  const key = await crypto.subtle.exportKey("jwk", (await applicationIdentity()).privateKey);
  return BACKUP_PREFIX + encode(new TextEncoder().encode(JSON.stringify({ version: 1, key, accounts })).buffer);
}

export async function importBackup(backup: string): Promise<{ xUserId: string; username: string }[]> {
  if (replacement) await replacement;
  const importing = restoreBackup(backup);
  replacement = importing;
  try {
    return await importing;
  } finally {
    if (replacement === importing) replacement = undefined;
  }
}

async function restoreBackup(backup: string): Promise<{ xUserId: string; username: string }[]> {
  let value = backup.trim();
  if (value.startsWith(BACKUP_PREFIX)) {
    const encoded = value.slice(BACKUP_PREFIX.length);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("Invalid identity backup");
    const binary = atob(encoded.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(encoded.length / 4) * 4, "="));
    value = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  }
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid identity backup");
  const { version, key, accounts } = parsed as { version?: unknown; key?: unknown; accounts?: unknown };
  if (version !== 1 || !key || typeof key !== "object") throw new Error("Invalid identity backup");
  if (accounts !== undefined && (!Array.isArray(accounts) || accounts.length > 100 || accounts.some((entry) => !entry || typeof entry !== "object" || typeof entry.xUserId !== "string" || !/^[1-9][0-9]{0,19}$/.test(entry.xUserId) || typeof entry.username !== "string" || !/^[A-Za-z0-9_]{1,15}$/.test(entry.username)))) throw new Error("Invalid backup accounts");
  const jwk = key as JsonWebKey;
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.x || !jwk.d) throw new Error("Invalid identity backup");
  const privateKey = await crypto.subtle.importKey("jwk", jwk, "Ed25519", true, ["sign"]);
  const publicKey = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x }, "Ed25519", true, ["verify"]);
  const message = new TextEncoder().encode("likes-identity-import-v1");
  const signature = await crypto.subtle.sign("Ed25519", privateKey, message);
  if (!(await crypto.subtle.verify("Ed25519", publicKey, signature, message))) throw new Error("Backup key pair does not match");
  await pending;
  const identity = { privateKey, publicKey };
  await saveIdentity(identity);
  pending = Promise.resolve(identity);
  return (accounts ?? []) as { xUserId: string; username: string }[];
}
