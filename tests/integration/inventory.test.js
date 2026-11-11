import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { initializeDatabase } from '../../src/db/schema.js';
import { seedIngredients } from '../../database/seeds/ingredients.js';
import { createApp } from '../../src/app.js';

test('Inventory HTTP management and stock concurrency', { timeout: 240000 }, async (t) => {
  const replica = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { version: '8.0.16' } });
  const client = new MongoClient(replica.getUri());
  await client.connect();
  const db = client.db('inventory_test');
  const server = createApp(client, db, { secureCookies: false });
  t.after(async () => {
    server.closeConversationEvents(); server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await client.close(); await replica.stop();
  });
  await initializeDatabase(db); await seedIngredients(db);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(cookie, path, method = 'GET', body, headers = {}) {
    const response = await fetch(base + path, { method, headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: (await response.json()).data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  async function account(name) {
    return request('', '/api/auth/register', 'POST', { username: name, email: `${name}@example.com`, display_name: name, password: 'inventory-password' });
  }
  const alice = await account('stock_alice'); const bob = await account('stock_bob'); const outsider = await account('stock_eve');
  const catalog = (await request(alice.cookie, '/api/ingredients')).data;
  const egg = catalog.find((item) => item.name === 'egg');
  const milk = catalog.find((item) => item.name === 'milk');
  const add = (ingredient, quantity, visibility = 'private') => ({ batch_id: randomUUID(), ingredient_id: ingredient._id, quantity, visibility });
  const stock = async () => (await request(alice.cookie, '/api/inventory')).data;
  let item;

  await t.test('requires authentication and validates dictionary, quantity, fields and visibility', async () => {
    assert.equal((await request('', '/api/inventory')).status, 401);
    assert.equal((await request('', '/api/ingredients')).status, 401);
    for (const quantity of [0, -1, 0.5, '100', Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal((await request(alice.cookie, '/api/inventory', 'POST', add(egg, quantity))).status, 400);
    }
    assert.equal((await request(alice.cookie, '/api/inventory', 'POST', add({ _id: randomUUID() }, 100))).status, 400);
    assert.equal((await request(alice.cookie, '/api/inventory', 'POST', add(egg, 100, 'public'))).status, 400);
    assert.equal((await request(alice.cookie, '/api/inventory', 'POST', { ...add(egg, 100), user_id: bob.data._id })).status, 400);
    assert.equal((await request(alice.cookie, '/api/inventory', 'POST', add(egg, 100), { Origin: 'https://other.example' })).status, 403);
    assert.deepEqual(await stock(), []);
  });
  await t.test('adds stock once on retry, merges duplicate food, preserves privacy and isolates owners', async () => {
    const payload = add(egg, 250);
    const results = await Promise.all([1, 2, 3].map(() => request(alice.cookie, '/api/inventory', 'POST', payload)));
    assert.ok(results.every((result) => result.status === 200));
    assert.equal((await stock())[0].quantity, 250);
    assert.equal((await request(alice.cookie, '/api/inventory', 'POST', { ...payload, quantity: 300 })).status, 409);
    assert.equal((await request(alice.cookie, '/api/inventory', 'POST', add(egg, 50, 'friends'))).status, 200);
    [item] = await stock(); assert.equal(item.quantity, 300); assert.equal(item.visibility, 'private');
    assert.deepEqual((await request(bob.cookie, '/api/inventory')).data, []);
    for (const [method, body] of [['PATCH', { quantity: 1, expected_quantity: 300 }], ['DELETE', { expected_quantity: 300 }]]) {
      assert.equal((await request(bob.cookie, `/api/inventory/${item._id}`, method, body)).status, 404);
    }
  });
  await t.test('sharing affects accepted friends only and recipe matching uses edited quantities', async () => {
    const relation = (await request(alice.cookie, '/api/friends/requests', 'POST', { user_id: bob.data._id })).data;
    await request(bob.cookie, `/api/friends/requests/${relation._id}`, 'PATCH', { status: 'accepted' });
    const shared = () => request(bob.cookie, `/api/friends/${alice.data._id}/fridge`);
    assert.deepEqual((await shared()).data.items, []);
    assert.equal((await request(alice.cookie, `/api/inventory/${item._id}`, 'PATCH', { visibility: 'friends' })).status, 200);
    assert.equal((await shared()).data.items[0].quantity, 300);
    assert.equal((await request(outsider.cookie, `/api/friends/${alice.data._id}/fridge`)).status, 404);
    await request(alice.cookie, `/api/inventory/${item._id}`, 'PATCH', { visibility: 'private' });
    assert.deepEqual((await shared()).data.items, []);
    const recipe = (await request(alice.cookie, '/api/recipes', 'POST', { title: 'Eggs', instructions: 'Cook.', servings: 1, items: [{ ingredient_id: egg._id, quantity: 400 }] })).data;
    await request(alice.cookie, `/api/inventory/${item._id}`, 'PATCH', { quantity: 450, expected_quantity: 300 });
    const recipeList = (await request(alice.cookie, '/api/recipes')).data.recipes;
    assert.equal(recipeList.find((row) => row._id === recipe._id).missing_count, 0);
  });
  await t.test('rejects stale edits and deletes after imports; handles competing edits and overflow', async () => {
    const id = `/api/inventory/${item._id}`;
    await request(alice.cookie, '/api/inventory/imports', 'POST', { batch_id: randomUUID(), items: [{ ingredient_id: egg._id, quantity: 50 }] });
    assert.equal((await request(alice.cookie, id, 'PATCH', { quantity: 100, expected_quantity: 450 })).status, 409);
    assert.equal((await request(alice.cookie, id, 'DELETE', { expected_quantity: 450 })).status, 409);
    assert.equal((await request(alice.cookie, id, 'PATCH', { quantity: -1, expected_quantity: 500 })).status, 400);
    assert.equal((await request(alice.cookie, id, 'PATCH', { quantity: 1 })).status, 400);
    const updates = await Promise.all([200, 300].map((quantity) => request(alice.cookie, id, 'PATCH', { quantity, expected_quantity: 500 })));
    assert.deepEqual(updates.map((result) => result.status).sort(), [200, 409]);
    const before = (await stock())[0].quantity;
    assert.equal((await request(alice.cookie, '/api/inventory', 'POST', add(egg, Number.MAX_SAFE_INTEGER))).status, 400);
    assert.equal((await stock())[0].quantity, before);
  });
  await t.test('handoff races do not lose stock updates; zero stock and deletion preserve request history', async () => {
    const id = `/api/inventory/${item._id}`;
    let current = (await stock())[0].quantity;
    await request(alice.cookie, id, 'PATCH', { quantity: 500, expected_quantity: current, visibility: 'friends' });
    const requestRow = (await request(bob.cookie, '/api/friends/ingredient-requests', 'POST', { owner_id: alice.data._id, ingredient_id: egg._id, quantity: 100 })).data;
    const path = `/api/friends/ingredient-requests/${requestRow._id}`;
    await request(alice.cookie, path, 'PATCH', { status: 'accepted' });
    const [edit, handoff] = await Promise.all([
      request(alice.cookie, id, 'PATCH', { quantity: 700, expected_quantity: 500 }),
      request(alice.cookie, path, 'PATCH', { status: 'completed' }),
    ]);
    assert.equal(handoff.status, 200);
    assert.equal((await stock())[0].quantity, edit.status === 200 ? 600 : 400);
    current = (await stock())[0].quantity;
    await request(alice.cookie, id, 'PATCH', { quantity: 0, expected_quantity: current });
    assert.equal((await stock())[0].quantity, 0);
    assert.deepEqual((await request(bob.cookie, `/api/friends/${alice.data._id}/fridge`)).data.items, []);
    assert.equal((await request(alice.cookie, id, 'DELETE', { expected_quantity: 0 })).status, 200);
    assert.equal((await db.collection('ingredient_requests').findOne({ _id: requestRow._id })).status, 'completed');
    assert.deepEqual(await stock(), []);
    await request(alice.cookie, '/api/inventory', 'POST', add(milk, 12500, 'friends'));
    assert.equal((await stock())[0].visibility, 'friends');
  });
});
