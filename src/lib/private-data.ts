import { isLikedUsername } from "./accounts.ts";
import { parseLikedPost } from "./history.ts";
import { isSolanaAddress } from "./solana.ts";
import type { LikedPostPayload } from "./types.ts";

export type TrackedAccount = { xUserId: string; username: string };
export type LaunchCapacity = { xUserId: string; used: number; limit: number };
export type AccountStatistics = { xUserId: string; engagements: number; tokensCreated: number; attributedRewardsLamports: string };
export type ProcessingStatus = "already_claimed" | "pending" | "deferred" | "grounding" | "filtering" | "rejected" | "generating" | "ready" | "sending" | "unresolved" | "finalized" | "failed";
export type EventRow = LikedPostPayload & { id: string; xUserId: string; intentId: string | null; receivedAt: string; status: "received"; processingStatus: ProcessingStatus; canForceCreate: boolean; tokenUrl: string | null; creatorEarningsLamports: string | null };
export type Balance = { xUserId: string; availableLamports: string; pendingLamports: string; claimedLamports: string; paused: boolean };
export type EligibilityReason = "below_minimum" | "quote_unavailable" | "quote_stale" | "disputed" | "unauthorized";
export type Balances = { accounts: Balance[]; combined: Omit<Balance, "xUserId" | "paused">; claimEligibility: { available: boolean; reason: EligibilityReason | null; solUsd: string | null; quoteAt: string | null } };
export type Claim = { id: string; status: "pending" | "held" | "confirmed" | "failed" | "canceled"; amountLamports: string; destination: string; transactionSignature: string | null };
export type ClaimHistory = Claim & { createdAt: string };

export function isXUserId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value);
}

export function trackedAccounts(value: unknown): TrackedAccount[] {
  if (!Array.isArray(value)) return [];
  const result: TrackedAccount[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const { xUserId, username } = item as Partial<TrackedAccount>;
    if (isXUserId(xUserId) && isLikedUsername(username) && !result.some((entry) => entry.xUserId === xUserId)) result.push({ xUserId, username });
  }
  return result;
}

export function validIds(value: unknown): string[] {
  return Array.isArray(value) && value.length <= 100 && value.every(isXUserId) && new Set(value).size === value.length ? value : [];
}

export function parseLaunchCapacity(value: unknown): LaunchCapacity[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { accounts?: unknown }).accounts)) throw new Error("Invalid launch capacity");
  return (value as { accounts: unknown[] }).accounts.map((entry) => {
    const row = entry as Partial<LaunchCapacity> | null;
    if (!row || !isXUserId(row.xUserId) || !Number.isSafeInteger(row.used) || row.used! < 0 || !Number.isSafeInteger(row.limit) || row.limit! < 1) throw new Error("Invalid launch capacity");
    return { xUserId: row.xUserId, used: row.used!, limit: row.limit! };
  });
}

export function parseAccountStatistics(value: unknown): AccountStatistics[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { accounts?: unknown }).accounts)) throw new Error("Invalid account statistics");
  return (value as { accounts: unknown[] }).accounts.map((entry) => {
    const row = entry as Partial<AccountStatistics> | null;
    if (!row || !isXUserId(row.xUserId) || !Number.isSafeInteger(row.engagements) || row.engagements! < 0 || !Number.isSafeInteger(row.tokensCreated) || row.tokensCreated! < 0 || !lamports(row.attributedRewardsLamports)) throw new Error("Invalid account statistics");
    return { xUserId: row.xUserId, engagements: row.engagements!, tokensCreated: row.tokensCreated!, attributedRewardsLamports: row.attributedRewardsLamports };
  });
}

export function parseEvents(value: unknown): { events: EventRow[]; nextCursor: string | null } {
  if (!value || typeof value !== "object") throw new Error("Invalid history");
  const { events, nextCursor } = value as { events?: unknown; nextCursor?: unknown };
  if (!Array.isArray(events) || !(nextCursor === null || typeof nextCursor === "string" && nextCursor.length > 0)) throw new Error("Invalid history");
  const statuses: ProcessingStatus[] = ["already_claimed", "pending", "deferred", "grounding", "filtering", "rejected", "generating", "ready", "sending", "unresolved", "finalized", "failed"];
  const rows = events.map((item) => {
    const post = parseLikedPost(item);
    const row = item as Partial<EventRow>;
    if (!post || !isXUserId(row.xUserId) || typeof row.id !== "string" || !(typeof row.intentId === "string" || (row.intentId === null && row.processingStatus === "already_claimed")) || (row.intentId !== null && row.processingStatus === "already_claimed") || typeof row.receivedAt !== "string" || row.status !== "received" || !statuses.includes(row.processingStatus as ProcessingStatus) || typeof row.canForceCreate !== "boolean" || (row.canForceCreate && (row.processingStatus !== "rejected" || typeof row.intentId !== "string")) || !(row.tokenUrl === null || typeof row.tokenUrl === "string") || (row.processingStatus === "finalized" ? !lamports(row.creatorEarningsLamports) : row.creatorEarningsLamports !== null)) throw new Error("Invalid history row");
    let tokenUrl: string | null = null;
    if ((row.processingStatus === "finalized" || row.processingStatus === "already_claimed") && row.tokenUrl) {
      const url = new URL(row.tokenUrl);
      if (url.protocol !== "https:") throw new Error("Invalid token URL");
      tokenUrl = url.href;
    }
    return { ...post, id: row.id, xUserId: row.xUserId, intentId: row.intentId, receivedAt: row.receivedAt, status: "received" as const, processingStatus: row.processingStatus as ProcessingStatus, canForceCreate: row.canForceCreate, tokenUrl, creatorEarningsLamports: row.creatorEarningsLamports ?? null };
  });
  return { events: rows, nextCursor };
}

function lamports(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
}

export function parseBalances(value: unknown): Balances {
  if (!value || typeof value !== "object") throw new Error("Invalid balances");
  const data = value as Partial<Balances>;
  const validAmounts = (entry: Partial<Balance>) => lamports(entry.availableLamports) && lamports(entry.pendingLamports) && lamports(entry.claimedLamports);
  if (!Array.isArray(data.accounts) || !data.accounts.every((entry) => entry && isXUserId(entry.xUserId) && validAmounts(entry) && typeof entry.paused === "boolean") || !data.combined || !validAmounts(data.combined) || !data.claimEligibility || typeof data.claimEligibility.available !== "boolean" || !(data.claimEligibility.reason === null || ["below_minimum", "quote_unavailable", "quote_stale", "disputed", "unauthorized"].includes(data.claimEligibility.reason as string)) || !(data.claimEligibility.solUsd === null || typeof data.claimEligibility.solUsd === "string") || !(data.claimEligibility.quoteAt === null || typeof data.claimEligibility.quoteAt === "string")) throw new Error("Invalid balances");
  return data as Balances;
}

export function parseClaim(value: unknown): Claim {
  if (!value || typeof value !== "object") throw new Error("Invalid claim");
  const claim = value as Partial<Claim>;
  if (typeof claim.id !== "string" || !["pending", "held", "confirmed", "failed", "canceled"].includes(claim.status ?? "") || !lamports(claim.amountLamports) || typeof claim.destination !== "string" || !isSolanaAddress(claim.destination) || !(claim.transactionSignature === null || typeof claim.transactionSignature === "string")) throw new Error("Invalid claim");
  return claim as Claim;
}

export function parseClaimHistory(value: unknown): { claims: ClaimHistory[]; nextCursor: string | null } {
  if (!value || typeof value !== "object") throw new Error("Invalid claim history");
  const { claims, nextCursor } = value as { claims?: unknown; nextCursor?: unknown };
  if (!Array.isArray(claims) || !(nextCursor === null || typeof nextCursor === "string" && nextCursor.length > 0)) throw new Error("Invalid claim history");
  return { claims: claims.map((item) => {
    const claim = parseClaim(item);
    const createdAt = (item as { createdAt?: unknown }).createdAt;
    if (typeof createdAt !== "string" || !createdAt || Number.isNaN(Date.parse(createdAt))) throw new Error("Invalid claim date");
    return { ...claim, createdAt };
  }), nextCursor };
}

export function formatSol(value: string): string {
  const amount = BigInt(value);
  const whole = amount / 1_000_000_000n;
  const fraction = (amount % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} SOL`;
}

export function formatUsd(lamportAmount: string, solUsd: string | null): string | null {
  if (!solUsd || !/^\d+(?:\.\d+)?$/.test(solUsd)) return null;
  const [whole = "0", fraction = ""] = solUsd.split(".");
  const price = BigInt(whole + fraction);
  if (price === 0n) return null;
  const numerator = BigInt(lamportAmount) * price * 100n;
  const denominator = 1_000_000_000n * 10n ** BigInt(fraction.length);
  const cents = (numerator + denominator / 2n) / denominator;
  if (numerator > 0n && cents === 0n) return "<$0.01";
  return `$${new Intl.NumberFormat("en-US").format(cents / 100n)}.${(cents % 100n).toString().padStart(2, "0")}`;
}
