import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LIKED_POSTS_LIMIT, parseLikedPosts, upsertLikedPost } from "./history.ts";
import type { LikedPostPayload } from "./types.ts";

function post(postId: string, text: string): LikedPostPayload {
  return {
    postId,
    text,
    media: [],
    url: `https://x.com/i/status/${postId}`,
    likedAt: "2026-09-21T19:40:00.000Z",
  };
}

describe("upsertLikedPost", () => {
  it("prepends a new like and replaces the same post", () => {
    const first = upsertLikedPost([], post("1", "first"));
    const second = upsertLikedPost(first, post("2", "second"));
    const again = upsertLikedPost(second, { ...post("1", "updated"), likedAt: "2026-09-21T20:00:00.000Z" });

    assert.deepEqual(
      again.map((item) => item.postId),
      ["1", "2"],
    );
    assert.equal(again[0]?.text, "updated");
    assert.equal(again[0]?.likedAt, "2026-09-21T20:00:00.000Z");
  });

  it("keeps the latest 200 likes", () => {
    let posts: LikedPostPayload[] = [];
    for (let index = 0; index < LIKED_POSTS_LIMIT + 5; index += 1) {
      posts = upsertLikedPost(posts, post(String(index), "text"));
    }

    assert.equal(posts.length, LIKED_POSTS_LIMIT);
    assert.equal(posts[0]?.postId, String(LIKED_POSTS_LIMIT + 4));
    assert.equal(posts.at(-1)?.postId, "5");
  });
});

describe("parseLikedPosts", () => {
  it("drops entries that are not liked posts", () => {
    const posts = parseLikedPosts([post("1", "kept"), { postId: "2" }, null, "nope"]);
    assert.deepEqual(posts, [post("1", "kept")]);
  });
});
