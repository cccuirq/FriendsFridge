import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../../worker'
import { command, initialState, DomainError, type State, type Body } from './domain'

/** One serialized SQLite-backed room makes stock transfer and request state atomic.
 * No browser can address this room directly: the worker verifies the platform JWT.
 */
export class FridgeRoom extends DurableObject<Env> {
  private streams = new Map<string, Set<WritableStreamDefaultWriter<Uint8Array>>>()
  private encoder = new TextEncoder()
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS fridge_state (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL)')
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS fridge_images (key TEXT PRIMARY KEY, content_type TEXT NOT NULL, body BLOB NOT NULL)')
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS shopping_kv (key TEXT PRIMARY KEY, body TEXT NOT NULL, expires INTEGER NOT NULL)')
  }
  private state(): State {
    const row = [...this.ctx.storage.sql.exec<{ body: string }>('SELECT body FROM fridge_state WHERE id = 1')][0]
    return row ? JSON.parse(row.body) : initialState()
  }
  private emit(ids: string[], event?: string) {
    const bytes = this.encoder.encode(`${event ? 'event: ' + event + '\n' : ''}data: {}\n\n`)
    for (const userId of new Set(ids)) for (const stream of this.streams.get(userId) || []) stream.write(bytes).catch(() => {})
  }
  async fetch(request: Request): Promise<Response> {
    let uploaded: string | undefined
    let imageBytes: ArrayBuffer | undefined
    try {
      if (new URL(request.url).pathname === '/health') {
        this.ctx.storage.sql.exec('SELECT 1').toArray()
        return Response.json({status:'ok',database:'DeepSpace Durable Object SQLite'})
      }
      const subject = request.headers.get('x-fridge-subject')
      if (!subject) return Response.json({ error: { code: 'UNAUTHENTICATED', message: 'Please sign in.' } }, { status: 401 })
      const url = new URL(request.url)
      if(url.pathname==='/api/_market/rpc'&&request.method==='POST') {
        if(!this.state().profiles.some(p=>p.auth_id===subject)) throw new DomainError(404,'PROFILE_REQUIRED','Create your profile first.')
        const input=await request.json() as {op:string;key:string;value?:unknown;ttl?:number;kind?:string}
        const time=Date.now(),key=String(input.key||'').slice(0,180)
        const get=(k:string)=>{const row=this.ctx.storage.sql.exec<{body:string}>('SELECT body FROM shopping_kv WHERE key=? AND expires>?',k,time).toArray()[0];return row?JSON.parse(row.body):null}
        const put=(k:string,value:unknown,ttl=3600000)=>{const body=JSON.stringify(value);if(body.length>200000)throw new DomainError(413,'TOO_LARGE','Shopping response too large.');this.ctx.storage.sql.exec('DELETE FROM shopping_kv WHERE expires<=?',time);this.ctx.storage.sql.exec('INSERT INTO shopping_kv (key,body,expires) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body,expires=excluded.expires',k,body,time+Math.min(ttl,86400000))}
        const value=this.ctx.storage.transactionSync(()=>{
          if(input.op==='get') return get(`cache:${key}`)
          if(input.op==='put'){put(`cache:${key}`,input.value,input.ttl??(key.startsWith('offers:')?900000:3600000));return true}
          if(input.op==='limit') {
            const kind=input.kind==='quote'?'quote':'location',day=new Date().toISOString().slice(0,10)
            const own=`limit:${day}:${kind}:${subject}`,global=`limit:${day}:${kind}:all`,a=Number(get(own)||0),b=Number(get(global)||0)
            if(a>=(kind==='quote'?3:12)||b>=(kind==='quote'?8:40)) throw new DomainError(429,'SHOPPING_LIMIT','Daily shopping lookup limit reached. Try again tomorrow; inventory and borrowing still work.')
            put(own,a+1,86400000);put(global,b+1,86400000);return true
          }
          const own=`job:${subject}:${key}`
          if(input.op==='jobCreate'){if(get(own))return false;put(own,{status:'starting',next_poll:time+5000},3600000);return true}
          if(input.op==='jobUpdate'){if(!get(own))throw new DomainError(404,'QUOTE_EXPIRED','Quote expired.');put(own,input.value,3600000);return true}
          if(input.op==='jobGet'){const job=get(own);if(!job)throw new DomainError(404,'QUOTE_EXPIRED','Quote not found or expired.');const allow_poll=Number(job.next_poll||0)<=time;if(allow_poll){job.next_poll=time+3000;put(own,job,3600000)}return {...job,allow_poll}}
          throw new DomainError(400,'INVALID_INPUT','Unknown shopping operation.')
        })
        return Response.json({data:value},{headers:{'Cache-Control':'no-store'}})
      }
      if (url.pathname === '/api/friends/conversations/events') {
        const profile = this.state().profiles.find(p => p.auth_id === subject)
        if (!profile) throw new DomainError(404, 'PROFILE_REQUIRED', 'Choose your username first.')
        const stream = new TransformStream<Uint8Array, Uint8Array>(), writer = stream.writable.getWriter()
        const clients = this.streams.get(profile._id) || new Set(); clients.add(writer); this.streams.set(profile._id, clients)
        const heartbeat = setInterval(() => { writer.write(this.encoder.encode(': heartbeat\n\n')).catch(close) }, 20000)
        const self = this
        function close() { clearInterval(heartbeat); clearTimeout(timer); clients.delete(writer); if (!clients.size) self.streams.delete(profile!._id); writer.close().catch(() => {}) }
        const timer = setTimeout(close, 60000)
        request.signal.addEventListener('abort', close, { once: true })
        writer.closed.catch(() => {}).finally(() => { clearInterval(heartbeat); clearTimeout(timer); clients.delete(writer) })
        void writer.write(this.encoder.encode(': connected\n\n'))
        return new Response(stream.readable, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' } })
      }
      let body: Body = {}
      if (!['GET','HEAD'].includes(request.method)) {
        const raw = await request.text()
        if (new TextEncoder().encode(raw).length > 3 * 1024 * 1024) throw new DomainError(413,'BODY_TOO_LARGE','Request is too large.')
        if(raw) {
          if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new DomainError(415,'JSON_REQUIRED','Use application/json.')
          try { body = JSON.parse(raw) } catch { throw new DomainError(400,'INVALID_JSON','Provide a JSON object.') }
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DomainError(400,'INVALID_JSON','Provide a JSON object.')
      }
      // Validate ownership and all business fields before spending storage on a photo.
      if (body.image && /^\/api\/recipes(?:\/[^/]+)?$/.test(url.pathname)) {
        command(structuredClone(this.state()), subject, request.method, url, body)
        const image = body.image as Body
        if (Object.keys(image).some(k => !['content_type','data'].includes(k)) || !['image/jpeg','image/png'].includes(String(image.content_type)) || typeof image.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data)) throw new DomainError(400,'INVALID_IMAGE','Choose a valid JPG or PNG.')
        const bytes = Uint8Array.from(atob(image.data), ch => ch.charCodeAt(0))
        if (bytes.length > 2 * 1024 * 1024) throw new DomainError(413,'IMAGE_TOO_LARGE','Choose a photo no larger than 2 MB.')
        const png = bytes.length > 32 && [...bytes.slice(0,8)].map(n => n.toString(16).padStart(2,'0')).join('') === '89504e470d0a1a0a' && new TextDecoder().decode(bytes.slice(12,16)) === 'IHDR'
        const jpeg = bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217
        if (!(image.content_type === 'image/png' ? png : jpeg)) throw new DomainError(400,'INVALID_IMAGE','Invalid image contents.')
        uploaded = `recipes/${crypto.randomUUID()}`
        imageBytes = bytes.buffer as ArrayBuffer
      }
      const result = this.ctx.storage.transactionSync(() => {
        const state = this.state()
        const result = command(state, subject, request.method, url, body, uploaded)
        if (!['GET','HEAD'].includes(request.method)) {
          for (const key of result.deleteImages || []) this.ctx.storage.sql.exec('DELETE FROM fridge_images WHERE key = ?',key)
          if (uploaded && imageBytes) {
            const used=this.ctx.storage.sql.exec<{size:number}>('SELECT COALESCE(SUM(length(body)),0) AS size FROM fridge_images').one().size
            if(used+imageBytes.byteLength>20*1024*1024) throw new DomainError(507,'IMAGE_STORAGE_LIMIT','Photo storage is full. Remove unused recipe photos or use a default illustration.')
            this.ctx.storage.sql.exec('INSERT INTO fridge_images (key,content_type,body) VALUES (?,?,?)',uploaded,String((body.image as Body).content_type),imageBytes)
          }
          const encoded = JSON.stringify(state)
          if (this.encoder.encode(encoded).length > 8 * 1024 * 1024) throw new DomainError(507,'STORAGE_LIMIT','This evaluation workspace is full. Contact the owner.')
          this.ctx.storage.sql.exec('INSERT INTO fridge_state (id, body) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body', encoded)
        }
        return result
      })
      if (result.imageKey) {
        const file = this.ctx.storage.sql.exec<{body:ArrayBuffer;content_type:string}>('SELECT body,content_type FROM fridge_images WHERE key = ?',result.imageKey).toArray()[0]
        if (!file) throw new DomainError(404,'RECIPE_NOT_FOUND','Recipe image not found.')
        return new Response(file.body, { headers: { 'Content-Type': file.content_type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
      }
      if (result.notify) this.emit(result.notify, result.event)
      return Response.json({ data: result.data }, { status: result.status || 200, headers: { 'Cache-Control': 'no-store' } })
    } catch (error) {
      if (error instanceof DomainError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status })
      console.error('Fridge request failed', error instanceof Error ? error.name : 'Unknown error')
      return Response.json({ error: { code: 'INTERNAL_ERROR', message: 'Unable to complete this request.' } }, { status: 500 })
    }
  }
}
