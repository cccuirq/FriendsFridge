# Portal submission draft

> Upgrade status: the latest source passes local tests but has not passed
> production acceptance because the custom data room continued running its
> previous code after deployment. The live app was restored to the last
> verified release. Do not submit the new reliability/export claims below as
> live features until `docs/upgrade-acceptance.md` records a successful retry.

Evidence and review: [DeepSpace requirements mapping](docs/deepspace-evidence.md)
and [prioritized optimization review](docs/optimization-review.md).

**Project:** Friend's Fridge

**Live URL:** https://friends-fridge-jianghui.app.space

**Repository:** the DeepSpace cloud source repository for the deployed app;
CS409 review copy: https://github.com/cccuirq/409FinalProj/tree/deepspace-migration/deepspace-app.

Friend's Fridge helps friends turn their existing ingredients into dinner.
Users keep private inventories, choose what friends may see, find recipes
and missing ingredients, chat, and request an ingredient handoff. Completing
the handoff moves stock atomically, including protection against repeated
clicks. Recipe sharing uses explicit invitations and revocable access.

I adapted our existing five-person CS409 project (base commit `9f1e164`),
preserving its business flows and crediting the original team and image
sources. The exercise work migrates authentication and hosting to DeepSpace,
implements the database transaction boundary and authorized photo storage,
and uses the native Anthropic integration for reviewable photo suggestions.
It does not present the entire prior team project as five days of new work.

DeepSpace native auth, SQLite Durable Objects and the native Anthropic
integration serve clear purposes. Recipe photos are stored in a bounded SQLite BLOB table because the free
platform tier refused R2 bindings. Photo analysis uses a small Haiku request
instead of a model requiring a $2 reserve. The original manual review step
is essential: neither quantities nor freshness can be trusted from a photo.
Additional integrations would not improve the core food-sharing workflow.

My main tradeoff was one serialized, 8 MB SQLite workspace. This makes a
stock transfer and request transition one understandable transaction and
keeps the migration small. I would normalize/index the state and add chat
retention before opening it to a larger audience. Authenticated personal JSON export is already available.

The meal planner also distinguishes meals already in stock, meals that can be
completed by requesting friends' shared ingredients, and meals within a grocery
budget. Native Apify jobs retrieve public non-member Amazon US listings and
nearby shop listings independently; OpenWeather geocoding supports manual city
entry when browser location is unavailable. Package rounding, missing prices,
source timestamps, owner-bound jobs and credit caps are explicit. Lookup receipts survive navigation and temporary connection errors; retries resume the same job. Quotes expire automatically and inventory changes refresh the recommendation list. Bounded candidate groups explain what was checked and let users explicitly request the next group. Nearby store
prices remain unavailable, so the app clearly labels the online-price fallback
instead of claiming local checkout prices. See `docs/meal-planning.md`.

The coding agent implemented the platform migration, API compatibility,
deployment preparation and automated tests, and investigated errors. The
automated suite checks two independent native accounts, privacy and forged
identities, invitations, chat, idempotency, atomic transfer and recipe-share
access. The optional paid vision test exercises a real photo through the UI.

## Applicant verification to complete personally

Do not submit this section as if it had already happened. After opening the
deployed app, fill in what you actually verified or changed:

- [ ] Sign in and create a username; edit the profile; sign out and sign in.
- [ ] Add a private food; make one food visible to friends.
- [ ] With a second account, search/invite/accept; verify private food stays hidden.
- [ ] Send a message; borrow an ingredient; complete once and check both stocks.
- [ ] Create a recipe with a photo; accept a share; save it; remove access.
- [ ] Upload a photo, review the suggested names, enter quantities, and confirm.
- [ ] Click only the fridge door to open/close it; check the default closed state.
- [ ] Try borrowing recommendations and send an explicit ingredient request.
- [ ] Enter a budget and verify the whole-pack purchase total and price source;
      test location permission or the manual city alternative.
- [ ] Explain `transactionSync`, share revocation, server-side identity, credit
      limits and the single-room scaling tradeoff without relying on the agent.

**My own verification / changes:** _Replace with the applicant's actual observations._
