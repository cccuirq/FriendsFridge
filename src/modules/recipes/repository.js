import { randomUUID } from 'node:crypto';
import { inTransaction } from '../../db/connection.js';
import { HttpError } from '../../utils/http.js';
import { friendPair } from '../friendships/delivery.js';

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
        shares.find({ recipient_id: actorId }).toArray(),
        saves.find({ user_id: actorId }).toArray(),
        ingredients.find({}, { projection: { _id: 1, name: 1, default_unit: 1 } }).sort({ name: 1 }).toArray(),
        db.collection('inventory_items').find({ user_id: actorId }, { projection: { ingredient_id: 1, quantity: 1 } }).toArray(),
      ]);
      const friendIds = relations.map((row) => row.user_low_id === actorId ? row.user_high_id : row.user_low_id);
      const friendSet = new Set(friendIds);
      const sharedBy = new Map(incoming.filter((row) => friendSet.has(row.sender_id)).map((row) => [row.recipe_id, row.sender_id]));
      const savedIds = new Set(saved.map((row) => row.recipe_id));
      const [rows, friends] = await Promise.all([
        recipes.find({ $or: [
          { author_id: actorId }, { visibility: 'public' },
          { visibility: 'friends', author_id: { $in: friendIds } },
          { _id: { $in: [...sharedBy.keys()] }, author_id: { $in: friendIds } },
        ] }).toArray(),
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
          missing_count: recipeItems.filter((row) => row.missing > 0).length,
          owned: recipe.author_id === actorId, saved: savedIds.has(recipe._id),
          shared: sharedBy.get(recipe._id) === recipe.author_id,
        };
      }).sort((a, b) => a.missing_count - b.missing_count ||
        a.missing_count / Math.max(1, a.items.length) - b.missing_count / Math.max(1, b.items.length) ||
        a.title.localeCompare(b.title) || a._id.localeCompare(b._id));
      return { recipes: result, ingredients: dictionary, friends };
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
        await inTransaction(client, async (session) => {
          const recipe = await recipes.findOne({ _id: recipeId, author_id: actorId }, { session });
          if (!recipe) throw notFound();
          if (!await friendships.findOne({ ...friendPair(actorId, recipientId), status: 'accepted' }, { session }) ||
              !await users.findOne({ _id: recipientId }, { session, projection: { _id: 1 } })) {
            throw new HttpError(404, 'FRIEND_NOT_FOUND', 'Choose someone from your friends list.');
          }
          await insertOnce(shares, key, { sender_id: actorId, message: '' }, session);
        });
      } catch (error) {
        if (error.code !== 11000 || !await shares.findOne({ ...key, sender_id: actorId })) throw error;
      }
      return { shared: true };
    },

    async deleteOwned(actorId, recipeId) {
      return inTransaction(client, async (session) => {
        const deleted = await db.collection('recipes').deleteOne({ _id: recipeId, author_id: actorId }, { session });
        if (!deleted.deletedCount) throw new Error('Recipe not found or not owned');
        for (const name of ['recipe_ingredients', 'saved_recipes', 'recipe_shares']) {
          await db.collection(name).deleteMany({ recipe_id: recipeId }, { session });
        }
      });
    },
  };
}
