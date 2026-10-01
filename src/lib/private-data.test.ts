import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatSol, parseBalances, parseClaim, parseEvents, trackedAccounts } from "./private-data.ts";

describe("private backend contract", () => {
  it("parses cursor history with numeric attribution and a finalized token link", () => {
    const payload = { postId: "67890", xUserId: "12345", username: "alice", avatarUrl: null, text: null, media: [], url: "https://x.com/i/status/67890", likedAt: "2026-09-21T19:20:00.000Z" };
    const row = { ...payload, id: "event", intentId: "intent", receivedAt: payload.likedAt, status: "received", processingStatus: "pending", canForceCreate: false, tokenUrl: null, creatorEarningsLamports: null };
    assert.deepEqual(parseEvents({ events: [row], nextCursor: "opaque" }).events[0]?.processingStatus, "pending");
    assert.equal(parseEvents({ events: [{ ...row, processingStatus: "rejected", canForceCreate: true }], nextCursor: null }).events[0]?.canForceCreate, true);
    assert.equal(parseEvents({ events: [{ ...row, processingStatus: "finalized", tokenUrl: "https://pump.fun/coin/mint", creatorEarningsLamports: "0" }], nextCursor: null }).events[0]?.tokenUrl, "https://pump.fun/coin/mint");
    assert.equal(parseEvents({ events: [{ ...row, processingStatus: "finalized", tokenUrl: "https://pump.fun/coin/mint", creatorEarningsLamports: "12345678901234567890" }], nextCursor: null }).events[0]?.creatorEarningsLamports, "12345678901234567890");
    const claimed = { ...row, intentId: null, processingStatus: "already_claimed", canForceCreate: false, creatorEarningsLamports: null };
    assert.equal(parseEvents({ events: [{ ...claimed, tokenUrl: "https://pump.fun/coin/mint" }], nextCursor: null }).events[0]?.tokenUrl, "https://pump.fun/coin/mint");
    assert.equal(parseEvents({ events: [claimed], nextCursor: null }).events[0]?.tokenUrl, null);
    assert.throws(() => parseEvents({ events: [{ ...claimed, tokenUrl: "http://pump.fun/coin/mint" }], nextCursor: null }));
    assert.equal(formatSol("12345678901234567890"), "12345678901.23456789 SOL");
    assert.deepEqual(parseEvents({ events: [], nextCursor: null }), { events: [], nextCursor: null });
    assert.throws(() => parseEvents({ events: [{ ...row, xUserId: "alice" }], nextCursor: null }));
    assert.throws(() => parseEvents({ events: [{ ...row, canForceCreate: true }], nextCursor: null }));
    assert.throws(() => parseEvents({ events: [{ ...row, processingStatus: "rejected", canForceCreate: "yes" }], nextCursor: null }));
    assert.throws(() => parseEvents({ events: [{ ...row, creatorEarningsLamports: "0" }], nextCursor: null }));
    for (const amount of [null, "-1", "1.5", "01", undefined]) {
      assert.throws(() => parseEvents({ events: [{ ...row, processingStatus: "finalized", creatorEarningsLamports: amount }], nextCursor: null }));
    }
  });

  it("keeps SOL balances and pending claims distinct from price availability and final payment", () => {
    const balances = parseBalances({ accounts: [{ xUserId: "12345", availableLamports: "50000000", pendingLamports: "100", claimedLamports: "20", paused: false }], combined: { availableLamports: "50000000", pendingLamports: "100", claimedLamports: "20" }, claimEligibility: { available: false, reason: "quote_stale", solUsd: "100.000000", quoteAt: "2026-09-21T19:20:00.000Z" } });
    assert.equal(balances.accounts[0]?.availableLamports, "50000000");
    assert.equal(balances.claimEligibility.reason, "quote_stale");
    assert.equal(formatSol("50000000"), "0.05 SOL");
    assert.equal(parseClaim({ id: "claim", status: "held", amountLamports: "50000000", destination: "11111111111111111111111111111111", transactionSignature: null }).status, "held");
    assert.throws(() => parseClaim({ id: "claim", status: "paid", amountLamports: "50000000", destination: "11111111111111111111111111111111", transactionSignature: null }));
  });

  it("uses numeric IDs as the tracked account key across handle changes", () => {
    assert.deepEqual(trackedAccounts([{ xUserId: "12345", username: "alice" }, { xUserId: "12345", username: "renamed" }, { xUserId: "bob", username: "bob" }]), [{ xUserId: "12345", username: "alice" }]);
  });
});
