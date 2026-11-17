export class HttpError extends Error {
  constructor(status, code, message) { super(message); Object.assign(this, { status, code }); }
}

export function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

export async function readJson(request, maxBytes = 16384) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new HttpError(415, 'JSON_REQUIRED', 'Use application/json.');
  let size = 0;
  let tooLarge = false;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) { tooLarge = true; chunks.length = 0; }
    if (!tooLarge) chunks.push(chunk);
  }
  if (tooLarge) throw new HttpError(413, 'BODY_TOO_LARGE', 'Request is too large.');
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString());
    if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error();
    return data;
  } catch { throw new HttpError(400, 'INVALID_JSON', 'Provide a JSON object.'); }
}

export function string(value, name, min, max) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) throw new HttpError(400, 'INVALID_INPUT', `${name} must be ${min}-${max} characters.`);
  return value.trim();
}

export function uuid(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new HttpError(400, 'INVALID_ID', 'Invalid ID.');
  return value;
}

export function fields(data, allowed) {
  if (Object.keys(data).some((key) => !allowed.includes(key))) throw new HttpError(400, 'INVALID_INPUT', 'Unexpected field.');
}
