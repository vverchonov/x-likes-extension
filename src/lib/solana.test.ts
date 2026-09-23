import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSolanaAddress } from "./solana.ts";

describe("isSolanaAddress", () => {
  it("accepts a 32-byte Solana address", () => {
    assert.equal(isSolanaAddress("11111111111111111111111111111111"), true);
    assert.equal(isSolanaAddress("So11111111111111111111111111111111111111112"), true);
    assert.equal(isSolanaAddress("  So11111111111111111111111111111111111111112  "), true);
  });

  it("rejects addresses that are not a Solana public key", () => {
    assert.equal(isSolanaAddress(""), false);
    assert.equal(isSolanaAddress("not-a-wallet"), false);
    assert.equal(isSolanaAddress("0OIl"), false);
    assert.equal(isSolanaAddress("1111111111111111111111111111111"), false);
  });
});
