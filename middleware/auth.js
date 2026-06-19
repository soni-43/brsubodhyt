const { getOne, run } = require('../db/database');

function requireLogin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.redirect('/login');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId || !req.session.isAdmin) {
    return res.redirect('/admin/login');
  }
  next();
}

function requireSuperAdmin(req, res, next) {
  if (!req.session || !req.session.userId || !req.session.isSuperAdmin) {
    return res.redirect('/admin');
  }
  next();
}

function requireGuest(req, res, next) {
  if (req.session && req.session.userId) {
    return res.redirect('/');
  }
  next();
}

async function loadUser(req, res, next) {
  res.locals.currentUser = null;
  res.locals.isAdmin = false;
  res.locals.isSuperAdmin = false;
  res.locals.unreadCount = 0;
  
  if (req.session && req.session.userId) {
    const user = await getOne('SELECT * FROM users WHERE id = ? AND is_banned = 0', [req.session.userId]);
    if (user) {
      res.locals.currentUser = user;
      res.locals.isAdmin = !!user.is_admin;
      res.locals.isSuperAdmin = !!user.is_super_admin;
      // Update last login
      await run('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
      // Get unread notification count
      try {
        const notif = await getOne('SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0', [user.id]);
        res.locals.unreadCount = notif ? notif.count : 0;
      } catch(e) {}
    }
  }
  next();
}

// Admin activity logger
async function logAdminAction(adminId, action, details = '', ipAddress = '') {
  try {
    await run(
      'INSERT INTO admin_logs (admin_id, action, details, ip_address) VALUES (?, ?, ?, ?)',
      [adminId, action, details, ipAddress]
    );
  } catch (e) { /* ignore */ }
}

module.exports = { requireLogin, requireAdmin, requireSuperAdmin, requireGuest, loadUser, logAdminAction };
