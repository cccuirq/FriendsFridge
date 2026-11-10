import { randomUUID } from 'node:crypto';
import { HttpError } from '../../utils/http.js';
import { publicUser } from '../auth/service.js';
import { friendPair } from './delivery.js';

const relationshipProjection = { low_received: 0, low_read: 0, high_received: 0, high_read: 0 };

export function friendshipService(db) {
  const relations = db.collection('friendships');
  const conflict = () => new HttpError(409, 'RELATIONSHIP_CONFLICT', 'Friendship state changed or request already exists.');
  return {
    async request(actorId, targetId) {
      if (actorId === targetId) throw new HttpError(400, 'SELF_REQUEST', 'You cannot add yourself.');
      if (!await db.collection('users').findOne({ _id: targetId })) throw new HttpError(404, 'USER_NOT_FOUND', 'User not found.');
      const filter = friendPair(actorId, targetId);
      const existing = await relations.findOne(filter);
      const now = new Date();
      if (existing) {
        if (!['declined', 'removed'].includes(existing.status)) throw conflict();
        const result = await relations.findOneAndUpdate({ _id: existing._id, status: existing.status, updated_at: existing.updated_at }, { $set: { status: 'pending', requested_by: actorId, updated_at: now } }, { returnDocument: 'after', projection: relationshipProjection });
        if (!result) throw conflict();
        return result;
      }
      const result = { _id: randomUUID(), ...filter, requested_by: actorId, status: 'pending', created_at: now, updated_at: now };
      try { await relations.insertOne(result); } catch (error) { if (error.code === 11000) throw conflict(); throw error; }
      return result;
    },
    async respond(actorId, relationshipId, status) {
      const result = await relations.findOneAndUpdate({ _id: relationshipId, status: 'pending', requested_by: { $ne: actorId }, $or: [{ user_low_id: actorId }, { user_high_id: actorId }] }, { $set: { status, updated_at: new Date() } }, { returnDocument: 'after', projection: relationshipProjection });
      if (!result) throw new HttpError(404, 'REQUEST_NOT_FOUND', 'No incoming pending request found.');
      return result;
    },
    async remove(actorId, friendId) {
      const result = await relations.findOneAndUpdate({ ...friendPair(actorId, friendId), status: 'accepted' }, { $set: { status: 'removed', updated_at: new Date() } }, { returnDocument: 'after', projection: relationshipProjection });
      if (!result) throw new HttpError(404, 'FRIEND_NOT_FOUND', 'Friend not found.');
      return result;
    },
    async list(actorId, status, direction, skip) {
      const filter = { status, $or: [{ user_low_id: actorId }, { user_high_id: actorId }] };
      if (status === 'pending') filter.requested_by = direction === 'outgoing' ? actorId : { $ne: actorId };
      const rows = await relations.find(filter, { projection: relationshipProjection }).sort({ updated_at: -1, _id: 1 }).skip(skip).limit(20).toArray();
      const ids = rows.map((row) => row.user_low_id === actorId ? row.user_high_id : row.user_low_id);
      const users = new Map((await db.collection('users').find({ _id: { $in: ids } }, { projection: { _id: 1, username: 1, display_name: 1 } }).toArray()).map((user) => [user._id, publicUser(user)]));
      return rows.map((row, i) => ({ ...row, user: users.get(ids[i]) || null }));
    },
  };
}
