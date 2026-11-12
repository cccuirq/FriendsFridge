# User & Friends API

Implemented on the `jianghui-sun` branch. Start MongoDB, then `npm start` and open the app. The homepage provides registration, login, profile editing, username search, friend requests, incoming/outgoing request lists, acceptance/decline, friend lists, and removal.

## Shared contract

All request bodies are JSON objects with `Content-Type: application/json`. Success is `{ "data": ... }`; errors are `{ "error": { "code": "...", "message": "..." } }`. Validation failures return 400, missing/expired login 401, cross-origin mutation 403, missing/inaccessible resources 404, duplicates or conflicting state 409, incorrect content type 415, and login/register throttling 429. Bodies are limited to 16 KiB.

Registration and login set a seven-day `ff_session` HttpOnly, SameSite=Strict cookie. In production (`NODE_ENV=production`) the cookie also requires HTTPS (`Secure`). Browser clients use same-origin requests; do not store passwords or tokens in localStorage. MongoDB stores only the token's SHA-256 digest and a salted scrypt password hash. Logout revokes the current session; login/registration replaces any session presented by that browser. Other devices retain their sessions.

All endpoints below except register, login, and logout require a valid session. Acting users always come from the session, never a client-supplied identity. Mutations reject cross-origin requests. This app serves its own frontend; CORS is not enabled. Deploy behind HTTPS and preserve the original Host header. Login/registration share a per-IP limit of 30 attempts in 15 minutes per server process; multi-instance deployments need a shared rate limiter.

| Method | Path | Request | Result |
| --- | --- | --- | --- |
| POST | `/api/auth/register` | `username`, `email`, `password`, `display_name` | 201, own profile; logs in automatically |
| POST | `/api/auth/login` | `identifier` (username or email), `password` | 200, own profile |
| POST | `/api/auth/logout` | No body | 200, `{ "logged_out": true }`; clears cookie; idempotent |
| GET | `/api/users/me` | None | Own profile |
| PATCH | `/api/users/me` | `display_name` and/or `email` | Updated own profile |
| GET | `/api/users?q=bo&offset=0` | Query parameters | Username prefix search; excludes self |
| POST | `/api/friends/requests` | `{ "user_id": "<target UUID>" }` | 201, pending relationship |
| GET | `/api/friends/requests?direction=incoming&offset=0` | `direction`: incoming (default) or outgoing | Pending relationships with other user's public profile |
| PATCH | `/api/friends/requests/:id` | `{ "status": "accepted" }` or `declined` | Updated relationship; only pending request's recipient |
| GET | `/api/friends?offset=0` | Query parameter | Accepted relationships with friend's public profile |
| DELETE | `/api/friends/:userId` | No body | Relationship with status `removed`; either friend may remove |

UUIDs are lowercase. `:id` for responding is the **relationship** `_id`; `:userId` for removal is the **friend's user** `_id`. List/search results have at most 20 records; increment `offset` by 20 for more. An empty array means no matches. Search and lists never return other users' email addresses or password hashes.

## Validation and profile fields

- Username: 3-50 ASCII letters, digits, or underscores; normalized to lowercase, unique, immutable after signup.
- Email: trimmed, normalized to lowercase, at most 255 characters, unique. Email delivery/verification and password reset are outside this module's current scope.
- Display name: 1-100 trimmed characters.
- Password: 8-128 characters, not trimmed; stored as an independently salted scrypt hash.
- Own profile: `_id`, `username`, `display_name`, `email`, `created_at`.
- Public profile: `_id`, `username`, `display_name`.
- Unexpected body fields are rejected; profile changes cannot modify IDs, passwords or other users.

## Friendship lifecycle

```text
new pair -> pending -> accepted -> removed
                 |                  |
                 +-> declined       +-> pending (new request)
                         |
                         +-> pending (new request)
```

One sorted pair document is reused across declined/removed reapplications. Reapplication updates `requested_by` to the new sender and `updated_at`, while preserving `_id` and `created_at`. A request to oneself fails. Duplicate pending requests, reciprocal pending requests, and requests between accepted friends return 409, including concurrent attempts. Reciprocal requests do not silently accept a friendship. Only the recipient can accept/decline; unrelated users cannot mutate the relationship. Removing a friend keeps the record and removes both users from each other's accepted lists. Other modules should grant friend visibility only for `status: 'accepted'`.

## Frontend integration

```javascript
const response = await fetch('/api/friends/requests', {
  method: 'POST',
  credentials: 'same-origin',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ user_id: friendId }),
});
const result = await response.json();
if (!response.ok) throw new Error(result.error.message);
```

For future authenticated modules, `authService(client, db).authenticate(token)` returns the server-side user record. Reuse this authentication layer rather than trusting `user_id` from request JSON. Do not serialize the full record; use `ownUser` or `publicUser` projections.

## Verification

Friendship creation, acceptance/decline, and removal notify both participants through the authenticated `/api/friends/conversations/events` SSE stream using a named `friendships` event. The frontend refreshes invitation lists/badges and friend activity on this event, and polls while visible every five seconds as a fallback. Background invitation refresh keeps all loaded pages and ignores results for stale accounts or superseded requests.

`npm test` runs real MongoDB replica-set tests independently of your local data. Tests cover duplicate accounts, hashes and cookie settings, login/expiration/revocation, profile isolation, literal searches, cross-origin protection, request authorization, concurrent duplicate pairs, decline/reapply/accept/remove/reapply, malformed JSON, and throttling. Email-change regression tests verify that the original password still works with the new normalized email and username and that invalid/duplicate edits leave the profile unchanged. SSE integration tests verify both participants receive relationship notifications; frontend pagination unit tests verify that refresh preserves loaded pages and discards stale results. Database tests still cover ingredient freshness, removed friendships, and inventory transactions.

Implementation references: [Node.js scrypt](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback), [MongoDB TTL indexes](https://www.mongodb.com/docs/manual/core/index-ttl/). Session expiry is checked on every authentication request even before TTL cleanup runs.
