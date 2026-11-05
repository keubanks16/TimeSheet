// TimeSheet API — Cloudflare Worker + D1
// Routes:
//   GET  /                 -> { ok, app, setup }   (setup = passcode already created)
//   POST /api/passcode     -> { passcode }         create the passcode (only works once)
//   PUT  /api/passcode     -> { passcode }         change it (needs current passcode in Authorization)
//   GET  /api/state        -> full state           (Authorization: Bearer <passcode>)
//   POST /api/sync         -> upsert months / entries / settings by updated_at, returns full state
//
// Sync rule: every record carries updated_at (ms). A record only overwrites what's stored
// when its updated_at is newer. Deletes are tombstones (deleted = 1) so they sync too.

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-max-age': '86400',
};
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS } });

const SALT = 'timesheet-v1:';
async function hash(pc) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(SALT + pc));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function getPasscodeHash(env) {
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key='passcode_hash'").first();
  return row ? row.value : null;
}
async function fullState(env) {
  const [months, entries, settings] = await Promise.all([
    env.DB.prepare('SELECT id, year, month, updated_at, deleted FROM months').all(),
    env.DB.prepare('SELECT id, month_id, date, description, hours, miles, note, updated_at, deleted FROM entries').all(),
    env.DB.prepare("SELECT value, updated_at FROM meta WHERE key='settings'").first(),
  ]);
  return {
    months: months.results,
    entries: entries.results,
    settings: settings ? { json: settings.value, updated_at: settings.updated_at } : null,
    serverTime: Date.now(),
  };
}
const num = v => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));
const str = v => (v === null || v === undefined ? null : String(v));

async function applySync(env, body) {
  const stmts = [];
  const upMonth = env.DB.prepare(
    `INSERT INTO months (id, year, month, updated_at, deleted) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(id) DO UPDATE SET year=excluded.year, month=excluded.month, updated_at=excluded.updated_at, deleted=excluded.deleted
     WHERE excluded.updated_at > months.updated_at`);
  const upEntry = env.DB.prepare(
    `INSERT INTO entries (id, month_id, date, description, hours, miles, note, updated_at, deleted) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT(id) DO UPDATE SET month_id=excluded.month_id, date=excluded.date, description=excluded.description, hours=excluded.hours,
       miles=excluded.miles, note=excluded.note, updated_at=excluded.updated_at, deleted=excluded.deleted
     WHERE excluded.updated_at > entries.updated_at`);
  const upSettings = env.DB.prepare(
    `INSERT INTO meta (key, value, updated_at) VALUES ('settings', ?1, ?2)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
     WHERE excluded.updated_at > meta.updated_at`);

  for (const m of body.months || []) {
    if (!m || !m.id) continue;
    stmts.push(upMonth.bind(String(m.id), num(m.year) || 0, num(m.month) || 0, num(m.updated_at) || 0, m.deleted ? 1 : 0));
  }
  for (const e of body.entries || []) {
    if (!e || !e.id || !e.month_id) continue;
    stmts.push(upEntry.bind(String(e.id), String(e.month_id), str(e.date), str(e.description) ?? '', num(e.hours), num(e.miles), str(e.note) ?? '', num(e.updated_at) || 0, e.deleted ? 1 : 0));
  }
  if (body.settings && typeof body.settings.json === 'string') {
    stmts.push(upSettings.bind(body.settings.json, num(body.settings.updated_at) || 0));
  }
  // D1 batch limit is generous, but chunk anyway for very large pushes
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return stmts.length;
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (path === '/' || path === '/api') {
        return json({ ok: true, app: 'TimeSheet API', setup: !!(await getPasscodeHash(env)) });
      }
      if (path === '/api/passcode' && req.method === 'POST') {
        const { passcode } = await req.json().catch(() => ({}));
        if (!passcode || String(passcode).length < 4) return json({ error: 'Passcode must be at least 4 characters' }, 400);
        if (await getPasscodeHash(env)) return json({ error: 'A passcode is already set. Enter it to connect.' }, 409);
        await env.DB.prepare("INSERT INTO meta (key, value, updated_at) VALUES ('passcode_hash', ?1, ?2)").bind(await hash(String(passcode)), Date.now()).run();
        return json({ ok: true });
      }

      // everything below needs the passcode
      const stored = await getPasscodeHash(env);
      if (!stored) return json({ error: 'No passcode set up yet', setup: false }, 401);
      const given = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      if (!given || (await hash(given)) !== stored) return json({ error: 'Wrong passcode' }, 401);

      if (path === '/api/state' && req.method === 'GET') return json(await fullState(env));
      if (path === '/api/sync' && req.method === 'POST') {
        const body = await req.json().catch(() => ({}));
        const applied = await applySync(env, body);
        const state = await fullState(env);
        state.applied = applied;
        return json(state);
      }
      if (path === '/api/passcode' && req.method === 'PUT') {
        const { passcode } = await req.json().catch(() => ({}));
        if (!passcode || String(passcode).length < 4) return json({ error: 'Passcode must be at least 4 characters' }, 400);
        await env.DB.prepare("UPDATE meta SET value=?1, updated_at=?2 WHERE key='passcode_hash'").bind(await hash(String(passcode)), Date.now()).run();
        return json({ ok: true });
      }
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  },
};
