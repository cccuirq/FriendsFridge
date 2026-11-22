# Inventory, borrowing and budget planning

The Recipes page combines one cooking mode (all, in stock, borrow, budget)
with an independent collection filter (all, saved, owned, shared). Changing
the serving count recalculates shortages on the server. Editing a recipe
still uses its original serving count and base quantities.

## Borrowing

Only accepted friends' positive inventory marked `friends` is considered.
A recipe is borrowable when those public quantities cover every shortage.
Suggestions expose no private inventory or contact email. Requests are sent
explicitly to each owner and may be split across friends; displayed availability
does not reserve stock. The existing accepted/completed handoff remains the
only stock-transfer operation.

## Current data sources and honest boundaries

The platform's SerpApi places and shopping endpoints returned an upstream
429, and its built-in Amazon search also depended on that depleted service.
The user approved an online-price fallback with nearby shops shown separately.

The implementation uses native DeepSpace integrations:

- `apify/run-actor` / `apify/get-run`, with `junglee/amazon-crawler`, for
  anonymous Amazon US public listings, in-stock flags and package titles.
- The same native integration with `compass/crawler-google-places` for nearby
  grocery listings, using a coarse point after explicit location permission.
- `openweathermap/geocoding` for the manual city alternative.

These independent providers were exercised with real public sample queries.
The app does not have a nearby branch's product inventory, checkout prices,
delivery eligibility, or member account. It never labels online prices as
local-store prices. No Prime, subscription, coupon or assumed member discounts
are applied. Taxes and delivery are explicitly excluded. Product links let the
user confirm a listing before purchase; the app does not place orders.

Nearby locations use rounded coordinates (two decimal places). There is no
continuous location watch and no location sharing with friends. Job metadata
and public nearby results expire after one hour. Browser permission is requested
only after a click; denied/unavailable location falls back to a city entry.

## Price calculation

1. The authenticated server reads accessible recipes and the user's inventory.
2. Required amounts are rounded up to integer hundredths for the planned people.
3. The lookup prioritizes the four closest recipes, with at most six distinct
   missing foods, to bound lookup time and owner credits.
4. Product names must match the canonical ingredient. Unknown or ambiguous
   package sizes, incompatible units, unavailable products and conditional
   discounts are rejected. Piece counts are not inferred from weight.
5. Only explicit package measurements are converted to canonical g/ml/piece.
   US fluid units apply to the Amazon US catalogue.
6. Packs = ceiling(shortage / pack contents). The full pack purchase price is
   charged in integer cents. Leftover contents are displayed; each meal is
   calculated independently, not as a combined multi-recipe basket.
7. Incomplete prices never count as zero. The UI distinguishes verified
   budget results from unpriced and over-budget recipes.

Quotes and public offers cache for 15 minutes and retain their actual retrieval
timestamp. Render-time checks exclude expired recommendations; an automatic
expiry banner for a page left idle is a follow-up item in optimization-review.md.
Serving or inventory changes invalidate incompatible recommendations.

## Reliability and cost

Lookups are asynchronous jobs with an owner-bound ID, status, short poll lock
and expiry in the application's SQLite Durable Object. The server controls
actor IDs, search URLs and limits; callers cannot run arbitrary actors or
retrieve someone else's job. Duplicate job IDs cannot start another run.

Price jobs cap at 18 products and $0.12 per run. Map jobs cap at six stores
and require a provider minimum reserve of $0.50 (actual sample cost $0.0242).
Daily quote attempts cap at three per user/eight per app; location attempts
cap at twelve per user/forty per app. Providers settle their actual usage;
failed or unavailable lookups display an error, with no fabricated price.

The paid end-to-end check is opt-in:

```sh
# PowerShell: $env:FRIDGE_SHOPPING_LIVE = '1'
FRIDGE_SHOPPING_LIVE=1 npx deepspace test run e2e --port 5198
```

Regular tests cover package rounding, unavailable/conditional listings, missing
prices, serving arithmetic, friendship privacy, explicit borrow requests,
manual door toggling and desktop/mobile planning layout without paid calls.

## Reliability upgrade

Lookup receipts are saved before submission and scoped to the current profile.
Navigation, reloads and transient poll errors resume the same owner-bound job;
changed request contents under an existing ID are rejected. Terminal failures
clear the receipt. If a provider starts but its ID cannot be persisted, the
app times out honestly rather than automatically creating another paid run;
this is not a claim of distributed exactly-once billing.

Quotes expire after 15 minutes and invalidate when stock, budget or servings
change. Live reads retain the current collection and meal mode. Each query
reports its four-recipe/six-food scope, supports an explicit next group, and
distinguishes unchecked ingredients from checked ingredients with no verified
offer. Recipes with more than six missing foods cannot be fully checked by
one bounded run. A zero budget never starts a provider price search.

Nearby results exclude obvious closed/non-retail or restricted services,
sort by approximate straight-line distance (within 15 km), and collapse after
completion. Listings still require confirmation before travel. Personal JSON
export is available on the profile page; photos remain authorized URLs rather
than embedded image backups. See [upgrade acceptance](upgrade-acceptance.md).
