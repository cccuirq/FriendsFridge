// Local development only. Stores real MongoDB files in .local/mongodb.
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { initializeDatabase } from '../src/db/schema.js';
import { seedIngredients } from './seeds/ingredients.js';
import { seedRecipes } from './seeds/recipes.js';

const dbPath = resolve('.local/mongodb');
await mkdir(dbPath, { recursive: true });
const replica = await MongoMemoryReplSet.create({
  binary: { version: '8.0.16' },
  instanceOpts: [{ port: 27017, dbPath }],
  replSet: { count: 1, name: 'rs0', storageEngine: 'wiredTiger', ip: '127.0.0.1' },
});
const client = new MongoClient(replica.getUri());
try {
  await client.connect();
  const db = client.db('friends_fridge');
  await initializeDatabase(db);
  await seedIngredients(db);
  await seedRecipes(client, db);
  console.log('Local MongoDB ready on 127.0.0.1:27017; database: friends_fridge.');
  console.log('Collections, ingredients, and sample recipes are ready. Data: .local/mongodb. Ctrl+C to stop.');
} catch (error) {
  await replica.stop({ doCleanup: false });
  throw error;
} finally { await client.close(); }

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => { await replica.stop({ doCleanup: false }); });
}
