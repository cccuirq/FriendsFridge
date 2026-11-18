# Recipe sharing invitations

Sharing sends a conversation invitation. A recipient must accept before the invitation adds a recipe to **Shared with me** or grants access to a private recipe. Accepting does not automatically save the recipe to **Saved**.

## User interface

- In a friend's chat, **Share recipe** lets the sender choose one of their own recipes. Sharing from a recipe detail page also opens that friend's chat.
- A pending chat card shows **Accept** and **Decline** to the recipient and **Cancel share** to the sender.
- Accepted cards offer **View recipe** and, for the recipient, **Remove shared recipe** with confirmation. The recipe detail page also offers **Remove from shared recipes**.
- Removing revokes that invitation's access and clears the recipient's saved record, without deleting the author's original or affecting other recipients.
- Declined, cancelled and removed cards remain in the conversation. Sending again creates a new invitation and preserves earlier cards.
- SSE notifies both participants of new invitations and state changes; visible tabs also poll every five seconds. Conversation refresh includes previously loaded pages so older cards keep their current status.

## API

All endpoints require the signed-in session and enforce the existing cross-origin and account-change checks.

`POST /api/recipes/:recipeId/shares`

```json
{ "recipient_id": "friend-uuid" }
```

Only the author may share a recipe, and the recipient must be a current accepted friend. Returns the sharing record, including `_id` and `status: "pending"`. Retries return the existing pending or accepted invitation; they do not create duplicate cards or unread deliveries.

`PATCH /api/recipes/shares/:shareId`

```json
{ "status": "accepted" }
```

| Current status | Actor | Allowed next status |
| --- | --- | --- |
| pending | recipient | accepted, declined |
| pending | sender | cancelled |
| accepted | recipient | removed |

Unrelated accounts receive 404. Invalid or stale transitions receive 409. Acceptance requires that the original recipe still exists and the friendship remains accepted. State changes use transactions; racing acceptance and cancellation have exactly one winner. Removal also clears the recipient's saved record in the same transaction.

The conversation timeline includes `kind: "recipe_share"`, `recipe_id`, `recipe_title`, `recipe_available` and `status`. Pending cards expose the title but do not expose private recipe instructions, ingredients or uploaded images.

`GET /api/recipes` grants share access only for accepted invitations and current friendships. Such entries include `shared: true` and `share_id`. Public recipes and recipes already visible to all accepted friends retain their separate visibility rules, but are not placed in **Shared with me** without an accepted invitation.

## Upgrade

On server startup, `initializeDatabase` converts legacy shares without a status to **pending**, preserving their IDs and timestamps. Their recipients must now accept them. It replaces the old unique recipe/recipient index with a partial unique index covering pending and accepted invitations, allowing terminal invitations to remain as history while preventing duplicate active invitations. The migration is safe to run repeatedly. Restart the web server after updating, then refresh all browser tabs.
