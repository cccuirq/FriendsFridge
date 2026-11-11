import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { initializeDatabase } from '../../src/db/schema.js';
import { seedIngredients, ingredients as seededIngredients, recognitionIngredients } from '../../database/seeds/ingredients.js';
import { createApp } from '../../src/app.js';

test('Photo recognition proxy and shared inventory confirmation', { timeout: 240000 }, async (t) => {
  const replica = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { version: '8.0.16' } });
  const client = new MongoClient(replica.getUri());
  await client.connect();
  const db = client.db('recognition_test');
  await initializeDatabase(db); await seedIngredients(db);
  const server = createApp(client, db, { secureCookies: false });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  // Explicit transport fixture, NOT evidence of real model accuracy.
  const fixture = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), 'fixture-image');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: { source: 'model', model: 'TEST-FIXTURE', image: { width: 10, height: 10 }, detections: [] } }));
  });
  fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
  const oldUrl = process.env.RECOGNITION_URL;
  process.env.RECOGNITION_URL = `http://127.0.0.1:${fixture.address().port}`;
  t.after(async () => {
    if (oldUrl === undefined) delete process.env.RECOGNITION_URL; else process.env.RECOGNITION_URL = oldUrl;
    server.closeConversationEvents(); server.closeAllConnections(); fixture.closeAllConnections();
    await Promise.all([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => fixture.close(resolve))]);
    await client.close(); await replica.stop();
  });
  const request = async (path, method = 'GET', body, cookie = '', headers = {}) => {
    const response = await fetch(base + path, { method, headers: { Cookie: cookie, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : headers['Content-Type'] ? body : JSON.stringify(body) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const register = (name) => request('/api/auth/register', 'POST', { username: name, display_name: name, email: `${name}@example.com`, password: 'recognition-test-password' });
  const alice = await register('photo_alice'); const bob = await register('photo_bob');
  const ingredients = (await request('/api/recognition/ingredients', 'GET', undefined, alice.cookie)).body.data;
  const egg = ingredients.find((item) => item.name === 'egg');
  assert.equal(ingredients.length, seededIngredients.length);
  assert.equal(new Set(recognitionIngredients.map((item) => item.name)).size, recognitionIngredients.length);
  for (const expected of recognitionIngredients) {
    const actual = ingredients.find((item) => item.name === expected.name);
    assert.ok(actual?.recognition_candidate, `Missing inventory mapping: ${expected.name}`);
    assert.equal(actual.default_unit, expected.default_unit);
  }

  await t.test('new ingredient categories save with shared units and safe retries', async () => {
    const names = ['cucumber', 'beef', 'grapes', 'yogurt', 'walnuts'];
    const batch = { batch_id: randomUUID(), items: names.map((name) => ({ ingredient_id: ingredients.find((item) => item.name === name)._id, quantity: 12500 })) };
    assert.equal((await request('/api/inventory/imports', 'POST', batch, bob.cookie)).status, 200);
    const replay = await request('/api/inventory/imports', 'POST', batch, bob.cookie);
    assert.equal(replay.status, 200);
    const stock = (await request('/api/inventory', 'GET', undefined, bob.cookie)).body.data;
    assert.deepEqual(stock.map((item) => item.ingredient.name).sort(), names.sort());
    assert.ok(stock.every((item) => item.quantity === 12500 && item.ingredient.default_unit === 'g'));
    // Keep the later account-isolation assertions independent of this batch.
    await db.collection('inventory_items').deleteMany({ user_id: bob.body.data._id });
    await db.collection('inventory_imports').deleteMany({ user_id: bob.body.data._id });
  });

  await t.test('protects uploads and rejects unsupported, empty and oversized input', async () => {
    assert.equal((await request('/api/recognition', 'POST', undefined)).status, 401);
    assert.equal((await request('/api/recognition', 'POST', 'text', alice.cookie, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await request('/api/recognition', 'POST', '', alice.cookie, { 'Content-Type': 'image/png' })).status, 400);
    assert.equal((await request('/api/recognition', 'POST', Buffer.alloc(10 * 1024 * 1024 + 1), alice.cookie, { 'Content-Type': 'image/png' })).status, 413);
    assert.equal((await request('/api/recognition', 'POST', 'fixture-image', alice.cookie, { 'Content-Type': 'image/png', Origin: 'https://other.example' })).status, 403);
    const result = await request('/api/recognition', 'POST', 'fixture-image', alice.cookie, { 'Content-Type': 'image/png' });
    assert.equal(result.status, 200); assert.deepEqual(result.body.data.detections, []);
    process.env.RECOGNITION_URL = 'http://127.0.0.1:1';
    assert.equal((await request('/api/recognition', 'POST', 'fixture-image', alice.cookie, { 'Content-Type': 'image/png' })).status, 503);
  });
  const payload = { batch_id: randomUUID(), items: [{ ingredient_id: egg._id, quantity: 100 }, { ingredient_id: egg._id, quantity: 200 }] };
  await t.test('merges rows and makes concurrent retries idempotent', async () => {
    const results = await Promise.all([1, 2, 3].map(() => request('/api/inventory/imports', 'POST', payload, alice.cookie)));
    assert.deepEqual(results.map((r) => r.status), [200, 200, 200]);
    assert.equal(await db.collection('inventory_imports').countDocuments(), 1);
    let stock = (await request('/api/inventory', 'GET', undefined, alice.cookie)).body.data;
    assert.equal(stock.length, 1); assert.equal(stock[0].quantity, 300); assert.equal(stock[0].visibility, 'private');
    assert.deepEqual((await request('/api/inventory', 'GET', undefined, bob.cookie)).body.data, []);
    assert.equal((await request('/api/inventory/imports', 'POST', { ...payload, items: [{ ingredient_id: egg._id, quantity: 500 }] }, alice.cookie)).status, 409);
    await db.collection('inventory_items').updateOne({ user_id: alice.body.data._id }, { $set: { visibility: 'friends' } });
    assert.equal((await request('/api/inventory/imports', 'POST', { ...payload, batch_id: randomUUID() }, alice.cookie)).status, 200);
    stock = (await request('/api/inventory', 'GET', undefined, alice.cookie)).body.data;
    assert.equal(stock[0].quantity, 600); assert.equal(stock[0].visibility, 'friends');
  });
  await t.test('rejects invalid quantities and rolls back the entire batch', async () => {
    for (const quantity of [0, -1, 1.5, '100', Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal((await request('/api/inventory/imports', 'POST', { batch_id: randomUUID(), items: [{ ingredient_id: egg._id, quantity }] }, alice.cookie)).status, 400);
    }
    const invalid = { batch_id: randomUUID(), items: [{ ingredient_id: egg._id, quantity: 100 }, { ingredient_id: randomUUID(), quantity: 100 }] };
    assert.equal((await request('/api/inventory/imports', 'POST', invalid, alice.cookie)).status, 400);
    assert.equal((await db.collection('inventory_items').findOne({ user_id: alice.body.data._id })).quantity, 600);
    assert.equal(await db.collection('inventory_imports').countDocuments({ batch_id: invalid.batch_id }), 0);
    assert.equal((await request('/api/inventory/imports', 'POST', { ...payload, user_id: bob.body.data._id }, alice.cookie)).status, 400);
  });
});
