# ScrollX extension

Chrome and Brave build of the X like capture extension. One Manifest V3 package is written to `dist/chrome` and `dist/brave`.

The first time the popup opens, it shows what data is collected and waits for an agree checkbox. The checkbox links to the rules at `{WEBSITE_URL}/docs`. Until that is accepted, the popup stays on that screen and the extension does not watch X, save the signed-in account, or send a like. After that, liking, reposting, or commenting on a post on x.com sends that post to `BE_ENDPOINT`. A reply to a comment under the post still sends the post, not the comment. The popup loads that account’s likes from the same URL. Unlikes and removing a repost are ignored.

The request and response contract is in [BACKEND.md](BACKEND.md).

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

The manifest `homepage_url` is `https://www.scrollx.app/`. What the extension collects, and why, is explained on that site at `/docs` and in the popup agreement. Chrome Web Store data-use disclosures are entered in the store dashboard, not in the manifest.

## Load

Chrome: open `chrome://extensions`, turn on Developer mode, choose Load unpacked, and select `extension/dist/chrome`.

Brave: open `brave://extensions`, turn on Developer mode, choose Load unpacked, and select `extension/dist/brave`.
