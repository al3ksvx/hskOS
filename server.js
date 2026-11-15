// HotelOS by YSYR – serwer: Express + SQLite + WebSocket + JWT
const express = require('express'), http = require('http'), path = require('path');
const Database = require('better-sqlite3'), bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'ZMIEN-MNIE-W-PRODUKCJI';
const db = new Database(process.env.DB_PATH || path.join(__dirname, 'hotel.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT, login TEXT UNIQUE, hash TEXT, role TEXT, lang TEXT DEFAULT 'pl', active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS rooms(id INTEGER PRIMARY KEY, number TEXT UNIQUE, floor INTEGER DEFAULT 0, type TEXT, beds INTEGER DEFAULT 2, price REAL DEFAULT 0, status TEXT DEFAULT 'clean', note TEXT DEFAULT '', updated TEXT);
CREATE TABLE IF NOT EXISTS bookings(id INTEGER PRIMARY KEY, room_id INTEGER, guest TEXT, phone TEXT, checkin TEXT, checkout TEXT, state TEXT DEFAULT 'booked', note TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY, room_id INTEGER, title TEXT, assignee INTEGER, done INTEGER DEFAULT 0, created TEXT);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT, body TEXT, system INTEGER DEFAULT 0, ts TEXT);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);
`);
const ROLES = ['admin', 'manager', 'reception', 'housekeeping'];
const STATUSES = ['clean', 'dirty', 'occupied', 'maintenance', 'inspection'];
const app = express(); app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const now = () => new Date().toISOString();
const broadcast = (type, data) => wss.clients.forEach(c => c.readyState === 1 && c.send(JSON.stringify({ type, data })));
wss.on('connection', (ws, req) => { // autoryzacja WS tokenem w query
  try { jwt.verify(new URL(req.url, 'http://x').searchParams.get('t'), SECRET); } catch { ws.close(4001); }
});
// proste ograniczenie prób logowania
const tries = new Map();
const auth = (...roles) => (req, res, next) => {
  try {
    const u = jwt.verify((req.headers.authorization || '').slice(7), SECRET);
    const row = db.prepare('SELECT id,name,login,role,lang,active FROM users WHERE id=?').get(u.id);
    if (!row || !row.active) return res.status(401).json({ error: 'auth' });
    if (roles.length && !roles.includes(row.role)) return res.status(403).json({ error: 'forbidden' });
    req.user = row; next();
  } catch { res.status(401).json({ error: 'auth' }); }
};
const sys = (key, params) => { // wiadomość systemowa: klucz tłumaczenia + parametry (tłumaczona po stronie klienta)
  const body = JSON.stringify({ key, params });
  const r = db.prepare('INSERT INTO messages(user_id,name,body,system,ts) VALUES(NULL,NULL,?,1,?)').run(body, now());
  broadcast('message', { id: r.lastInsertRowid, user_id: null, name: null, body, system: 1, ts: now() });
};
const hasUsers = () => db.prepare('SELECT COUNT(*) c FROM users').get().c > 0;

// --- Auth ---
app.get('/api/setup', (_, res) => res.json({ needsSetup: !hasUsers() }));
app.post('/api/setup', (req, res) => { // pierwsze konto administratora
  if (hasUsers()) return res.status(403).json({ error: 'forbidden' });
  const { name, login, password, hotel } = req.body;
  if (!name || !login || !password || password.length < 8) return res.status(400).json({ error: 'invalid' });
  db.prepare('INSERT INTO users(name,login,hash,role) VALUES(?,?,?,?)').run(name, login.trim().toLowerCase(), bcrypt.hashSync(password, 10), 'admin');
  db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('hotel', hotel || 'Mój Hotel');
  res.json({ ok: true });
});
app.post('/api/login', (req, res) => {
  const ip = req.ip, t = tries.get(ip) || { n: 0, at: Date.now() };
  if (Date.now() - t.at > 600000) { t.n = 0; t.at = Date.now(); }
  if (t.n >= 10) return res.status(429).json({ error: 'toomany' });
  const u = db.prepare('SELECT * FROM users WHERE login=? AND active=1').get(String(req.body.login || '').trim().toLowerCase());
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.hash)) { t.n++; tries.set(ip, t); return res.status(401).json({ error: 'badlogin' }); }
  res.json({ token: jwt.sign({ id: u.id }, SECRET, { expiresIn: '12h' }), user: { id: u.id, name: u.name, login: u.login, role: u.role, lang: u.lang } });
});
app.get('/api/me', auth(), (req, res) => res.json({ user: req.user, hotel: (db.prepare("SELECT v FROM settings WHERE k='hotel'").get() || {}).v || 'Hotel' }));
app.put('/api/me', auth(), (req, res) => {
  const { lang, password, name } = req.body;
  if (lang) db.prepare('UPDATE users SET lang=? WHERE id=?').run(lang, req.user.id);
  if (name) db.prepare('UPDATE users SET name=? WHERE id=?').run(name, req.user.id);
  if (password) { if (password.length < 8) return res.status(400).json({ error: 'invalid' }); db.prepare('UPDATE users SET hash=? WHERE id=?').run(bcrypt.hashSync(password, 10), req.user.id); }
  res.json({ ok: true });
});
// --- Użytkownicy (admin) ---
app.get('/api/users', auth('admin', 'manager'), (_, res) => res.json(db.prepare('SELECT id,name,login,role,active FROM users').all()));
app.post('/api/users', auth('admin'), (req, res) => {
  const { name, login, password, role } = req.body;
  if (!name || !login || !password || password.length < 8 || !ROLES.includes(role)) return res.status(400).json({ error: 'invalid' });
  try { db.prepare('INSERT INTO users(name,login,hash,role) VALUES(?,?,?,?)').run(name, login.trim().toLowerCase(), bcrypt.hashSync(password, 10), role); res.json({ ok: true }); }
  catch { res.status(409).json({ error: 'exists' }); }
});
app.put('/api/users/:id', auth('admin'), (req, res) => {
  const { role, active } = req.body, id = +req.params.id;
  if (id === req.user.id) return res.status(400).json({ error: 'self' });
  if (ROLES.includes(role)) db.prepare('UPDATE users SET role=? WHERE id=?').run(role, id);
  if (active !== undefined) db.prepare('UPDATE users SET active=? WHERE id=?').run(active ? 1 : 0, id);
  res.json({ ok: true });
});
// --- Ustawienia hotelu ---
app.put('/api/hotel', auth('admin'), (req, res) => { db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('hotel', String(req.body.name || '').slice(0, 80)); broadcast('hotel', {}); res.json({ ok: true }); });
// --- Pokoje ---
app.get('/api/rooms', auth(), (_, res) => res.json(db.prepare('SELECT * FROM rooms ORDER BY floor, number').all()));
app.post('/api/rooms', auth('admin', 'manager'), (req, res) => {
  const { number, floor, type, beds, price } = req.body;
  if (!number) return res.status(400).json({ error: 'invalid' });
  try { db.prepare('INSERT INTO rooms(number,floor,type,beds,price,updated) VALUES(?,?,?,?,?,?)').run(String(number), +floor || 0, type || '', +beds || 2, +price || 0, now()); broadcast('rooms', {}); res.json({ ok: true }); }
  catch { res.status(409).json({ error: 'exists' }); }
});
app.delete('/api/rooms/:id', auth('admin'), (req, res) => { db.prepare('DELETE FROM rooms WHERE id=?').run(req.params.id); broadcast('rooms', {}); res.json({ ok: true }); });
app.put('/api/rooms/:id/status', auth(), (req, res) => {
  const { status, note } = req.body, r = db.prepare('SELECT * FROM rooms WHERE id=?').get(req.params.id);
  if (!r || !STATUSES.includes(status)) return res.status(400).json({ error: 'invalid' });
  const hk = req.user.role === 'housekeeping' && !['clean', 'dirty', 'inspection'].includes(status) && status !== 'maintenance';
  if (hk) return res.status(403).json({ error: 'forbidden' });
  db.prepare('UPDATE rooms SET status=?, note=COALESCE(?,note), updated=? WHERE id=?').run(status, note ?? null, now(), r.id);
  sys('sys.room', { room: r.number, status, user: req.user.name });
  broadcast('rooms', {}); res.json({ ok: true });
});
// --- Rezerwacje ---
app.get('/api/bookings', auth('admin', 'manager', 'reception'), (_, res) => res.json(db.prepare('SELECT b.*, r.number room FROM bookings b JOIN rooms r ON r.id=b.room_id ORDER BY checkin DESC').all()));
app.post('/api/bookings', auth('admin', 'manager', 'reception'), (req, res) => {
  const { room_id, guest, phone, checkin, checkout, note } = req.body;
  if (!room_id || !guest || !checkin || !checkout || checkout <= checkin) return res.status(400).json({ error: 'invalid' });
  const clash = db.prepare("SELECT 1 FROM bookings WHERE room_id=? AND state IN ('booked','in') AND checkin<? AND checkout>?").get(room_id, checkout, checkin);
  if (clash) return res.status(409).json({ error: 'overlap' });
  db.prepare('INSERT INTO bookings(room_id,guest,phone,checkin,checkout,note) VALUES(?,?,?,?,?,?)').run(room_id, guest, phone || '', checkin, checkout, note || '');
  broadcast('bookings', {}); res.json({ ok: true });
});
app.put('/api/bookings/:id/state', auth('admin', 'manager', 'reception'), (req, res) => {
  const { state } = req.body, b = db.prepare('SELECT * FROM bookings WHERE id=?').get(req.params.id);
  if (!b || !['booked', 'in', 'out', 'cancelled'].includes(state)) return res.status(400).json({ error: 'invalid' });
  db.prepare('UPDATE bookings SET state=? WHERE id=?').run(state, b.id);
  const rs = state === 'in' ? 'occupied' : state === 'out' ? 'dirty' : null;
  if (rs) { db.prepare('UPDATE rooms SET status=?, updated=? WHERE id=?').run(rs, now(), b.room_id); const r = db.prepare('SELECT number FROM rooms WHERE id=?').get(b.room_id); sys('sys.room', { room: r.number, status: rs, user: req.user.name }); }
  broadcast('rooms', {}); broadcast('bookings', {}); res.json({ ok: true });
});
// --- Zadania ---
app.get('/api/tasks', auth(), (_, res) => res.json(db.prepare('SELECT t.*, r.number room, u.name assignee_name FROM tasks t LEFT JOIN rooms r ON r.id=t.room_id LEFT JOIN users u ON u.id=t.assignee ORDER BY done, id DESC').all()));
app.post('/api/tasks', auth('admin', 'manager', 'reception'), (req, res) => {
  const { title, room_id, assignee } = req.body; if (!title) return res.status(400).json({ error: 'invalid' });
  db.prepare('INSERT INTO tasks(room_id,title,assignee,created) VALUES(?,?,?,?)').run(room_id || null, title, assignee || null, now()); broadcast('tasks', {}); res.json({ ok: true });
});
app.put('/api/tasks/:id', auth(), (req, res) => { db.prepare('UPDATE tasks SET done=? WHERE id=?').run(req.body.done ? 1 : 0, req.params.id); broadcast('tasks', {}); res.json({ ok: true }); });
// --- Czat ---
app.get('/api/messages', auth(), (_, res) => res.json(db.prepare('SELECT * FROM (SELECT * FROM messages ORDER BY id DESC LIMIT 100) ORDER BY id').all()));
app.post('/api/messages', auth(), (req, res) => {
  const body = String(req.body.body || '').trim().slice(0, 1000); if (!body) return res.status(400).json({ error: 'invalid' });
  const r = db.prepare('INSERT INTO messages(user_id,name,body,ts) VALUES(?,?,?,?)').run(req.user.id, req.user.name, body, now());
  broadcast('message', { id: r.lastInsertRowid, user_id: req.user.id, name: req.user.name, body, system: 0, ts: now() }); res.json({ ok: true });
});
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
server.listen(PORT, () => console.log('HotelOS by YSYR działa na porcie ' + PORT));
