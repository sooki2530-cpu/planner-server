/*
  Day Plan backend — cloud storage + AI coach.
  Runs on Railway. Needs two things set in Railway:
    1) A Postgres database (Railway injects DATABASE_URL automatically).
    2) An env var ANTHROPIC_API_KEY = your Anthropic key.
  Optional env vars:
    MODEL          (defaults to claude-3-5-sonnet-latest)
    ALLOWED_ORIGIN (defaults to *; you can lock it to your GitHub Pages URL)
*/
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json({ limit: '3mb' }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false } : false
});

async function init() {
  await pool.query(`CREATE TABLE IF NOT EXISTS planners(
    username TEXT PRIMARY KEY,
    pin_hash TEXT NOT NULL,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated TIMESTAMPTZ DEFAULT now()
  )`);
  console.log('db ready');
}
init().catch(e => console.error('init error', e));

const norm = u => (u || '').toString().trim().toLowerCase();
const hash = (user, pin) =>
  crypto.createHash('sha256').update(norm(user) + ':' + String(pin) + ':dayplan-salt-v1').digest('hex');

// ---- health ----
app.get('/', (_req, res) => res.send('Day Plan backend is running.'));

// ---- load (also used to create/verify an account) ----
app.post('/load', async (req, res) => {
  try {
    const user = norm(req.body.user), pin = String(req.body.pin || '');
    if (!user || !pin) return res.status(400).json({ error: 'Enter a name and a PIN.' });
    const { rows } = await pool.query('SELECT pin_hash, data FROM planners WHERE username=$1', [user]);
    if (!rows.length) return res.json({ ok: true, isNew: true, data: null });        // brand new account
    if (rows[0].pin_hash !== hash(user, pin)) return res.status(401).json({ error: 'Wrong PIN for that name.' });
    res.json({ ok: true, isNew: false, data: rows[0].data });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
});

// ---- save (creates on first save, then requires matching pin) ----
app.post('/save', async (req, res) => {
  try {
    const user = norm(req.body.user), pin = String(req.body.pin || ''), data = req.body.data || {};
    if (!user || !pin) return res.status(400).json({ error: 'Enter a name and a PIN.' });
    const h = hash(user, pin);
    const { rows } = await pool.query('SELECT pin_hash FROM planners WHERE username=$1', [user]);
    if (rows.length && rows[0].pin_hash !== h) return res.status(401).json({ error: 'Wrong PIN for that name.' });
    await pool.query(
      `INSERT INTO planners(username, pin_hash, data, updated) VALUES($1,$2,$3,now())
       ON CONFLICT(username) DO UPDATE SET data=$3, updated=now()`,
      [user, h, data]
    );
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
});

// ---- coach ----
app.post('/coach', async (req, res) => {
  try {
    const user = norm(req.body.user), pin = String(req.body.pin || '');
    const message = String(req.body.message || '').slice(0, 2000);
    const history = Array.isArray(req.body.history) ? req.body.history.slice(-8) : [];
    if (!user || !pin) return res.status(400).json({ error: 'Sign in first.' });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Coach not configured (missing API key).' });
    const { rows } = await pool.query('SELECT pin_hash, data FROM planners WHERE username=$1', [user]);
    if (!rows.length || rows[0].pin_hash !== hash(user, pin)) return res.status(401).json({ error: 'Sign in first.' });

    const data = rows[0].data || {};
    const summary = summarize(data);
    const coachName = (data.coach && data.coach.name) ? String(data.coach.name).slice(0, 30) : 'Coach';
    const mode = ['kickoff', 'weekly'].includes(req.body.mode) ? req.body.mode : 'chat';

    const system =
`You are ${coachName}, this person's personal coach living inside their day-planner app. You are not a generic assistant. You have one job: help them become who they want to be, and you care about them fiercely.

Voice: blunt, direct, real, human. You talk like a coach who believes in them too much to let them coast. Short and punchy. No corporate cheer, no lists unless asked, no em dashes.

How to read the room from their data:
- When they are DOING WELL (streak alive, focuses done, showing up, schedule honored): celebrate it hard and specifically, by name. Then tell them to reward themselves and name an actual treat they have earned.
- When they are SLACKING (streak broken, nothing done, overdue piling up, dodging their keystone with NO good reason and a light schedule): do not sugarcoat it. Call it out plainly, refuse the excuses, and put them back on track with ONE non-negotiable next step. Be tough because you respect them.

Be appreciative and realistic, this matters most:
- Notice effort and say so, sincerely. If they are already carrying a heavy load (a packed schedule, many hours booked, back-to-back classes and work), acknowledge how much they are already doing and mean it.
- NEVER tell someone who already has a full day (say 8+ hours booked) to do more. That is not motivating, it is crushing. When the day is genuinely packed, flip your job: protect their energy, tell them to rest, eat, breathe, and not burn out, and be proud of them for showing up to a hard day. Doing the scheduled load IS the win on those days.
- Match your push to reality. A person at their limit needs encouragement and permission to rest, not another task. A person coasting with an empty day needs a nudge. Read which one they are before you speak.

Hard limits that keep you safe to talk to:
- Challenge the behavior, never attack their worth. No insults about who they are, no shame spirals, no name-calling.
- If they seem genuinely low, overwhelmed, sad, or in real distress (not just lazy), drop the tough act completely and be gentle, warm and caring. Their wellbeing comes before any streak. If they sound like they might be in crisis, gently encourage them to reach out to someone they trust or a professional.
- Read their mood for the day if given, and match it.

Use their REAL data below. Reference actual numbers, habit names, assignments and schedule. Notice patterns across days (for example, they finish more on days they move first) and point them out when useful. Keep replies under 130 words unless they ask for more.

THEIR PLANNER RIGHT NOW:
${summary}`;

    let messages;
    if (mode === 'kickoff') {
      messages = [{ role: 'user', content: '(It is the start of my day and I just opened you. Give me a short, punchy morning kickoff based on my data: where my streak stands, what matters most today, and one thing to lock in. Praise or push me as I have earned.)' }];
    } else if (mode === 'weekly') {
      messages = [{ role: 'user', content: '(Give me my weekly review: how the last 7 days actually went, one pattern you notice, what I did well, and the one thing to fix next week. Be honest.)' }];
    } else {
      messages = [...history.filter(m => m && m.role && m.content), { role: 'user', content: message }];
    }

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.MODEL || 'claude-3-5-sonnet-latest',
        max_tokens: 700,
        system,
        messages
      })
    });
    const j = await r.json();
    if (!r.ok || j.error) {
      console.error('anthropic', r.status, j.error);
      return res.status(502).json({ error: (j.error && j.error.message) || 'The coach is briefly unavailable. Try again.' });
    }
    const reply = (j.content && j.content[0] && j.content[0].text) || '...';
    res.json({ ok: true, reply });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
});

// ---- build a compact, readable summary of the user's data for the coach ----
function summarize(d) {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [];
  // keystone + streak
  const ks = d.keystone || {};
  if (ks.name) {
    lines.push(`Keystone habit: "${ks.name}". Streak: ${streakOf(ks.history || {})} day(s). Done today: ${ks.history && ks.history[today] ? 'yes' : 'not yet'}.`);
  } else {
    lines.push('No keystone habit set yet.');
  }
  // today focuses
  const tf = (d.focuses || []).filter(f => f.date === today);
  const doneF = tf.filter(f => f.done).length;
  if (tf.length) {
    lines.push(`Today's focuses (${doneF}/${tf.length} done): ` +
      tf.map(f => `${f.title} [${f.done ? 'done' : 'open'}, ${f.min}min${f.remark ? ', note: ' + f.remark : ''}]`).join('; '));
  } else {
    lines.push("No focuses set for today.");
  }
  // week completion
  const weekKeys = [...Array(7)].map((_, i) => { const dt = new Date(); dt.setDate(dt.getDate() - i); return dt.toISOString().slice(0, 10); });
  const weekDone = (d.focuses || []).filter(f => f.done && weekKeys.includes(f.date)).length;
  lines.push(`Focuses finished in the last 7 days: ${weekDone}.`);
  // schedule for today + the next 7 days (so nothing gets missed)
  const allBlocks = d.schedule || [];
  const blocksOn = (k) => {
    const w = new Date(k + 'T00:00').getDay();
    return allBlocks.filter(s => s.repeatWeekly ? (s.weekday === w && (!s.start || k >= s.start)) : s.date === k)
      .sort((a, b) => (a.from || '').localeCompare(b.from || ''));
  };
  const schedLines = [];
  for (let i = 0; i < 8; i++) {
    const dt = new Date(); dt.setDate(dt.getDate() + i);
    const k = dt.toISOString().slice(0, 10);
    const blocks = blocksOn(k);
    if (blocks.length) {
      const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : dt.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
      schedLines.push(`${label}: ` + blocks.map(s => `${s.from}-${s.to} ${s.desc} (${s.type})`).join('; '));
    }
  }
  const todayBlocks = blocksOn(today);
  const minsOf = s => { const f = (s.from || '').split(':'), t = (s.to || '').split(':'); if (f.length < 2 || t.length < 2) return 0; return Math.max(0, (+t[0] * 60 + +t[1]) - (+f[0] * 60 + +f[1])); };
  const hoursToday = Math.round(todayBlocks.reduce((a, s) => a + minsOf(s), 0) / 6) / 10;
  lines.push(todayBlocks.length ? `Today's schedule (${hoursToday}h booked): ` + todayBlocks.map(s => `${s.from}-${s.to} ${s.desc} (${s.type})`).join('; ') : 'Nothing scheduled for today specifically.');
  if (hoursToday >= 8) lines.push(`NOTE: today is a heavy day, ${hoursToday} hours are already booked. They are carrying a lot.`);
  lines.push(schedLines.length ? 'Schedule over the next week:\n' + schedLines.join('\n') : 'No schedule blocks in the next week. (Total blocks saved: ' + allBlocks.length + ')');
  // assignments
  const open = (d.assignments || []).filter(a => !a.done);
  const overdue = open.filter(a => a.due && a.due < today);
  if (open.length) {
    lines.push(`Open assignments: ${open.length}` + (overdue.length ? `, of which ${overdue.length} OVERDUE` : '') + '. ' +
      open.slice(0, 6).map(a => `${a.title}${a.due ? ' (due ' + a.due + ')' : ''} [${a.imp} imp]`).join('; '));
  } else {
    lines.push('No open assignments.');
  }
  // mood today + recent
  const moods = d.moods || {};
  const moodWord = s => ({ 1: 'rough', 2: 'low', 3: 'okay', 4: 'good', 5: 'great' })[s] || '?';
  if (moods[today]) {
    lines.push(`Mood today: ${moods[today].score}/5 (${moodWord(moods[today].score)})` + (moods[today].note ? ` — "${moods[today].note}"` : ''));
  } else {
    lines.push('Mood today: not logged yet.');
  }
  const recentMoods = weekKeys.map(k => moods[k] ? `${k.slice(5)}:${moods[k].score}` : null).filter(Boolean);
  if (recentMoods.length) lines.push('Recent moods (last 7d): ' + recentMoods.join(', '));
  // 14-day pattern table: did keystone + focuses finished, so patterns can be seen
  const hist = ks.history || {};
  const rowsP = [];
  for (let i = 0; i < 14; i++) {
    const dt = new Date(); dt.setDate(dt.getDate() - i);
    const k = dt.toISOString().slice(0, 10);
    const dn = (d.focuses || []).filter(f => f.date === k && f.done).length;
    const wk = dt.toLocaleDateString('en-US', { weekday: 'short' });
    rowsP.push(`${wk} ${k.slice(5)}: keystone ${hist[k] ? 'Y' : 'n'}, ${dn} focus done${moods[k] ? ', mood ' + moods[k].score : ''}`);
  }
  lines.push('Last 14 days (newest first):\n' + rowsP.join('\n'));
  return lines.join('\n');
}

function streakOf(history) {
  let count = 0, missUsed = false;
  const cur = new Date();
  for (let i = 0; i < 400; i++) {
    const key = cur.toISOString().slice(0, 10);
    const done = !!history[key];
    if (i === 0) { if (done) count++; }
    else { if (done) count++; else { if (!missUsed) missUsed = true; else break; } }
    cur.setDate(cur.getDate() - 1);
  }
  return count;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Day Plan backend up on ' + PORT));
