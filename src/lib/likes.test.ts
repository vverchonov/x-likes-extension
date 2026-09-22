import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isLikedUsername, LIKES_CACHE_MS, likesUrl, parseLikesResponse, readLikesCache } from "./likes.ts";

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
  it("asks the likes endpoint for one account", () => {
    assert.equal(
      likesUrl("https://example.com/api/likes", "current_user"),
      "https://example.com/api/likes?username=current_user",
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

  it("drops a coin url that is not a page", () => {
    const posts = parseLikesResponse({
      likes: [{ ...like, coinUrl: "javascript:alert(1)" }],
    });
    assert.equal(posts[0]?.coinUrl, null);
  });

  it("returns nothing when the payload is not a likes list", () => {
    assert.deepEqual(parseLikesResponse(null), []);
    assert.deepEqual(parseLikesResponse({ likes: "nope" }), []);
  });
});

describe("readLikesCache", () => {
  const now = Date.parse("2026-09-22T16:00:00.000Z");
  const cache = {
    username: "current_user",
    fetchedAt: now - 30_000,
    likes: [{ ...like, coinUrl: "https://pump.fun/coin/abc" }],
  };

  it("reuses a response from the last minute for the same account", () => {
    const posts = readLikesCache(cache, "current_user", now);
    assert.equal(posts?.[0]?.postId, "1");
    assert.equal(posts?.[0]?.coinUrl, "https://pump.fun/coin/abc");
  });

  it("ignores a response that is a minute old or for another account", () => {
    assert.equal(readLikesCache({ ...cache, fetchedAt: now - LIKES_CACHE_MS }, "current_user", now), null);
    assert.equal(readLikesCache(cache, "other_user", now), null);
    assert.equal(readLikesCache(null, "current_user", now), null);
  });
});

describe("isLikedUsername", () => {
  it("accepts an X handle", () => {
    assert.equal(isLikedUsername("current_user"), true);
    assert.equal(isLikedUsername(""), false);
    assert.equal(isLikedUsername("has space"), false);
  });
});
