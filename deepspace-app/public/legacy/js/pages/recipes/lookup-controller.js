export const QUOTE_TTL = 15 * 60 * 1000;
export const expiryDelay = (checkedAt, now = Date.now()) => Math.max(0, new Date(checkedAt).getTime() + QUOTE_TTL - now);

/** Persist only lookup receipts, never tokens, photos or recipe contents. */
export function createLookupController({ api, storage, owner, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, uuid = () => crypto.randomUUID() }) {
  const key = () => `ff-lookup-receipts:${owner() || 'session'}`;
  const signature = (path, body) => JSON.stringify([path, Object.keys(body).sort().map(name => [name, body[name]])]);
  let memory = {}, loadedKey;
  function read() {
    if (loadedKey !== key()) { memory = {}; loadedKey = key(); }
    try { if (storage) {const parsed=JSON.parse(storage.getItem(key()) || JSON.stringify(memory));if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))memory=parsed;} } catch { /* Private browsing can disable storage. */ }
    for (const name of Object.keys(memory)) if (!memory[name] || typeof memory[name].request_id!=='string' || !Number.isFinite(memory[name].started_at) || now() - memory[name].started_at > 60 * 60 * 1000) delete memory[name];
    return memory;
  }
  function save(receipts, scope = key()) {
    if(scope === key()) memory = receipts;
    try { storage?.setItem(scope, JSON.stringify(receipts)); } catch { /* Memory still preserves retries in this page. */ }
  }
  const terminal = error => [400, 401, 403, 404, 409, 422, 429].includes(error.status) || ['LOOKUP_FAILED', 'SHOPPING_TIMEOUT', 'QUOTE_EXPIRED'].includes(error.code);
  return {
    hasPending(path, body) { return Boolean(read()[signature(path, body)]); },
    async run(path, body, current = () => true, progress = () => {}) {
      const scope = key(), name = signature(path, body), receipts = read();
      const resumed = Boolean(receipts[name]);
      const receipt = receipts[name] || { request_id: uuid(), started_at: now() };
      receipts[name] = receipt; save(receipts, scope); // Before POST: a lost response must not create another paid job.
      progress({ resumed });
      try {
        let response = receipt.job_id ? { status: 'pending', job_id: receipt.job_id } : await api(path, 'POST', { ...body, request_id: receipt.request_id });
        let errors = 0;
        for (let attempt = 0; response.status === 'pending' && attempt < 60; attempt++) {
          receipt.job_id = response.job_id; receipts[name] = receipt; save(receipts, scope);
          await wait(errors ? Math.min(12000, 2000 * 2 ** errors) : 3000);
          if (!current()) return null;
          try { response = await api(`/api/recipes/shopping/jobs/${receipt.job_id}`); errors = 0; }
          catch (error) {
            if (terminal(error) || ++errors >= 3) throw error;
            progress({ resumed: true, reconnecting: true });
          }
        }
        if (!current()) return null;
        if (response.status !== 'complete') throw new Error('This lookup is still running. Resume it to continue without starting a new search.');
        delete receipts[name]; save(receipts, scope);
        return response;
      } catch (error) {
        if (terminal(error)) { delete receipts[name]; save(receipts, scope); }
        error.canResume = !terminal(error);
        throw error;
      }
    },
  };
}
