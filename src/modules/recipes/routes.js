import { HttpError, fields, json, readJson, string, uuid } from '../../utils/http.js';
import { recipeRepository } from './repository.js';

function recipeInput(body) {
  fields(body, ['title', 'description', 'instructions', 'servings', 'items']);
  if (!Number.isSafeInteger(body.servings) || body.servings < 1 || body.servings > 10000) {
    throw new HttpError(400, 'INVALID_INPUT', 'Servings must be a whole number from 1 to 10,000.');
  }
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 50) {
    throw new HttpError(400, 'INVALID_INPUT', 'Add between 1 and 50 ingredients.');
  }
  const used = new Set();
  const items = body.items.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new HttpError(400, 'INVALID_INPUT', 'Invalid ingredient.');
    fields(row, ['ingredient_id', 'quantity']);
    const ingredient_id = uuid(row.ingredient_id);
    if (used.has(ingredient_id)) throw new HttpError(400, 'DUPLICATE_INGREDIENT', 'List each ingredient only once.');
    if (!Number.isSafeInteger(row.quantity) || row.quantity < 1) {
      throw new HttpError(400, 'INVALID_QUANTITY', 'Enter a positive quantity with up to two decimal places.');
    }
    used.add(ingredient_id);
    return { ingredient_id, quantity: row.quantity };
  });
  return {
    title: string(body.title, 'Recipe name', 1, 200),
    description: string(body.description ?? '', 'Description', 0, 500),
    instructions: string(body.instructions, 'Directions', 1, 4000),
    servings: body.servings, items,
  };
}

export function recipeRoutes(client, db) {
  const recipes = recipeRepository(client, db);
  return async (request, response, path, actorId) => {
    if (path === '/api/recipes') {
      if (request.method === 'GET') json(response, 200, { data: await recipes.list(actorId) });
      else if (request.method === 'POST') {
        const body = recipeInput(await readJson(request));
        json(response, 201, { data: await recipes.create(actorId, body) });
      } else throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      return;
    }
    const match = /^\/api\/recipes\/([^/]+)\/(saved|shares)$/.exec(path);
    if (!match) throw new HttpError(404, 'NOT_FOUND', 'Endpoint not found.');
    const id = uuid(match[1]);
    if (match[2] === 'saved' && ['PUT', 'DELETE'].includes(request.method)) {
      json(response, 200, { data: await recipes.setSaved(actorId, id, request.method === 'PUT') });
    } else if (match[2] === 'shares' && request.method === 'POST') {
      const body = await readJson(request);
      fields(body, ['recipient_id']);
      json(response, 200, { data: await recipes.share(actorId, id, uuid(body.recipient_id)) });
    } else throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  };
}
