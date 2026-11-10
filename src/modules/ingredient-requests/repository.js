import { randomUUID } from 'node:crypto';
import { inTransaction } from '../../db/connection.js';
import { HttpError } from '../../utils/http.js';
import { friendPair, recordDelivery } from '../friendships/delivery.js';

export function ingredientRequestRepository(client, db) {
  const requests = db.collection('ingredient_requests');
  const inventory = db.collection('inventory_items');
  const users = db.collection('users');
  const ingredients = db.collection('ingredients');
  const publicProfile = { _id: 1, username: 1, display_name: 1 };
  const ingredientDetails = { _id: 1, name: 1, category: 1, default_unit: 1 };

  async function requireFriend(actorId, friendId, session) {
    const friend = await db.collection('friendships').findOne({ ...friendPair(actorId, friendId), status: 'accepted' }, { session });
    if (!friend) throw new HttpError(404, 'FRIEND_NOT_FOUND', 'An accepted friendship is required.');
  }

  // actorId must come from the authenticated session, never a request body.
  return {
    async sharedFridge(actorId, friendId, skip) {
      return inTransaction(client, async (session) => {
        await requireFriend(actorId, friendId, session);
        const friend = await users.findOne({ _id: friendId }, { session, projection: publicProfile });
        if (!friend) throw new HttpError(404, 'FRIEND_NOT_FOUND', 'Friend not found.');
        const items = await inventory.aggregate([
          { $match: { user_id: friendId, visibility: 'friends', quantity: { $gt: 0 } } },
          { $lookup: { from: 'ingredients', localField: 'ingredient_id', foreignField: '_id', pipeline: [{ $project: ingredientDetails }], as: 'ingredient' } },
          { $unwind: '$ingredient' },
          { $sort: { 'ingredient.name': 1, _id: 1 } },
          { $skip: skip },
          { $limit: 20 },
          { $project: { _id: 0, quantity: 1, ingredient: 1 } },
        ], { session }).toArray();
        return { friend, items };
      });
    },
    async list(actorId, skip) {
      const rows = await requests.find({ $or: [{ owner_id: actorId }, { requester_id: actorId }] })
        .sort({ updated_at: -1, _id: 1 }).skip(skip).limit(20).toArray();
      const otherIds = rows.map((row) => row.owner_id === actorId ? row.requester_id : row.owner_id);
      const [people, foods] = await Promise.all([
        users.find({ _id: { $in: otherIds } }, { projection: publicProfile }).toArray(),
        ingredients.find({ _id: { $in: rows.map((row) => row.ingredient_id) } }, { projection: ingredientDetails }).toArray(),
      ]);
      const peopleById = new Map(people.map((person) => [person._id, person]));
      const foodsById = new Map(foods.map((food) => [food._id, food]));
      return rows.map((row, index) => ({ ...row, person: peopleById.get(otherIds[index]), ingredient: foodsById.get(row.ingredient_id) }));
    },
    async create(actorId, { owner_id, ingredient_id, quantity, message = '' }) {
      if (actorId === owner_id || !Number.isSafeInteger(quantity) || quantity <= 0) throw new HttpError(400, 'INVALID_INPUT', 'Enter a valid ingredient and quantity.');
      return inTransaction(client, async (session) => {
        await requireFriend(actorId, owner_id, session);
        const item = await inventory.findOne({ user_id: owner_id, ingredient_id, visibility: 'friends', quantity: { $gte: quantity } }, { session });
        if (!item) throw new HttpError(409, 'INGREDIENT_UNAVAILABLE', 'This shared ingredient is unavailable in that quantity.');
        const now = new Date();
        const request = { _id: randomUUID(), requester_id: actorId, owner_id, ingredient_id, quantity, message, status: 'pending', created_at: now, updated_at: now };
        await requests.insertOne(request, { session });
        await recordDelivery(db, actorId, owner_id, session);
        return request;
      });
    },
    async transition(actorId, requestId, nextStatus) {
      return inTransaction(client, async (session) => {
        const request = await requests.findOne({ _id: requestId }, { session });
        if (!request) throw new HttpError(404, 'REQUEST_NOT_FOUND', 'Request not found.');
        const isOwner = actorId === request.owner_id;
        const isRequester = actorId === request.requester_id;
        const allowed = (request.status === 'pending' && isOwner && ['accepted', 'declined'].includes(nextStatus))
          || (['pending', 'accepted'].includes(request.status) && (isOwner || isRequester) && nextStatus === 'cancelled')
          || (request.status === 'accepted' && isOwner && nextStatus === 'completed');
        if (!isOwner && !isRequester) throw new HttpError(404, 'REQUEST_NOT_FOUND', 'Request not found.');
        if (!allowed) throw new HttpError(409, 'REQUEST_CONFLICT', 'Forbidden action for this request in its current state.');
        const now = new Date();
        if (nextStatus === 'completed') {
          const result = await inventory.updateOne({ user_id: request.owner_id, ingredient_id: request.ingredient_id, quantity: { $gte: request.quantity } }, {
            $inc: { quantity: -request.quantity }, $set: { updated_at: now },
          }, { session });
          if (result.modifiedCount !== 1) throw new HttpError(409, 'INSUFFICIENT_STOCK', 'There is no longer enough stock to complete this request.');
        }
        const result = await requests.findOneAndUpdate({ _id: requestId, status: request.status }, {
          $set: { status: nextStatus, updated_at: now },
        }, { session, returnDocument: 'after' });
        if (!result) throw new HttpError(409, 'REQUEST_CONFLICT', 'Request state changed.');
        return result;
      });
    },
  };
}
