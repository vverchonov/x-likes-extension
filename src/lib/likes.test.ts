import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isLikedUsername, likesUrl, parseLikesResponse } from "./likes.ts";

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

describe("isLikedUsername", () => {
  it("accepts an X handle", () => {
    assert.equal(isLikedUsername("current_user"), true);
    assert.equal(isLikedUsername(""), false);
    assert.equal(isLikedUsername("has space"), false);
  });
});
