# Grocery quote verification repair

Verified November 22, 2026 (America/Chicago).

Live: https://friends-fridge-jianghui.app.space
Release: `rel_01M826EWBX71FKPHY9YP03TH9X`
Authoritative cloud source: `eb116a82b8cbdfec6b82e3359a406dd25930c505`, branch `fridge-cabinet-3d`.
The GitHub migration copy also retains earlier pending upgrades; that does not make those upgrades live.

## Causes and fixes

- Three search hits could all be irrelevant, unavailable, expensive bulk packs, or unsuitable substitutes. We now request up to six search hits per missing food, sort searches by price, and include a small set of directly checked product candidates for eggs, milk and flour. Candidate IDs contain no prices: each run retrieves current price and stock again.
- Equivalent dual-unit labels were rejected. Consistent labels within 2% are accepted conservatively; contradictory labels remain rejected.
- Package net count/volume in structured product attributes was ignored. We now use explicit Unit Count / Units / Package Size Name / Size when the title has no usable measurement. Shipping weight and box dimensions are excluded. Grams are never invented from a piece count or volume.
- Old empty results remained cached. The repair uses a versioned cache namespace, retains actual retrieval timestamps and bypasses previous rejected results.
- Limited query groups silently skipped later recipes. Groups now expose coverage and an explicit next-group action, retaining later candidates when the six-food limit is reached.
- A bare zero hid the reason. Missing quotes, not-yet-checked items and verified over-budget totals are separated. When no meal qualifies, checked candidates remain visible with incomplete/over-budget labels; partial subtotals are never treated as complete budget totals.

Unavailable stock, missing public prices, unknown pack sizes, conditional discounts, incompatible products and invalid links have distinct diagnostics. Flour substitutes, plant-based milk and processed tomato alternatives are excluded where they do not match the canonical ingredient.

## Verification

29 deployed-source unit checks pass; the migration copy passes 37 including its pending-feature checks. A real local browser flow passed. Production auth/static/price checks passed 8/8 in 32.9 seconds, using native test authentication and real Apify results.

The live test found a complete two-serving pancake purchase: eggs $2.17 (12 count), milk $2.35 (1 gallon), flour $0.97 (2 lb): **$5.49 total**, within $15. The app charges whole packs and displays leftover quantities. These are time-specific Amazon US non-member catalogue listings, not local-store checkout prices. Tax, shipping, minimum basket rules and delivery eligibility must be confirmed with the retailer.

Earlier test iterations exposed bulk milk and unrelated low-price hits and were not marked successful. They led to the direct-detail candidates and revised search strategy. No estimates or old fixture prices were inserted into production responses. Captured fixtures test parsing only; production always uses live retrieval or an unexpired public-offer cache.

Price jobs are bounded at 42 products and $0.25 per run, with existing daily limits of three per user/eight per app. A group covers up to four recipes and six missing foods. Recipes with more than six missing foods are not directly targeted by a single group; cached prices from other groups may still cover them. A query is not an exhaustive market comparison.

This repair uses existing room RPC operations and changes the Worker/parser/UI; it does not require a data-room upgrade or a maintenance window. The restored cabinet and refined photo picker remain unchanged.

See [machine-readable evidence](evidence/pricing-verification-2026-11-22.json).
