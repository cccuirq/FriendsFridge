# Friend’s Fridge

A CS 409 final project about keeping track of groceries and sharing ingredients and recipes with friends.

## Project idea

Friend’s Fridge helps users keep track of groceries, decide what to cook, and ask friends for ingredients they’re missing. If you need an egg for pancakes, you can check a friend’s shared fridge and send a request from the app.

## Proposal

[Project proposal](https://docs.google.com/document/d/1UlzD680KIkKY2jyNW98FWANaL8JMyS2eL-Badco_-6Q/edit?tab=t.0)

## Current status

- **Accounts.** Create an account, sign in or out, and edit your profile from the avatar menu.
- **Friends.** Find existing friends by name or username. Open **Invites** to search for new people by username and manage invitations. Select a friend’s name to open the conversation, or use the fridge icon to see the ingredients they’ve shared.
- **Messages.** The Friends list shows the latest message and puts unread conversations first. New messages and ingredient requests appear automatically. Red dots on the Friends tab and individual rows show what’s unread.
- **Ingredient requests.** Choose an ingredient and quantity from a friend’s shared fridge. The request appears in your conversation, where your friend can accept or decline it and record the handoff. Inventory is deducted when the handoff is marked complete.

- **Recipes.** Browse recommendations based on your current inventory, see exactly what is missing, save recipes, and create private recipes to share with accepted friends.

After sign-in, the app opens **My Fridge**, which shows saved inventory. **Photo Recognition** uploads a JPG/PNG to a local YOLO-World service, lets the user correct suggestions, and adds confirmed ingredients to the same inventory. General inventory editing is still planned.

For Photo Recognition, follow the [setup, testing and Inventory integration guide](docs/photo-recognition.md). It requires a separate Python 3.11 environment and local model service; the existing app still runs when that service is stopped, and manual ingredient entry remains available.

## Run locally

Requires Node.js 22 or newer. From the project directory, install dependencies and start the local MongoDB replica set. This also initializes the database and seeds ingredients and sample recipes.

```sh
npm ci
npm run db:local
```

Leave MongoDB running and run `npm start` in a second terminal. Open [Friend’s Fridge](http://127.0.0.1:3000) in your browser. Use `npm run dev` to restart the server automatically when code changes.

To use Docker, Atlas, or an existing replica set, follow the [database setup guide](docs/database/README.md). Run `npm test` to verify the app and database against a separate test replica set.

## Structure

- `server.js` and `src/app.js` start the Node.js server and serve the frontend and API.
- `public/` contains the browser interface, navigation, and live message updates.
- `src/modules/` contains the account, friendship, conversation, and ingredient-request logic.
- `src/db/` and `database/` contain the MongoDB schema, local setup, and ingredient seeds.

See the [project structure](docs/structure.md) for more detail.

## API

`GET /api/health` checks the MongoDB connection. See the [User & Friends API reference](docs/api/user-friends.md) for account and friendship endpoints.
