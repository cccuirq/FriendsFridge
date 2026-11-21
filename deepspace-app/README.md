# Friend's Fridge on DeepSpace

A shared-fridge app: keep a private pantry, discover meals from what you own,
ask a friend for a missing ingredient, and record the handoff exactly once.

This is a DeepSpace adaptation of the five-person CS409 team project at
https://github.com/cccuirq/409FinalProj, based on commit `9f1e164` by VOE-Du
(November 18, 2026). The original application remains at the repository root.
The existing UI, ingredient catalogue, recipe examples and image credits are
retained; this folder contains the platform migration, not a claim that all
of the original team's work was newly written for the exercise.

## Run

Use the Node/npm versions in `package.json` (Node 22.15+ and npm 11.6+).

```sh
npm ci
npx deepspace auth login
npx deepspace dev start
npm run type-check
npx deepspace test run all --port 5198
npm run build
```

The multi-user test requires two usable native test accounts; see
`npx deepspace test accounts list`. Credentials stay in the CLI credential
store, never in this repository. Set `FRIDGE_VISION_LIVE=1` to additionally
exercise real paid photo recognition with the built-in public apple image.
Normal tests do not call a paid model. This optional check consumes the
owner's credits and does not top up the account.

## Platform choices

* **Native auth:** Google/GitHub via DeepSpace. First sign-in creates an app
  username, display name and contact email. Old passwords and MongoDB accounts
  are not uploaded or reused; contact email is not the login identity.
* **Native SQLite Durable Object:** `FridgeRoom` runs synchronous business
  commands in `storage.transactionSync`. Completing a handoff validates stock,
  subtracts from the owner, adds to the recipient, and changes the request
  status in one transaction. Concurrent retries cannot double transfer.
* **Native SQLite image table:** recipe photos are fetched through an authorization
  check, including revocation when a recipe share or friendship is removed. The free
  platform tier refuses R2 bindings, so image bytes live in a separate SQLite
  table (2 MB per photo, 20 MB total) with transactional cleanup.
* **Native Anthropic integration:** Haiku 4.5 reads photos/receipt lines into
  canonical food suggestions. Browser resizing, bounded output, 10 attempts
  per user/day and 50 across the workspace/day constrain spending. No image
  becomes stock until a person reviews names and enters quantities. Suggested
  boxes are approximate; there is no fabricated confidence score. Errors
  preserve the manual-entry path. Generic paid integration proxy access is
  disabled, so it cannot bypass this server-side flow.
* **Live updates:** private, authenticated SSE connections notify each user of
  relevant friendship/chat/stock changes. Streams reconnect periodically.

The native scaffold's required users schema and six existing Durable Object
classes remain. The previous MemoryFlow schemas remain read-only to preserve
existing storage when the application identity is reused and renamed. No
undeploy/delete-data operation is part of this migration.

## Feature mapping

| Original module | DeepSpace implementation |
| --- | --- |
| User & Friends | Native sign-in; application profile; username search; invitations, accept/decline, removal and reapply |
| Fridge Inventory | Add/edit/delete; integer hundredths and canonical units; stale-write checks; private/friends visibility; idempotent photo imports |
| AI Photo Recognition | JPG/PNG upload; native low-cost vision; editable review; confirmation before stock writes |
| Recipe Discovery | Inventory matching/missing amounts; recipe CRUD/photos; saved recipes; private sharing invitations and revocation |
| Ingredient Sharing | Friend-visible stock; chat/unread; borrow accept/decline/cancel; atomic completed handoff |

There are 212 canonical ingredients, 11 seeded recipes, eight ingredient
categories, and the original default-image gallery. `fresh_interval` remains
an optional dictionary field; the app does not invent expiry dates or give
food-safety judgments from photos.

## Main tradeoff and boundaries

The evaluation workspace uses one serialized SQLite snapshot capped at 8 MB
and a separate image table capped at 20 MB.
This gives a small, understandable atomic transaction boundary for borrowing
and preserves the original API/UI without an external MongoDB deployment.
It is designed for a small demo group, not an unbounded public chat service.
The next scaling step is normalized SQLite tables with indexed pagination,
retention/export for chat, and scoped rooms where business transactions permit.

Photo model predictions differ from the previous local YOLO/CLIP service;
the upload/review/import flow is preserved, not identical model output.
Vision still costs credits per actual use. Haiku was chosen after a real
Florence-2 call was refused for its $2 minimum reserve; a real Haiku image
description succeeded for $0.000323. That is a test observation, not a fixed
price guarantee. No shopping, calendar, email or location integration was
added because none helps the ingredient handoff.

## Source and deploy

The reused app already has **DeepSpace cloud source authority**. Its official
cloud clone is the authoritative deploy source; commit there before
`npx deepspace deploy --rename`. The directory in the CS409 repository is a
review copy. Do not call `app init --new-id` or `undeploy`: the former forks
the identity; the latter destroys app data. Local `.dev.vars`, `.deepspace`,
`.wrangler`, credentials and build output are ignored.

See [SUBMISSION.md](SUBMISSION.md) for the portal note and an honest applicant
verification checklist. See the retained `public/legacy/assets/defaults/`
manifests and gallery for image attribution.
