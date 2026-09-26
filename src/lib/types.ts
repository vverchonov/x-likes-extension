export type MediaItem = {
  type: "image" | "video";
  url: string;
};

export type CachedTweet = {
  postId: string;
  text: string | null;
  media: MediaItem[];
  isReply: boolean;
  conversationId: string | null;
  inReplyToStatusId: string | null;
};

export type EngagementKind = "like" | "repost" | "comment";

export type OutgoingEngagement = {
  kind: EngagementKind;
  tweetId: string;
};

export type LikedPostPayload = {
  postId: string;
  username: string;
  avatarUrl: string | null;
  text: string | null;
  media: MediaItem[];
  url: string;
  likedAt: string;
};

export type LikedPost = LikedPostPayload & {
  coinUrl: string | null;
  earning: number | null;
};

export type DomCaptureInput = {
  postId: string | null;
  hasReplyingTo: boolean;
  pageStatusId: string | null;
};

export type DomDecision = { action: "send"; postId: string } | { action: "drop" };

export const PAGE_MESSAGE_SOURCE = "x-likes-extension";

export type FavoritePageMessage = {
  source: typeof PAGE_MESSAGE_SOURCE;
  type: "favorite";
  tweetId: string;
  tweet: CachedTweet | null;
  kind: EngagementKind;
  /** True when tweetId is the original post, including when the person replied to a comment under it. */
  original: boolean;
};
