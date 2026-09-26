import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  collectTweets,
  decideDomCapture,
  engagementFromRequest,
  isFavoriteTweetRequest,
  isUnfavoriteTweetRequest,
  originalPostForEngagement,
  parseFavoriteTweetId,
  payloadFromCached,
  preferOriginalImage,
  profileImageUrl,
  profileImageUrlFromStyle,
  shouldHarvestTweets,
  usernameFromAccountText,
  usernameFromProfileHref,
} from "./extract.ts";
import type { CachedTweet } from "./types.ts";

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

describe("engagementFromRequest", () => {
  const likeUrl = "https://x.com/i/api/graphql/abc/FavoriteTweet";
  const repostUrl = "https://x.com/i/api/graphql/abc/CreateRetweet";
  const commentUrl = "https://x.com/i/api/graphql/abc/CreateTweet";

  it("reads a like, a repost, and a comment", () => {
    assert.deepEqual(engagementFromRequest(likeUrl, JSON.stringify({ variables: { tweet_id: "100" } })), {
      kind: "like",
      tweetId: "100",
    });
    assert.deepEqual(engagementFromRequest(repostUrl, JSON.stringify({ variables: { tweet_id: "100" } })), {
      kind: "repost",
      tweetId: "100",
    });
    assert.deepEqual(
      engagementFromRequest(
        commentUrl,
        JSON.stringify({ variables: { tweet_text: "nice", reply: { in_reply_to_tweet_id: "100" } } }),
      ),
      { kind: "comment", tweetId: "100" },
    );
  });

  it("reads a long comment and ignores a new post", () => {
    const noteUrl = "https://x.com/i/api/graphql/abc/CreateNoteTweet";
    assert.deepEqual(
      engagementFromRequest(noteUrl, JSON.stringify({ variables: { reply: { in_reply_to_tweet_id: "100" } } })),
      { kind: "comment", tweetId: "100" },
    );
    assert.equal(engagementFromRequest(commentUrl, JSON.stringify({ variables: { tweet_text: "a new post" } })), null);
    assert.equal(engagementFromRequest("https://x.com/i/api/graphql/abc/DeleteRetweet", JSON.stringify({ variables: { tweet_id: "100" } })), null);
  });
});

describe("originalPostForEngagement", () => {
  const post = cachedTweet({ postId: "100", text: "Hello from a post", conversationId: "100" });
  const comment = cachedTweet({
    postId: "200",
    text: "This is a comment",
    isReply: true,
    conversationId: "100",
    inReplyToStatusId: "100",
  });
  const replyToComment = cachedTweet({
    postId: "300",
    text: "A reply to that comment",
    isReply: true,
    conversationId: "100",
    inReplyToStatusId: "200",
  });

  it("keeps a repost or comment on the original post", () => {
    const cache = new Map([[post.postId, post], [comment.postId, comment]]);
    assert.equal(originalPostForEngagement(cache, "100")?.postId, "100");
    assert.equal(originalPostForEngagement(cache, "100")?.tweet?.text, "Hello from a post");
    assert.equal(originalPostForEngagement(cache, "200")?.postId, "100");
    assert.equal(originalPostForEngagement(cache, "200")?.tweet?.text, "Hello from a post");
  });

  it("sends the post when the person replies to a comment under it", () => {
    const cache = new Map([
      [post.postId, post],
      [comment.postId, comment],
      [replyToComment.postId, replyToComment],
    ]);
    const resolved = originalPostForEngagement(cache, "200");
    assert.equal(resolved?.postId, "100");
    assert.equal(resolved?.tweet?.text, "Hello from a post");
    assert.equal(originalPostForEngagement(cache, "300")?.postId, "100");
  });

  it("uses the new reply's conversation when the comment itself was not cached", () => {
    const cache = new Map([[replyToComment.postId, replyToComment]]);
    const resolved = originalPostForEngagement(cache, "200");
    assert.deepEqual(resolved, { postId: "100", tweet: null });
  });

  it("walks a reply chain when the conversation id is missing", () => {
    const cache = new Map<string, CachedTweet>([
      ["100", cachedTweet({ postId: "100", text: "Hello from a post" })],
      ["200", cachedTweet({ postId: "200", isReply: true, inReplyToStatusId: "100" })],
      ["300", cachedTweet({ postId: "300", isReply: true, inReplyToStatusId: "200" })],
    ]);
    assert.equal(originalPostForEngagement(cache, "300")?.postId, "100");
    assert.equal(originalPostForEngagement(cache, "300")?.tweet?.text, "Hello from a post");
  });
});

function cachedTweet(tweet: Pick<CachedTweet, "postId"> & Partial<CachedTweet>): CachedTweet {
  return {
    text: null,
    media: [],
    isReply: false,
    conversationId: null,
    inReplyToStatusId: null,
    ...tweet,
  };
}

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
    assert.deepEqual(payloadFromCached(tweet, "2026-09-21T19:20:00.000Z", "current_user", null), {
      postId: "100",
      username: "current_user",
      avatarUrl: null,
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

describe("usernameFromProfileHref", () => {
  it("reads a profile handle and rejects nav paths", () => {
    assert.equal(usernameFromProfileHref("https://x.com/current_user"), "current_user");
    assert.equal(usernameFromProfileHref("/Current_User"), "Current_User");
    assert.equal(usernameFromProfileHref("https://x.com/home"), null);
    assert.equal(usernameFromProfileHref("https://x.com/explore"), null);
    assert.equal(usernameFromAccountText("Ada @current_user"), "current_user");
    assert.equal(usernameFromAccountText("no handle here"), null);
  });
});

describe("profileImageUrl", () => {
  it("keeps an https profile image and drops anything else", () => {
    const image = "https://pbs.twimg.com/profile_images/1/avatar_normal.jpg";
    assert.equal(profileImageUrl(image), image);
    assert.equal(profileImageUrl("blob:https://x.com/123"), null);
    assert.equal(profileImageUrl(null), null);
    assert.equal(
      profileImageUrlFromStyle(`background-image: url("${image}")`),
      image,
    );
    assert.equal(profileImageUrlFromStyle("background-image: none"), null);
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
