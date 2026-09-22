# Backend integration

The extension talks to one URL, `BE_ENDPOINT`. That URL receives a like and, when the popup needs a fresh list, returns that account’s likes. There is no auth header and no cookie. The extension calls the URL from its own background worker, so the backend does not need browser CORS for these requests.

A like is sent only when capture is on, the post is an original post, and the signed-in X handle can be read. Replies are not sent. Unlikes are not sent. If the POST fails, the extension tries once more. The popup does not ask for the list on every like.

## Send a like

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
| `postId` | string | X status id of the liked post. |
| `username` | string | Signed-in handle, without `@`. Read from the open X page on that like. 1–15 letters, numbers, or underscores. |
| `avatarUrl` | string or `null` | Profile image URL for that account. `null` when X did not show one. Only `https` URLs are sent. |
| `text` | string or `null` | Post text. `null` when the post has none. |
| `media` | array | Images and videos on that post. Each item is `{ "type": "image" \| "video", "url": "https://..." }`. Empty when there is no media. |
| `url` | string | `https://x.com/i/status/{postId}`. |
| `likedAt` | string | ISO-8601 time when the extension saw the like. |

A `2xx` response means the like was accepted. Any other status, or a network failure, is a failure. The body of the POST response is ignored.

The same post can be sent again if the person likes it again. Treat `postId` plus `username` as the like to store.

## List likes

`GET {BE_ENDPOINT}?username={handle}`

`Accept: application/json`

The popup reads the signed-in handle from an open X tab, then asks for that account. `username` is the same handle sent on POST.

The extension keeps the last successful list for **1 minute**. Opening the popup inside that minute shows the saved list and does not call the backend. Opening it after a minute calls `GET` again. **Refresh** in the popup header always calls `GET`. A successful POST clears the saved list, so the next time the popup opens it calls `GET` again.

```json
{
  "likes": [
    {
      "postId": "123",
      "username": "current_user",
      "avatarUrl": "https://pbs.twimg.com/profile_images/1/avatar.jpg",
      "text": "post text or null",
      "media": [{ "type": "image", "url": "https://pbs.twimg.com/media/abc.jpg" }],
      "url": "https://x.com/i/status/123",
      "likedAt": "2026-09-21T19:20:00.000Z",
      "coinUrl": "https://pump.fun/coin/abc"
    }
  ]
}
```

The body is a JSON object with a `likes` array. The extension orders the rows newest `likedAt` first. A row is skipped when `postId`, `username`, `url`, or `likedAt` is missing, when `text` is not a string or `null`, or when `media` is not an array of image and video URLs.

| Field | Type | Meaning |
| --- | --- | --- |
| `postId`, `username`, `text`, `media`, `url`, `likedAt` | same as POST | Shown on the liked post. |
| `avatarUrl` | string or `null` | Shown beside the handle when it is an `https` URL. Missing or anything else shows no image. |
| `coinUrl` | string or `null` | Page for the coin that like created. An `http` or `https` URL becomes **View coin**. `null`, a missing field, or any other value shows no coin link. |

`200` with `"likes": []` is an empty list. The popup says “No likes yet”. A non-`2xx` response, a network failure, or a body that is not an object with a `likes` array is a load error. The popup says “Couldn't load likes”.

Return `coinUrl` only after the coin exists. Until then use `null`. The popup does not poll for that change. The person can press **Refresh**, or open the popup again after the one-minute cache, to see a coin that was created later.
