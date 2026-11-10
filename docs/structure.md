# Project directory structure

The project uses MongoDB with validated application collections and a sessions collection. See [database setup](database/README.md) for connection settings, initialization, seed data, and database tests. The User & Friends frontend and HTTP APIs are implemented; other feature directories remain scaffolding.

```text
409FinalProj/
|-- server.js                  # Current HTTP server entry point
|-- package.json
|-- public/                    # Publicly served frontend files only
|   |-- index.html
|   |-- app.js                 # Current frontend entry point
|   |-- styles.css
|   |-- assets/
|   |   |-- images/
|   |   `-- icons/
|   `-- js/
|       |-- api/               # API client functions
|       |-- components/        # Reusable UI components
|       |-- utils/
|       `-- pages/
|           |-- auth/
|           |-- inventory/
|           |-- recipes/
|           |-- friends/
|           |-- requests/
|           `-- recognition/   # Upload, review, and correct suggestions
|-- src/                       # Server-only JavaScript
|   |-- config/                # Environment and service configuration
|   |-- db/                    # MongoDB connection and transaction helpers
|   |-- middleware/            # Authentication, validation, error handling
|   |-- utils/
|   `-- modules/
|       |-- auth/
|       |-- ingredients/       # Standard ingredient dictionary and units
|       |-- inventory/         # Quantities and per-item visibility
|       |-- recipes/           # Recipes, matching, saves, and shares
|       |-- friendships/       # Friend requests and accepted relationships
|       |-- ingredient-requests/
|       `-- recognition/       # Image service adapter and suggestion drafts
|-- database/
|   |-- migrations/            # Ordered MongoDB schema changes
|   `-- seeds/                 # Common ingredients and sample data
|-- tests/
|   |-- unit/
|   |-- integration/
|   |-- database/              # Constraints, transactions, concurrency
|   `-- fixtures/              # Synthetic test inputs
`-- docs/
    |-- structure.md
    |-- api/                   # Endpoints and shared response conventions
    |-- database/              # ER diagram, data dictionary, unit conventions
    `-- design/
        |-- heuristic-evaluation/
        `-- revisions/         # At least one revision based on evaluation
```

## Module and collection ownership

| Backend module | MongoDB collections | Responsibility |
| --- | --- | --- |
| `auth` | `users`, `sessions` | Accounts, login, logout, password hashes |
| `ingredients` | `ingredients` | Canonical ingredient names and default units |
| `inventory` | `inventory_items` | One row per user and ingredient; private/friends visibility |
| `recipes` | `recipes`, `recipe_ingredients`, `saved_recipes`, `recipe_shares` | Food and drink recipes, missing ingredients, saving, explicit sharing |
| `friendships` | `friendships` | One ordered user pair; pending/accepted/declined/removed |
| `ingredient-requests` | `ingredient_requests` | Request, accept, decline, cancel, and complete |
| `recognition` | None initially | Generate suggestions; save inventory only after user confirmation |

Within each backend module, add routes, controllers, services, and repository files as needed. Keep database access in repositories and business rules in services. Ingredient request transactions and recipe deletion are implemented as repository functions; User & Friends authenticated endpoints are implemented; remaining feature endpoints are pending. The server checks MongoDB at startup and exposes GET /api/health. It serves its original three frontend files; new frontend assets will require static route support when implemented.

## Shared implementation rules

- Obtain the acting user from authenticated server context. Check ownership, accepted friendship, and visibility on the backend.
- Use UUID string identifiers, reference IDs, timestamps, and collection validators. MongoDB has no foreign keys; application services must validate cross-collection references. Never store plaintext passwords.
- Use the ingredient dictionary's default unit for inventory, recipe quantities, and ingredient requests. Agree on canonical names and units before integrations.
- Enforce unique inventory `(user_id, ingredient_id)`, recipe ingredients `(recipe_id, ingredient_id)`, saves `(user_id, recipe_id)`, ordered friendships `(user_low_id, user_high_id)`, and recipe shares `(recipe_id, recipient_id)`.
- Enforce ordered, distinct friendship participants and membership of `requested_by`; only the recipient may accept or decline a friend request.
- Recipe visibility supports private/friends/public. Explicit recipients may view private recipes; saving alone grants no access. Initially, only authors may explicitly share their recipes with friends.
- Ingredient requests require accepted friendship, friends-visible inventory, and sufficient quantity. Allowed transitions are pending to accepted/declined/cancelled, then accepted to completed/cancelled. Acceptance does not reserve or deduct stock.
- On completion, recheck and deduct stock and update request status in one transaction; prevent duplicate completion and negative inventory. Inventory deletion must not delete request history.
- Cascade recipe deletion to its ingredient rows, saves, and shares. Index inventory user IDs, both friendship participants, and request owner/requester IDs.
- Compute missing ingredients from recipes and inventory rather than storing another table. Recognition suggestions remain drafts until reviewed and confirmed; no upload-history table is required initially.
- Keep credentials and private uploaded images outside `public/`. Define private upload storage when implementing recognition.
- Agree on API response and error formats in `docs/api/` before connecting modules.

Empty directories contain `.gitkeep` so Git can preserve the scaffold. Replace placeholders as implementation files are added.
