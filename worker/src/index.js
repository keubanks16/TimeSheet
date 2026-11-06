// TimeSheet API — Cloudflare Worker + D1
// Routes:
//   GET  /                 -> { ok, app, setup }   (setup = passcode already created)
//   POST /api/passcode     -> { passcode }         create the passcode (only works once)
//   PUT  /api/passcode     -> { passcode }         change it (needs current passcode in Authorization)
//   GET  /api/state        -> full state           (Authorization: Bearer <passcode>)
//   POST /api/sync         -> upsert months / entries / settings by updated_at, returns full state
//   GET|POST /api/visit    -> log a site visit: ?pass=..&site=Dodge%20SP&miles=148
//                             (meant for an iPhone Shortcuts "When I arrive" automation). Only acts
//                             Mon–Thu 9:00am–2:00pm Eastern (add &force=1 to test outside that window).
//                             Sets that day's miles to the given number unless the day already has miles.
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
    env.DB.prepare('SELECT id, year, month, updated_at, deleted, mileage_status, mileage_status_date FROM months').all(),
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
    `INSERT INTO months (id, year, month, updated_at, deleted, mileage_status, mileage_status_date) VALUES (?1, ?2, ?3, ?4, ?5, COALESCE(?6, 'none'), ?7)
     ON CONFLICT(id) DO UPDATE SET year=excluded.year, month=excluded.month, updated_at=excluded.updated_at, deleted=excluded.deleted,
       mileage_status=COALESCE(?6, months.mileage_status), mileage_status_date=CASE WHEN ?6 IS NULL THEN months.mileage_status_date ELSE ?7 END
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
    const ms = ['none', 'submitted', 'paid'].includes(m.mileage_status) ? m.mileage_status : null; // null = old client, keep what's stored
    stmts.push(upMonth.bind(String(m.id), num(m.year) || 0, num(m.month) || 0, num(m.updated_at) || 0, m.deleted ? 1 : 0, ms, ms ? str(m.mileage_status_date) : null));
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

// Local (Eastern) date parts for a timestamp: { iso: 'YYYY-MM-DD', dow: 0-6 (Sun=0), hour, minute }
function eastern(ts) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ts));
  const g = t => (parts.find(p => p.type === t) || {}).value;
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday'));
  return { iso: `${g('year')}-${g('month')}-${g('day')}`, dow, hour: Number(g('hour')) % 24, minute: Number(g('minute')) };
}
const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

async function logVisit(env, p) {
  const site = String(p.site || '').trim();
  const miles = num(p.miles);
  if (!site || miles === null || miles <= 0) return { error: 'site and miles are required' };
  const ts = num(p.when) || Date.now();
  const et = eastern(ts);
  const inWindow = et.dow >= 1 && et.dow <= 4 && et.hour >= 9 && et.hour < 14;
  if (!inWindow && !p.force) return { ok: true, action: 'ignored', reason: 'outside Mon–Thu 9am–2pm', date: et.iso, site };
  const [y, mo] = et.iso.split('-').map(Number);
  const t = Date.now();
  let month = await env.DB.prepare('SELECT id FROM months WHERE year=?1 AND month=?2 AND deleted=0 ORDER BY updated_at ASC LIMIT 1').bind(y, mo).first();
  if (!month) {
    month = { id: newId() };
    await env.DB.prepare('INSERT INTO months (id, year, month, updated_at, deleted) VALUES (?1, ?2, ?3, ?4, 0)').bind(month.id, y, mo, t).run();
  }
  const rows = (await env.DB.prepare('SELECT id, description, miles FROM entries WHERE month_id=?1 AND date=?2 AND deleted=0 ORDER BY updated_at ASC').bind(month.id, et.iso).all()).results;
  const withMiles = rows.find(r => Number(r.miles) > 0);
  if (withMiles) return { ok: true, action: 'skipped', reason: 'day already has miles', date: et.iso, site, miles: Number(withMiles.miles) };
  if (rows.length) {
    const r = rows[0];
    await env.DB.prepare('UPDATE entries SET miles=?1, description=?2, updated_at=?3 WHERE id=?4')
      .bind(miles, (r.description || '').trim() ? r.description : site, t, r.id).run();
    return { ok: true, action: 'updated', date: et.iso, site, miles };
  }
  await env.DB.prepare('INSERT INTO entries (id, month_id, date, description, hours, miles, note, updated_at, deleted) VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, 0)')
    .bind(newId(), month.id, et.iso, site, miles, '', t).run();
  return { ok: true, action: 'created', date: et.iso, site, miles };
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
      // /api/visit also accepts the passcode as ?pass= (or "pass" in the JSON body) so a Shortcut can call it with a plain URL
      let visitParams = null;
      if (path === '/api/visit') {
        visitParams = Object.fromEntries(url.searchParams.entries());
        if (req.method === 'POST') Object.assign(visitParams, await req.json().catch(() => ({})));
      }
      const given = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') || (visitParams && visitParams.pass) || '';
      if (!given || (await hash(given)) !== stored) return json({ error: 'Wrong passcode' }, 401);

      if (visitParams) return json(await logVisit(env, visitParams));

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
