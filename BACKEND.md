# Backend integration

The extension talks to one URL, `BE_ENDPOINT`. In production that URL is `https://api.scrollx.app`. That URL receives a like and, when the popup needs a fresh list, returns likes for every X account the extension has seen that person sign in with. The payout balance is for that same list. There is no auth header and no cookie. The extension calls the URL from its own background worker, so the backend does not need browser CORS for these requests.

A like is sent only after the person has agreed to the data disclaimer, capture is on, and the signed-in X handle can be read. The same POST is sent when that person reposts a post or comments on it. The body is always the original post, including when they reply to a comment under that post. The comment’s own text is not sent. Unlikes and removing a repost are not sent. Nothing is sent before that agreement. If the POST fails, the extension tries once more. The popup does not ask for the list on every like, repost, or comment.

## Send a like, repost, or comment

`POST {BE_ENDPOINT}`

`Content-Type: application/json`

```json
{
  "postId": "123",
  "username": "current_user",
  "avatarUrl": "https://pbs.twimg.com/profile_images/1/avatar.jpg",
  "text": "post text or null",
  "media": [{ "type": "image", "url": "https://pbs.twimg.com/media/abc.jpg" }],
  "url": "https://x.com/i/status/123",
  "likedAt": "2026-09-21T19:20:00.000Z"
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `postId` | string | X status id of the original post. A repost or comment uses that post, not the comment. A reply to a comment under the post still uses the post. |
| `username` | string | The one account that liked, reposted, or commented, without `@`. Read from the open X page on that action. 1–15 letters, numbers, or underscores. Switching accounts does not change an action that was already sent. |
| `avatarUrl` | string or `null` | Profile image URL for that account. `null` when X did not show one. Only `https` URLs are sent. |
| `text` | string or `null` | Post text. `null` when the post has none, or when the extension only knew the post id and could not read the caption. |
| `media` | array | Images and videos on that post. Each item is `{ "type": "image" \| "video", "url": "https://..." }`. Empty when there is no media, or when the caption could not be read. |
| `url` | string | `https://x.com/i/status/{postId}`. |
| `likedAt` | string | ISO-8601 time when the extension saw the like, repost, or comment. |

A `2xx` response means the like was accepted. Any other status, or a network failure, is a failure. The body of the POST response is ignored.

The same post can be sent again if the person likes, reposts, or comments on it again. Treat `postId` plus `username` as the engagement to store. A comment does not add a second post id for the reply. There is no field that says whether this POST was a like, a repost, or a comment. A later POST for the same `postId` and `username` may arrive with `text: null` and `media: []` when the extension could not read the post. Keep a caption and media already stored for that pair.

## List likes

`GET {BE_ENDPOINT}?usernames={handle},{other_handle}`

`Accept: application/json`

`usernames` is every unique account the extension has seen this person sign in with, comma-separated, with the latest switch last. The extension records an account the first time it can read the signed-in handle on an open X page, and again each time that person switches accounts. The same handle is stored once. `likes` is every like, repost, and comment stored for those accounts, not only the account open on X. `balance` is the combined USD payout for that whole list.

The extension keeps the last successful list for **1 minute**, and only while the set of `usernames` is unchanged. Opening the popup inside that minute shows the saved list and does not call the backend. Opening it after a minute, or adding or removing a tracked account, calls `GET` again. Switching which account is open on X does not, while that account is already in the set. **Refresh** at the bottom of the popup always calls `GET`. A successful like, repost, or comment POST clears the saved list, so the next time the popup opens it calls `GET` again. A successful payout claim clears the saved list and calls `GET` again immediately.

```json
{
  "balance": 12.5,
  "balances": [
    { "username": "other_user", "balance": 4 },
    { "username": "current_user", "balance": 8.5 }
  ],
  "likes": [
    {
      "postId": "123",
      "username": "current_user",
      "avatarUrl": "https://pbs.twimg.com/profile_images/1/avatar.jpg",
      "text": "post text or null",
      "media": [{ "type": "image", "url": "https://pbs.twimg.com/media/abc.jpg" }],
      "url": "https://x.com/i/status/123",
      "likedAt": "2026-09-21T19:20:00.000Z",
      "coinUrl": "https://pump.fun/coin/abc",
      "earning": 4.25
    }
  ]
}
```

The body is a JSON object with `balance`, `balances`, and a `likes` array. `likes` includes each tracked account. A row’s `username` is the account that liked, reposted, or commented on that post, so the same post can appear once per account. The home screen shows that whole list together, newest `likedAt` first, with `@username` on each row. Post `text` can be the full caption. The popup shows at most three lines. `balance` is the combined USD amount the accounts in `usernames` can receive. A missing or invalid `balance` is shown as `$0.00`. The popup enables **Claim** on the home screen only when that combined `balance` is greater than `5`. At `$5` or below it hides that button and shows “Payouts from $5+”. Home **Claim** pays every account in `usernames` together.

`balances` is one entry per saved account: `{ "username", "balance" }`. The accounts screen lists every handle saved in the extension. **Claim** on a row is enabled only when that account’s balance is greater than `5`, and the claim body then lists only that username. A handle missing from `balances`, or a list request that fails, shows `-` for that row and no claim button. An entry that is present with a missing or invalid `balance` is shown as `$0.00`.

A like is skipped when `postId`, `username`, `url`, or `likedAt` is missing, when `text` is not a string or `null`, or when `media` is not an array of image and video URLs.

| Field | Type | Meaning |
| --- | --- | --- |
| `postId`, `username`, `text`, `media`, `url`, `likedAt` | same as POST | Shown on the liked post. `text` longer than three lines is truncated in the popup. |
| `avatarUrl` | string or `null` | Shown beside the handle when it is an `https` URL. Missing or anything else shows no image. |
| `coinUrl` | string or `null` | Page for the coin that like created. An `http` or `https` URL becomes **view coin**. `null`, a missing field, or any other value shows no coin link. |
| `earning` | number or `null` | USD earned from that coin. Shown only when `coinUrl` is an `http` or `https` page. A finite number of zero or more is white text at the right of the post, reading “earned” plus the amount, for example `earned $4.25`. There is no claim button for a coin. `null`, a missing field, a negative number, or any other value shows no earnings text. An `earning` without a coin link is not shown. |

`200` with `"likes": []` is an empty list. The popup says “No likes yet”. A non-`2xx` response, a network failure, or a body that is not an object with a `likes` array is a load error. The popup says “Couldn't load likes”.

Return `coinUrl` only after the coin exists. Until then use `null`. The popup does not poll for that change. The person can press **Refresh**, or open the popup again after the one-minute cache, to see a coin that was created later.

Removing an account in the popup only drops it from the saved list. It is not deleted on X. Signing in or switching to that account adds it again. Adding or removing an account clears the saved list and calls `GET` again right away, so the home total, the likes, and each account balance match the accounts still saved.

## Claim a payout

`POST {BE_ENDPOINT}`

`Content-Type: application/json`

```json
{
  "type": "payout",
  "username": "current_user",
  "usernames": ["other_user", "current_user"],
  "wallet": "11111111111111111111111111111111",
  "balance": 12.5
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `type` | `"payout"` | This body is a payout claim, not a like, repost, or comment. |
| `username` | string | Account this claim is paid to. Home uses the account open on X when that account is still saved, and otherwise the latest saved account. An account row uses that row. |
| `usernames` | string array | Accounts included in this payout. Home sends every saved account. A row sends only that account. |
| `wallet` | string | Solana address where the person wants the payout. |
| `balance` | number | USD amount shown for this claim. Home sends the combined total. A row sends that account’s balance. |

A `2xx` response means the claim was accepted. Any other status is a failure, and the popup lets the person try again.

Home **Claim** and a row **Claim** open a screen for a Solana wallet. **Claim** stays off until the address is a 32-byte Solana public key, then sends the claim above.

A successful claim must lower both the combined `balance` and the claimed account’s entry in `balances`. The extension deletes its saved list as soon as the claim returns `2xx`, then calls `GET` again, so the home total and the accounts screen both drop the withdrawn amount.
