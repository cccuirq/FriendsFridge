import catalogue from './data/catalog.json'
import sampleRecipes from './data/recipes.json'
import recognition from './data/recognition.json'

export class DomainError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message) }
}
export interface Profile { _id: string; auth_id: string; username: string; email: string; display_name: string; created_at: string; vision_day?: string; vision_count?: number }
export interface Ingredient { _id: string; name: string; category: string; default_unit: string; fresh_interval: number | null }
interface Stock { _id: string; user_id: string; ingredient_id: string; quantity: number; visibility: string; created_at: string; updated_at: string }
interface Friendship { _id: string; user_low_id: string; user_high_id: string; requested_by: string; status: string; created_at: string; updated_at: string; counters: Record<string, { received: number; read: number }> }
interface Recipe { _id: string; author_id: string | null; title: string; description: string; instructions: string; servings: number; visibility: string; items: { ingredient_id: string; quantity: number }[]; image_key?: string; created_at: string; updated_at: string }
interface Message { _id: string; sender_id: string; recipient_id: string; text: string; created_at: string }
interface Borrow { client_request_id?:string; _id: string; requester_id: string; owner_id: string; ingredient_id: string; quantity: number; message: string; status: string; created_at: string; updated_at: string }
interface Share { _id: string; recipe_id: string; sender_id: string; recipient_id: string; recipe_title: string; status: string; message: string; created_at: string; updated_at: string }
export interface State { version: number; profiles: Profile[]; ingredients: Ingredient[]; stock: Stock[]; friends: Friendship[]; recipes: Recipe[]; messages: Message[]; requests: Borrow[]; shares: Share[]; saves: { user_id: string; recipe_id: string }[]; batches: { user_id: string; batch_id: string; fingerprint: string }[] }
export interface Result { data: unknown; status?: number; notify?: string[]; event?: string; imageKey?: string; deleteImages?: string[] }
export type Body = Record<string, unknown>
export const uid = () => crypto.randomUUID()
const now = () => new Date().toISOString()
export const fail = (status: number, code: string, message: string): never => { throw new DomainError(status, code, message) }
export function text(v: unknown, name: string, min = 1, max = 100) { if (typeof v !== 'string' || v.trim().length < min || v.trim().length > max) return fail(400, 'INVALID_INPUT', `${name} must be ${min}-${max} characters.`); return v.trim() }
export function quantity(v: unknown, min = 0): number { if (!Number.isSafeInteger(v) || (v as number) < min) return fail(400, 'INVALID_QUANTITY', 'Enter a valid quantity in integer hundredths.'); return v as number }
export function id(v: unknown) { const value = text(v, 'ID', 36, 36); if (!/^[a-f0-9-]{36}$/.test(value)) fail(400, 'INVALID_ID', 'Invalid ID.'); return value }
export function fields(body: Body, allowed: string[]) { if (Object.keys(body).some(k => !allowed.includes(k))) fail(400, 'INVALID_INPUT', 'Unexpected field.') }
const publicProfile = (p: Profile) => ({ _id: p._id, username: p.username, display_name: p.display_name })
const ownProfile = (p: Profile) => ({ ...publicProfile(p), email: p.email, created_at: p.created_at })
const byTime = (a: { created_at: string; _id: string }, b: { created_at: string; _id: string }) => b.created_at.localeCompare(a.created_at) || b._id.localeCompare(a._id)

export function initialState(): State {
  const ingredients = catalogue.ingredients.map((r, i) => ({ _id: `f2000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, name: r.name, category: r.category, default_unit: r.default_unit, fresh_interval: null }))
  const recipes: Recipe[] = sampleRecipes.map(r => ({ _id: r.id, author_id: null, title: r.title, description: r.description, instructions: r.instructions, servings: r.servings, visibility: 'public', created_at: now(), updated_at: now(), items: r.items.map(([name, , amount]) => ({ ingredient_id: ingredients.find(i => i.name === name)!._id, quantity: Number(amount) })) }))
  return { version: 1, profiles: [], ingredients, stock: [], friends: [], recipes, messages: [], requests: [], shares: [], saves: [], batches: [] }
}

/** Synchronous business commands: called inside one Durable Object SQL transaction. */
export function command(s: State, subject: string, method: string, url: URL, body: Body = {}, imageKey?: string): Result {
  const path = url.pathname
  const offsetValue = url.searchParams.get('offset') || '0'
  if (!/^\d{1,6}$/.test(offsetValue)) fail(400, 'INVALID_INPUT', 'Invalid offset.')
  const offset = Number(offsetValue)
  const page = <T,>(rows: T[]) => rows.slice(offset, offset + 20)
  let actor = s.profiles.find(p => p.auth_id === subject)
  if (path === '/api/users/me' && method === 'POST') {
    fields(body, ['username', 'display_name', 'email'])
    if (actor) return { data: ownProfile(actor) }
    const username = text(body.username, 'Username', 3, 50).toLowerCase()
    if (!/^[a-z0-9_]+$/.test(username)) fail(400, 'INVALID_INPUT', 'Use letters, numbers and underscores.')
    const email = text(body.email, 'Email', 3, 255).toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'INVALID_INPUT', 'Invalid email.')
    if (s.profiles.some(p => p.username === username || p.email === email)) fail(409, 'ALREADY_EXISTS', 'Username or contact email already in use.')
    actor = { _id: uid(), auth_id: subject, username, email, display_name: text(body.display_name, 'Display name', 1, 100), created_at: now() }
    s.profiles.push(actor); return { data: ownProfile(actor), status: 201 }
  }
  if (!actor) return fail(404, 'PROFILE_REQUIRED', 'Choose your application username first.')
  if (path === '/api/_vision/quota' && method === 'POST') {
    const day = now().slice(0,10)
    if (actor.vision_day !== day) { actor.vision_day = day; actor.vision_count = 0 }
    if ((actor.vision_count || 0) >= 10 || s.profiles.filter(p=>p.vision_day===day).reduce((total,p)=>total+(p.vision_count||0),0)>=50) fail(429,'VISION_LIMIT','Daily cloud recognition limit reached. Add ingredients manually or try tomorrow.')
    actor.vision_count = (actor.vision_count || 0) + 1
    return { data: { allowed: true } }
  }
  const me = actor._id
  const person = (peer: string) => s.profiles.find(p => p._id === peer)
  const pair = (peer: string) => s.friends.find(f => [f.user_low_id, f.user_high_id].includes(me) && [f.user_low_id, f.user_high_id].includes(peer) && me !== peer)
  const relation = (a: string, b: string) => s.friends.find(f => [f.user_low_id, f.user_high_id].includes(a) && [f.user_low_id, f.user_high_id].includes(b) && a !== b)
  const isFriend = (peer: string) => pair(peer)?.status === 'accepted'
  const requireFriend = (peer: string) => { if (!isFriend(peer)) fail(404, 'FRIEND_NOT_FOUND', 'An accepted friendship is required.') }
  const food = (ingredientId: string) => s.ingredients.find(i => i._id === ingredientId)
  const stock = (userId: string, ingredientId: string) => s.stock.find(i => i.user_id === userId && i.ingredient_id === ingredientId)
  const delivered = (from: string, to: string) => { const f = relation(from, to); if (f?.status === 'accepted') { f.counters[to] ||= { received: 0, read: 0 }; f.counters[to].received++ } }
  const canView = (r: Recipe | undefined) => Boolean(r && (r.author_id === me || r.visibility === 'public' || (r.author_id && isFriend(r.author_id) && (r.visibility === 'friends' || s.shares.some(a => a.recipe_id === r._id && a.sender_id === r.author_id && a.recipient_id === me && a.status === 'accepted')))))
  const safeFriend = (f: Friendship) => ({ _id: f._id, user_low_id: f.user_low_id, user_high_id: f.user_high_id, requested_by: f.requested_by, status: f.status, created_at: f.created_at, updated_at: f.updated_at })
  const vis = (v: unknown) => { if (v !== 'private' && v !== 'friends') fail(400, 'INVALID_VISIBILITY', 'Choose Only me or Friends.'); return v as string }

  if (path === '/api/users/me/export' && method === 'GET') {
    return { data: {
      export_version: 1, exported_at: now(), user: ownProfile(actor),
      ingredients: s.ingredients,
      inventory: s.stock.filter(row => row.user_id === me),
      recipes: s.recipes.filter(r => r.author_id === me).map(({image_key, ...recipe}) => ({
        ...recipe, ...(image_key ? {image_url: `/api/recipes/${recipe._id}/image`} : {}),
      })),
      saved_recipes: s.saves.filter(row => row.user_id === me && canView(s.recipes.find(r => r._id === row.recipe_id))),
      friendships: s.friends.filter(f => [f.user_low_id, f.user_high_id].includes(me)).map(f => ({
        ...safeFriend(f), user: publicProfile(person(f.user_low_id === me ? f.user_high_id : f.user_low_id)!),
      })),
      messages: s.messages.filter(row => row.sender_id === me || row.recipient_id === me),
      ingredient_requests: s.requests.filter(row => row.owner_id === me || row.requester_id === me),
      recipe_shares: s.shares.filter(row => row.sender_id === me || row.recipient_id === me),
    } }
  }

  if (path === '/api/users/me') {
    if (method === 'GET') return { data: ownProfile(actor) }
    if (method === 'PATCH') {
      fields(body, ['display_name', 'email']); if (!Object.keys(body).length) fail(400, 'INVALID_INPUT', 'Provide a display name or email.')
      const displayName = 'display_name' in body ? text(body.display_name, 'Display name', 1, 100) : actor.display_name
      const email = 'email' in body ? text(body.email, 'Email', 3, 255).toLowerCase() : actor.email
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'INVALID_INPUT', 'Invalid email.')
      if (s.profiles.some(p => p._id !== me && p.email === email)) fail(409, 'ALREADY_EXISTS', 'Contact email already in use.')
      actor.display_name = displayName; actor.email = email; return { data: ownProfile(actor) }
    }
  }
  if (path === '/api/users' && method === 'GET') {
    const q = text(url.searchParams.get('q'), 'Search', 2, 50).toLowerCase()
    return { data: page(s.profiles.filter(p => p._id !== me && p.username.startsWith(q) && !(url.searchParams.get('invitable') === '1' && ['pending', 'accepted'].includes(pair(p._id)?.status || ''))).sort((a, b) => a.username.localeCompare(b.username))).map(publicProfile) }
  }
  if ((path === '/api/ingredients' || path === '/api/recognition/ingredients') && method === 'GET') return { data: [...s.ingredients].sort((a,b) => a.name.localeCompare(b.name)).map(i => ({ ...i, ...(path.includes('recognition') ? { recognition_candidate: recognition.some(r => r.name === i.name) } : {}) })) }
  if (path === '/api/inventory' && method === 'GET') return { data: s.stock.filter(i => i.user_id === me).map(i => ({ ...i, ingredient: food(i.ingredient_id) })).sort((a,b) => a.ingredient!.name.localeCompare(b.ingredient!.name)) }
  if ((path === '/api/inventory' || path === '/api/inventory/imports') && method === 'POST') {
    const manual = path === '/api/inventory'
    fields(body, manual ? ['batch_id', 'ingredient_id', 'quantity', 'visibility'] : ['batch_id', 'items'])
    const batch = id(body.batch_id), visibility = manual ? vis(body.visibility || 'private') : 'private'
    const rows = manual ? [{ ingredient_id: body.ingredient_id, quantity: body.quantity }] : body.items
    if (!Array.isArray(rows) || !rows.length || rows.length > 50) fail(400, 'INVALID_INPUT', 'Confirm between 1 and 50 ingredients.')
    const merged = new Map<string, number>()
    for (const raw of rows as unknown[]) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(400, 'INVALID_INPUT', 'Invalid ingredient.')
      const item = raw as Body; fields(item, ['ingredient_id', 'quantity']); const ingredientId = id(item.ingredient_id)
      if (!food(ingredientId)) fail(400, 'INVALID_INGREDIENT', 'Choose a listed ingredient.')
      merged.set(ingredientId, quantity((merged.get(ingredientId) || 0) + quantity(item.quantity, 1), 1))
    }
    const normalized = [...merged].sort(([a],[b]) => a.localeCompare(b))
    const fingerprint = JSON.stringify([normalized, manual ? visibility : null])
    const receipt = s.batches.find(b => b.user_id === me && b.batch_id === batch)
    if (receipt) { if (receipt.fingerprint !== fingerprint) fail(409, 'BATCH_CONFLICT', 'This confirmation was already used with different contents.'); return { data: { batch_id: batch, added: merged.size, replayed: true } } }
    for (const [ingredientId, amount] of normalized) quantity((stock(me, ingredientId)?.quantity || 0) + amount)
    for (const [ingredientId, amount] of normalized) {
      const current = stock(me, ingredientId)
      if (current) { current.quantity += amount; current.updated_at = now() }
      else s.stock.push({ _id: uid(), user_id: me, ingredient_id: ingredientId, quantity: amount, visibility, created_at: now(), updated_at: now() })
    }
    s.batches.push({ user_id: me, batch_id: batch, fingerprint })
    return { data: { batch_id: batch, added: merged.size, replayed: false }, notify: [me] }
  }
  let match = /^\/api\/inventory\/([^/]+)$/.exec(path)
  if (match && ['PATCH','DELETE'].includes(method)) {
    const item = s.stock.find(i => i._id === id(match![1]) && i.user_id === me)
    if (!item) return fail(404, 'ITEM_NOT_FOUND', 'Food is no longer in your fridge.')
    fields(body, method === 'DELETE' ? ['expected_quantity'] : ['quantity', 'expected_quantity', 'visibility'])
    if (method === 'DELETE' || 'quantity' in body) {
      if (quantity(body.expected_quantity) !== item.quantity) fail(409, 'STOCK_CHANGED', 'Stock changed. Reload before editing.')
    }
    if (method === 'DELETE') { s.stock = s.stock.filter(i => i._id !== item._id); return { data: { deleted: true }, notify: [me] } }
    if (!('quantity' in body) && !('visibility' in body)) fail(400, 'INVALID_INPUT', 'Provide quantity or visibility.')
    const amount = 'quantity' in body ? quantity(body.quantity) : item.quantity
    const visibility = 'visibility' in body ? vis(body.visibility) : item.visibility
    item.quantity = amount; item.visibility = visibility; item.updated_at = now(); return { data: item, notify: [me] }
  }
  if (path === '/api/friends/requests') {
    if (method === 'GET') {
      const direction = url.searchParams.get('direction') || 'incoming'
      if (!['incoming','outgoing'].includes(direction)) fail(400, 'INVALID_INPUT', 'Invalid direction.')
      return { data: page(s.friends.filter(f => f.status === 'pending' && [f.user_low_id,f.user_high_id].includes(me) && (direction === 'outgoing' ? f.requested_by === me : f.requested_by !== me)).sort(byTime)).map(f => ({ ...safeFriend(f), user: publicProfile(person(f.user_low_id === me ? f.user_high_id : f.user_low_id)!) })) }
    }
    if (method === 'POST') {
      fields(body, ['user_id']); const peer = id(body.user_id)
      if (peer === me) fail(400, 'SELF_REQUEST', 'You cannot add yourself.')
      if (!person(peer)) fail(404, 'USER_NOT_FOUND', 'User not found.')
      let f = pair(peer)
      if (f && ['pending','accepted'].includes(f.status)) fail(409, 'RELATIONSHIP_CONFLICT', 'A friendship or invitation already exists.')
      if (f) { f.status = 'pending'; f.requested_by = me; f.updated_at = now() }
      else { const [low, high] = [me,peer].sort(); f = { _id: uid(), user_low_id: low, user_high_id: high, requested_by: me, status: 'pending', created_at: now(), updated_at: now(), counters: {} }; s.friends.push(f) }
      return { data: safeFriend(f), status: 201, notify: [me, peer], event: 'friendships' }
    }
  }
  match = /^\/api\/friends\/requests\/([^/]+)$/.exec(path)
  if (match && method === 'PATCH') {
    fields(body, ['status']); if (!['accepted','declined'].includes(String(body.status))) fail(400, 'INVALID_INPUT', 'Choose accept or decline.')
    const f = s.friends.find(f => f._id === id(match![1]) && f.status === 'pending' && f.requested_by !== me && [f.user_low_id,f.user_high_id].includes(me))
    if (!f) return fail(404, 'REQUEST_NOT_FOUND', 'Incoming pending invitation not found.')
    f.status = String(body.status); f.updated_at = now(); return { data: safeFriend(f), notify: [f.user_low_id,f.user_high_id], event: 'friendships' }
  }
  if (path === '/api/friends' && method === 'GET') return { data: page(s.friends.filter(f => f.status === 'accepted' && [f.user_low_id,f.user_high_id].includes(me)).sort(byTime)).map(f => ({ ...safeFriend(f), user: publicProfile(person(f.user_low_id === me ? f.user_high_id : f.user_low_id)!) })) }
  match = /^\/api\/friends\/([^/]+)$/.exec(path)
  if (match && method === 'DELETE') { const peer = id(match[1]); requireFriend(peer); const f = pair(peer)!; f.status = 'removed'; f.updated_at = now(); return { data: safeFriend(f), notify: [me,peer], event: 'friendships' } }

  function timeline(peer?: string) {
    const includes = (a: string, b: string) => (a === me || b === me) && (!peer || a === peer || b === peer)
    const messages = s.messages.filter(m => includes(m.sender_id, m.recipient_id)).map(m => ({ ...m, kind: 'message' }))
    const requests = s.requests.filter(r => includes(r.requester_id, r.owner_id)).map(r => ({ ...r, sender_id: r.requester_id, recipient_id: r.owner_id, text: r.message, kind: 'request', ingredient: food(r.ingredient_id) }))
    const shares = s.shares.filter(r => includes(r.sender_id,r.recipient_id)).map(r => ({ ...r, kind: 'recipe_share', recipe_title: s.recipes.find(p => p._id === r.recipe_id)?.title || r.recipe_title, recipe_available: s.recipes.some(p => p._id === r.recipe_id) }))
    return [...messages, ...requests, ...shares].sort(byTime)
  }
  if (path === '/api/friends/conversations/unread' && method === 'GET') return { data: s.friends.filter(f => [f.user_low_id,f.user_high_id].includes(me) && (f.counters[me]?.received || 0) > (f.counters[me]?.read || 0)).map(f => f.user_low_id === me ? f.user_high_id : f.user_low_id) }
  if ((path === '/api/friends/directory' || path === '/api/friends/conversations') && method === 'GET') {
    const recent = timeline(); const peers = new Set(recent.map(r => r.sender_id === me ? r.recipient_id : r.sender_id))
    if (path.endsWith('/directory')) for (const f of s.friends) if (f.status === 'accepted' && [f.user_low_id,f.user_high_id].includes(me)) peers.add(f.user_low_id === me ? f.user_high_id : f.user_low_id)
    const query = text(url.searchParams.get('q') || '', 'Search', 0, 100).toLowerCase()
    const rows = [...peers].map(peer => ({ _id: peer, peer: person(peer) ? publicProfile(person(peer)!) : null, latest: recent.find(r => r.sender_id === peer || r.recipient_id === peer), active: isFriend(peer), unread: (pair(peer)?.counters[me]?.received || 0) > (pair(peer)?.counters[me]?.read || 0), updated_at: pair(peer)?.updated_at || '' })).filter(r => !query || (r.active && [r.peer?.username,r.peer?.display_name].some(n => n?.toLowerCase().includes(query)))).sort((a,b) => Number(b.unread) - Number(a.unread) || (b.latest?.created_at || b.updated_at).localeCompare(a.latest?.created_at || a.updated_at))
    const count = url.searchParams.get('count') || '20'; if (!/^[1-9]\d{0,5}$/.test(count)) fail(400, 'INVALID_INPUT', 'Invalid directory size.')
    return { data: path.endsWith('/directory') ? rows.slice(0, Math.min(Number(count),1000) + 1) : page(rows) }
  }
  match = /^\/api\/friends\/([^/]+)\/conversation(\/read)?$/.exec(path)
  if (match) {
    const peer = id(match[1]); const f = pair(peer)
    if (match[2] && method === 'POST') { fields(body,['through']); const through = quantity(body.through,1); if (!f || (f.counters[me]?.received || 0) < through) fail(404,'DELIVERY_NOT_FOUND','No matching delivery.'); f!.counters[me].read = Math.max(f!.counters[me].read,through); return { data: { through }, notify: [me] } }
    if (!match[2] && method === 'POST') {
      requireFriend(peer); fields(body,['message_id','text']); const messageId = id(body.message_id), value = text(body.text,'Message',1,1000)
      const existing = s.messages.find(m => m._id === messageId)
      if (existing) { if (existing.sender_id !== me || existing.recipient_id !== peer || existing.text !== value) fail(409,'MESSAGE_CONFLICT','Message ID already used.'); return { data: existing, status: 201 } }
      const m = { _id: messageId, sender_id: me, recipient_id: peer, text: value, created_at: now() }; s.messages.push(m); delivered(me,peer); return { data: m, status: 201, notify: [me,peer] }
    }
    if (!match[2] && method === 'GET') {
      let rows = timeline(peer); if (!person(peer) || (!isFriend(peer) && !rows.length)) fail(404,'CONVERSATION_NOT_FOUND','Conversation not found.')
      const before = url.searchParams.get('before')
      if (before) { const cursor = /^(\d{1,15}):([a-f0-9-]{36})$/.exec(before); if (!cursor) fail(400,'INVALID_INPUT','Invalid message cursor.'); rows = rows.filter(r => new Date(r.created_at).getTime() < Number(cursor![1]) || (new Date(r.created_at).getTime() === Number(cursor![1]) && r._id < cursor![2])) }
      const items = rows.slice(0,20), last = items.at(-1)
      return { data: { peer: publicProfile(person(peer)!), can_message: isFriend(peer), items, received: f?.counters[me]?.received || 0, read: f?.counters[me]?.read || 0, next_before: rows.length > 20 && last ? new Date(last.created_at).getTime() + ':' + last._id : null } }
    }
  }
  match = /^\/api\/friends\/([^/]+)\/fridge$/.exec(path)
  if (match && method === 'GET') { const peer = id(match[1]); requireFriend(peer); return { data: { friend: publicProfile(person(peer)!), items: page(s.stock.filter(i => i.user_id === peer && i.visibility === 'friends' && i.quantity > 0).map(i => ({ quantity: i.quantity, ingredient: food(i.ingredient_id) })).sort((a,b) => a.ingredient!.name.localeCompare(b.ingredient!.name))) } } }
  if (path === '/api/friends/ingredient-requests') {
    if (method === 'GET') return { data: page(s.requests.filter(r => r.owner_id === me || r.requester_id === me).sort(byTime)).map(r => ({ ...r, ingredient: food(r.ingredient_id), person: publicProfile(person(r.owner_id === me ? r.requester_id : r.owner_id)!) })) }
    if (method === 'POST') {
      fields(body,['owner_id','ingredient_id','quantity','message','request_id']); const peer = id(body.owner_id), ingredientId = id(body.ingredient_id), amount = quantity(body.quantity,1); requireFriend(peer)
      const clientId=body.request_id===undefined?undefined:id(body.request_id),message=text(body.message || '','Message',0,500)
      if(clientId){const previous=s.requests.find(r=>r.requester_id===me&&r.client_request_id===clientId);if(previous){if(previous.owner_id!==peer||previous.ingredient_id!==ingredientId||previous.quantity!==amount||previous.message!==message)fail(409,'REQUEST_CONFLICT','This request ID was already used for different contents.');return {data:previous,status:201}}}
      const current = stock(peer,ingredientId); if (!current || current.visibility !== 'friends' || current.quantity < amount) fail(409,'INGREDIENT_UNAVAILABLE','This shared ingredient is unavailable in that quantity.')
      const r = { _id: uid(), requester_id: me, owner_id: peer, ingredient_id: ingredientId, quantity: amount, message, ...(clientId?{client_request_id:clientId}:{}), status: 'pending', created_at: now(), updated_at: now() }; s.requests.push(r); delivered(me,peer); return { data: r, status: 201, notify: [me,peer] }
    }
  }
  match = /^\/api\/friends\/ingredient-requests\/([^/]+)$/.exec(path)
  if (match && method === 'PATCH') {
    fields(body,['status']); const r = s.requests.find(r => r._id === id(match![1]) && [r.requester_id,r.owner_id].includes(me)); if (!r) return fail(404,'REQUEST_NOT_FOUND','Request not found.')
    const status = String(body.status), owner = r.owner_id === me
    const allowed = (r.status === 'pending' && owner && ['accepted','declined'].includes(status)) || (['pending','accepted'].includes(r.status) && status === 'cancelled') || (r.status === 'accepted' && owner && status === 'completed')
    if (!allowed) fail(409,'REQUEST_CONFLICT','Forbidden action for this request in its current state.')
    if (status === 'completed') {
      const giver = stock(r.owner_id,r.ingredient_id), receiver = stock(r.requester_id,r.ingredient_id)
      if (!giver || giver.quantity < r.quantity) fail(409,'INSUFFICIENT_STOCK','There is no longer enough stock.')
      quantity((receiver?.quantity || 0) + r.quantity)
      giver!.quantity -= r.quantity; giver!.updated_at = now()
      if (receiver) { receiver.quantity += r.quantity; receiver.updated_at = now() }
      else s.stock.push({ _id: uid(), user_id: r.requester_id, ingredient_id: r.ingredient_id, quantity: r.quantity, visibility: 'private', created_at: now(), updated_at: now() })
    }
    r.status = status; r.updated_at = now(); return { data: r, notify: [r.requester_id,r.owner_id] }
  }

  function recipeInput(): Pick<Recipe,'title'|'description'|'instructions'|'servings'|'items'> {
    fields(body,['title','description','instructions','servings','items','image'])
    const servings = quantity(body.servings,1); if (servings > 10000) fail(400,'INVALID_INPUT','Too many servings.')
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 50) fail(400,'INVALID_INPUT','Choose 1-50 ingredients.')
    const used = new Set<string>()
    const items = (body.items as Body[]).map(row => { if (!row || typeof row !== 'object') return fail(400,'INVALID_INPUT','Invalid ingredient.'); fields(row,['ingredient_id','quantity']); const ingredientId = id(row.ingredient_id); if (used.has(ingredientId) || !food(ingredientId)) fail(400,'INVALID_INGREDIENT','Choose distinct listed ingredients.'); used.add(ingredientId); return { ingredient_id: ingredientId, quantity: quantity(row.quantity,1) } })
    return { title: text(body.title,'Title',1,200), description: text(body.description || '','Description',0,500), instructions: text(body.instructions,'Directions',1,4000), servings, items }
  }
  if (path === '/api/recipes') {
    if (method === 'GET') {
      const rows = s.recipes.filter(canView).map(r => {
        const planned = url.searchParams.get('servings') ? quantity(Number(url.searchParams.get('servings')),1) : r.servings
        if(planned>20 && url.searchParams.has('servings')) fail(400,'INVALID_INPUT','Choose 1-20 servings.')
        const items = r.items.map(i => {
          const ingredient = food(i.ingredient_id)!, available = stock(me,i.ingredient_id)?.quantity || 0
          const required = quantity(Math.ceil(i.quantity * planned / r.servings),1)
          const borrow_sources = s.stock.filter(row=>row.ingredient_id===i.ingredient_id&&row.visibility==='friends'&&row.quantity>0&&isFriend(row.user_id)).map(row=>({user:publicProfile(person(row.user_id)!),quantity:row.quantity}))
          return {ingredient_id:i.ingredient_id,name:ingredient.name,unit:ingredient.default_unit,base_required:i.quantity,required,available,missing:Math.max(0,required-available),borrow_sources,pending_requested:s.requests.filter(r=>r.requester_id===me&&r.ingredient_id===i.ingredient_id&&['pending','accepted'].includes(r.status)).reduce((n,r)=>n+r.quantity,0)}
        })
        const share = s.shares.find(a => a.recipe_id === r._id && a.sender_id === r.author_id && a.recipient_id === me && a.status === 'accepted' && isFriend(a.sender_id))
        return { _id: r._id, title: r.title, description: r.description, instructions: r.instructions, servings: r.servings, planned_servings:planned, can_borrow:items.some(i=>i.missing>0)&&items.every(i=>i.borrow_sources.reduce((sum,row)=>sum+row.quantity,0)>=i.missing), items, missing_count: items.filter(i => i.missing > 0).length, owned: r.author_id === me, saved: s.saves.some(a => a.user_id === me && a.recipe_id === r._id), shared: Boolean(share), ...(share ? { share_id: share._id } : {}), ...(r.image_key ? { image_url: `/api/recipes/${r._id}/image` } : {}) }
      }).sort((a,b) => a.missing_count - b.missing_count || a.missing_count / a.items.length - b.missing_count / b.items.length || a.title.localeCompare(b.title))
      return { data: { recipes: rows, ingredients: s.ingredients, friends: s.profiles.filter(p => isFriend(p._id)).map(publicProfile) } }
    }
    if (method === 'POST') { const data = recipeInput(); const r: Recipe = { _id: uid(), author_id: me, visibility: 'private', created_at: now(), updated_at: now(), ...data, ...(imageKey ? { image_key: imageKey } : {}) }; s.recipes.push(r); return { data: { _id: r._id }, status: 201 } }
  }
  match = /^\/api\/recipes\/shares\/([^/]+)$/.exec(path)
  if (match && method === 'PATCH') {
    fields(body,['status']); const share = s.shares.find(r => r._id === id(match![1]) && [r.sender_id,r.recipient_id].includes(me)); if (!share) return fail(404,'SHARE_NOT_FOUND','Sharing invitation not found.')
    const recipient = share.recipient_id === me, status = String(body.status)
    const allowed = (share.status === 'pending' && (recipient ? ['accepted','declined'].includes(status) : status === 'cancelled')) || (share.status === 'accepted' && recipient && status === 'removed')
    if (!allowed) fail(409,'SHARE_CONFLICT','This sharing action is no longer available.')
    const peer = recipient ? share.sender_id : share.recipient_id
    if (status === 'accepted' && (!isFriend(peer) || !s.recipes.some(r => r._id === share.recipe_id && r.author_id === share.sender_id))) fail(404,'RECIPE_NOT_FOUND','Recipe or friendship no longer available.')
    share.status = status; share.updated_at = now()
    if (status === 'removed') s.saves = s.saves.filter(r => !(r.user_id === me && r.recipe_id === share.recipe_id))
    delivered(me,peer); return { data: share, notify: [me,peer] }
  }
  match = /^\/api\/recipes\/([^/]+)(?:\/(saved|shares|image))?$/.exec(path)
  if (match) {
    const recipeId = id(match[1]), action = match[2], r = s.recipes.find(r => r._id === recipeId)
    if (action === 'image' && method === 'GET') { if (!canView(r) || !r?.image_key) return fail(404,'RECIPE_NOT_FOUND','Recipe image not found.'); return { data: null, imageKey: r.image_key } }
    if (action === 'saved' && ['PUT','DELETE'].includes(method)) {
      if (method === 'PUT' && !canView(r)) fail(404,'RECIPE_NOT_FOUND','Recipe not found.')
      s.saves = s.saves.filter(a => !(a.user_id === me && a.recipe_id === recipeId))
      if (method === 'PUT') s.saves.push({ user_id: me, recipe_id: recipeId })
      return { data: { saved: method === 'PUT' } }
    }
    if (!r || r.author_id !== me) return fail(404,'RECIPE_NOT_FOUND','Recipe not found or not owned.')
    if (!action && method === 'PATCH') {
      const data = recipeInput(); const old = r.image_key; Object.assign(r,data,{updated_at:now()})
      if (imageKey) r.image_key = imageKey
      else if (body.image === null) delete r.image_key
      return { data: { _id: r._id }, deleteImages: old && old !== r.image_key ? [old] : [] }
    }
    if (!action && method === 'DELETE') {
      s.recipes = s.recipes.filter(a => a._id !== r._id); s.saves = s.saves.filter(a => a.recipe_id !== r._id); s.shares = s.shares.filter(a => a.recipe_id !== r._id)
      return { data: { _id: r._id, deleted: true }, deleteImages: r.image_key ? [r.image_key] : [] }
    }
    if (action === 'shares' && method === 'POST') {
      fields(body,['recipient_id']); const peer = id(body.recipient_id); if (peer === me) fail(400,'SELF_SHARE','Choose another friend.'); requireFriend(peer)
      const previous = s.shares.find(a => a.recipe_id === r._id && a.recipient_id === peer && ['pending','accepted'].includes(a.status))
      if (previous) return { data: previous }
      const share: Share = { _id: uid(), recipe_id: r._id, sender_id: me, recipient_id: peer, recipe_title: r.title, status: 'pending', message: '', created_at: now(), updated_at: now() }; s.shares.push(share); delivered(me,peer); return { data: share, notify: [me,peer] }
    }
  }
  return fail(404, 'NOT_FOUND', 'Endpoint not found.')
}
