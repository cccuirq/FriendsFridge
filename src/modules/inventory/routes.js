import { HttpError, fields, json, readJson, uuid } from '../../utils/http.js';
import { inventoryRepository } from './repository.js';

function quantity(value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new HttpError(400, 'INVALID_QUANTITY', 'Enter a valid quantity with up to two decimal places.');
  return value;
}
function visibility(value) {
  if (!['private', 'friends'].includes(value)) throw new HttpError(400, 'INVALID_VISIBILITY', 'Choose Only me or Friends.');
  return value;
}

export function inventoryRoutes(client, db) {
  const inventory = inventoryRepository(client, db);
  return async (request, response, path, actorId) => {
    if (path === '/api/ingredients' && request.method === 'GET') {
      json(response, 200, { data: await db.collection('ingredients').find({}, { projection: { name: 1, category: 1, default_unit: 1 } }).sort({ name: 1 }).toArray() });
      return;
    }
    if (path === '/api/inventory') {
      if (request.method === 'GET') json(response, 200, { data: await inventory.list(actorId) });
      else if (request.method === 'POST') {
        const body = await readJson(request);
        fields(body, ['batch_id', 'ingredient_id', 'quantity', 'visibility']);
        const result = await inventory.addBatch(actorId, uuid(body.batch_id), [{ ingredient_id: uuid(body.ingredient_id), quantity: quantity(body.quantity, 1) }], visibility(body.visibility ?? 'private'));
        json(response, 200, { data: result });
      } else throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      return;
    }
    const match = /^\/api\/inventory\/([^/]+)$/.exec(path);
    if (!match) throw new HttpError(404, 'NOT_FOUND', 'Endpoint not found.');
    const id = uuid(match[1]);
    if (!['PATCH', 'DELETE'].includes(request.method)) throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    const body = await readJson(request);
    if (request.method === 'DELETE') {
      fields(body, ['expected_quantity']);
      json(response, 200, { data: await inventory.remove(actorId, id, quantity(body.expected_quantity)) });
    } else {
      fields(body, ['quantity', 'visibility', 'expected_quantity']);
      const changes = {};
      if ('quantity' in body) { changes.quantity = quantity(body.quantity); quantity(body.expected_quantity); }
      if ('visibility' in body) changes.visibility = visibility(body.visibility);
      if (!Object.keys(changes).length) throw new HttpError(400, 'INVALID_INPUT', 'Provide quantity or visibility.');
      json(response, 200, { data: await inventory.update(actorId, id, changes, body.expected_quantity) });
    }
  };
}
