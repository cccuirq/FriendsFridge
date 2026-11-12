import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectDatabase, inTransaction } from '../../src/db/connection.js';

export const samples = [
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
  {
    "id": "f1000000-0000-4000-8000-000000000003",
    "title": "Salmon Avocado Salad",
    "description": "A simple salmon and avocado salad with lemon dressing.",
    "servings": 2,
    "instructions": "Cook the salmon in a pan until cooked through.\nArrange the sliced avocado and lettuce on plates.\nAdd the salmon and drizzle with olive oil and lemon juice.",
    "items": [
      [
        "salmon",
        "g",
        25000
      ],
      [
        "avocado",
        "piece",
        100
      ],
      [
        "lettuce",
        "g",
        10000
      ],
      [
        "olive oil",
        "ml",
        1500
      ],
      [
        "lemon",
        "piece",
        100
      ]
    ]
  },
  {
    "id": "f1000000-0000-4000-8000-000000000004",
    "title": "Chicken Fried Rice",
    "description": "A quick pan of rice, chicken, egg and vegetables.",
    "servings": 2,
    "instructions": "Cook the rice and let it cool.\nCook diced chicken thoroughly in a pan, then add the carrot and onion.\nScramble in the eggs, add rice and soy sauce, and stir until hot.",
    "items": [
      [
        "rice",
        "g",
        15000
      ],
      [
        "chicken",
        "g",
        20000
      ],
      [
        "egg",
        "piece",
        200
      ],
      [
        "carrot",
        "g",
        8000
      ],
      [
        "onion",
        "g",
        6000
      ],
      [
        "soy sauce",
        "ml",
        1500
      ],
      [
        "olive oil",
        "ml",
        1000
      ]
    ]
  },
  {
    "id": "f1000000-0000-4000-8000-000000000005",
    "title": "French Omelette",
    "description": "Soft eggs folded with butter and a little cheese.",
    "servings": 1,
    "instructions": "Whisk eggs with salt and pepper.\nMelt butter in a nonstick pan and gently stir in the eggs.\nAdd cheese, fold and cook to your preferred doneness.",
    "items": [
      [
        "egg",
        "piece",
        200
      ],
      [
        "butter",
        "g",
        1000
      ],
      [
        "cheese",
        "g",
        2000
      ],
      [
        "salt",
        "g",
        100
      ],
      [
        "black pepper",
        "g",
        50
      ]
    ]
  },
  {
    "id": "f1000000-0000-4000-8000-000000000006",
    "title": "Garlic Prawns",
    "description": "A simple lemon and garlic shrimp skillet.",
    "servings": 2,
    "instructions": "Melt butter in a pan and briefly cook the chopped garlic.\nAdd shrimp and cook until opaque and cooked through.\nFinish with lemon juice and serve immediately.",
    "items": [
      [
        "shrimp",
        "g",
        25000
      ],
      [
        "garlic",
        "g",
        1000
      ],
      [
        "butter",
        "g",
        2000
      ],
      [
        "lemon",
        "piece",
        100
      ]
    ]
  },
  {
    "id": "f1000000-0000-4000-8000-000000000007",
    "title": "Creamy Tomato Soup",
    "description": "Tomatoes and onion blended into a smooth soup.",
    "servings": 2,
    "instructions": "Soften chopped onion in olive oil.\nAdd chopped tomatoes and water, then simmer until soft.\nBlend carefully and stir in cream. Warm gently and season with salt.",
    "items": [
      [
        "tomato",
        "g",
        40000
      ],
      [
        "onion",
        "g",
        8000
      ],
      [
        "olive oil",
        "ml",
        1000
      ],
      [
        "water",
        "ml",
        25000
      ],
      [
        "cream",
        "ml",
        5000
      ],
      [
        "salt",
        "g",
        200
      ]
    ]
  },
  {
    "id": "f1000000-0000-4000-8000-000000000008",
    "title": "Banana Milk Shake",
    "description": "A non-alcoholic banana and milk drink.",
    "servings": 1,
    "instructions": "Peel and slice the banana.\nBlend with cold milk and honey until smooth.\nPour into a glass and serve.",
    "items": [
      [
        "banana",
        "piece",
        100
      ],
      [
        "milk",
        "ml",
        25000
      ],
      [
        "honey",
        "g",
        1000
      ]
    ]
  },
  {
    "id": "f1000000-0000-4000-8000-000000000009",
    "title": "Margarita",
    "description": "A simplified tequila, orange liqueur and fresh lime cocktail.",
    "servings": 1,
    "instructions": "Juice the lime and optionally rim a glass with salt.\nShake tequila, triple sec and lime juice with ice.\nStrain into the glass. Ice is optional and not tracked in inventory.",
    "items": [
      [
        "tequila",
        "ml",
        5000
      ],
      [
        "triple sec",
        "ml",
        2000
      ],
      [
        "lime",
        "piece",
        100
      ],
      [
        "salt",
        "g",
        100
      ]
    ]
  },
  {
    "id": "f1000000-0000-4000-8000-000000000010",
    "title": "Mojito",
    "description": "A simplified rum, mint and lime cocktail.",
    "servings": 1,
    "instructions": "Gently muddle mint with sugar and lime wedges in a glass.\nAdd rum and ice if available.\nTop with cold water and stir. Ice is optional and not tracked in inventory.",
    "items": [
      [
        "rum",
        "ml",
        5000
      ],
      [
        "lime",
        "piece",
        100
      ],
      [
        "mint",
        "g",
        300
      ],
      [
        "sugar",
        "g",
        1000
      ],
      [
        "water",
        "ml",
        10000
      ]
    ]
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
