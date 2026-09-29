import { isLikedUsername } from "./accounts.ts";
import { parseLikedPost } from "./history.ts";
import { isSolanaAddress } from "./solana.ts";
import type { LikedPostPayload } from "./types.ts";

export type TrackedAccount = { xUserId: string; username: string };
export type ProcessingStatus = "pending" | "deferred" | "grounding" | "filtering" | "rejected" | "manual_review" | "generating" | "ready" | "sending" | "unresolved" | "finalized" | "failed";
export type EventRow = LikedPostPayload & { id: string; xUserId: string; intentId: string; receivedAt: string; status: "received"; processingStatus: ProcessingStatus; tokenUrl: string | null; creatorEarningsLamports: string | null };
export type Balance = { xUserId: string; availableLamports: string; pendingLamports: string; claimedLamports: string; paused: boolean };
export type EligibilityReason = "below_minimum" | "quote_unavailable" | "quote_stale" | "disputed" | "unauthorized";
export type Balances = { accounts: Balance[]; combined: Omit<Balance, "xUserId" | "paused">; claimEligibility: { available: boolean; reason: EligibilityReason | null; solUsd: string | null; quoteAt: string | null } };
export type Claim = { id: string; status: "pending" | "held" | "confirmed" | "failed" | "canceled"; amountLamports: string; destination: string; transactionSignature: string | null };

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

export function parseEvents(value: unknown): { events: EventRow[]; nextCursor: string | null } {
  if (!value || typeof value !== "object") throw new Error("Invalid history");
  const { events, nextCursor } = value as { events?: unknown; nextCursor?: unknown };
  if (!Array.isArray(events) || !(nextCursor === null || typeof nextCursor === "string" && nextCursor.length > 0)) throw new Error("Invalid history");
  const statuses: ProcessingStatus[] = ["pending", "deferred", "grounding", "filtering", "rejected", "manual_review", "generating", "ready", "sending", "unresolved", "finalized", "failed"];
  const rows = events.map((item) => {
    const post = parseLikedPost(item);
    const row = item as Partial<EventRow>;
    if (!post || !isXUserId(row.xUserId) || typeof row.id !== "string" || typeof row.intentId !== "string" || typeof row.receivedAt !== "string" || row.status !== "received" || !statuses.includes(row.processingStatus as ProcessingStatus) || !(row.tokenUrl === null || typeof row.tokenUrl === "string") || (row.processingStatus === "finalized" ? !lamports(row.creatorEarningsLamports) : row.creatorEarningsLamports !== null)) throw new Error("Invalid history row");
    let tokenUrl: string | null = null;
    if (row.processingStatus === "finalized" && row.tokenUrl) {
      const url = new URL(row.tokenUrl);
      if (url.protocol !== "https:") throw new Error("Invalid token URL");
      tokenUrl = url.href;
    }
    return { ...post, id: row.id, xUserId: row.xUserId, intentId: row.intentId, receivedAt: row.receivedAt, status: "received" as const, processingStatus: row.processingStatus as ProcessingStatus, tokenUrl, creatorEarningsLamports: row.creatorEarningsLamports ?? null };
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

export function formatSol(value: string): string {
  const amount = BigInt(value);
  const whole = amount / 1_000_000_000n;
  const fraction = (amount % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} SOL`;
}
