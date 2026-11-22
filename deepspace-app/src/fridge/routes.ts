import type { Hono } from 'hono'
import { resolveSessionReadAuth } from 'deepspace/worker'
import type { AppContext } from '../../worker'
import { resolveAuth } from '../server/http-routes'
import { createActionTools } from '../server/action-routes'
import { recognizeIngredients } from './vision'
import {handleShopping} from './shopping'
import { FRIDGE_REVISION } from './revision'

export function registerFridgeRoutes(app: Hono<AppContext>) {
  // Paid calls are server controlled, with a bounded model and a daily quota.
  app.all('/api/integrations/:name/:endpoint', c => c.json({error:'Use the app recognition flow.'},403))
  app.get('/api/health', async c => {
    const stub=c.env.FRIDGE_ROOMS.get(c.env.FRIDGE_ROOMS.idFromName(`app:${c.env.DEEPSPACE_APP_ID}`))
    const response=await stub.fetch(new Request('https://internal/health'))
    const room=await response.json() as {status:string;database:string;revision?:string}
    const current=room.revision===FRIDGE_REVISION
    return c.json({...room,status:current?'ok':'updating',worker_revision:FRIDGE_REVISION,room_revision:room.revision||'unknown'},current?200:503)
  })
  app.get('/image-demo', c => c.redirect('/legacy/image-demo.html'))
  app.use('/api/*', async (c, next) => {
    const path = c.req.path
    if (!/^\/api\/(users|friends|inventory|ingredients|recognition)(?:\/|$)/.test(path) && !/^\/api\/recipes(?:\/|$)/.test(path)) return next()
    const auth = await resolveAuth(c.req.raw,c.env) || await resolveSessionReadAuth(c.req.raw,c.env)
    if (!auth) return c.json({ error: { code: 'UNAUTHENTICATED', message: 'Please sign in with DeepSpace.' } },401)
    if (!['GET','HEAD'].includes(c.req.method)) {
      const origin = c.req.header('Origin')
      if ((origin && origin !== new URL(c.req.url).origin) || c.req.header('Sec-Fetch-Site') === 'cross-site') return c.json({ error: { code: 'CROSS_ORIGIN', message: 'Cross-origin requests are not allowed.' } },403)
    }
    if(path.startsWith('/api/recipes/shopping/')) {
      const token=c.req.header('Authorization')?.slice(7)
      if(!token)return c.json({error:{code:'UNAUTHENTICATED',message:'Please sign in again.'}},401)
      let params:Record<string,unknown>={}
      if(c.req.method!=='GET') {
        const raw=await c.req.text()
        if(new TextEncoder().encode(raw).length>16384)return c.json({error:{code:'BODY_TOO_LARGE',message:'Lookup request is too large.'}},413)
        try{params=JSON.parse(raw)}catch{return c.json({error:{code:'INVALID_JSON',message:'Provide a JSON object.'}},400)}
        if(!params||typeof params!=='object'||Array.isArray(params))return c.json({error:{code:'INVALID_JSON',message:'Provide a JSON object.'}},400)
      }
      return handleShopping({userId:auth.userId,callerJwt:token,env:c.env,tools:createActionTools(c.env,auth.userId,token),params},path,c.req.method)
    }
    if (path === '/api/recognition' && c.req.method === 'POST') {
      const token = c.req.header('Authorization')?.slice(7)
      if (!token) return c.json({ error: { code: 'UNAUTHENTICATED', message: 'Please sign in again.' } },401)
      const type = c.req.header('Content-Type')?.split(';')[0].trim()
      if (!['image/jpeg','image/png'].includes(type || '')) return c.json({ error: { code: 'INVALID_IMAGE_TYPE', message: 'Choose a JPG or PNG.' } },415)
      if (Number(c.req.header('Content-Length')) > 10 * 1024 * 1024) return c.json({ error: { code: 'IMAGE_TOO_LARGE', message: 'Image must be 10 MB or smaller.' } },413)
      const bytes = new Uint8Array(await c.req.arrayBuffer())
      if (!bytes.length || bytes.length > 10 * 1024 * 1024) return c.json({ error: { code: 'INVALID_IMAGE', message: 'Choose a non-empty image up to 10 MB.' } },400)
      let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i,i+8192))
      const result = await recognizeIngredients({ userId: auth.userId, callerJwt: token, env: c.env, tools: createActionTools(c.env,auth.userId,token), params: { content_type: type, data: btoa(binary) } })
      return result.success ? c.json({ data: result.data }) : c.json({ error: { code: 'RECOGNITION_UNAVAILABLE', message: result.error } },503)
    }
    const stub = c.env.FRIDGE_ROOMS.get(c.env.FRIDGE_ROOMS.idFromName(`app:${c.env.DEEPSPACE_APP_ID}`))
    const headers = new Headers(c.req.raw.headers)
    headers.delete('x-fridge-subject'); headers.delete('cookie'); headers.delete('authorization')
    headers.set('x-fridge-subject',auth.userId)
    return stub.fetch(new Request(c.req.raw,{ headers }))
  })
}
