import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invitationPages } from '../../public/js/pages/friends/invitations.js';

test('invitation refresh retains loaded pages and updates pagination after removal', async () => {
  const rows = Array.from({ length: 45 }, (_, i) => ({ _id: String(i) }));
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    const offset = Number(new URL(path, 'http://localhost').searchParams.get('offset'));
    return rows.slice(offset, offset + 20);
  };
  const path = '/api/friends/requests?direction=incoming';
  const refreshed = await invitationPages(api, path, 0, 40, () => true);
  assert.deepEqual(refreshed.rows, rows.slice(0, 40));
  assert.equal(refreshed.lastOffset, 20);
  assert.equal(refreshed.hasMore, true);
  assert.deepEqual(calls, [path + '&offset=0', path + '&offset=20']);
  rows.splice(15);
  const reduced = await invitationPages(api, path, 0, 40, () => true);
  assert.equal(reduced.rows.length, 15);
  assert.equal(reduced.lastOffset, 0);
  assert.equal(reduced.hasMore, false);
});

test('invitation pagination ignores stale account or list responses', async () => {
  let calls = 0;
  const result = await invitationPages(async () => { calls++; return Array(20).fill({ _id: 'stale' }); }, '/api/friends/requests', 0, 40, () => false);
  assert.equal(result, null);
  assert.equal(calls, 1);
});
