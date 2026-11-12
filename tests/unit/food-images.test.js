import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { defaultImages } from '../../public/assets/defaults/manifest.js';
import { findFoodImage } from '../../public/js/food-images.js';
import { ingredients } from '../../database/seeds/ingredients.js';
import { samples } from '../../database/seeds/recipes.js';

test('default food photos resolve canonical names, aliases and safe fallbacks', () => {
  assert.equal(findFoodImage(' EGG ').key, 'egg');
  assert.equal(findFoodImage('eggs').key, 'egg');
  assert.equal(findFoodImage('tomatoes').key, 'tomato');
  assert.equal(findFoodImage('gin').provider, 'TheCocktailDB');
  assert.equal(findFoodImage('Fluffy Pancakes', 'recipe').kind, 'recipe');
  assert.equal(findFoodImage('Margarita', 'drink').kind, 'drink');
  for (const name of ['unknown ingredient', '../../etc/passwd', 'https://evil.example/image.png', null]) assert.equal(findFoodImage(name), null);
});

test('all demo photos are real local PNG/JPEG files with tracked sources', async () => {
  assert.equal(defaultImages.length, ingredients.length + samples.length);
  assert.equal(new Set(defaultImages.map((image) => image.src)).size, defaultImages.length);
  for (const image of defaultImages) {
    assert.match(image.src, /^\/assets\/defaults\/[a-z0-9-]+\.(png|jpg)$/);
    assert.ok(['www.themealdb.com', 'www.thecocktaildb.com', 'commons.wikimedia.org'].includes(new URL(image.source).hostname));
    if (image.provider === 'Wikimedia Commons') { assert.ok(image.author); assert.match(image.license, /CC[ -]BY|CC0|Public domain/i); }
    const data = await readFile(new URL(`../../public${image.src}`, import.meta.url));
    assert.ok(data.length > 1000);
    if (image.src.endsWith('.png')) assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    else assert.equal(data.subarray(0, 3).toString('hex'), 'ffd8ff');
  }
});

test('every seeded ingredient and example recipe has a matching illustration', () => {
  assert.equal(ingredients.length, 212);
  assert.equal(samples.length, 10);
  for (const [name, category] of ingredients) {
    const image = findFoodImage(name);
    assert.ok(image, `Missing ingredient image: ${name}`);
    assert.equal(image.category, category);
  }
  for (const recipe of samples) {
    assert.ok(findFoodImage(recipe.title, 'recipe'), `Missing recipe image: ${recipe.title}`);
    for (const [name] of recipe.items) assert.ok(findFoodImage(name), `Missing recipe ingredient image: ${name}`);
  }
});
