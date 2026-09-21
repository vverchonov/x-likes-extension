import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  collectTweets,
  decideDomCapture,
  isFavoriteTweetRequest,
  isUnfavoriteTweetRequest,
  parseFavoriteTweetId,
  payloadFromCached,
  preferOriginalImage,
  shouldHarvestTweets,
} from "./extract.ts";

const originalPost = {
  rest_id: "100",
  legacy: {
    id_str: "100",
    full_text: "Hello from a post",
    in_reply_to_status_id_str: null,
    extended_entities: {
      media: [
        {
          type: "photo",
          media_url_https: "https://pbs.twimg.com/media/abc.jpg?name=small",
        },
        {
          type: "video",
          media_url_https: "https://pbs.twimg.com/ext_tw_video_thumb/abc.jpg",
          video_info: {
            variants: [
              { content_type: "application/x-mpegURL", url: "https://video.twimg.com/ext_tw_video/abc.m3u8" },
              { bitrate: 832000, content_type: "video/mp4", url: "https://video.twimg.com/ext_tw_video/low.mp4" },
              { bitrate: 2176000, content_type: "video/mp4", url: "https://video.twimg.com/ext_tw_video/high.mp4" },
            ],
          },
        },
      ],
    },
  },
};

const reply = {
  rest_id: "200",
  legacy: {
    id_str: "200",
    full_text: "This is a comment",
    in_reply_to_status_id_str: "100",
  },
};

describe("collectTweets", () => {
  it("keeps original posts and marks replies", () => {
    const tweets = collectTweets({
      data: {
        home: {
          instructions: [
            {
              entries: [
                { content: { itemContent: { tweet_results: { result: originalPost } } } },
                {
                  content: {
                    itemContent: {
                      tweet_results: { result: { tweet: reply } },
                    },
                  },
                },
              ],
            },
          ],
        },
      },
    });

    assert.deepEqual(
      tweets.map((tweet) => ({ postId: tweet.postId, isReply: tweet.isReply, text: tweet.text })),
      [
        { postId: "100", isReply: false, text: "Hello from a post" },
        { postId: "200", isReply: true, text: "This is a comment" },
      ],
    );
  });

  it("prefers note text and the highest bitrate mp4", () => {
    const [tweet] = collectTweets({
      ...originalPost,
      note_tweet: { note_tweet_results: { result: { text: "A much longer post" } } },
    });

    assert.ok(tweet);
    assert.equal(tweet.text, "A much longer post");
    assert.deepEqual(tweet.media, [
      { type: "image", url: "https://pbs.twimg.com/media/abc.jpg?name=orig" },
      { type: "video", url: "https://video.twimg.com/ext_tw_video/high.mp4" },
    ]);
  });

  it("drops blob and non-https media urls", () => {
    const [tweet] = collectTweets({
      rest_id: "300",
      legacy: {
        full_text: "No usable media",
        extended_entities: {
          media: [{ type: "photo", media_url_https: "blob:https://x.com/123" }],
        },
      },
    });

    assert.ok(tweet);
    assert.deepEqual(tweet.media, []);
  });
});

describe("parseFavoriteTweetId", () => {
  it("reads a JSON body", () => {
    assert.equal(parseFavoriteTweetId(JSON.stringify({ variables: { tweet_id: "100" } })), "100");
  });

  it("reads form-encoded variables", () => {
    const body = new URLSearchParams({ variables: JSON.stringify({ tweet_id: "100" }) }).toString();
    assert.equal(parseFavoriteTweetId(body), "100");
  });

  it("ignores unlike requests", () => {
    assert.equal(isFavoriteTweetRequest("https://x.com/i/api/graphql/abc/FavoriteTweet"), true);
    assert.equal(isUnfavoriteTweetRequest("https://x.com/i/api/graphql/abc/UnfavoriteTweet"), true);
    assert.equal(shouldHarvestTweets("https://x.com/i/api/graphql/abc/HomeTimeline"), true);
    assert.equal(shouldHarvestTweets("https://x.com/i/api/graphql/abc/FavoriteTweet"), false);
  });
});

describe("decideDomCapture", () => {
  it("sends a timeline post that is not a reply", () => {
    assert.deepEqual(decideDomCapture({ postId: "100", hasReplyingTo: false, pageStatusId: null }), {
      action: "send",
      postId: "100",
    });
  });

  it("drops reply lines, thread comments, and unknown posts", () => {
    assert.deepEqual(decideDomCapture({ postId: "200", hasReplyingTo: true, pageStatusId: null }), { action: "drop" });
    assert.deepEqual(decideDomCapture({ postId: "200", hasReplyingTo: false, pageStatusId: "100" }), { action: "drop" });
    assert.deepEqual(decideDomCapture({ postId: null, hasReplyingTo: false, pageStatusId: null }), { action: "drop" });
  });

  it("drops a reply opened on its own page", () => {
    assert.deepEqual(decideDomCapture({ postId: "200", hasReplyingTo: true, pageStatusId: "200" }), { action: "drop" });
  });
});

describe("payloadFromCached", () => {
  it("builds the backend payload", () => {
    const [tweet] = collectTweets(originalPost);
    assert.ok(tweet);
    assert.deepEqual(payloadFromCached(tweet, "2026-09-21T19:20:00.000Z"), {
      postId: "100",
      text: "Hello from a post",
      media: [
        { type: "image", url: "https://pbs.twimg.com/media/abc.jpg?name=orig" },
        { type: "video", url: "https://video.twimg.com/ext_tw_video/high.mp4" },
      ],
      url: "https://x.com/i/status/100",
      likedAt: "2026-09-21T19:20:00.000Z",
    });
  });
});

describe("preferOriginalImage", () => {
  it("upgrades twimg size params only", () => {
    assert.equal(
      preferOriginalImage("https://pbs.twimg.com/media/abc.jpg?name=small"),
      "https://pbs.twimg.com/media/abc.jpg?name=orig",
    );
    assert.equal(preferOriginalImage("https://video.twimg.com/ext_tw_video/high.mp4"), "https://video.twimg.com/ext_tw_video/high.mp4");
  });
});
