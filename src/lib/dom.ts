import { httpsUrl, preferOriginalImage, statusIdFromHref } from "./extract.ts";
import type { MediaItem } from "./types.ts";

export type DomObservation = {
  postId: string | null;
  text: string | null;
  media: MediaItem[];
  hasReplyingTo: boolean;
};

export function observeArticle(article: Element): DomObservation {
  return {
    postId: statusIdFromArticle(article),
    text: textFromArticle(article),
    media: mediaFromArticle(article),
    hasReplyingTo: articleHasReplyingTo(article),
  };
}

export function rootPostOnStatusPage(root: ParentNode, pathname: string): DomObservation | null {
  if (!statusIdFromHref(pathname)) return null;
  const main = root.querySelector('[data-testid="primaryColumn"]') ?? root;
  const articles = main.querySelectorAll('article[data-testid="tweet"]');
  for (const article of articles) {
    const observation = observeArticle(article);
    if (observation.postId && !observation.hasReplyingTo) return observation;
  }
  return null;
}

export function findArticleByStatusId(root: ParentNode, postId: string): Element | null {
  const articles = root.querySelectorAll('article[data-testid="tweet"]');
  for (const article of articles) {
    if (statusIdFromArticle(article) === postId) return article;
  }
  return null;
}

function statusIdFromArticle(article: Element): string | null {
  const links = article.querySelectorAll('a[href*="/status/"]');
  for (const link of links) {
    if (!(link instanceof HTMLAnchorElement)) continue;
    if (link.closest("article") !== article) continue;
    if (link.closest('[data-testid="quoteTweet"]')) continue;
    if (!link.querySelector("time")) continue;
    const statusId = statusIdFromHref(link.href);
    if (statusId) return statusId;
  }
  return null;
}

function textFromArticle(article: Element): string | null {
  const nodes = article.querySelectorAll('[data-testid="tweetText"]');
  for (const node of nodes) {
    if (node.closest("article") !== article) continue;
    if (node.closest('[data-testid="quoteTweet"]')) continue;
    const text = node.textContent?.trim() ?? "";
    if (text) return text;
  }
  return null;
}

function mediaFromArticle(article: Element): MediaItem[] {
  const media: MediaItem[] = [];

  const images = article.querySelectorAll('[data-testid="tweetPhoto"] img');
  for (const image of images) {
    if (!(image instanceof HTMLImageElement)) continue;
    if (image.closest("article") !== article) continue;
    if (image.closest('[data-testid="quoteTweet"]')) continue;
    const url = httpsUrl(image.currentSrc) ?? httpsUrl(image.src);
    if (url) media.push({ type: "image", url: preferOriginalImage(url) });
  }

  const videos = article.querySelectorAll('[data-testid="videoPlayer"] video');
  for (const video of videos) {
    if (!(video instanceof HTMLVideoElement)) continue;
    if (video.closest("article") !== article) continue;
    if (video.closest('[data-testid="quoteTweet"]')) continue;
    const source = video.querySelector("source");
    const videoUrl = httpsUrl(video.currentSrc) ?? httpsUrl(video.src) ?? (source ? httpsUrl(source.src) : null);
    if (videoUrl) {
      media.push({ type: "video", url: videoUrl });
      continue;
    }
    const poster = httpsUrl(video.poster);
    if (poster) media.push({ type: "image", url: preferOriginalImage(poster) });
  }

  return media;
}

function articleHasReplyingTo(article: Element): boolean {
  const nodes = article.querySelectorAll("div, span");
  for (const node of nodes) {
    if (node.closest("article") !== article) continue;
    if (node.closest('[data-testid="tweetText"]')) continue;
    if (node.closest('[data-testid="quoteTweet"]')) continue;
    const text = node.textContent?.trim() ?? "";
    if (text.length > 0 && text.length < 120 && text.startsWith("Replying to")) return true;
  }
  return false;
}
