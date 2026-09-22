# Likes extension

Chrome and Brave build of the X like capture extension. One Manifest V3 package is written to `dist/chrome` and `dist/brave`.

Liking an original post on x.com or twitter.com sends this JSON to `BE_ENDPOINT`:

```json
{
  "postId": "123",
  "username": "current_user",
  "avatarUrl": "https://pbs.twimg.com/profile_images/1/avatar.jpg",
  "text": "post text or null",
  "media": [{ "type": "image", "url": "https://..." }],
  "url": "https://x.com/i/status/123",
  "likedAt": "2026-09-21T19:20:00.000Z"
}
```

Replies are ignored. Unlikes are ignored. The popup switch turns capture off.

The popup loads that account’s likes from the same URL with `GET`. It reads the signed-in handle from an open X tab, then requests:

`GET {BE_ENDPOINT}?username={handle}`

```json
{
  "likes": [
    {
      "postId": "123",
      "username": "current_user",
      "avatarUrl": "https://pbs.twimg.com/profile_images/1/avatar.jpg",
      "text": "post text or null",
      "media": [{ "type": "image", "url": "https://..." }],
      "url": "https://x.com/i/status/123",
      "likedAt": "2026-09-21T19:20:00.000Z",
      "coinUrl": "https://pump.fun/coin/abc"
    }
  ]
}
```

`coinUrl` is the coin page when that like created a coin. `null` or a missing `coinUrl` means no coin, and the popup shows no coin link. `avatarUrl` is the signed-in account’s profile image. `null` means that image was not on the page.

## Setup

```bash
cd extension
cp .env.example .env
npm install
npm test
npm run build
```

Set these in `.env`:

- `BE_ENDPOINT` — full URL that receives the POST
- `X_PROFILE_URL` — link shown in the popup
- `WEBSITE_URL` — link shown in the popup

## Load

Chrome: open `chrome://extensions`, turn on Developer mode, choose Load unpacked, and select `extension/dist/chrome`.

Brave: open `brave://extensions`, turn on Developer mode, choose Load unpacked, and select `extension/dist/brave`.
