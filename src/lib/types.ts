export type MediaItem = {
  type: "image" | "video";
  url: string;
};

export type CachedTweet = {
  postId: string;
  text: string | null;
  media: MediaItem[];
  isReply: boolean;
};

export type LikedPostPayload = {
  postId: string;
  username: string;
  text: string | null;
  media: MediaItem[];
  url: string;
  likedAt: string;
};

export type LikedPost = LikedPostPayload & {
  coinUrl: string | null;
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
};
