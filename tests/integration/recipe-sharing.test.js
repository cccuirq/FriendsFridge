import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { initializeDatabase } from '../../src/db/schema.js';
import { createApp } from '../../src/app.js';

test('Recipe sharing invitations, consent, removal and conversation history', { timeout: 240000 }, async (t) => {
  const replica = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { version: '8.0.16' } });
  const client = new MongoClient(replica.getUri());
  await client.connect();
  const db = client.db('recipe_sharing_test');
  await initializeDatabase(db);
  const server = createApp(client, db, { secureCookies: false });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeConversationEvents(); server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await client.close(); await replica.stop();
  });
  async function request(person, path, method = 'GET', body) {
    const response = await fetch(base + path, {
      method, headers: { Cookie: person?.cookie || '', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, ...(await response.json()), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  async function account(name) {
    const result = await request(null, '/api/auth/register', 'POST', { username: name, display_name: name, email: `${name}@example.com`, password: 'sharing-test-password' });
    return { id: result.data._id, cookie: result.cookie };
  }
  const sender = await account('share_sender'), recipient = await account('share_recipient'), outsider = await account('share_outsider');
  const friendship = (await request(sender, '/api/friends/requests', 'POST', { user_id: recipient.id })).data;
  await request(recipient, `/api/friends/requests/${friendship._id}`, 'PATCH', { status: 'accepted' });
  const ingredientId = randomUUID();
  await db.collection('ingredients').insertOne({ _id: ingredientId, name: 'egg', category: 'protein', default_unit: 'piece', fresh_interval: null, created_at: new Date() });
  const image = { content_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XcAAAAASUVORK5CYII=' };
  const recipe = (await request(sender, '/api/recipes', 'POST', { title: 'Private shared eggs', instructions: 'Cook the eggs.', servings: 1, items: [{ ingredient_id: ingredientId, quantity: 100 }], image })).data;
  const recipePath = `/api/recipes/${recipe._id}`;
  const list = async (person) => (await request(person, '/api/recipes')).data.recipes;
  const getRecipe = async (person) => (await list(person)).find((row) => row._id === recipe._id);
  const send = () => request(sender, recipePath + '/shares', 'POST', { recipient_id: recipient.id });
  const transition = (person, id, status) => request(person, `/api/recipes/shares/${id}`, 'PATCH', { status });
  const timeline = async (person, peer) => (await request(person, `/api/friends/${peer.id}/conversation`)).data;
  let invitation;

  await t.test('pending invitations are deduplicated, delivered in chat and grant no private access', async () => {
    const sent = await Promise.all([1, 2, 3].map(send));
    assert.ok(sent.every((row) => row.status === 200));
    assert.equal(new Set(sent.map((row) => row.data._id)).size, 1);
    invitation = sent[0].data;
    assert.equal(invitation.status, 'pending');
    assert.equal(await db.collection('recipe_shares').countDocuments({ recipe_id: recipe._id }), 1);
    assert.equal(await getRecipe(recipient), undefined);
    assert.equal((await request(recipient, recipePath + '/saved', 'PUT')).status, 404);
    assert.equal((await request(recipient, recipePath + '/image')).status, 404);
    for (const [person, peer] of [[sender, recipient], [recipient, sender]]) {
      const card = (await timeline(person, peer)).items.find((row) => row._id === invitation._id);
      assert.equal(card.kind, 'recipe_share');
      assert.equal(card.status, 'pending');
      assert.equal(card.recipe_title, 'Private shared eggs');
      assert.equal(card.instructions, undefined);
    }
    const directory = (await request(recipient, '/api/friends/directory')).data;
    assert.equal(directory[0].latest.kind, 'recipe_share');
    assert.equal(directory[0].unread, true);
    assert.deepEqual((await request(recipient, '/api/friends/conversations/unread')).data, [sender.id]);
    assert.equal((await transition(outsider, invitation._id, 'accepted')).status, 404);
    assert.equal((await transition(sender, invitation._id, 'accepted')).status, 409);
    assert.equal((await transition(recipient, invitation._id, 'cancelled')).status, 409);
    assert.equal((await transition(recipient, invitation._id, 'removed')).status, 409);
    assert.equal((await transition(null, invitation._id, 'accepted')).status, 401);
  });

  await t.test('acceptance enables shared access without auto-saving; removal clears only recipient access and saves', async () => {
    assert.equal((await transition(recipient, invitation._id, 'accepted')).status, 200);
    let received = await getRecipe(recipient);
    assert.equal(received.shared, true);
    assert.equal(received.share_id, invitation._id);
    assert.equal(received.saved, false);
    const photo = await fetch(base + recipePath + '/image', { headers: { Cookie: recipient.cookie } });
    assert.equal(photo.status, 200); await photo.arrayBuffer();
    assert.equal((await transition(sender, invitation._id, 'cancelled')).status, 409);
    await request(recipient, recipePath + '/saved', 'PUT');
    await request(sender, recipePath + '/saved', 'PUT');
    assert.equal((await transition(sender, invitation._id, 'removed')).status, 409);
    assert.equal((await transition(recipient, invitation._id, 'removed')).status, 200);
    assert.equal(await getRecipe(recipient), undefined);
    assert.equal((await request(recipient, recipePath + '/image')).status, 404);
    assert.equal(await db.collection('saved_recipes').countDocuments({ user_id: recipient.id, recipe_id: recipe._id }), 0);
    assert.equal((await getRecipe(sender)).saved, true);
    assert.equal((await getRecipe(sender)).owned, true);
    assert.equal((await timeline(recipient, sender)).items.find((row) => row._id === invitation._id).status, 'removed');
    assert.equal((await transition(recipient, invitation._id, 'accepted')).status, 409);
  });

  await t.test('declines, cancellations and re-sharing retain distinct chat cards', async () => {
    const declined = (await send()).data;
    assert.notEqual(declined._id, invitation._id);
    assert.equal((await transition(recipient, declined._id, 'declined')).status, 200);
    assert.equal((await transition(recipient, declined._id, 'accepted')).status, 409);
    const cancelled = (await send()).data;
    assert.equal((await transition(sender, cancelled._id, 'cancelled')).status, 200);
    assert.equal((await transition(recipient, cancelled._id, 'accepted')).status, 409);
    assert.equal(await getRecipe(recipient), undefined);
    const cards = (await timeline(recipient, sender)).items;
    assert.equal(cards.find((row) => row._id === declined._id).status, 'declined');
    assert.equal(cards.find((row) => row._id === cancelled._id).status, 'cancelled');
    assert.equal(cards.find((row) => row._id === invitation._id).status, 'removed');
  });

  await t.test('accept versus cancel races have one winner and never grant cancelled access', async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const share = (await send()).data;
      const results = await Promise.all([transition(recipient, share._id, 'accepted'), transition(sender, share._id, 'cancelled')]);
      assert.deepEqual(results.map((row) => row.status).sort(), [200, 409]);
      const stored = await db.collection('recipe_shares').findOne({ _id: share._id });
      assert.equal(Boolean(await getRecipe(recipient)), stored.status === 'accepted');
      if (stored.status === 'accepted') await transition(recipient, share._id, 'removed');
    }
  });

  await t.test('notifies both chats immediately when an invitation is sent, accepted or removed', async (subtest) => {
    const controller = new AbortController();
    const readers = [];
    subtest.after(async () => {
      controller.abort();
      await Promise.all(readers.map((reader) => reader.cancel().catch(() => {})));
    });
    const decoder = new TextDecoder();
    for (const person of [sender, recipient]) {
      const response = await fetch(base + '/api/friends/conversations/events', { headers: { Cookie: person.cookie }, signal: controller.signal });
      const reader = response.body.getReader(); readers.push(reader);
      assert.match(decoder.decode((await reader.read()).value), /: connected/);
    }
    async function notified() {
      let timer;
      try {
        await Promise.race([
          Promise.all(readers.map(async (reader) => assert.match(decoder.decode((await reader.read()).value), /data: \{\}/))),
          new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Sharing did not notify both chats')); }, 2000); }),
        ]);
      } finally { clearTimeout(timer); }
    }
    const share = (await send()).data;
    await notified();
    assert.equal((await transition(recipient, share._id, 'accepted')).status, 200);
    await notified();
    assert.equal((await transition(recipient, share._id, 'removed')).status, 200);
    await notified();
  });

  await t.test('conversation pagination preserves old sharing cards without duplicate entries', async () => {
    for (let i = 0; i < 21; i++) {
      const share = (await send()).data;
      await transition(sender, share._id, 'cancelled');
    }
    let page = await timeline(recipient, sender);
    assert.equal(page.items.length, 20);
    assert.ok(page.next_before);
    const rows = [...page.items];
    while (page.next_before) {
      page = (await request(recipient, `/api/friends/${sender.id}/conversation?before=${encodeURIComponent(page.next_before)}`)).data;
      rows.push(...page.items);
    }
    assert.equal(new Set(rows.map((row) => row._id)).size, rows.length);
    assert.equal(rows.length, await db.collection('recipe_shares').countDocuments());
    assert.equal(rows.find((row) => row._id === invitation._id).status, 'removed');
  });

  await t.test('friend removal blocks acceptance, and deleting the recipe invalidates old invitations', async () => {
    const share = (await send()).data;
    await request(sender, `/api/friends/${recipient.id}`, 'DELETE');
    assert.equal((await transition(recipient, share._id, 'accepted')).status, 404);
    assert.equal((await timeline(recipient, sender)).can_message, false);
    assert.equal((await transition(sender, share._id, 'cancelled')).status, 200);
    assert.equal((await send()).status, 404);
    await request(sender, recipePath, 'DELETE');
    assert.equal((await transition(recipient, share._id, 'accepted')).status, 404);
  });
});

test('Legacy sharing migration requests consent and preserves invitation IDs', { timeout: 240000 }, async (t) => {
  const replica = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { version: '8.0.16' } });
  const client = new MongoClient(replica.getUri());
  await client.connect();
  t.after(async () => { await client.close(); await replica.stop(); });
  const db = client.db('recipe_share_migration_test');
  const legacy = { _id: randomUUID(), recipe_id: randomUUID(), sender_id: randomUUID(), recipient_id: randomUUID(), message: '', created_at: new Date() };
  await db.collection('recipe_shares').createIndex({ recipe_id: 1, recipient_id: 1 }, { unique: true });
  await db.collection('recipe_shares').insertOne(legacy);
  await initializeDatabase(db);
  const migrated = await db.collection('recipe_shares').findOne({ _id: legacy._id });
  assert.equal(migrated.status, 'pending');
  assert.deepEqual(migrated.updated_at, legacy.created_at);
  await initializeDatabase(db);
  assert.deepEqual(await db.collection('recipe_shares').findOne({ _id: legacy._id }), migrated);
  await db.collection('recipe_shares').updateOne({ _id: legacy._id }, { $set: { status: 'cancelled' } });
  const fresh = { ...migrated, _id: randomUUID(), status: 'pending' };
  await db.collection('recipe_shares').insertOne(fresh);
  await assert.rejects(db.collection('recipe_shares').insertOne({ ...fresh, _id: randomUUID() }), { code: 11000 });
  assert.equal(await db.collection('recipe_shares').countDocuments(), 2);
});
