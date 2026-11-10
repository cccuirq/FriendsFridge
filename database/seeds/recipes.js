import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectDatabase, inTransaction } from '../../src/db/connection.js';

const samples = [
  {
    id: 'f1000000-0000-4000-8000-000000000001',
    title: 'Fluffy Pancakes',
    description: 'A quick breakfast made with flour, milk, and eggs.',
    servings: 2,
    instructions: 'Whisk the eggs and milk together, then stir in the flour.\nSpoon the batter into a hot nonstick pan. Flip when bubbles form.\nCook until golden on both sides.',
    items: [['egg', 'piece', 200], ['milk', 'ml', 20000], ['flour', 'g', 15000]],
  },
  {
    id: 'f1000000-0000-4000-8000-000000000002',
    title: 'Tomato Pasta',
    description: 'Pasta with a simple tomato and garlic sauce.',
    servings: 2,
    instructions: 'Cook the pasta and reserve a little of the cooking water.\nCook the garlic in olive oil, then add the chopped tomatoes.\nToss the pasta with the sauce and a splash of cooking water.',
    items: [['pasta', 'g', 18000], ['tomato', 'g', 20000], ['garlic', 'g', 600], ['olive oil', 'ml', 1500]],
  },
];

export async function seedRecipes(client, db) {
  for (const { id: _id, items, ...recipe } of samples) {
    await inTransaction(client, async (session) => {
      const recipes = db.collection('recipes');
      if (await recipes.findOne({ _id }, { session })) return;
      const ingredients = await db.collection('ingredients')
        .find({ name: { $in: items.map(([name]) => name) } }, { session }).toArray();
      const ids = new Map(ingredients.map((ingredient) => [ingredient.name, ingredient]));
      const now = new Date();
      const rows = items.map(([name, unit, quantity]) => {
        const ingredient = ids.get(name);
        if (ingredient?.default_unit !== unit) throw new Error(`Seed ingredient "${name}" with unit "${unit}" first.`);
        return { _id: randomUUID(), recipe_id: _id, ingredient_id: ingredient._id, quantity, created_at: now };
      });
      await recipes.insertOne({ _id, ...recipe, author_id: null, visibility: 'public', created_at: now, updated_at: now }, { session });
      await db.collection('recipe_ingredients').insertMany(rows, { session });
    });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { client, db } = await connectDatabase();
  try {
    await seedRecipes(client, db);
    console.log('Sample recipes are ready.');
  } finally { await client.close(); }
}
