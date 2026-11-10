import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError, string, fields } from '../../utils/http.js';
import { inTransaction } from '../../db/connection.js';

const derive = promisify(scrypt);
const options = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const lifetime = 7 * 24 * 60 * 60 * 1000;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const dummySalt = randomBytes(16).toString('hex');
export const publicUser = ({ _id, username, display_name }) => ({ _id, username, display_name });
export const ownUser = (user) => ({ ...publicUser(user), email: user.email, created_at: user.created_at });

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${(await derive(password, salt, 64, options)).toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [algorithm, salt, hex] = (stored || '').split('$');
  const valid = algorithm === 'scrypt' && /^[a-f0-9]{32}$/.test(salt) && /^[a-f0-9]{128}$/.test(hex);
  const result = await derive(password, valid ? salt : dummySalt, 64, options);
  return valid && timingSafeEqual(result, Buffer.from(hex, 'hex'));
}

function password(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) throw new HttpError(400, 'INVALID_INPUT', 'Password must be 8-128 characters.');
  return value;
}
function username(value) {
  const normalized = string(value, 'Username', 3, 50).toLowerCase();
  if (!/^[a-z0-9_]+$/.test(normalized)) throw new HttpError(400, 'INVALID_INPUT', 'Username may contain letters, numbers and underscores.');
  return normalized;
}
function email(value) {
  const normalized = string(value, 'Email', 3, 255).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new HttpError(400, 'INVALID_INPUT', 'Invalid email.');
  return normalized;
}

export function authService(client, db) {
  const users = db.collection('users');
  const sessions = db.collection('sessions');
  function makeSession(userId) {
    const token = randomBytes(32).toString('hex');
    return { token, record: { _id: randomUUID(), user_id: userId, token_hash: digest(token), created_at: new Date(), expires_at: new Date(Date.now() + lifetime) } };
  }
  return {
    async register(data, oldToken) {
      fields(data, ['username', 'email', 'password', 'display_name']);
      const user = { _id: randomUUID(), username: username(data.username), email: email(data.email), display_name: string(data.display_name, 'Display name', 1, 100), password_hash: await hashPassword(password(data.password)), created_at: new Date() };
      const session = makeSession(user._id);
      await inTransaction(client, async (tx) => {
        await users.insertOne(user, { session: tx });
        await sessions.insertOne(session.record, { session: tx });
        if (oldToken) await sessions.deleteOne({ token_hash: digest(oldToken) }, { session: tx });
      });
      return { user: ownUser(user), token: session.token };
    },
    async login(data, oldToken) {
      fields(data, ['identifier', 'password']);
      const identifier = string(data.identifier, 'Username or email', 1, 255).toLowerCase();
      const supplied = password(data.password);
      const user = await users.findOne({ $or: [{ username: identifier }, { email: identifier }] });
      if (!await verifyPassword(supplied, user?.password_hash)) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Incorrect username/email or password.');
      const session = makeSession(user._id);
      await inTransaction(client, async (tx) => {
        await sessions.insertOne(session.record, { session: tx });
        if (oldToken) await sessions.deleteOne({ token_hash: digest(oldToken) }, { session: tx });
      });
      return { user: ownUser(user), token: session.token };
    },
    async authenticate(token) {
      if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new HttpError(401, 'UNAUTHENTICATED', 'Please log in.');
      const session = await sessions.findOne({ token_hash: digest(token), expires_at: { $gt: new Date() } });
      const user = session && await users.findOne({ _id: session.user_id });
      if (!user) throw new HttpError(401, 'UNAUTHENTICATED', 'Session expired. Please log in.');
      return user;
    },
    async logout(token) { if (token) await sessions.deleteOne({ token_hash: digest(token) }); },
    async updateProfile(userId, data) {
      fields(data, ['display_name', 'email']);
      if (!Object.keys(data).length) throw new HttpError(400, 'INVALID_INPUT', 'Provide a display name or email.');
      const changes = {};
      if ('display_name' in data) changes.display_name = string(data.display_name, 'Display name', 1, 100);
      if ('email' in data) changes.email = email(data.email);
      return ownUser(await users.findOneAndUpdate({ _id: userId }, { $set: changes }, { returnDocument: 'after' }));
    },
    async search(userId, query, skip, invitable = false) {
      const q = string(query, 'Search', 2, 50).toLowerCase();
      // Treat search as literal text, not an arbitrary regex from the caller.
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const filter = { _id: { $ne: userId }, username: { $regex: `^${escaped}` } };
      if (invitable) {
        const relationships = await db.collection('friendships').find({
          status: { $in: ['pending', 'accepted'] },
          $or: [{ user_low_id: userId }, { user_high_id: userId }],
        }, { projection: { user_low_id: 1, user_high_id: 1 } }).toArray();
        filter._id.$nin = relationships.map((row) => row.user_low_id === userId ? row.user_high_id : row.user_low_id);
      }
      return users.find(filter, { projection: { _id: 1, username: 1, display_name: 1 } }).sort({ username: 1 }).skip(skip).limit(20).toArray();
    },
  };
}
