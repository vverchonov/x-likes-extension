# ScrollX extension

Chrome and Brave extension for observing likes, reposts and comments on original X posts. One Manifest V3 package is written to `dist/chrome` and `dist/brave`.

The first time the popup opens, it asks for consent and links to the rules at `{WEBSITE_URL}/docs` before observing X requests or tracking accounts. After consent, successful likes, reposts and comments on x.com are attributed to an observed numeric X account ID and sent as original-post observations while capture is enabled. A reply to a comment under a post resolves to the original post; if the original cannot be resolved, delivery is withheld. Unlikes and removing reposts are ignored. The popup shows cursor-paginated private history for all tracked accounts or one selected account, per-token creator rewards attributed to the reported X ID, and separate server-authorized SOL balances, eligibility and claim status. Attributed rewards may not be claimable by the submitting key after a dispute. Removing an account changes the local view, not its backend history.

The background worker owns an exportable Ed25519 application key in extension IndexedDB. Reveal and copy its private key string in settings to restore the same backend identity (and tracked account selection) after reinstalling or moving browsers; paste the string to import it. Older JSON backups can also be pasted. The private key and session never enter the X page or content script. This key is not a Solana wallet. Claims require a separately entered and confirmed Solana destination; an accepted claim is pending until confirmed by the backend. No X cookies are sent to the backend.

The request and response contract is in [BACKEND.md](BACKEND.md).

## Setup

```bash
cd x-ext
cp .env.example .env
npm install
npm test
npm run typecheck
npm run build
```

Set these in `.env` or supply them as environment variables to `npm run build` (environment variables take precedence):

- `BE_ENDPOINT` — backend `/v1/events` URL (the extension uses its origin for signed auth, history and rewards requests)
- `X_PROFILE_URL` — link shown in the popup
- `WEBSITE_URL` — link shown in the popup

The manifest `homepage_url` uses the website origin; data-use disclosures for the Chrome Web Store are entered in the store dashboard.

## Load

Chrome: open `chrome://extensions`, turn on Developer mode, choose Load unpacked, and select `dist/chrome`.

Brave: open `brave://extensions`, turn on Developer mode, choose Load unpacked, and select `dist/brave`.
