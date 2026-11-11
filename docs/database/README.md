# MongoDB database

The database layer uses the official MongoDB Node.js driver. The application collections are `users`, `ingredients`, `inventory_items`, `recipes`, `recipe_ingredients`, `saved_recipes`, `friendships`, `friend_messages`, `ingredient_requests`, and `recipe_shares`. The `sessions` collection stores hashed login tokens with a TTL expiry index.

## Local setup (PowerShell)

Requires Node.js 22+ and Docker Desktop with its Linux engine running, or an existing MongoDB replica set / Atlas database.

```powershell
npm install
Copy-Item .env.example .env
docker compose up -d --wait
npm run db:init
npm run db:seed
npm run db:seed:recipes
npm start
```

For Atlas, put your connection string in `MONGODB_URI` in `.env`, set `MONGODB_DB`, and skip Docker. Never commit `.env`. The Docker configuration binds to localhost and is for local development only. It starts a single-node replica set because cross-document transactions require a replica set or sharded cluster. Stop it with `docker compose down`; the named data volume is preserved.

If Docker is unavailable, run `npm run db:local` in a separate terminal instead of Docker. This downloads and starts a real local MongoDB replica set on port 27017, initializes the collections and seeds automatically, and keeps data in the ignored `.local/mongodb/` directory. Leave that terminal running, then run `npm start` in another terminal. Stop with Ctrl+C; restart with the same command. This helper always uses the local `friends_fridge` database and is for development only. Do not run it alongside Docker MongoDB on the same port.

`db:init` creates collections, strict validators, and indexes. It can be rerun without dropping data; existing collections receive updated validators. It backfills missing ingredient `fresh_interval` fields with `null`, preserving existing values. It does not repair other invalid documents or resolve duplicate data. `db:seed` inserts 206 standard ingredients (including the 204 recognition candidates from the shared vocabulary) without changing existing ingredient IDs, names, or units.

Photo Recognition adds `inventory_imports` with a unique `(user_id, batch_id)` index. These confirmation receipts make stock increments idempotent across retries and restarts, using the same transaction as `inventory_items` writes. They contain no images. See [the integration contract](../api/photo-recognition.md).

The server requires a working database connection and applies collection validators/indexes at startup. `GET /api/health` pings MongoDB and returns 200 or 503. The local helper also seeds two public sample recipes. For an existing database, run `npm run db:seed:recipes` after seeding ingredients.

## Data conventions

- `_id` and references are lowercase UUID strings. All documents have `created_at`; mutable inventory, recipes, friendships, and requests also have `updated_at`, stored as BSON dates.
- Quantities are **integer hundredths of the ingredient's default unit**: 2 eggs = `200`, 200 ml milk = `20000`, 1.25 g salt = `125`. Convert at the UI/API boundary. Maximum is JavaScript's safe integer limit; negative, fractional stored quantities and invalid states are rejected. Inventory may be zero; recipe/request quantities must be positive.
- `servings` is an ordinary positive integer, not scaled. Passwords must be hashed by the authentication service; the database only accepts a `password_hash` field, not plaintext `password`.
- Names and units come from `ingredients`; normalize usernames, emails, and ingredient names in application services before writes. Unique indexes are case-sensitive.
- Optional messages and recipe descriptions use an empty string. System recipe `author_id` is `null`.
- Strict schemas reject missing required fields and unknown fields. See `src/db/schema.js` for all fields, enums, and indexes.
- Ordered friendship pairs prevent reverse duplicates; validators reject self-friendship, unrelated `requested_by`, self ingredient requests, and self recipe shares.

- `ingredients.fresh_interval` is a required positive integer number of days, or `null` when not specified. It is a configurable freshness estimate, not an automatic expiry or deletion timer. Seed ingredients start with `null`; no freshness durations are guessed.
- Friendship `status` supports `pending`, `accepted`, `declined`, and `removed`. Removing a friend should change an accepted relation to `removed` and update `updated_at`, keeping the pair record. Only `accepted` grants friend access; reapplying should reuse the same pair with `pending` and the new `requested_by`. These HTTP operations are implemented in the User & Friends API.

## Business operations

`ingredientRequestRepository(client, db)` implements creating requests and changing their status. Creation checks accepted friendship, shared inventory, and quantity. Only owners accept/decline or complete; either participant can cancel pending/accepted requests. Acceptance does not reserve stock. Completion atomically checks and deducts inventory and updates the request in one transaction; repeated or concurrent completion cannot deduct twice. Request history does not reference an inventory document ID.

`recipeRepository(client, db).deleteOwned(actorId, recipeId)` deletes an author's recipe and its ingredient rows, saves, and shares within one transaction.

MongoDB does **not** enforce foreign keys or automatic deletion cascades. Recipe reads and writes use the authenticated session. New recipes are private by default and can be shared with accepted friends. A saved recipe or old share does not grant access after the friendship is removed. Raw collection access is not an authorization boundary. Recognition results remain drafts until confirmation; no upload collection is required yet.

## Verification

```powershell
npm test
```

Tests start a temporary, real MongoDB replica set, independent of `.env` and the application database. The first run downloads a MongoDB binary. They verify initialization/seed idempotency, unique and validation constraints, request permissions/privacy, concurrent completion, transaction rollback, history retention, and recipe cleanup.

References: [MongoDB schema validation](https://www.mongodb.com/docs/manual/core/schema-validation/specify-json-schema/), [Node driver transactions](https://www.mongodb.com/docs/drivers/node/current/crud/transactions/).
