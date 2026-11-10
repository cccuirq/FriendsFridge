import { HttpError } from '../../utils/http.js';

export function friendPair(a, b) {
  const [user_low_id, user_high_id] = [a, b].sort();
  return { user_low_id, user_high_id };
}

export function deliveryFields(pair, recipientId) {
  return recipientId === pair.user_low_id
    ? { received: 'low_received', read: 'low_read' }
    : { received: 'high_received', read: 'high_read' };
}

// Run alongside the event insert in the same transaction.
export async function recordDelivery(db, senderId, recipientId, session) {
  const pair = friendPair(senderId, recipientId);
  const { received } = deliveryFields(pair, recipientId);
  const updated = await db.collection('friendships').updateOne(
    { ...pair, status: 'accepted' }, { $inc: { [received]: 1 } }, { session },
  );
  if (!updated.matchedCount) throw new HttpError(404, 'FRIEND_NOT_FOUND', 'An accepted friendship is required.');
}
