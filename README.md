# Likes extension

Chrome and Brave build of the X like capture extension. One Manifest V3 package is written to `dist/chrome` and `dist/brave`.

Liking an original post on x.com or twitter.com sends this JSON to `BE_ENDPOINT`:

```json
{
  "postId": "123",
  "username": "current_user",
  "text": "post text or null",
  "media": [{ "type": "image", "url": "https://..." }],
  "url": "https://x.com/i/status/123",
  "likedAt": "2026-09-21T19:20:00.000Z"
}
```

Replies are ignored. Unlikes are ignored. The popup switch turns capture off.

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
