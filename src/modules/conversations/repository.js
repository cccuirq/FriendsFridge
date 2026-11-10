import { inTransaction } from '../../db/connection.js';
import { HttpError } from '../../utils/http.js';
import { deliveryFields, friendPair, recordDelivery } from '../friendships/delivery.js';

const publicProfile = { _id: 1, username: 1, display_name: 1 };
const recentFirst = { created_at: -1, _id: -1 };
const pageSize = 20;

function unreadFor(side) {
  return { $gt: [{ $ifNull: [`$${side}_received`, 0] }, { $ifNull: [`$${side}_read`, 0] }] };
}

const peerLookup = [
  { $lookup: { from: 'users', localField: '_id', foreignField: '_id', pipeline: [{ $project: publicProfile }], as: 'peer' } },
  { $set: { peer: { $first: '$peer' } } },
];

function pairFilter(actorId, peerId, from, to) {
  if (!peerId) return { $or: [{ [from]: actorId }, { [to]: actorId }] };
  return { $or: [{ [from]: actorId, [to]: peerId }, { [from]: peerId, [to]: actorId }] };
}

function timeline(actorId, peerId, before) {
  const older = before ? [{ $match: { $or: [
    { created_at: { $lt: before.date } },
    { created_at: before.date, _id: { $lt: before.id } },
  ] } }] : [];
  const newest = peerId ? [{ $sort: recentFirst }, { $limit: pageSize + 1 }] : [];
  return [
    { $match: pairFilter(actorId, peerId, 'sender_id', 'recipient_id') },
    ...older,
    ...newest,
    { $project: { created_at: 1, sender_id: 1, recipient_id: 1, text: 1, kind: { $literal: 'message' } } },
    { $unionWith: { coll: 'ingredient_requests', pipeline: [
      { $match: pairFilter(actorId, peerId, 'requester_id', 'owner_id') },
      ...older,
      ...newest,
      { $project: {
        created_at: 1, sender_id: '$requester_id', recipient_id: '$owner_id', text: '$message',
        ingredient_id: 1, quantity: 1, status: 1, kind: { $literal: 'request' },
      } },
    ] } },
  ];
}

const ingredientLookup = [
  { $lookup: {
    from: 'ingredients', localField: 'ingredient_id', foreignField: '_id',
    pipeline: [{ $project: { name: 1, default_unit: 1 } }], as: 'ingredient',
  } },
  { $set: { ingredient: { $first: '$ingredient' } } },
];

function latestByPeer(actorId) {
  return [
    ...timeline(actorId),
    { $sort: recentFirst },
    { $group: {
      _id: { $cond: [{ $eq: ['$sender_id', actorId] }, '$recipient_id', '$sender_id'] },
      latest: { $first: '$$ROOT' },
    } },
  ];
}

export function conversationRepository(client, db) {
  const messages = db.collection('friend_messages');
  const users = db.collection('users');
  const friendships = db.collection('friendships');

  return {
    async unread(actorId) {
      const rows = await friendships.find({ $or: [
        { user_low_id: actorId, $expr: unreadFor('low') },
        { user_high_id: actorId, $expr: unreadFor('high') },
      ] }, { projection: { user_low_id: 1, user_high_id: 1 } }).toArray();
      return rows.map((row) => row.user_low_id === actorId ? row.user_high_id : row.user_low_id);
    },

    async markRead(actorId, peerId, through) {
      const pair = friendPair(actorId, peerId);
      const { received, read } = deliveryFields(pair, actorId);
      const result = await friendships.updateOne({ ...pair, [received]: { $gte: through } }, { $max: { [read]: through } });
      if (!result.matchedCount) throw new HttpError(404, 'DELIVERY_NOT_FOUND', 'No matching message delivery.');
      return { through };
    },

    async list(actorId, skip) {
      return messages.aggregate([
        ...latestByPeer(actorId),
        { $sort: { 'latest.created_at': -1, 'latest._id': -1 } },
        { $skip: skip },
        { $limit: pageSize },
        ...peerLookup,
      ]).toArray();
    },

    async directory(actorId, count, query) {
      const actorIsLow = { $eq: ['$user_low_id', actorId] };
      const match = query ? { $regex: query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } : null;
      return messages.aggregate([
        ...latestByPeer(actorId),
        { $unionWith: { coll: 'friendships', pipeline: [
          { $match: { $or: [{ user_low_id: actorId }, { user_high_id: actorId }] } },
          { $project: {
            _id: { $cond: [actorIsLow, '$user_high_id', '$user_low_id'] },
            active: { $eq: ['$status', 'accepted'] },
            unread: { $cond: [actorIsLow, unreadFor('low'), unreadFor('high')] },
            updated_at: 1,
          } },
        ] } },
        { $group: {
          _id: '$_id', latest: { $max: '$latest' }, active: { $max: '$active' },
          unread: { $max: '$unread' }, updated_at: { $max: '$updated_at' },
        } },
        { $match: match ? { active: true } : { $or: [{ active: true }, { latest: { $ne: null } }] } },
        ...(match ? [
          ...peerLookup,
          { $match: { $or: [{ 'peer.username': match }, { 'peer.display_name': match }] } },
        ] : []),
        { $sort: { unread: -1, 'latest.created_at': -1, updated_at: -1, _id: 1 } },
        { $limit: count + 1 },
        ...(match ? [] : peerLookup),
      ]).toArray();
    },

    async read(actorId, peerId, before) {
      const pair = friendPair(actorId, peerId);
      const { received, read } = deliveryFields(pair, actorId);
      // Capture the delivery counter before reading the timeline. An arrival during
      // the read can only advance the counter and must not be acknowledged by it.
      const friendship = await friendships.findOne(pair);
      const can_message = friendship?.status === 'accepted';
      const [items, peer] = await Promise.all([
        messages.aggregate([
          ...timeline(actorId, peerId, before),
          { $sort: recentFirst },
          { $limit: pageSize + 1 },
          ...ingredientLookup,
        ]).toArray(),
        users.findOne({ _id: peerId }, { projection: publicProfile }),
      ]);
      if (!peer || (!can_message && !items.length)) {
        throw new HttpError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found.');
      }
      const hasMore = items.length > pageSize;
      if (hasMore) items.pop();
      const last = items.at(-1);
      return { peer, can_message, items, received: friendship?.[received] ?? 0, read: friendship?.[read] ?? 0,
        next_before: hasMore ? last.created_at.getTime() + ':' + last._id : null };
    },

    async send(actorId, peerId, messageId, text) {
      try {
        return await inTransaction(client, async (session) => {
          if (!await friendships.findOne({ ...friendPair(actorId, peerId), status: 'accepted' }, { session })) {
            throw new HttpError(404, 'FRIEND_NOT_FOUND', 'You can only send messages to current friends.');
          }
          const message = { _id: messageId, sender_id: actorId, recipient_id: peerId, text };
          const result = await messages.findOneAndUpdate(message, { $setOnInsert: { created_at: new Date() } }, {
            session, upsert: true, returnDocument: 'after', includeResultMetadata: true,
          });
          if (result.lastErrorObject?.upserted) await recordDelivery(db, actorId, peerId, session);
          return result.value;
        });
      } catch (error) {
        if (error.code === 11000) throw new HttpError(409, 'MESSAGE_CONFLICT', 'That message ID is already in use.');
        throw error;
      }
    },
  };
}
