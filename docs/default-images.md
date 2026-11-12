# Default food and drink images

Open `/image-demo` to see all 222 locally cached images without signing in. The same image helper is used by My Fridge, friends' shared ingredients, and recipe cards/details. Unknown ingredients or failed images retain a category icon.

All 206 original dictionary entries are covered, plus black pepper and five spirits/liqueurs (gin, vodka, rum, tequila, triple sec): 212 ingredients across eight categories. The 10 public sample recipes include breakfast, salads, rice, omelette, seafood, soup, a non-alcoholic milkshake and two cocktails. They use representative illustrations, not a claim that the external recipe exactly matches the app's ingredients or instructions. Custom recipes keep an icon placeholder if no curated title matches. The preview gallery supports search and category filtering. Seeding adds dictionary and recipe records, never user stock.

Assets live in `public/assets/defaults/`; `manifest.js` tracks each image's original URL, source page, provider, and local path. Wikimedia entries also record the author, license name, license link and original file title. `shared/default-image-catalog.json` is the shared list of canonical names and curated source mappings. `coverage.json` records counts and any unresolved downloads. No user information, inventory, or private recipe data is sent to the providers. The browser makes same-origin image requests and needs no external-image CSP exception or API key.

To synchronize ingredients/recipes and download missing cached images (Python standard library, internet required):

```powershell
npm run db:seed
npm run db:seed:recipes
python scripts/sync_default_images.py
```

This uses the providers' educational/development test key `1` for the selected meal/cocktail lookups. It is a small educational preview, not a bulk dataset or a claim of unrestricted image rights. Follow the providers' terms for deployment; the API documentation specifies supporter/production key requirements for public app-store releases. Preserve source attribution when reusing the assets.

Missing provider photos are supplemented by Wikimedia Commons with author/license attribution. Existing downloaded images are reused; Wikimedia requests are paced and retried on rate limits. A failed download is listed in `coverage.json` and makes the script exit with an error instead of claiming full coverage.

Sources: [Wikimedia reuse guidance](https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia), [TheMealDB API and ingredient thumbnails](https://www.themealdb.com/api.php), [TheCocktailDB API and ingredient thumbnails](https://www.thecocktaildb.com/api.php). Attribution is displayed in the app footer, preview cards, and recipe illustrations.

`npm test` checks lookup aliases, unknown-name fallback, source metadata, local image signatures, static routes and missing-image responses, alongside existing application tests.
