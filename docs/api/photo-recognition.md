# Photo Recognition and inventory import API

Node endpoints require the existing `ff_session` cookie and same-origin writes. Acting user IDs always come from the authenticated server context. Errors use `{ "error": { "code": "...", "message": "..." } }`.

## POST /api/recognition

Body: raw JPEG or PNG bytes, not JSON or multipart. `Content-Type: image/jpeg` or `image/png`. Maximum 10 MiB; Python additionally validates actual decoded format and a 20-megapixel limit. EXIF orientation is applied before inference and coordinates refer to that oriented image. No files are persisted.

Success example (illustrative JSON contract, not an accuracy test result):

```json
{
  "data": {
    "model": "ingredients-worldv2-l.pt",
    "source": "model",
    "image": { "width": 1024, "height": 768 },
    "detections": [
      { "name": "apple", "confidence": 0.8, "box": [10, 20, 200, 220] }
    ]
  }
}
```

`box` is `[x_min, y_min, x_max, y_max]` in image pixels. `detections: []` is a successful result, not an error. Inference uses 640px input, threshold 0.45, class-agnostic NMS with IoU threshold 0.5, at most 50 boxes. Boxes are model proposals; they may overlap or misclassify.

Errors: 400 empty/corrupt/mismatched image, 401 unauthenticated, 403 cross-origin, 413 too large, 415 unsupported media type, 502 invalid upstream response, 503 unavailable/busy/failed model or 90-second proxy timeout.

Python exposes `POST /recognize` with the same payload and response and `GET /health` returning 200 ready or 503 unavailable. It binds to loopback and is intended to be called by Node, not exposed publicly. It has no separate user database or CORS configuration. Start one worker; concurrent work is rejected with `RECOGNITION_BUSY`.

## GET /api/recognition/ingredients

Returns `{ "data": [{ "_id": "uuid", "name": "milk", "default_unit": "ml", "category": "dairy", "recognition_candidate": true }] }`, sorted by name. This is the existing shared ingredient dictionary (206 seeded entries). The shared vocabulary marks 204 entries as recognition candidates; this flag does not guarantee detection accuracy or model readiness. Python translates each text prompt into its canonical inventory name before returning detections, e.g. `milk carton` → `milk`, `raw beef steak` → `beef`. Existing clients may ignore the additive metadata fields.

## POST /api/inventory/imports

```json
{
  "batch_id": "00000000-0000-4000-8000-000000000001",
  "items": [
    { "ingredient_id": "00000000-0000-4000-8000-000000000002", "quantity": 200 }
  ]
}
```

IDs above are placeholders. Use IDs from the dictionary and a new `crypto.randomUUID()` per confirmation batch. Quantities are positive safe integers in **hundredths of the canonical default unit**. 1–50 input rows; duplicate ingredient IDs are merged and sorted before hashing. Unknown dictionary IDs reject the entire batch. Arbitrary names, units, user IDs and visibility fields are rejected.

Returns `{ "data": { "batch_id": "...", "added": 1, "replayed": false } }`. `added` counts distinct ingredient types, not physical objects. An identical retry returns `replayed: true` without additional inventory change. Reusing the same batch ID with changed contents returns 409 `BATCH_CONFLICT`.

The import receipt and all stock increments commit atomically. Existing stock rows retain UUID, created_at and visibility. New rows are private. Errors never intentionally leave a partially applied batch. Network timeouts may occur after a successful commit; retry the **same batch and payload**.

Receipt schema addition: `inventory_imports { _id, user_id, batch_id, fingerprint, created_at }`, unique `(user_id, batch_id)`. No image or detections are stored. This is submission deduplication, not image deduplication or total-stock synchronization.

## GET /api/inventory

Returns `{ "data": [inventoryItem] }` for the signed-in user only, sorted by ingredient name. Each item has the existing inventory fields and joined `ingredient` dictionary document. The prototype reads all of this user's items; pagination remains future work. Manual add/edit/delete and visibility routes are documented in [the inventory API](inventory.md).
