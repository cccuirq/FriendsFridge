import { randomUUID } from 'node:crypto';
import { inTransaction } from '../../db/connection.js';
import { HttpError } from '../../utils/http.js';
import { friendPair, recordDelivery } from '../friendships/delivery.js';

const notFound = () => new HttpError(404, 'RECIPE_NOT_FOUND', 'Recipe not found.');
const byId = (rows) => new Map(rows.map((row) => [row._id, row]));

export function recipeRepository(client, db) {
  const recipes = db.collection('recipes');
  const items = db.collection('recipe_ingredients');
  const saves = db.collection('saved_recipes');
  const shares = db.collection('recipe_shares');
  const ingredients = db.collection('ingredients');
  const friendships = db.collection('friendships');
  const users = db.collection('users');
  const publicFields = { projection: { _id: 1, display_name: 1, username: 1 } };

  async function canView(recipe, actorId, session) {
    if (!recipe) return false;
    if (recipe.author_id === actorId || recipe.visibility === 'public') return true;
    if (!recipe.author_id) return false;
    const relationship = await friendships.findOne({ ...friendPair(actorId, recipe.author_id), status: 'accepted' }, { session });
    if (!relationship) return false;
    return recipe.visibility === 'friends' || Boolean(await shares.findOne({
      recipe_id: recipe._id, recipient_id: actorId, sender_id: recipe.author_id,
      status: 'accepted',
    }, { session }));
  }

  async function insertOnce(collection, key, row, session) {
    await collection.updateOne(key, { $setOnInsert: { ...key, ...row, _id: randomUUID(), created_at: new Date() } },
      { upsert: true, session });
  }

  return {
    async list(actorId) {
      const [relations, incoming, saved, dictionary, stock] = await Promise.all([
        friendships.find({ status: 'accepted', $or: [{ user_low_id: actorId }, { user_high_id: actorId }] }).toArray(),
        shares.find({ recipient_id: actorId, status: 'accepted' }).toArray(),
        saves.find({ user_id: actorId }).toArray(),
        ingredients.find({}, { projection: { _id: 1, name: 1, default_unit: 1 } }).sort({ name: 1 }).toArray(),
        db.collection('inventory_items').find({ user_id: actorId }, { projection: { ingredient_id: 1, quantity: 1 } }).toArray(),
      ]);
      const friendIds = relations.map((row) => row.user_low_id === actorId ? row.user_high_id : row.user_low_id);
      const friendSet = new Set(friendIds);
      const sharedBy = new Map(incoming.filter((row) => friendSet.has(row.sender_id)).map((row) => [row.recipe_id, row.sender_id]));
      const savedIds = new Set(saved.map((row) => row.recipe_id));
      const shareIds = new Map(incoming.map((row) => [row.recipe_id, row._id]));
      const [rows, friends] = await Promise.all([
        recipes.find({ $or: [
          { author_id: actorId }, { visibility: 'public' },
          { visibility: 'friends', author_id: { $in: friendIds } },
          { _id: { $in: [...sharedBy.keys()] }, author_id: { $in: friendIds } },
        ] }, { projection: { 'image.data': 0 } }).toArray(),
        users.find({ _id: { $in: friendIds } }, publicFields).sort({ display_name: 1, _id: 1 }).toArray(),
      ]);
      const visible = rows.filter((recipe) => recipe.author_id === actorId || recipe.visibility === 'public' ||
        (friendSet.has(recipe.author_id) && (recipe.visibility === 'friends' || sharedBy.get(recipe._id) === recipe.author_id)));
      const dictionaryById = byId(dictionary);
      const stockById = new Map(stock.map((row) => [row.ingredient_id, row.quantity]));
      const byRecipe = new Map(visible.map((recipe) => [recipe._id, []]));
      for (const row of await items.find({ recipe_id: { $in: [...byRecipe.keys()] } }).toArray()) {
        const ingredient = dictionaryById.get(row.ingredient_id);
        const available = ingredient ? (stockById.get(row.ingredient_id) ?? 0) : 0;
        byRecipe.get(row.recipe_id).push({
          ingredient_id: row.ingredient_id, name: ingredient?.name ?? 'Unavailable ingredient',
          unit: ingredient?.default_unit ?? '', required: row.quantity, available,
          missing: Math.max(row.quantity - available, 0),
        });
      }
      const result = visible.map((recipe) => {
        const recipeItems = byRecipe.get(recipe._id);
        return {
          _id: recipe._id, title: recipe.title, description: recipe.description, servings: recipe.servings,
          instructions: recipe.instructions, items: recipeItems,
          ...(recipe.image ? { image_url: `/api/recipes/${recipe._id}/image` } : {}),
          missing_count: recipeItems.filter((row) => row.missing > 0).length,
          owned: recipe.author_id === actorId, saved: savedIds.has(recipe._id),
          shared: sharedBy.get(recipe._id) === recipe.author_id,
          ...(sharedBy.get(recipe._id) === recipe.author_id ? { share_id: shareIds.get(recipe._id) } : {}),
        };
      }).sort((a, b) => a.missing_count - b.missing_count ||
        a.missing_count / Math.max(1, a.items.length) - b.missing_count / Math.max(1, b.items.length) ||
        a.title.localeCompare(b.title) || a._id.localeCompare(b._id));
      return { recipes: result, ingredients: dictionary, friends };
    },

    async image(actorId, recipeId) {
      const recipe = await recipes.findOne({ _id: recipeId });
      if (!await canView(recipe, actorId) || !recipe.image) throw notFound();
      return { content_type: recipe.image.content_type, data: Buffer.from(recipe.image.data.buffer) };
    },

    async create(actorId, data) {
      const _id = randomUUID();
      const now = new Date();
      return inTransaction(client, async (session) => {
        const ingredientIds = data.items.map((row) => row.ingredient_id);
        if (await ingredients.countDocuments({ _id: { $in: ingredientIds } }, { session }) !== ingredientIds.length) {
          throw new HttpError(400, 'INVALID_INGREDIENT', 'Choose ingredients from the fridge ingredient list.');
        }
        const { items: rows, ...details } = data;
        await recipes.insertOne({ _id, ...details, author_id: actorId, visibility: 'private', created_at: now, updated_at: now }, { session });
        await items.insertMany(rows.map((row) => ({ _id: randomUUID(), recipe_id: _id, ...row, created_at: now })), { session });
        return { _id };
      });
    },

    async updateOwned(actorId, recipeId, data) {
      return inTransaction(client, async (session) => {
        if (!await recipes.findOne({ _id: recipeId, author_id: actorId }, { session, projection: { _id: 1 } })) throw notFound();
        const { items: rows, image, ...details } = data;
        const ingredientIds = rows.map((row) => row.ingredient_id);
        if (await ingredients.countDocuments({ _id: { $in: ingredientIds } }, { session }) !== ingredientIds.length) {
          throw new HttpError(400, 'INVALID_INGREDIENT', 'Choose ingredients from the fridge ingredient list.');
        }
        const now = new Date();
        const update = { $set: { ...details, updated_at: now, ...(image ? { image } : {}) }, ...(image === null ? { $unset: { image: '' } } : {}) };
        await recipes.updateOne({ _id: recipeId, author_id: actorId }, update, { session });
        await items.deleteMany({ recipe_id: recipeId }, { session });
        await items.insertMany(rows.map((row) => ({ _id: randomUUID(), recipe_id: recipeId, ...row, created_at: now })), { session });
        return { _id: recipeId };
      });
    },

    async setSaved(actorId, recipeId, saved) {
      const key = { user_id: actorId, recipe_id: recipeId };
      if (!saved) {
        await saves.deleteOne(key);
      } else {
        try {
          await inTransaction(client, async (session) => {
            if (!await canView(await recipes.findOne({ _id: recipeId }, { session }), actorId, session)) throw notFound();
            await insertOnce(saves, key, {}, session);
          });
        } catch (error) {
          if (error.code !== 11000 || !await saves.findOne(key)) throw error;
        }
      }
      return { saved };
    },

    async share(actorId, recipeId, recipientId) {
      if (actorId === recipientId) throw new HttpError(400, 'SELF_SHARE', 'Choose a friend other than yourself.');
      const key = { recipe_id: recipeId, recipient_id: recipientId };
      try {
        return await inTransaction(client, async (session) => {
          const recipe = await recipes.findOne({ _id: recipeId, author_id: actorId }, { session });
          if (!recipe) throw notFound();
          if (!await friendships.findOne({ ...friendPair(actorId, recipientId), status: 'accepted' }, { session }) ||
              !await users.findOne({ _id: recipientId }, { session, projection: { _id: 1 } })) {
            throw new HttpError(404, 'FRIEND_NOT_FOUND', 'Choose someone from your friends list.');
          }
          const existing = await shares.findOne({ ...key, status: { $in: ['pending', 'accepted'] } }, { session });
          if (existing) return existing;
          const now = new Date();
          const share = { _id: randomUUID(), ...key, sender_id: actorId, message: '', recipe_title: recipe.title, status: 'pending', created_at: now, updated_at: now };
          await shares.insertOne(share, { session });
          await recordDelivery(db, actorId, recipientId, session);
          return share;
        });
      } catch (error) {
        if (error.code === 11000) {
          const existing = await shares.findOne({ ...key, sender_id: actorId, status: { $in: ['pending', 'accepted'] } });
          if (existing) return existing;
          throw new HttpError(409, 'SHARE_CONFLICT', 'This sharing invitation changed. Please try again.');
        }
        throw error;
      }
    },

    async transitionShare(actorId, shareId, nextStatus) {
      return inTransaction(client, async (session) => {
        const share = await shares.findOne({ _id: shareId }, { session });
        if (!share || ![share.sender_id, share.recipient_id].includes(actorId)) throw new HttpError(404, 'SHARE_NOT_FOUND', 'Sharing invitation not found.');
        const isRecipient = actorId === share.recipient_id;
        const allowed = (share.status === 'pending' && (isRecipient ? ['accepted', 'declined'].includes(nextStatus) : nextStatus === 'cancelled'))
          || (share.status === 'accepted' && isRecipient && nextStatus === 'removed');
        if (!allowed) throw new HttpError(409, 'SHARE_CONFLICT', 'This action is no longer available for this sharing invitation.');
        if (nextStatus === 'accepted') {
          if (!await recipes.findOne({ _id: share.recipe_id, author_id: share.sender_id }, { session, projection: { _id: 1 } })) throw notFound();
          if (!await friendships.findOne({ ...friendPair(share.sender_id, share.recipient_id), status: 'accepted' }, { session })) {
            throw new HttpError(404, 'FRIEND_NOT_FOUND', 'An accepted friendship is required.');
          }
        }
        const updated = await shares.findOneAndUpdate({ _id: shareId, status: share.status }, {
          $set: { status: nextStatus, updated_at: new Date() },
        }, { session, returnDocument: 'after' });
        if (!updated) throw new HttpError(409, 'SHARE_CONFLICT', 'This sharing invitation changed. Please reload.');
        if (nextStatus === 'removed') await saves.deleteOne({ user_id: actorId, recipe_id: share.recipe_id }, { session });
        const peerId = isRecipient ? share.sender_id : share.recipient_id;
        if (await friendships.findOne({ ...friendPair(actorId, peerId), status: 'accepted' }, { session })) {
          await recordDelivery(db, actorId, peerId, session);
        }
        return updated;
      });
    },

    async deleteOwned(actorId, recipeId) {
      return inTransaction(client, async (session) => {
        const deleted = await db.collection('recipes').deleteOne({ _id: recipeId, author_id: actorId }, { session });
        if (!deleted.deletedCount) throw new HttpError(404, 'RECIPE_NOT_FOUND', 'Recipe not found or not owned');
        for (const name of ['recipe_ingredients', 'saved_recipes', 'recipe_shares']) {
          await db.collection(name).deleteMany({ recipe_id: recipeId }, { session });
        }
      });
    },
  };
}
