import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { userRoutes } from './modules/auth/routes.js';
import { conversationEvents } from './modules/conversations/events.js';
import { HttpError, json } from './utils/http.js';

const files = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/js/pages/recipes/recipes.js': ['js/pages/recipes/recipes.js', 'text/javascript; charset=utf-8'],
};

export function createApp(client, db, options) {
  const events = conversationEvents();
  const users = userRoutes(client, db, { ...options, events });
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    response.setHeader('Referrer-Policy', 'same-origin');
    try {
      const url = new URL(request.url, 'http://localhost');
      if (await users(request, response, url)) return;
      if (request.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      if (url.pathname === '/recipes') {
        response.writeHead(302, { Location: '/#recipes' });
        response.end();
        return;
      }
      if (url.pathname === '/api/hello') return json(response, 200, { message: 'Hello World' });
      if (url.pathname === '/api/health') {
        try { await db.command({ ping: 1 }); json(response, 200, { status: 'ok', database: 'mongodb' }); }
        catch { json(response, 503, { status: 'unavailable' }); }
        return;
      }
      const file = files[url.pathname];
      if (!file) throw new HttpError(404, 'NOT_FOUND', 'Not found.');
      const content = await readFile(new URL(`../public/${file[0]}`, import.meta.url));
      response.writeHead(200, { 'Content-Type': file[1] }); response.end(content);
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      if (error.code === 11000) json(response, 409, { error: { code: 'ALREADY_EXISTS', message: 'Username or email already in use.' } });
      else if (error instanceof HttpError) json(response, error.status, { error: { code: error.code, message: error.message } });
      else {
        console.error('Request failed:', error.name);
        json(response, 500, { error: { code: 'INTERNAL_ERROR', message: 'Unable to complete request.' } });
      }
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.closeConversationEvents = events.close;
  return server;
}
