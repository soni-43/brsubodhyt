const express = require('express');
const session = require('express-session');
const path = require('path');
const { initDatabase, migrate, getAll, getOne } = require('./db/database');
const { loadUser } = require('./middleware/auth');
const userRoutes = require('./routes/user');
const adminRoutes = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize database
initDatabase();

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session
const SQLiteStore = require('connect-sqlite3')(session);
const sessionConfig = {
  secret: 'br-subodh-yt-secret-key-2024-advanced',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' }
};

if (process.env.DATABASE_URL) {
  app.use(session(sessionConfig));
} else {
  sessionConfig.store = new SQLiteStore({ db: 'sessions.db', dir: __dirname });
  app.use(session(sessionConfig));
}

// XSS protection helper
app.use((req, res, next) => {
  const sanitize = (str) => {
    if (typeof str !== 'string') return str;
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
  };
  res.locals.sanitize = sanitize;
  // Sanitize query params
  if (req.query) {
    for (const key in req.query) {
      req.query[key] = sanitize(req.query[key]);
    }
  }
  next();
});

// CSRF token generation
app.use((req, res, next) => {
  if (!req.session.csrfToken) {
    req.session.csrfToken = require('crypto').randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;
  next();
});

// CSRF validation middleware
function csrfProtect(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const token = req.body._csrf || req.headers['x-csrf-token'];
  if (token !== req.session.csrfToken) {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }
  next();
}
app.use((req, res, next) => {
  req.csrfProtect = csrfProtect;
  next();
});

// Load user middleware
app.use(loadUser);

// Global settings + policies + social links
app.use(async (req, res, next) => {
  try {
    const rows = await getAll('SELECT setting_key, setting_value FROM settings');
    res.locals.siteSettings = {};
    rows.forEach(r => { res.locals.siteSettings[r.setting_key] = r.setting_value; });
    
    // Load policies
    const policies = await getAll('SELECT policy_type, content FROM policies');
    res.locals.policies = {};
    policies.forEach(p => { res.locals.policies[p.policy_type] = p.content; });
  } catch (e) {
    res.locals.siteSettings = {};
    res.locals.policies = {};
  }
  next();
});

// Routes
app.use('/', userRoutes);
app.use('/admin', adminRoutes);

// 404
app.use((req, res) => {
  res.status(404).render('404', { title: 'Not Found' });
});

// Start server
(async () => {
  await migrate();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] BR SUBODH YT running on port ${PORT}`);
  });
})();
