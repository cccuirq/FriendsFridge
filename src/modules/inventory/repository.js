import { createHash, randomUUID } from 'node:crypto';
import { inTransaction } from '../../db/connection.js';
import { HttpError } from '../../utils/http.js';

// Shared stock management for manual edits, photo imports, recipes and handoffs.
export function inventoryRepository(client, db) {
  const stock = db.collection('inventory_items');
  const receipts = db.collection('inventory_imports');
  return {
    async list(actorId) {
      return stock.aggregate([
        { $match: { user_id: actorId } },
        { $lookup: { from: 'ingredients', localField: 'ingredient_id', foreignField: '_id', as: 'ingredient' } },
        { $unwind: '$ingredient' },
        { $sort: { 'ingredient.name': 1 } },
      ]).toArray();
    },
    async update(actorId, itemId, changes, expectedQuantity) {
      const filter = { _id: itemId, user_id: actorId };
      if ('quantity' in changes) filter.quantity = expectedQuantity;
      const result = await stock.findOneAndUpdate(filter, { $set: { ...changes, updated_at: new Date() } }, { returnDocument: 'after' });
      if (!result) {
        if (!await stock.findOne({ _id: itemId, user_id: actorId })) throw new HttpError(404, 'ITEM_NOT_FOUND', 'Food is no longer in your fridge.');
        throw new HttpError(409, 'STOCK_CHANGED', 'Stock changed while you were editing. Review the latest quantity and try again.');
      }
      return result;
    },
    async remove(actorId, itemId, expectedQuantity) {
      const result = await stock.deleteOne({ _id: itemId, user_id: actorId, quantity: expectedQuantity });
      if (!result.deletedCount) {
        if (!await stock.findOne({ _id: itemId, user_id: actorId })) throw new HttpError(404, 'ITEM_NOT_FOUND', 'Food is no longer in your fridge.');
        throw new HttpError(409, 'STOCK_CHANGED', 'Stock changed. Review the latest quantity before deleting.');
      }
      return { deleted: true };
    },
    async addBatch(actorId, batchId, items, visibility) {
      const fingerprint = createHash('sha256').update(JSON.stringify(visibility === undefined ? items : { items, visibility })).digest('hex');
      const filter = { user_id: actorId, batch_id: batchId };
      const replay = (receipt) => {
        if (receipt.fingerprint !== fingerprint) throw new HttpError(409, 'BATCH_CONFLICT', 'This addition was already confirmed with different contents. Start a new addition.');
        return { batch_id: batchId, added: items.length, replayed: true };
      };
      const existing = await receipts.findOne(filter);
      if (existing) return replay(existing);
      try {
        return await inTransaction(client, async (session) => {
          const receipt = await receipts.findOne(filter, { session });
          if (receipt) return replay(receipt);
          const ids = items.map((item) => item.ingredient_id);
          if (await db.collection('ingredients').countDocuments({ _id: { $in: ids } }, { session }) !== ids.length) {
            throw new HttpError(400, 'INVALID_INGREDIENT', 'Choose ingredients from the shared ingredient list.');
          }
          const now = new Date();
          await receipts.insertOne({ _id: randomUUID(), ...filter, fingerprint, created_at: now }, { session });
          for (const item of items) {
            const key = { user_id: actorId, ingredient_id: item.ingredient_id };
            const current = await stock.findOne(key, { session });
            if (current && !Number.isSafeInteger(current.quantity + item.quantity)) {
              throw new HttpError(400, 'INVALID_QUANTITY', 'The resulting quantity is too large.');
            }
            await stock.updateOne(key, {
              $inc: { quantity: item.quantity }, $set: { updated_at: now },
              $setOnInsert: { _id: randomUUID(), created_at: now, visibility: visibility ?? 'private' },
            }, { session, upsert: true });
          }
          return { batch_id: batchId, added: items.length, replayed: false };
        });
      } catch (error) {
        if (error.code === 11000) {
          const receipt = await receipts.findOne(filter);
          if (receipt) return replay(receipt);
          throw new HttpError(409, 'INVENTORY_BUSY', 'Inventory changed. Retry this same confirmation.');
        }
        throw error;
      }
    },
  };
}
