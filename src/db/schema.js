const id = { bsonType: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' };
const text = (maxLength) => ({ bsonType: 'string', minLength: 1, ...(maxLength ? { maxLength } : {}) });
const date = { bsonType: 'date' };
const states = (...values) => ({ enum: values });
// Quantities are integer hundredths of the ingredient's default unit.
// This avoids floating-point rounding when stock is deducted.
const quantity = (minimum) => ({ bsonType: ['int', 'long', 'double'], minimum, maximum: Number.MAX_SAFE_INTEGER, multipleOf: 1 });
const unique = (key) => ({ key, unique: true });
const index = (key) => ({ key });

function collection(properties, indexes = [], expressions = [], optional = {}) {
  const schema = { $jsonSchema: {
    bsonType: 'object', additionalProperties: false,
    required: ['_id', 'created_at', ...Object.keys(properties)],
    properties: { _id: id, created_at: date, ...properties, ...optional },
  } };
  return { validator: expressions.length ? { $and: [schema, ...expressions.map(($expr) => ({ $expr }))] } : schema, indexes };
}

export const collections = {
  // Stores confirmation IDs only, never photos; keeps retries safe across restarts.
  inventory_imports: collection({ user_id: id, batch_id: id, fingerprint: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' } }, [unique({ user_id: 1, batch_id: 1 })]),
  users: collection({ username: text(50), email: text(255), password_hash: text(), display_name: text(100) }, [unique({ username: 1 }), unique({ email: 1 })]),
  sessions: collection({ user_id: id, token_hash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' }, expires_at: date }, [unique({ token_hash: 1 }), index({ user_id: 1 }), { key: { expires_at: 1 }, expireAfterSeconds: 0 }]),
  ingredients: collection({ name: text(100), category: text(50), default_unit: text(20), fresh_interval: { anyOf: [quantity(1), { bsonType: 'null' }] } }, [unique({ name: 1 })]),
  inventory_items: collection({ user_id: id, ingredient_id: id, quantity: quantity(0), visibility: states('private', 'friends'), updated_at: date }, [unique({ user_id: 1, ingredient_id: 1 }), index({ user_id: 1, visibility: 1 })]),
  recipes: collection({ author_id: { anyOf: [id, { bsonType: 'null' }] }, title: text(200), description: { bsonType: 'string' }, instructions: text(), servings: { ...quantity(1), maximum: 10000 }, visibility: states('private', 'friends', 'public'), updated_at: date }, [index({ author_id: 1 }), index({ visibility: 1 })]),
  recipe_ingredients: collection({ recipe_id: id, ingredient_id: id, quantity: quantity(1) }, [unique({ recipe_id: 1, ingredient_id: 1 }), index({ ingredient_id: 1 })]),
  saved_recipes: collection({ user_id: id, recipe_id: id }, [unique({ user_id: 1, recipe_id: 1 }), index({ recipe_id: 1 })]),
  friendships: collection({ user_low_id: id, user_high_id: id, requested_by: id, status: states('pending', 'accepted', 'declined', 'removed'), updated_at: date }, [unique({ user_low_id: 1, user_high_id: 1 }), index({ user_high_id: 1, status: 1 })], [
    { $lt: ['$user_low_id', '$user_high_id'] },
    { $in: ['$requested_by', ['$user_low_id', '$user_high_id']] },
  ], { low_received: quantity(0), low_read: quantity(0), high_received: quantity(0), high_read: quantity(0) }),
  friend_messages: collection({ sender_id: id, recipient_id: id, text: text(1000) }, [index({ sender_id: 1, recipient_id: 1, created_at: -1 }), index({ recipient_id: 1, sender_id: 1, created_at: -1 })], [{ $ne: ['$sender_id', '$recipient_id'] }]),
  ingredient_requests: collection({ requester_id: id, owner_id: id, ingredient_id: id, quantity: quantity(1), message: { bsonType: 'string' }, status: states('pending', 'accepted', 'completed', 'declined', 'cancelled'), updated_at: date }, [index({ owner_id: 1, status: 1 }), index({ requester_id: 1, status: 1 })], [{ $ne: ['$requester_id', '$owner_id'] }]),
  recipe_shares: collection({ recipe_id: id, sender_id: id, recipient_id: id, message: { bsonType: 'string' } }, [unique({ recipe_id: 1, recipient_id: 1 }), index({ recipient_id: 1, created_at: -1 })], [{ $ne: ['$sender_id', '$recipient_id'] }]),
};

export async function initializeDatabase(db) {
  for (const [name, { validator, indexes }] of Object.entries(collections)) {
    try {
      await db.createCollection(name, { validator, validationLevel: 'strict', validationAction: 'error' });
    } catch (error) {
      if (error.code !== 48) throw error; // NamespaceExists
      await db.command({ collMod: name, validator, validationLevel: 'strict', validationAction: 'error' });
    }
    // Preserve existing ingredients; unknown freshness is represented by null.
    if (name === 'ingredients') {
      await db.collection(name).updateMany({ fresh_interval: { $exists: false } }, { $set: { fresh_interval: null } });
    }
    if (indexes.length) await db.collection(name).createIndexes(indexes);
  }
}
