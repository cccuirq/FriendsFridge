import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { initializeDatabase } from '../../src/db/schema.js';
import { createApp } from '../../src/app.js';

test('User & Friends HTTP workflows', { timeout: 240000 }, async (t) => {
  const replica = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { version: '8.0.16' } });
  const client = new MongoClient(replica.getUri());
  const servers = [];
  t.after(async () => {
    for (const server of servers) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    await client.close(); await replica.stop();
  });
  await client.connect();
  const db = client.db('users_friends_test');
  await initializeDatabase(db);
  const server = createApp(client, db, { secureCookies: false }); servers.push(server);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  function browser() {
    return { cookie: '', async request(path, method = 'GET', body, headers = {}) {
      const response = await fetch(base + path, { method, headers: { ...(this.cookie ? { Cookie: this.cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
      const set = response.headers.get('set-cookie'); if (set) this.cookie = set.split(';')[0];
      return { status: response.status, headers: response.headers, body: await response.json() };
    } };
  }
  const alice = browser(), bob = browser(), eve = browser(), guest = browser();
  const account = (name) => ({ username: name, email: `${name}@example.com`, display_name: name, password: 'correct horse battery' });
  let aliceId, bobId, relationId;

  await t.test('registers normalized accounts, stores hashes and rejects duplicates', async () => {
    const result = await alice.request('/api/auth/register', 'POST', { ...account('Alice'), email: 'ALICE@EXAMPLE.COM' });
    assert.equal(result.status, 201); aliceId = result.body.data._id;
    assert.equal(result.body.data.username, 'alice'); assert.equal(result.body.data.email, 'alice@example.com');
    assert.match(result.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    assert.equal(result.body.data.password_hash, undefined);
    const stored = await db.collection('users').findOne({ _id: aliceId });
    assert.match(stored.password_hash, /^scrypt\$/); assert.ok(!stored.password_hash.includes('correct horse'));
    const session = await db.collection('sessions').findOne({ user_id: aliceId });
    assert.notEqual(session.token_hash, alice.cookie.split('=')[1]);
    assert.equal((await guest.request('/api/auth/register', 'POST', account('alice'))).status, 409);
    assert.equal((await guest.request('/api/auth/register', 'POST', { ...account('other'), email: 'alice@example.com' })).status, 409);
    assert.equal((await guest.request('/api/auth/register', 'POST', { ...account('short'), password: '123' })).status, 400);
    assert.equal((await guest.request('/api/auth/register', 'POST', { ...account('inject'), email: { $ne: null } })).status, 400);
    bobId = (await bob.request('/api/auth/register', 'POST', account('bob'))).body.data._id;
    await eve.request('/api/auth/register', 'POST', account('eve'));
  });
  await t.test('requires authentication, isolates profile edits and protects searches', async () => {
    assert.equal((await guest.request('/api/users/me')).status, 401);
    const profile = await alice.request('/api/users/me', 'PATCH', { display_name: '<script>not HTML</script>', email: 'newalice@example.com' });
    assert.equal(profile.status, 200); assert.equal(profile.body.data.email, 'newalice@example.com');
    assert.equal((await alice.request('/api/users/me', 'PATCH', { user_id: bobId, display_name: 'Hacked' })).status, 400);
    assert.equal((await bob.request('/api/users/me')).body.data.display_name, 'bob');
    assert.equal((await alice.request('/api/users/me', 'PATCH', { email: 'bob@example.com' })).status, 409);
    const results = await alice.request('/api/users?q=bo');
    assert.equal(results.status, 200); assert.equal(results.body.data[0]._id, bobId);
    assert.equal(results.body.data[0].email, undefined); assert.equal(results.body.data[0].password_hash, undefined);
    assert.deepEqual((await alice.request('/api/users?q=bo&invitable=1')).body.data.map((user) => user._id), [bobId]);
    assert.deepEqual((await alice.request('/api/friends/directory?q=bo')).body.data, []);
    assert.equal((await alice.request('/api/users?q=.*')).body.data.length, 0);
    assert.equal((await alice.request('/api/users?q=b')).status, 400);
    assert.equal((await alice.request('/api/users?q=bo&offset=-1')).status, 400);
    assert.equal((await alice.request('/api/users/me', 'PATCH', { display_name: 'bad' }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await alice.request('/api/users/me', 'PATCH', { display_name: 'bad' }, { 'Content-Type': 'text/plain' })).status, 415);
  });
  await t.test('friend requests enforce pair uniqueness and recipient authorization', async () => {
    assert.equal((await alice.request('/api/friends/requests', 'POST', { user_id: aliceId })).status, 400);
    assert.equal((await alice.request('/api/friends/requests', 'POST', { user_id: randomUUID() })).status, 404);
    assert.equal((await alice.request('/api/friends/requests', 'POST', { user_id: 'bad' })).status, 400);
    const results = await Promise.all([alice.request('/api/friends/requests', 'POST', { user_id: bobId }), bob.request('/api/friends/requests', 'POST', { user_id: aliceId })]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    const relation = await db.collection('friendships').findOne({}); relationId = relation._id;
    assert.deepEqual((await alice.request('/api/users?q=bo&invitable=1')).body.data, []);
    assert.deepEqual((await bob.request('/api/users?q=al&invitable=1')).body.data, []);
    const sender = relation.requested_by === aliceId ? alice : bob;
    const recipient = sender === alice ? bob : alice;
    assert.equal((await sender.request('/api/friends/requests?direction=outgoing')).body.data.length, 1);
    assert.equal((await recipient.request('/api/friends/requests')).body.data.length, 1);
    assert.equal((await eve.request('/api/friends/requests')).body.data.length, 0);
    assert.equal((await sender.request(`/api/friends/requests/${relationId}`, 'PATCH', { status: 'accepted' })).status, 404);
    assert.equal((await eve.request(`/api/friends/requests/${relationId}`, 'PATCH', { status: 'accepted' })).status, 404);
    assert.equal((await recipient.request(`/api/friends/requests/${relationId}`, 'PATCH', { status: 'removed' })).status, 400);
    assert.equal((await recipient.request(`/api/friends/requests/${relationId}`, 'PATCH', { status: 'declined' })).status, 200);
    assert.equal((await alice.request('/api/friends')).body.data.length, 0);
  });
  await t.test('reapplies, accepts, lists both sides, removes and reapplies again', async () => {
    const reapplied = await alice.request('/api/friends/requests', 'POST', { user_id: bobId });
    assert.equal(reapplied.status, 201); assert.equal(reapplied.body.data._id, relationId);
    assert.equal((await bob.request(`/api/friends/requests/${relationId}`, 'PATCH', { status: 'accepted' })).status, 200);
    assert.deepEqual((await alice.request('/api/friends/directory?q=BO')).body.data.map((row) => row._id), [bobId]);
    assert.deepEqual((await bob.request('/api/friends/directory?q=NOT%20HTML')).body.data.map((row) => row._id), [aliceId]);
    assert.deepEqual((await alice.request('/api/friends/directory?q=.*')).body.data, []);
    assert.deepEqual((await alice.request('/api/friends/directory?q=eve')).body.data, []);
    assert.deepEqual((await alice.request('/api/users?q=bo&invitable=1')).body.data, []);
    assert.equal((await alice.request('/api/users?q=bo')).body.data[0]._id, bobId);
    for (const person of [alice, bob]) {
      const result = await person.request('/api/friends');
      assert.equal(result.body.data.length, 1); assert.equal(result.body.data[0].user.email, undefined);
      assert.equal((await person.request('/api/friends/requests')).body.data.length, 0);
    }
    assert.equal((await eve.request(`/api/friends/${bobId}`, 'DELETE')).status, 404);
    assert.equal((await alice.request(`/api/friends/${bobId}`, 'DELETE')).status, 200);
    assert.equal((await db.collection('friendships').findOne({ _id: relationId })).status, 'removed');
    assert.equal((await bob.request('/api/friends')).body.data.length, 0);
    assert.equal((await bob.request('/api/friends/requests', 'POST', { user_id: aliceId })).status, 201);
    assert.equal((await alice.request(`/api/friends/requests/${relationId}`, 'PATCH', { status: 'accepted' })).status, 200);
    assert.equal(await db.collection('friendships').countDocuments(), 1);
  });
  await t.test('sends private messages between friends and notifies the recipient immediately', async (t) => {
    const inbox = '/api/friends/conversations';
    const toBob = `/api/friends/${bobId}/conversation`;
    const toAlice = `/api/friends/${aliceId}/conversation`;
    const message = { message_id: randomUUID(), text: 'Hi Bob!' };
    assert.equal((await guest.request(toBob)).status, 401);
    assert.equal((await eve.request(toBob)).status, 404);
    assert.equal((await eve.request(toBob, 'POST', message)).status, 404);
    assert.equal((await alice.request(toBob, 'POST', { ...message, sender_id: bobId })).status, 400);
    assert.equal((await alice.request(toBob, 'POST', { ...message, text: ' ' })).status, 400);
    assert.deepEqual((await alice.request(toBob)).body.data.items, []);
    const eventPath = base + '/api/friends/conversations/events';
    assert.equal((await fetch(eventPath)).status, 401);
    const stream = await fetch(eventPath, { headers: { Cookie: bob.cookie }, signal: AbortSignal.timeout(5000) });
    assert.match(stream.headers.get('content-type'), /text\/event-stream/);
    const reader = stream.body.getReader();
    t.after(() => reader.cancel().catch(() => {}));
    const decoder = new TextDecoder();
    assert.match(decoder.decode((await reader.read()).value), /: connected/);
    assert.equal((await alice.request(toBob, 'POST', message)).status, 201);
    assert.match(decoder.decode((await reader.read()).value), /data: \{\}/);
    assert.equal((await alice.request(toBob, 'POST', message)).status, 201);
    assert.equal((await alice.request(toBob, 'POST', { ...message, text: 'Different draft' })).status, 409);
    const received = (await bob.request(toAlice)).body.data;
    assert.equal(received.peer.email, undefined);
    assert.equal(received.items.length, 1);
    assert.equal(received.items[0].sender_id, aliceId);
    assert.equal(received.items[0].text, 'Hi Bob!');
    assert.equal(received.items[0].kind, 'message');
    assert.equal((await bob.request(toAlice, 'POST', { message_id: randomUUID(), text: 'Hi Alice!' })).status, 201);
    const threads = (await alice.request(inbox)).body.data;
    assert.equal(threads.length, 1);
    assert.equal(threads[0].peer._id, bobId);
    assert.equal(threads[0].latest.text, 'Hi Alice!');
    assert.deepEqual((await eve.request(inbox)).body.data, []);
    await db.collection('friend_messages').insertMany(Array.from({ length: 21 }, (_, i) => ({
      _id: randomUUID(), sender_id: bobId, recipient_id: aliceId, text: 'Earlier message ' + i, created_at: new Date(1000 + i),
    })));
    const first = (await alice.request(toBob)).body.data;
    const older = (await alice.request(toBob + '?before=' + encodeURIComponent(first.next_before))).body.data;
    assert.equal(first.items.length, 20);
    assert.equal(older.items.length, 3);
    assert.equal(older.next_before, null);
    assert.equal(new Set([...first.items, ...older.items].map((item) => item._id)).size, 23);
  });
  await t.test('tracks unread conversations separately and preserves arrivals after a read snapshot', async () => {
    const unread = '/api/friends/conversations/unread';
    const toBob = `/api/friends/${bobId}/conversation`;
    const toAlice = `/api/friends/${aliceId}/conversation`;
    const eveId = (await eve.request('/api/users/me')).body.data._id;
    const invite = (await alice.request('/api/friends/requests', 'POST', { user_id: eveId })).body.data;
    assert.equal((await eve.request(`/api/friends/requests/${invite._id}`, 'PATCH', { status: 'accepted' })).status, 200);
    assert.equal((await eve.request(toAlice, 'POST', { message_id: randomUUID(), text: 'Hello from Eve' })).status, 201);
    assert.deepEqual(new Set((await alice.request(unread)).body.data), new Set([bobId, eveId]));
    assert.deepEqual((await eve.request(unread)).body.data, []);
    assert.equal((await guest.request(unread)).status, 401);
    const friend = (await alice.request('/api/friends')).body.data.find((row) => row.user._id === bobId);
    assert.ok(Object.keys(friend).every((key) => !key.endsWith('_received') && !key.endsWith('_read')));

    const oldSnapshot = (await bob.request(toAlice)).body.data;
    assert.equal(oldSnapshot.received, 1);
    assert.equal((await alice.request(toBob, 'POST', { message_id: randomUUID(), text: 'One more thing' })).status, 201);
    assert.equal((await bob.request(toAlice + '/read', 'POST', { through: oldSnapshot.received })).status, 200);
    assert.deepEqual((await bob.request(unread)).body.data, [aliceId]);
    const newest = (await bob.request(toAlice)).body.data;
    assert.equal(newest.received, 2);
    assert.equal((await bob.request(toAlice + '/read', 'POST', { through: newest.received + 1 })).status, 404);
    assert.equal((await bob.request(toAlice + '/read', 'POST', { through: newest.received })).status, 200);
    assert.equal((await bob.request(toAlice + '/read', 'POST', { through: oldSnapshot.received })).status, 200);
    assert.deepEqual((await bob.request(unread)).body.data, []);

    const eveThread = `/api/friends/${eveId}/conversation`;
    const eveSnapshot = (await alice.request(eveThread)).body.data;
    assert.equal((await alice.request(eveThread + '/read', 'POST', { through: eveSnapshot.received })).status, 200);
    const directory = (await alice.request('/api/friends/directory?count=1')).body.data;
    assert.deepEqual(directory.map((row) => [row._id, row.unread]), [[bobId, true], [eveId, false]]);
    const bobSnapshot = (await alice.request(toBob)).body.data;
    assert.equal((await alice.request(toBob + '/read', 'POST', { through: bobSnapshot.received })).status, 200);
    assert.deepEqual((await alice.request(unread)).body.data, []);
    assert.equal((await eve.request(toAlice, 'POST', { message_id: randomUUID(), text: 'Another message from Eve' })).status, 201);
    assert.deepEqual((await alice.request(unread)).body.data, [eveId]);
  });
  await t.test('shares only friend-visible stock and handles requests through handoff', async () => {
    const created_at = new Date();
    const [egg, milk] = [randomUUID(), randomUUID()];
    await db.collection('ingredients').insertMany([
      { _id: egg, name: 'egg', category: 'protein', default_unit: 'piece', fresh_interval: null, created_at },
      { _id: milk, name: 'milk', category: 'dairy', default_unit: 'ml', fresh_interval: null, created_at },
    ]);
    await db.collection('inventory_items').insertMany([
      { _id: randomUUID(), user_id: bobId, ingredient_id: egg, quantity: 300, visibility: 'friends', created_at, updated_at: created_at },
      { _id: randomUUID(), user_id: bobId, ingredient_id: milk, quantity: 20000, visibility: 'private', created_at, updated_at: created_at },
    ]);
    const fridge = `/api/friends/${bobId}/fridge`;
    const path = '/api/friends/ingredient-requests';
    assert.equal((await guest.request(fridge)).status, 401);
    assert.equal((await eve.request(fridge)).status, 404);
    const shared = await alice.request(fridge);
    assert.equal(shared.status, 200);
    assert.equal(shared.body.data.friend.email, undefined);
    assert.deepEqual(shared.body.data.items.map((item) => item.ingredient._id), [egg]);
    const request = { owner_id: bobId, ingredient_id: egg, quantity: 125, message: 'Pick up tonight?' };
    assert.equal((await eve.request(path, 'POST', request)).status, 404);
    assert.equal((await alice.request(path, 'POST', { ...request, ingredient_id: milk })).status, 409);
    assert.equal((await alice.request(path, 'POST', { ...request, quantity: 301 })).status, 409);
    assert.equal((await alice.request(path, 'POST', request, { Origin: 'https://evil.example' })).status, 403);
    const sent = await alice.request(path, 'POST', request);
    assert.equal(sent.status, 201);
    const unread = '/api/friends/conversations/unread';
    const toAlice = `/api/friends/${aliceId}/conversation`;
    assert.deepEqual((await bob.request(unread)).body.data, [aliceId]);
    const received = (await bob.request(toAlice)).body.data;
    assert.equal((await bob.request(toAlice + '/read', 'POST', { through: received.received })).status, 200);
    assert.deepEqual((await bob.request(unread)).body.data, []);
    const threadPath = `/api/friends/${bobId}/conversation`;
    const thread = (await alice.request(threadPath)).body.data;
    const requestEntry = thread.items.find((item) => item._id === sent.body.data._id);
    assert.equal(requestEntry.kind, 'request');
    assert.equal(requestEntry.ingredient.name, 'egg');
    assert.ok(thread.items.some((item) => item.kind === 'message'));
    const detail = `${path}/${sent.body.data._id}`;
    const incoming = (await bob.request(path)).body.data[0];
    assert.equal(incoming.person._id, aliceId);
    assert.equal(incoming.ingredient.name, 'egg');
    assert.equal(incoming.message, request.message);
    assert.deepEqual((await eve.request(path)).body.data, []);
    assert.equal((await eve.request(detail, 'PATCH', { status: 'cancelled' })).status, 404);
    assert.equal((await alice.request(detail, 'PATCH', { status: 'accepted' })).status, 409);
    assert.equal((await bob.request(detail, 'PATCH', { status: 'accepted' })).status, 200);
    assert.deepEqual((await alice.request(unread)).body.data, [(await eve.request('/api/users/me')).body.data._id]);
    assert.equal((await alice.request(fridge)).body.data.items[0].quantity, 300);
    assert.equal((await bob.request(detail, 'PATCH', { status: 'completed' })).status, 200);
    assert.equal((await bob.request(detail, 'PATCH', { status: 'completed' })).status, 409);
    assert.equal((await alice.request(fridge)).body.data.items[0].quantity, 175);
    assert.equal((await alice.request(path)).body.data[0].status, 'completed');
    await db.collection('friendships').updateOne({ _id: relationId }, { $set: { status: 'removed' } });
    assert.equal((await alice.request(fridge)).status, 404);
    assert.equal((await alice.request(path)).body.data[0].status, 'completed');
    assert.equal((await alice.request(threadPath)).body.data.can_message, false);
    assert.equal((await alice.request(threadPath, 'POST', { message_id: randomUUID(), text: 'Hello again' })).status, 404);
  });
  await t.test('uses the signed-in fridge and protects private recipe shares', async () => {
    const endpoint = '/api/recipes';
    const egg = await db.collection('ingredients').findOne({ name: 'egg' });
    const draft = { title: 'Egg toast', instructions: 'Cook the eggs.', servings: 1, items: [{ ingredient_id: egg._id, quantity: 200 }] };
    assert.equal((await guest.request(endpoint)).status, 401);
    assert.equal((await bob.request(endpoint, 'POST', { ...draft, items: [draft.items[0], draft.items[0]] })).status, 400);
    assert.equal((await bob.request(endpoint, 'POST', { ...draft, author_id: aliceId })).status, 400);
    assert.equal((await bob.request(endpoint, 'POST', draft, { Origin: 'https://evil.example' })).status, 403);
    const created = await bob.request(endpoint, 'POST', draft);
    assert.equal(created.status, 201);
    const id = created.body.data._id;
    const getRecipe = async (person) => (await person.request(endpoint)).body.data.recipes.find((recipe) => recipe._id === id);
    const mine = await getRecipe(bob);
    assert.equal(mine.owned, true);
    assert.deepEqual(mine.items.map(({ required, available, missing }) => [required, available, missing]), [[200, 175, 25]]);
    assert.equal(await getRecipe(alice), undefined);
    assert.equal((await alice.request(`${endpoint}/${id}/saved`, 'PUT')).status, 404);
    assert.equal((await bob.request(`${endpoint}/${id}/shares`, 'POST', { recipient_id: aliceId })).status, 404);
    await alice.request('/api/friends/requests', 'POST', { user_id: bobId });
    assert.equal((await bob.request(`/api/friends/requests/${relationId}`, 'PATCH', { status: 'accepted' })).status, 200);
    for (let repeat = 0; repeat < 2; repeat++) {
      assert.equal((await bob.request(`${endpoint}/${id}/shares`, 'POST', { recipient_id: aliceId })).status, 200);
      assert.equal((await alice.request(`${endpoint}/${id}/saved`, 'PUT')).status, 200);
    }
    const received = await getRecipe(alice);
    assert.equal(received.shared, true);
    assert.equal(received.saved, true);
    assert.equal(received.items[0].missing, 200);
    assert.equal(await getRecipe(eve), undefined);
    assert.equal(await db.collection('recipe_shares').countDocuments({ recipe_id: id }), 1);
    assert.equal(await db.collection('saved_recipes').countDocuments({ recipe_id: id }), 1);
    assert.equal((await alice.request(`/api/friends/${bobId}`, 'DELETE')).status, 200);
    assert.equal(await getRecipe(alice), undefined);
  });
  await t.test('logout revokes tokens, login rotates sessions and expired tokens fail', async () => {
    const oldCookie = alice.cookie;
    assert.equal((await alice.request('/api/auth/logout', 'POST')).status, 200);
    alice.cookie = oldCookie; assert.equal((await alice.request('/api/users/me')).status, 401);
    assert.equal((await alice.request('/api/auth/login', 'POST', { identifier: 'alice', password: 'wrong password' })).status, 401);
    assert.equal((await alice.request('/api/auth/login', 'POST', { identifier: 'missing', password: 'wrong password' })).status, 401);
    assert.equal((await alice.request('/api/auth/login', 'POST', { identifier: 'NEWALICE@EXAMPLE.COM', password: account('alice').password })).status, 200);
    const loggedIn = alice.cookie;
    await alice.request('/api/auth/login', 'POST', { identifier: 'alice', password: account('alice').password });
    assert.notEqual(alice.cookie, loggedIn);
    guest.cookie = loggedIn; assert.equal((await guest.request('/api/users/me')).status, 401);
    const token = alice.cookie.split('=')[1];
    await db.collection('sessions').updateOne({ token_hash: createHash('sha256').update(token).digest('hex') }, { $set: { expires_at: new Date(0) } });
    assert.equal((await alice.request('/api/users/me')).status, 401);
  });
  await t.test('serves UI and handles malformed JSON and rate limits', async () => {
    const html = await fetch(base); assert.equal(html.status, 200); assert.match(await html.text(), /Your friends/);
    const invalid = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken' }); assert.equal(invalid.status, 400);
    assert.equal((await guest.request('/api/auth/login', 'POST', { identifier: 'x'.repeat(20000), password: 'wrong password' })).status, 413);
    const limited = createApp(client, db, { secureCookies: false, authLimit: 1 }); servers.push(limited);
    limited.listen(0, '127.0.0.1'); await once(limited, 'listening');
    const url = `http://127.0.0.1:${limited.address().port}/api/auth/login`;
    const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'none', password: 'wrong password' }) };
    assert.equal((await fetch(url, options)).status, 401);
    const blocked = await fetch(url, options); assert.equal(blocked.status, 429); assert.ok(blocked.headers.get('retry-after'));
  });
});
