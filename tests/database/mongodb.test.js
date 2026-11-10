import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { initializeDatabase } from '../../src/db/schema.js';
import { seedIngredients } from '../../database/seeds/ingredients.js';
import { ingredientRequestRepository } from '../../src/modules/ingredient-requests/repository.js';
import { recipeRepository } from '../../src/modules/recipes/repository.js';

test('MongoDB validators, indexes, seeds, permissions and transactions', { timeout: 240000 }, async (t) => {
  const replica = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { version: '8.0.16' } });
  const client = new MongoClient(replica.getUri());
  t.after(async () => { await client.close(); await replica.stop(); });
  await client.connect();
  const db = client.db('friends_fridge_test');
  // Simulate an ingredient created before fresh_interval was introduced.
  await db.collection('ingredients').insertOne({ _id: randomUUID(), name: 'egg', category: 'protein', default_unit: 'piece', created_at: new Date() });
  await initializeDatabase(db);
  await initializeDatabase(db);
  assert.equal((await db.listCollections().toArray()).length, 11);
  await seedIngredients(db);
  await seedIngredients(db);
  assert.equal(await db.collection('ingredients').countDocuments(), 20);
  const ingredient = await db.collection('ingredients').findOne({ name: 'egg' });
  assert.equal(ingredient.fresh_interval, null);
  for (const fresh_interval of [-1, 0, 1.5, '7']) {
    await assert.rejects(db.collection('ingredients').updateOne({ _id: ingredient._id }, { $set: { fresh_interval } }), { code: 121 });
  }
  await assert.rejects(db.collection('ingredients').updateOne({ _id: ingredient._id }, { $unset: { fresh_interval: '' } }), { code: 121 });
  await db.collection('ingredients').updateOne({ _id: ingredient._id }, { $set: { fresh_interval: 7 } });
  await initializeDatabase(db);
  await seedIngredients(db);
  assert.equal((await db.collection('ingredients').findOne({ _id: ingredient._id })).fresh_interval, 7);
  const now = new Date();
  const [owner, requester, outsider] = [randomUUID(), randomUUID(), randomUUID()];
  for (const [i, _id] of [owner, requester, outsider].entries()) {
    await db.collection('users').insertOne({ _id, username: `user${i}`, email: `user${i}@example.com`, password_hash: 'test-only-hash', display_name: `User ${i}`, created_at: now });
  }
  const item = { _id: randomUUID(), user_id: owner, ingredient_id: ingredient._id, quantity: 300, visibility: 'friends', created_at: now, updated_at: now };
  await db.collection('inventory_items').insertOne(item);
  await assert.rejects(db.collection('inventory_items').insertOne({ ...item, _id: randomUUID() }), { code: 11000 });
  for (const quantity of [-1, 0.5]) {
    await assert.rejects(db.collection('inventory_items').updateOne({ _id: item._id }, { $set: { quantity } }), { code: 121 });
  }
  const [low, high] = [owner, requester].sort();
  await assert.rejects(db.collection('friendships').insertOne({ _id: randomUUID(), user_low_id: high, user_high_id: low, requested_by: owner, status: 'accepted', created_at: now, updated_at: now }), { code: 121 });
  await db.collection('friendships').insertOne({ _id: randomUUID(), user_low_id: low, user_high_id: high, requested_by: requester, status: 'accepted', created_at: now, updated_at: now });
  const repository = ingredientRequestRepository(client, db);
  await db.collection('friendships').updateOne({ user_low_id: low, user_high_id: high }, { $set: { status: 'removed', updated_at: new Date() } });
  await assert.rejects(repository.create(requester, { owner_id: owner, ingredient_id: ingredient._id, quantity: 100 }), /friendship/);
  await assert.rejects(db.collection('friendships').updateOne({ user_low_id: low, user_high_id: high }, { $set: { status: 'invalid' } }), { code: 121 });
  await db.collection('friendships').updateOne({ user_low_id: low, user_high_id: high }, { $set: { status: 'accepted', updated_at: new Date() } });
  await assert.rejects(repository.create(outsider, { owner_id: owner, ingredient_id: ingredient._id, quantity: 100 }), /friendship/);
  await db.collection('inventory_items').updateOne({ _id: item._id }, { $set: { visibility: 'private' } });
  await assert.rejects(repository.create(requester, { owner_id: owner, ingredient_id: ingredient._id, quantity: 100 }), /unavailable/);
  await db.collection('inventory_items').updateOne({ _id: item._id }, { $set: { visibility: 'friends' } });
  const first = await repository.create(requester, { owner_id: owner, ingredient_id: ingredient._id, quantity: 200 });
  const second = await repository.create(requester, { owner_id: owner, ingredient_id: ingredient._id, quantity: 200 });
  await assert.rejects(repository.transition(requester, first._id, 'accepted'), /Forbidden/);
  await repository.transition(owner, first._id, 'accepted');
  await repository.transition(owner, second._id, 'accepted');
  assert.equal((await db.collection('inventory_items').findOne({ _id: item._id })).quantity, 300);
  const results = await Promise.allSettled([repository.transition(owner, first._id, 'completed'), repository.transition(owner, second._id, 'completed')]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await db.collection('inventory_items').findOne({ _id: item._id })).quantity, 100);
  assert.equal(await db.collection('ingredient_requests').countDocuments({ status: 'completed' }), 1);
  assert.equal(await db.collection('ingredient_requests').countDocuments({ status: 'accepted' }), 1);
  const completed = await db.collection('ingredient_requests').findOne({ status: 'completed' });
  await assert.rejects(repository.transition(owner, completed._id, 'completed'), /Forbidden/);
  await db.collection('inventory_items').deleteOne({ _id: item._id });
  assert.equal(await db.collection('ingredient_requests').countDocuments(), 2);

  const recipeId = randomUUID();
  await db.collection('recipes').insertOne({ _id: recipeId, author_id: owner, title: 'Eggs', description: '', instructions: 'Cook eggs.', servings: 1, visibility: 'private', created_at: now, updated_at: now });
  await db.collection('recipe_ingredients').insertOne({ _id: randomUUID(), recipe_id: recipeId, ingredient_id: ingredient._id, quantity: 100, created_at: now });
  await db.collection('saved_recipes').insertOne({ _id: randomUUID(), recipe_id: recipeId, user_id: requester, created_at: now });
  await db.collection('recipe_shares').insertOne({ _id: randomUUID(), recipe_id: recipeId, sender_id: owner, recipient_id: requester, message: '', created_at: now });
  const recipes = recipeRepository(client, db);
  await assert.rejects(recipes.deleteOwned(outsider, recipeId), /not owned/);
  await recipes.deleteOwned(owner, recipeId);
  for (const name of ['recipe_ingredients', 'saved_recipes', 'recipe_shares']) assert.equal(await db.collection(name).countDocuments({ recipe_id: recipeId }), 0);
});
