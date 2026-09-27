import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canRequestPayout,
  formatPayout,
  isLikedUsername,
  earningsFor,
  LIKES_CACHE_MS,
  likesUrl,
  parseLikesList,
  parseLikesResponse,
  payoutClaim,
  readLikesCache,
} from "./likes.ts";

const like = {
  postId: "1",
  username: "current_user",
  avatarUrl: null,
  text: "Hello",
  media: [],
  url: "https://x.com/i/status/1",
  likedAt: "2026-09-21T19:40:00.000Z",
};

describe("likesUrl", () => {
  it("asks for likes from every tracked account", () => {
    assert.equal(
      likesUrl("https://example.com/api/likes", ["other_user", "current_user"]),
      "https://example.com/api/likes?usernames=other_user%2Ccurrent_user",
    );
  });
});

describe("parseLikesResponse", () => {
  it("keeps a coin link only when the backend sends a page url", () => {
    const posts = parseLikesResponse({
      likes: [
        { ...like, coinUrl: "https://pump.fun/coin/abc" },
        { ...like, postId: "2", likedAt: "2026-09-21T18:00:00.000Z", coinUrl: null },
        { ...like, postId: "3", likedAt: "2026-09-21T20:00:00.000Z" },
      ],
    });

    assert.deepEqual(
      posts.map((post) => ({ postId: post.postId, coinUrl: post.coinUrl })),
      [
        { postId: "3", coinUrl: null },
        { postId: "1", coinUrl: "https://pump.fun/coin/abc" },
        { postId: "2", coinUrl: null },
      ],
    );
  });

  it("keeps a coin earning and drops a missing or invalid one", () => {
    const posts = parseLikesResponse({
      likes: [
        { ...like, earning: 12.5 },
        { ...like, postId: "2", likedAt: "2026-09-21T18:00:00.000Z" },
        { ...like, postId: "3", likedAt: "2026-09-21T17:00:00.000Z", earning: -1 },
      ],
    });
    assert.deepEqual(
      posts.map((post) => post.earning),
      [12.5, null, null],
    );
  });

  it("drops a coin url that is not a page", () => {
    const posts = parseLikesResponse({
      likes: [{ ...like, coinUrl: "javascript:alert(1)" }],
    });
    assert.equal(posts[0]?.coinUrl, null);
  });

  it("keeps likes from every tracked account and orders them newest first", () => {
    const posts = parseLikesResponse({
      likes: [
        { ...like, likedAt: "2026-09-21T18:00:00.000Z" },
        { ...like, postId: "2", username: "other_user", likedAt: "2026-09-21T20:00:00.000Z" },
      ],
    });
    assert.deepEqual(
      posts.map((post) => ({ postId: post.postId, username: post.username })),
      [
        { postId: "2", username: "other_user" },
        { postId: "1", username: "current_user" },
      ],
    );
  });

  it("returns nothing when the payload is not a likes list", () => {
    assert.deepEqual(parseLikesResponse(null), []);
    assert.deepEqual(parseLikesResponse({ likes: "nope" }), []);
  });
});

describe("parseLikesList", () => {
  it("reads the payout balance and treats a missing balance as zero", () => {
    assert.equal(parseLikesList({ balance: 12.5, likes: [like] }).balance, 12.5);
    assert.equal(parseLikesList({ likes: [like] }).balance, 0);
    assert.equal(parseLikesList({ balance: -3, likes: [] }).balance, 0);
  });
});

describe("payoutClaim", () => {
  it("builds a claim only for a real Solana address above five dollars", () => {
    assert.deepEqual(payoutClaim("current_user", "11111111111111111111111111111111", 6, ["other_user"]), {
      type: "payout",
      username: "current_user",
      usernames: ["other_user", "current_user"],
      wallet: "11111111111111111111111111111111",
      balance: 6,
    });
    assert.equal(payoutClaim("current_user", "11111111111111111111111111111111", 5, ["current_user"]), null);
    assert.equal(payoutClaim("current_user", "not-a-wallet", 6, ["current_user"]), null);
  });
});

describe("earningsFor", () => {
  it("keeps a reported balance and leaves the rest unknown", () => {
    assert.deepEqual(earningsFor(["current_user", "other_user"], [{ username: "other_user", balance: 6 }]), [
      { username: "current_user", balance: null },
      { username: "other_user", balance: 6 },
    ]);
    assert.deepEqual(earningsFor(["current_user"], []), [{ username: "current_user", balance: null }]);
  });
});

describe("canRequestPayout", () => {
  it("allows a payout only above five dollars", () => {
    assert.equal(canRequestPayout(5), false);
    assert.equal(canRequestPayout(5.01), true);
    assert.equal(formatPayout(5), "$5.00");
    assert.equal(formatPayout(12.5), "$12.50");
  });
});

describe("readLikesCache", () => {
  const now = Date.parse("2026-09-22T16:00:00.000Z");
  const accounts = ["other_user", "current_user"];
  const cache = {
    username: "current_user",
    accounts,
    fetchedAt: now - 30_000,
    balance: 8,
    likes: [{ ...like, coinUrl: "https://pump.fun/coin/abc" }],
  };

  it("reuses a response from the last minute for the same accounts", () => {
    const cached = readLikesCache(cache, accounts, now);
    assert.equal(cached?.balance, 8);
    assert.equal(cached?.likes[0]?.postId, "1");
    assert.equal(cached?.likes[0]?.coinUrl, "https://pump.fun/coin/abc");
  });

  it("ignores a response that is a minute old or for another set of accounts", () => {
    assert.equal(readLikesCache({ ...cache, fetchedAt: now - LIKES_CACHE_MS }, accounts, now), null);
    assert.equal(readLikesCache(cache, ["current_user"], now), null);
    assert.equal(readLikesCache(null, accounts, now), null);
  });
});

describe("isLikedUsername", () => {
  it("accepts an X handle", () => {
    assert.equal(isLikedUsername("current_user"), true);
    assert.equal(isLikedUsername(""), false);
    assert.equal(isLikedUsername("has space"), false);
  });
});
