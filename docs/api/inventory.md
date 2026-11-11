# Fridge inventory API

All routes require the existing `ff_session` cookie. The server derives the owner from that session. Use same-origin JSON writes, lowercase UUIDs and the standard `{ "data": ... }` / `{ "error": { "code", "message" } }` envelopes.

Quantities are safe integers in hundredths of the ingredient dictionary's default unit: 2 eggs = 200; 125 ml milk = 12500. The UI displays normal units and accepts at most two decimal places. No arbitrary names or client-supplied units are accepted.

| Method | Route | Body / behavior |
| --- | --- | --- |
| GET | `/api/ingredients` | Alphabetical dictionary: `_id`, `name`, `category`, `default_unit` |
| GET | `/api/inventory` | Owner's stock, sorted by ingredient name, including joined `ingredient` details |
| POST | `/api/inventory` | `{ batch_id, ingredient_id, quantity, visibility? }`; quantity must be positive; visibility defaults to `private` |
| PATCH | `/api/inventory/:id` | `{ quantity?, expected_quantity?, visibility? }`; at least quantity or visibility required |
| DELETE | `/api/inventory/:id` | `{ expected_quantity }`; removes stock without deleting request history |

Visibility is `private` (Only me) or `friends` (all accepted friends). New stock uses the selected visibility. Adding more of an existing ingredient preserves its sharing setting; change it through PATCH. The shared-fridge endpoint includes only friends-visible stock with a positive quantity. No anonymous/public inventory access is provided.

POST adds to existing stock rather than replacing it. Generate a fresh `batch_id` per intended addition; keep the same ID and identical payload on network/server failure. It uses the same transactional `inventory_imports` receipts as photo confirmation. Replays return 200 with `{ batch_id, added: 1, replayed: true }`; initial success returns `replayed: false`. A different payload with the same batch ID returns 409 `BATCH_CONFLICT`. Existing photo-import payloads and receipts remain compatible.

PATCH may set quantity to zero, keeping an out-of-stock entry. Quantity changes require `expected_quantity`, the stock quantity last read. DELETE also requires it. Both match ownership and quantity in the atomic database operation. A changed quantity returns 409 `STOCK_CHANGED`; refresh and review before retrying. This protects edits from overwriting intervening photo additions, handoffs and other edits. Visibility-only updates do not replace quantities.

Missing or another user's stock returns 404 `ITEM_NOT_FOUND`. Invalid quantities, visibility, unknown dictionary entries or unexpected fields return 400. Authentication and cross-origin protections use the existing shared API rules.

The My Fridge page offers searchable dictionary selection, quantities, per-food sharing, edit/delete and one-unit increase/decrease controls. The refrigerator opens once per authenticated page session, respects reduced-motion settings and adapts to mobile screens. Recipe availability is recomputed on its next load. Photo imports appear when returning to My Fridge. No database schema migration is needed.
