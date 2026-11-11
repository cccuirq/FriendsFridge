import { HttpError, fields, json, readJson, uuid } from '../../utils/http.js';
import { inventoryRepository } from '../inventory/repository.js';
import { recognitionIngredients } from '../../../shared/recognition-ingredients.js';

const maxBytes = 10 * 1024 * 1024;

async function recognize(request) {
  const type = request.headers['content-type']?.split(';')[0].trim();
  if (!['image/jpeg', 'image/png'].includes(type)) throw new HttpError(415, 'INVALID_IMAGE_TYPE', 'Choose a JPG or PNG image.');
  if (Number(request.headers['content-length']) > maxBytes) throw new HttpError(413, 'IMAGE_TOO_LARGE', 'Image must be 10 MB or smaller.');
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, 'IMAGE_TOO_LARGE', 'Image must be 10 MB or smaller.');
    chunks.push(chunk);
  }
  if (!size) throw new HttpError(400, 'EMPTY_IMAGE', 'Choose a non-empty image.');
  let response;
  try {
    response = await fetch(new URL('/recognize', process.env.RECOGNITION_URL || 'http://127.0.0.1:8001'), {
      method: 'POST', headers: { 'Content-Type': type }, body: Buffer.concat(chunks), signal: AbortSignal.timeout(90000),
    });
  } catch (error) {
    throw new HttpError(503, 'RECOGNITION_UNAVAILABLE', error.name === 'TimeoutError'
      ? 'Recognition timed out. Try a smaller image or add ingredients manually.'
      : 'Recognition service is unavailable. Start the Python service or add ingredients manually.');
  }
  let result;
  try { result = await response.json(); }
  catch { throw new HttpError(502, 'INVALID_RECOGNITION_RESPONSE', 'Recognition service returned an invalid response.'); }
  if (!response.ok) throw new HttpError([400, 413, 415, 503].includes(response.status) ? response.status : 502,
    result.error?.code || 'RECOGNITION_FAILED', result.error?.message || 'Recognition failed. Please try again.');
  if (result.data?.source !== 'model' || !Array.isArray(result.data.detections)) throw new HttpError(502, 'INVALID_RECOGNITION_RESPONSE', 'Recognition service returned an invalid response.');
  return result.data;
}

function batchInput(body) {
  fields(body, ['batch_id', 'items']);
  const batchId = uuid(body.batch_id);
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 50) throw new HttpError(400, 'INVALID_INPUT', 'Confirm between 1 and 50 ingredients.');
  const merged = new Map();
  for (const item of body.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new HttpError(400, 'INVALID_INPUT', 'Invalid ingredient.');
    fields(item, ['ingredient_id', 'quantity']);
    const id = uuid(item.ingredient_id);
    const quantity = (merged.get(id) || 0) + item.quantity;
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || !Number.isSafeInteger(quantity)) throw new HttpError(400, 'INVALID_QUANTITY', 'Enter a positive quantity with up to two decimal places.');
    merged.set(id, quantity);
  }
  return { batchId, items: [...merged].sort(([a], [b]) => a.localeCompare(b)).map(([ingredient_id, quantity]) => ({ ingredient_id, quantity })) };
}

export function recognitionRoutes(client, db) {
  const inventory = inventoryRepository(client, db);
  return async (request, response, path, actorId) => {
    if (path === '/api/recognition' && request.method === 'POST') {
      json(response, 200, { data: await recognize(request) });
    } else if (path === '/api/recognition/ingredients' && request.method === 'GET') {
      const candidates = new Set(recognitionIngredients.map((item) => item.name));
      const items = await db.collection('ingredients').find({}, { projection: { _id: 1, name: 1, default_unit: 1, category: 1 } }).sort({ name: 1 }).toArray();
      json(response, 200, { data: items.map((item) => ({ ...item, recognition_candidate: candidates.has(item.name) })) });
    } else if (path === '/api/inventory' && request.method === 'GET') {
      json(response, 200, { data: await inventory.list(actorId) });
    } else if (path === '/api/inventory/imports' && request.method === 'POST') {
      const { batchId, items } = batchInput(await readJson(request));
      json(response, 200, { data: await inventory.addBatch(actorId, batchId, items) });
    } else throw new HttpError(404, 'NOT_FOUND', 'Endpoint not found.');
  };
}
