import { HttpError, fields, json, readJson, string, uuid } from '../../utils/http.js';
import { recipeRepository } from './repository.js';

function recipeImage(image) {
  if (image == null) return undefined;
  if (typeof image !== 'object' || Array.isArray(image)) throw new HttpError(400, 'INVALID_IMAGE', 'Choose a JPG or PNG image.');
  fields(image, ['content_type', 'data']);
  if (!['image/jpeg', 'image/png'].includes(image.content_type) || typeof image.data !== 'string'
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data)) {
    throw new HttpError(400, 'INVALID_IMAGE', 'Choose a valid JPG or PNG image.');
  }
  const data = Buffer.from(image.data, 'base64');
  if (data.length > 2 * 1024 * 1024) throw new HttpError(413, 'IMAGE_TOO_LARGE', 'Choose an image no larger than 2 MB.');
  const png = data.length > 32 && data.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
    && data.toString('ascii', 12, 16) === 'IHDR';
  const jpeg = data.length > 4 && data.subarray(0, 3).toString('hex') === 'ffd8ff' && data.subarray(-2).toString('hex') === 'ffd9';
  if (!(image.content_type === 'image/png' ? png : jpeg)) throw new HttpError(400, 'INVALID_IMAGE', 'Choose a valid JPG or PNG image.');
  return { content_type: image.content_type, data };
}

function recipeInput(body, editing = false) {
  fields(body, ['title', 'description', 'instructions', 'servings', 'items', 'image']);
  const image = recipeImage(body.image);
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
    ...(image ? { image } : editing && body.image === null ? { image: null } : {}),
  };
}

export function recipeRoutes(client, db) {
  const recipes = recipeRepository(client, db);
  return async (request, response, path, actorId) => {
    if (path === '/api/recipes') {
      if (request.method === 'GET') json(response, 200, { data: await recipes.list(actorId) });
      else if (request.method === 'POST') {
        const body = recipeInput(await readJson(request, 3 * 1024 * 1024));
        json(response, 201, { data: await recipes.create(actorId, body) });
      } else throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      return;
    }
    const ownRecipe = /^\/api\/recipes\/([^/]+)$/.exec(path);
    if (ownRecipe) {
      const id = uuid(ownRecipe[1]);
      if (request.method === 'PATCH') {
        const body = recipeInput(await readJson(request, 3 * 1024 * 1024), true);
        json(response, 200, { data: await recipes.updateOwned(actorId, id, body) });
      } else if (request.method === 'DELETE') {
        await recipes.deleteOwned(actorId, id);
        json(response, 200, { data: { _id: id, deleted: true } });
      } else throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      return;
    }
    const match = /^\/api\/recipes\/([^/]+)\/(saved|shares|image)$/.exec(path);
    if (!match) throw new HttpError(404, 'NOT_FOUND', 'Endpoint not found.');
    const id = uuid(match[1]);
    if (match[2] === 'image' && request.method === 'GET') {
      const image = await recipes.image(actorId, id);
      response.writeHead(200, { 'Content-Type': image.content_type, 'Cache-Control': 'no-store' });
      response.end(image.data);
    } else if (match[2] === 'saved' && ['PUT', 'DELETE'].includes(request.method)) {
      json(response, 200, { data: await recipes.setSaved(actorId, id, request.method === 'PUT') });
    } else if (match[2] === 'shares' && request.method === 'POST') {
      const body = await readJson(request);
      fields(body, ['recipient_id']);
      json(response, 200, { data: await recipes.share(actorId, id, uuid(body.recipient_id)) });
    } else throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  };
}
