# Verified deployment

- Verified on November 21, 2026.
- Live: https://friends-fridge-jianghui.app.space
- App: `app_01M7T9Z1CJZANYFXBFTZ2M1FQM` (the existing MemoryFlow identity).
- Release: `rel_01M7ZSV4BHPEDWC176A8JM3VEV`.
- Authoritative DeepSpace source commit: `408590fee7`.
- Original CS409 base: `9f1e164` by VOE-Du.
- Previous MemoryFlow source remains in cloud Git history (`2321800`);
  the local official clone also has tag `memoryflow-before-fridge-20261121`.
- The old MemoryFlow URL was replaced. No app undeploy or data deletion was run.

## Checks actually performed by the agent

1. A clean `npm ci` succeeded after regenerating the dependency lockfile.
2. TypeScript checks, lint and production build succeeded.
3. Sixteen unit tests passed, including canonical seed references, quantity
   validation, private inventory, stale edits, idempotent imports, model output
   validation and the recognition quota.
4. Eight local browser/API tests passed.
5. All eight tests also passed against the live URL using two independent
   native test accounts. The journey covered onboarding, username search,
   recipient-only friendship acceptance, inventory visibility, message
   idempotency/unread, a concurrent repeated handoff (one success and one
   conflict), stock conservation, ownership checks, private recipe photo
   storage, invitation acceptance, saving, share revocation and friend removal.
6. Real cloud vision ran through the deployed photo upload UI with the public
   apple image. The editable suggestions contained `apple`; quantity was blank
   for human confirmation. No mock model response was used in this check.
7. Screenshots were inspected. The native scaffold's dark-theme text initially
   conflicted with the original light UI; the final build uses the paper theme.
8. Production error logs for the final 10-minute window contained zero events.
   Earlier release history remains available for recovery.

These are automated/agent checks, not a claim that the applicant has personally
verified the app. Complete the checklist in SUBMISSION.md before submitting.

## Free-tier adaptations

The initial R2 deploy was refused because that custom binding requires an
admin account. Photos now use an authorized SQLite BLOB table (2 MB per photo,
20 MB total); the application snapshot has a separate 8 MB cap.

Florence-2's minimum reserve exceeded available credits. Haiku 4.5 was verified
instead, using DeepSpace's native Anthropic integration with bounded image
size, output and attempts. Existing credits suffice for the demonstrated
path; it still incurs per-use charges and is not an indefinitely free API.

No old MongoDB accounts, passwords, inventories or private uploads were copied
to production. Native sign-in asks each person to choose their app username.

## Recheck production

```sh
# Requires two usable native test accounts in the local CLI store.
# Set FRIDGE_VISION_LIVE=1 only to include the small paid image test.
FRIDGE_TEST_URL=https://friends-fridge-jianghui.app.space \
  npx playwright test --config tests/playwright.config.ts --workers 2
```

On PowerShell set the variables using `$env:FRIDGE_TEST_URL = '...'` first.
