import { authService, ownUser } from './service.js';
import { friendshipService } from '../friendships/service.js';
import { ingredientRequestRepository } from '../ingredient-requests/repository.js';
import { conversationRepository } from '../conversations/repository.js';
import { recipeRoutes } from '../recipes/routes.js';
import { inventoryRoutes } from '../inventory/routes.js';
import { recognitionRoutes } from '../recognition/routes.js';
import { HttpError, json, readJson, uuid, fields, string } from '../../utils/http.js';

export function userRoutes(client, db, { secureCookies = process.env.NODE_ENV === 'production', authLimit = 30, events } = {}) {
  const auth = authService(client, db);
  const friends = friendshipService(db);
  const ingredients = ingredientRequestRepository(client, db);
  const conversations = conversationRepository(client, db);
  const recipes = recipeRoutes(client, db);
  const recognition = recognitionRoutes(client, db);
  const inventory = inventoryRoutes(client, db);
  const attempts = new Map();
  const cookie = (request) => request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith('ff_session='))?.slice(11);
  const setCookie = (response, token) => response.setHeader('Set-Cookie', `ff_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? 604800 : 0}${secureCookies ? '; Secure' : ''}`);
  const page = (url) => {
    const skip = url.searchParams.get('offset') || '0';
    if (!/^\d{1,6}$/.test(skip)) throw new HttpError(400, 'INVALID_INPUT', 'Invalid offset.');
    return Number(skip);
  };
  return async (request, response, url) => {
    const path = url.pathname;
    if (!/^\/api\/(auth|users|friends|recipes|recognition|inventory|ingredients)(?:\/|$)/.test(path)) return false;
    if (!['GET', 'HEAD'].includes(request.method)) {
      const expected = `${secureCookies ? 'https' : 'http'}://${request.headers.host}`;
      if ((request.headers.origin && request.headers.origin !== expected) || request.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'CROSS_ORIGIN', 'Cross-origin requests are not allowed.');
    }
    if (['/api/auth/register', '/api/auth/login'].includes(path) && request.method === 'POST') {
      const now = Date.now();
      for (const [key, record] of attempts) if (record.until <= now) attempts.delete(key);
      const ip = request.socket.remoteAddress;
      const record = attempts.get(ip) || { count: 0, until: now + 15 * 60 * 1000 };
      attempts.set(ip, record);
      if (++record.count > authLimit) { response.setHeader('Retry-After', Math.ceil((record.until - now) / 1000)); throw new HttpError(429, 'RATE_LIMIT', 'Too many login/register attempts. Try later.'); }
      const data = await readJson(request);
      const registering = path.endsWith('/register');
      const result = await auth[registering ? 'register' : 'login'](data, cookie(request));
      events.disconnect(cookie(request));
      setCookie(response, result.token);
      json(response, registering ? 201 : 200, { data: result.user }); return true;
    }
    if (path === '/api/auth/logout' && request.method === 'POST') {
      await auth.logout(cookie(request)); events.disconnect(cookie(request));
      setCookie(response, ''); json(response, 200, { data: { logged_out: true } }); return true;
    }
    const user = await auth.authenticate(cookie(request));
    if (path === '/api/ingredients' || (path.startsWith('/api/inventory') && path !== '/api/inventory/imports')) {
      await inventory(request, response, path, user._id);
      return true;
    }
    if (/^\/api\/(recognition|inventory)(?:\/|$)/.test(path)) {
      await recognition(request, response, path, user._id);
      return true;
    }
    if (path === '/api/recipes' || path.startsWith('/api/recipes/')) {
      await recipes(request, response, path, user._id);
      return true;
    }
    const key = `${request.method} ${path}`;
    let data;
    if (key === 'GET /api/users/me') data = ownUser(user);
    else if (key === 'PATCH /api/users/me') data = await auth.updateProfile(user._id, await readJson(request));
    else if (key === 'GET /api/users') {
      data = await auth.search(user._id, url.searchParams.get('q'), page(url), url.searchParams.get('invitable') === '1');
    } else if (key === 'GET /api/friends') data = await friends.list(user._id, 'accepted', null, page(url));
    else if (key === 'GET /api/friends/directory') {
      const count = url.searchParams.get('count') ?? '20';
      if (!/^[1-9]\d{0,5}$/.test(count)) throw new HttpError(400, 'INVALID_INPUT', 'Invalid directory size.');
      const query = string(url.searchParams.get('q') ?? '', 'Search', 0, 100);
      data = await conversations.directory(user._id, Number(count), query);
    } else if (key === 'GET /api/friends/conversations/events') {
      events.subscribe(user._id, cookie(request), response);
      return true;
    } else if (key === 'GET /api/friends/requests') {
      const direction = url.searchParams.get('direction') || 'incoming';
      if (!['incoming', 'outgoing'].includes(direction)) throw new HttpError(400, 'INVALID_INPUT', 'Invalid request direction.');
      data = await friends.list(user._id, 'pending', direction, page(url));
    } else if (key === 'POST /api/friends/requests') {
      const body = await readJson(request); fields(body, ['user_id']);
      data = await friends.request(user._id, uuid(body.user_id));
      events.publishFriendships(data.user_low_id, data.user_high_id);
      json(response, 201, { data }); return true;
    } else if (request.method === 'PATCH' && /^\/api\/friends\/requests\/[^/]+$/.test(path)) {
      const body = await readJson(request); fields(body, ['status']);
      if (!['accepted', 'declined'].includes(body.status)) throw new HttpError(400, 'INVALID_INPUT', 'Status must be accepted or declined.');
      data = await friends.respond(user._id, uuid(path.split('/').pop()), body.status);
      events.publishFriendships(data.user_low_id, data.user_high_id);
    } else if (key === 'GET /api/friends/conversations') {
      data = await conversations.list(user._id, page(url));
    } else if (key === 'GET /api/friends/conversations/unread') {
      data = await conversations.unread(user._id);
    } else if (request.method === 'POST' && /^\/api\/friends\/[^/]+\/conversation\/read$/.test(path)) {
      const body = await readJson(request);
      fields(body, ['through']);
      if (!Number.isSafeInteger(body.through) || body.through <= 0) throw new HttpError(400, 'INVALID_INPUT', 'Invalid delivery number.');
      data = await conversations.markRead(user._id, uuid(path.split('/')[3]), body.through);
      events.publish(user._id);
    } else if (/^\/api\/friends\/[^/]+\/conversation$/.test(path) && ['GET', 'POST'].includes(request.method)) {
      const peerId = uuid(path.split('/')[3]);
      if (request.method === 'POST') {
        const body = await readJson(request);
        fields(body, ['message_id', 'text']);
        data = await conversations.send(user._id, peerId, uuid(body.message_id), string(body.text, 'Message', 1, 1000));
        events.publish(user._id, peerId);
        json(response, 201, { data }); return true;
      }
      const cursor = url.searchParams.get('before');
      let before;
      if (cursor !== null) {
        const match = /^(\d{1,15}):([a-f0-9-]+)$/.exec(cursor);
        if (!match) throw new HttpError(400, 'INVALID_INPUT', 'Invalid message cursor.');
        before = { date: new Date(Number(match[1])), id: uuid(match[2]) };
      }
      data = await conversations.read(user._id, peerId, before);
    } else if (request.method === 'GET' && /^\/api\/friends\/[^/]+\/fridge$/.test(path)) {
      data = await ingredients.sharedFridge(user._id, uuid(path.split('/')[3]), page(url));
    } else if (key === 'GET /api/friends/ingredient-requests') {
      data = await ingredients.list(user._id, page(url));
    } else if (key === 'POST /api/friends/ingredient-requests') {
      const body = await readJson(request);
      fields(body, ['owner_id', 'ingredient_id', 'quantity', 'message']);
      data = await ingredients.create(user._id, {
        owner_id: uuid(body.owner_id), ingredient_id: uuid(body.ingredient_id), quantity: body.quantity,
        message: body.message === undefined ? '' : string(body.message, 'Message', 0, 500),
      });
      events.publish(data.requester_id, data.owner_id);
      json(response, 201, { data }); return true;
    } else if (request.method === 'PATCH' && /^\/api\/friends\/ingredient-requests\/[^/]+$/.test(path)) {
      const body = await readJson(request);
      fields(body, ['status']);
      if (!['accepted', 'declined', 'cancelled', 'completed'].includes(body.status)) throw new HttpError(400, 'INVALID_INPUT', 'Invalid request status.');
      data = await ingredients.transition(user._id, uuid(path.split('/').pop()), body.status);
      events.publish(data.requester_id, data.owner_id);
    } else if (request.method === 'DELETE' && /^\/api\/friends\/[^/]+$/.test(path)) {
      data = await friends.remove(user._id, uuid(path.split('/').pop()));
      events.publishFriendships(data.user_low_id, data.user_high_id);
    }
    else throw new HttpError(404, 'NOT_FOUND', 'Endpoint not found.');
    json(response, 200, { data }); return true;
  };
}
