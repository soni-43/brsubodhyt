const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const { getOne, getAll, run } = require('../db/database');
const { requireAdmin, requireSuperAdmin, logAdminAction } = require('../middleware/auth');

// File upload config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '..', 'public', 'uploads')),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// Helper to get settings as object
async function getSettings() {
  const rows = await getAll('SELECT setting_key, setting_value FROM settings');
  const s = {};
  rows.forEach(r => { s[r.setting_key] = r.setting_value; });
  return s;
}

// ===== ADMIN LOGIN =====
router.get('/login', (req, res) => {
  if (req.session && req.session.isAdmin) return res.redirect('/admin');
  res.render('admin/login', { title: 'Admin Login', layout: false, error: null });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await getOne('SELECT * FROM users WHERE username = ? AND is_admin = 1', [username]);
  if (!user) return res.render('admin/login', { title: 'Admin Login', layout: false, error: 'Invalid credentials' });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.render('admin/login', { title: 'Admin Login', layout: false, error: 'Invalid credentials' });
  req.session.userId = user.id;
  req.session.isAdmin = true;
  req.session.isSuperAdmin = !!user.is_super_admin;
  await logAdminAction(user.id, 'Admin Login', '', req.ip);
  res.redirect('/admin');
});

router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login');
});

// ===== DASHBOARD =====
router.get('/', requireAdmin, async (req, res) => {
  const totalUsers = await getOne('SELECT COUNT(*) as count FROM users WHERE is_admin = 0');
  const totalApis = await getOne('SELECT COUNT(*) as count FROM apis');
  const totalDeposits = await getOne("SELECT COALESCE(SUM(amount),0) as total FROM deposits WHERE status = 'approved'");
  const totalRevenue = await getOne("SELECT COALESCE(SUM(price),0) as total FROM purchases WHERE status = 'activated'");
  const pendingDeposits = await getOne("SELECT COUNT(*) as count FROM deposits WHERE status = 'pending'");
  const pendingActivations = await getOne("SELECT COUNT(*) as count FROM purchases WHERE status = 'waiting'");
  const totalFeedback = await getOne('SELECT COUNT(*) as count FROM feedbacks');
  const onlineUsers = await getOne("SELECT COUNT(*) as count FROM users WHERE last_login > datetime('now', '-15 minutes')");
  
  res.render('admin/dashboard', {
    title: 'Admin Dashboard',
    stats: {
      totalUsers: totalUsers ? totalUsers.count : 0,
      totalApis: totalApis ? totalApis.count : 0,
      totalDeposits: totalDeposits ? totalDeposits.total : 0,
      totalRevenue: totalRevenue ? totalRevenue.total : 0,
      pendingDeposits: pendingDeposits ? pendingDeposits.count : 0,
      pendingActivations: pendingActivations ? pendingActivations.count : 0,
      totalFeedback: totalFeedback ? totalFeedback.count : 0,
      onlineUsers: onlineUsers ? onlineUsers.count : 0
    }
  });
});

// ===== USER MANAGEMENT =====
router.get('/users', requireAdmin, async (req, res) => {
  const users = await getAll('SELECT * FROM users WHERE is_admin = 0 ORDER BY created_at DESC');
  res.render('admin/users', { title: 'User Management', users });
});

router.post('/users/:id/balance', requireAdmin, async (req, res) => {
  const { action, amount } = req.body;
  const userId = req.params.id;
  const amt = parseFloat(amount);
  
  if (action === 'add') {
    await run('UPDATE users SET balance = balance + ?, total_deposits = total_deposits + ? WHERE id = ?', [amt, amt, userId]);
    await run('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)',
      [userId, 'Balance Added', `₹${amt} has been added to your balance.`]);
    await logAdminAction(req.session.userId, 'Add Balance', `Added ₹${amt} to user #${userId}`, req.ip);
  } else if (action === 'deduct') {
    await run('UPDATE users SET balance = MAX(0, balance - ?) WHERE id = ?', [amt, userId]);
    await run('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)',
      [userId, 'Balance Deducted', `₹${amt} has been deducted from your balance.`]);
    await logAdminAction(req.session.userId, 'Deduct Balance', `Deducted ₹${amt} from user #${userId}`, req.ip);
  }
  res.redirect('/admin/users');
});

router.post('/users/:id/ban', requireAdmin, async (req, res) => {
  const userId = req.params.id;
  const user = await getOne('SELECT is_banned FROM users WHERE id = ?', [userId]);
  const newStatus = user && user.is_banned ? 0 : 1;
  await run('UPDATE users SET is_banned = ? WHERE id = ?', [newStatus, userId]);
  await logAdminAction(req.session.userId, newStatus ? 'Ban User' : 'Unban User', `User #${userId}`, req.ip);
  res.redirect('/admin/users');
});

router.post('/users/:id/delete', requireAdmin, async (req, res) => {
  await run('DELETE FROM notifications WHERE user_id = ?', [req.params.id]);
  await run('DELETE FROM task_completions WHERE user_id = ?', [req.params.id]);
  await run('DELETE FROM feedbacks WHERE user_id = ?', [req.params.id]);
  await run('DELETE FROM purchases WHERE user_id = ?', [req.params.id]);
  await run('DELETE FROM deposits WHERE user_id = ?', [req.params.id]);
  await run('DELETE FROM users WHERE id = ? AND is_admin = 0', [req.params.id]);
  await logAdminAction(req.session.userId, 'Delete User', `User #${req.params.id}`, req.ip);
  res.redirect('/admin/users');
});

// ===== DEPOSIT MANAGEMENT =====
router.get('/deposits', requireAdmin, async (req, res) => {
  const deposits = await getAll("SELECT d.*, u.username FROM deposits d JOIN users u ON d.user_id = u.id ORDER BY d.created_at DESC");
  res.render('admin/deposits', { title: 'Deposit Management', deposits });
});

router.post('/deposits/:id/approve', requireAdmin, async (req, res) => {
  const deposit = await getOne('SELECT * FROM deposits WHERE id = ?', [req.params.id]);
  if (deposit && deposit.status === 'pending') {
    // Calculate bonus
    const settings = await getSettings();
    const bonusPercent = parseFloat(settings.deposit_bonus_percent || '0');
    const bonus = deposit.amount * (bonusPercent / 100);
    const totalCredit = deposit.amount + bonus;
    
    await run("UPDATE deposits SET status = 'approved' WHERE id = ?", [req.params.id]);
    await run('UPDATE users SET balance = balance + ?, total_deposits = total_deposits + ? WHERE id = ?',
      [totalCredit, deposit.amount, deposit.user_id]);
    
    let msg = `Your deposit of ₹${deposit.amount} has been approved.`;
    if (bonus > 0) msg += ` Bonus: ₹${bonus.toFixed(2)} (${bonusPercent}%)`;
    await run('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)',
      [deposit.user_id, 'Deposit Approved', msg]);
    await logAdminAction(req.session.userId, 'Approve Deposit', `Deposit #${req.params.id} ₹${deposit.amount}`, req.ip);
  }
  res.redirect('/admin/deposits');
});

router.post('/deposits/:id/reject', requireAdmin, async (req, res) => {
  const deposit = await getOne('SELECT * FROM deposits WHERE id = ?', [req.params.id]);
  if (deposit && deposit.status === 'pending') {
    await run("UPDATE deposits SET status = 'rejected' WHERE id = ?", [req.params.id]);
    await run('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)',
      [deposit.user_id, 'Deposit Rejected', `Your deposit of ₹${deposit.amount} has been rejected.`]);
    await logAdminAction(req.session.userId, 'Reject Deposit', `Deposit #${req.params.id} ₹${deposit.amount}`, req.ip);
  }
  res.redirect('/admin/deposits');
});

// ===== API MANAGEMENT =====
router.get('/apis', requireAdmin, async (req, res) => {
  const apis = await getAll('SELECT * FROM apis ORDER BY created_at DESC');
  res.render('admin/apis', { title: 'API Management', apis });
});

router.post('/apis/add', requireAdmin, async (req, res) => {
  const { title, category, price, label, description, api_details, total_quantity } = req.body;
  await run('INSERT INTO apis (title, category, price, label, description, api_details, total_quantity, available_quantity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [title, category, parseFloat(price), label || 'Random', description, api_details, parseInt(total_quantity), parseInt(total_quantity)]);
  await logAdminAction(req.session.userId, 'Add API', title, req.ip);
  res.redirect('/admin/apis');
});

router.post('/apis/:id/edit', requireAdmin, async (req, res) => {
  const { title, category, price, label, description, api_details, total_quantity } = req.body;
  const apiId = req.params.id;
  const api = await getOne('SELECT * FROM apis WHERE id = ?', [apiId]);
  const qtyDiff = parseInt(total_quantity) - (api ? api.total_quantity : 0);
  await run('UPDATE apis SET title=?, category=?, price=?, label=?, description=?, api_details=?, total_quantity=?, available_quantity = available_quantity + ? WHERE id=?',
    [title, category, parseFloat(price), label, description, api_details, parseInt(total_quantity), qtyDiff, apiId]);
  await logAdminAction(req.session.userId, 'Edit API', `API #${apiId}`, req.ip);
  res.redirect('/admin/apis');
});

router.post('/apis/:id/delete', requireAdmin, async (req, res) => {
  await run('DELETE FROM purchases WHERE api_id = ?', [req.params.id]);
  await run('DELETE FROM apis WHERE id = ?', [req.params.id]);
  await logAdminAction(req.session.userId, 'Delete API', `API #${req.params.id}`, req.ip);
  res.redirect('/admin/apis');
});

router.post('/apis/:id/toggle', requireAdmin, async (req, res) => {
  const api = await getOne('SELECT is_active FROM apis WHERE id = ?', [req.params.id]);
  await run('UPDATE apis SET is_active = ? WHERE id = ?', [api && api.is_active ? 0 : 1, req.params.id]);
  res.redirect('/admin/apis');
});

// ===== API ACTIVATIONS =====
router.get('/activations', requireAdmin, async (req, res) => {
  const purchases = await getAll("SELECT p.*, u.username, a.title as api_name FROM purchases p JOIN users u ON p.user_id = u.id JOIN apis a ON p.api_id = a.id ORDER BY p.created_at DESC");
  res.render('admin/activations', { title: 'API Activations', purchases });
});

router.post('/activations/:id/activate', requireAdmin, async (req, res) => {
  const purchase = await getOne('SELECT * FROM purchases WHERE id = ?', [req.params.id]);
  if (purchase && purchase.status === 'waiting') {
    const api = await getOne('SELECT * FROM apis WHERE id = ?', [purchase.api_id]);
    await run("UPDATE purchases SET status = 'activated', api_details = ? WHERE id = ?", [api ? api.api_details : '', req.params.id]);
    await run('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)',
      [purchase.user_id, 'API Activated', `Your API "${api ? api.title : ''}" has been activated.`]);
    await logAdminAction(req.session.userId, 'Activate API', `Purchase #${req.params.id}`, req.ip);
  }
  res.redirect('/admin/activations');
});

router.post('/activations/:id/reject', requireAdmin, async (req, res) => {
  const { reason } = req.body;
  const purchase = await getOne('SELECT * FROM purchases WHERE id = ?', [req.params.id]);
  if (purchase && purchase.status === 'waiting') {
    await run("UPDATE purchases SET status = 'rejected', rejection_reason = ? WHERE id = ?", [reason || 'Rejected by admin', req.params.id]);
    await run('UPDATE users SET balance = balance + ? WHERE id = ?', [purchase.price, purchase.user_id]);
    const api = await getOne('SELECT * FROM apis WHERE id = ?', [purchase.api_id]);
    await run('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)',
      [purchase.user_id, 'API Rejected', `Your API "${api ? api.title : ''}" was rejected. ₹${purchase.price} refunded. Reason: ${reason || 'Not specified'}`]);
    await logAdminAction(req.session.userId, 'Reject API', `Purchase #${req.params.id}, reason: ${reason}`, req.ip);
  }
  res.redirect('/admin/activations');
});

// ===== FEEDBACK MANAGEMENT =====
router.get('/feedback', requireAdmin, async (req, res) => {
  const feedbacks = await getAll('SELECT f.*, u.username FROM feedbacks f JOIN users u ON f.user_id = u.id ORDER BY f.created_at DESC');
  res.render('admin/feedback', { title: 'Feedback Management', feedbacks });
});

router.post('/feedback/:id/approve', requireAdmin, async (req, res) => {
  await run("UPDATE feedbacks SET status = 'approved' WHERE id = ?", [req.params.id]);
  await logAdminAction(req.session.userId, 'Approve Feedback', `Feedback #${req.params.id}`, req.ip);
  res.redirect('/admin/feedback');
});

router.post('/feedback/:id/reject', requireAdmin, async (req, res) => {
  await run("UPDATE feedbacks SET status = 'rejected' WHERE id = ?", [req.params.id]);
  await logAdminAction(req.session.userId, 'Reject Feedback', `Feedback #${req.params.id}`, req.ip);
  res.redirect('/admin/feedback');
});

router.post('/feedback/:id/hide', requireAdmin, async (req, res) => {
  const fb = await getOne('SELECT is_hidden FROM feedbacks WHERE id = ?', [req.params.id]);
  await run('UPDATE feedbacks SET is_hidden = ? WHERE id = ?', [fb && fb.is_hidden ? 0 : 1, req.params.id]);
  await logAdminAction(req.session.userId, 'Hide/Show Feedback', `Feedback #${req.params.id}`, req.ip);
  res.redirect('/admin/feedback');
});

router.post('/feedback/:id/delete', requireAdmin, async (req, res) => {
  await run('DELETE FROM feedbacks WHERE id = ?', [req.params.id]);
  await logAdminAction(req.session.userId, 'Delete Feedback', `Feedback #${req.params.id}`, req.ip);
  res.redirect('/admin/feedback');
});

// ===== SOCIAL TASKS =====
router.get('/tasks', requireAdmin, async (req, res) => {
  const tasks = await getAll('SELECT * FROM social_tasks ORDER BY created_at DESC');
  const completions = await getAll('SELECT tc.*, u.username, st.task_name FROM task_completions tc JOIN users u ON tc.user_id = u.id JOIN social_tasks st ON tc.task_id = st.id ORDER BY tc.created_at DESC');
  res.render('admin/tasks', { title: 'Social Tasks', tasks, completions });
});

router.post('/tasks/add', requireAdmin, async (req, res) => {
  const { platform, task_name, task_url, reward } = req.body;
  await run('INSERT INTO social_tasks (platform, task_name, task_url, reward) VALUES (?, ?, ?, ?)',
    [platform, task_name, task_url, parseFloat(reward || 0)]);
  await logAdminAction(req.session.userId, 'Add Task', task_name, req.ip);
  res.redirect('/admin/tasks');
});

router.post('/tasks/:id/toggle', requireAdmin, async (req, res) => {
  const task = await getOne('SELECT is_active FROM social_tasks WHERE id = ?', [req.params.id]);
  await run('UPDATE social_tasks SET is_active = ? WHERE id = ?', [task && task.is_active ? 0 : 1, req.params.id]);
  res.redirect('/admin/tasks');
});

router.post('/tasks/:id/delete', requireAdmin, async (req, res) => {
  await run('DELETE FROM task_completions WHERE task_id = ?', [req.params.id]);
  await run('DELETE FROM social_tasks WHERE id = ?', [req.params.id]);
  res.redirect('/admin/tasks');
});

router.post('/tasks/complete/:id/verify', requireAdmin, async (req, res) => {
  const comp = await getOne('SELECT * FROM task_completions WHERE id = ?', [req.params.id]);
  if (comp && comp.status === 'pending') {
    await run("UPDATE task_completions SET status = 'verified' WHERE id = ?", [req.params.id]);
    const task = await getOne('SELECT * FROM social_tasks WHERE id = ?', [comp.task_id]);
    if (task) {
      await run('UPDATE users SET balance = balance + ? WHERE id = ?', [task.reward, comp.user_id]);
      await run('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)',
        [comp.user_id, 'Task Reward', `₹${task.reward} reward for "${task.task_name}" has been credited!`]);
    }
  }
  res.redirect('/admin/tasks');
});

router.post('/tasks/complete/:id/reject', requireAdmin, async (req, res) => {
  await run("UPDATE task_completions SET status = 'rejected' WHERE id = ?", [req.params.id]);
  res.redirect('/admin/tasks');
});

// ===== POLICIES =====
router.get('/policies', requireAdmin, async (req, res) => {
  const policies = await getAll('SELECT * FROM policies');
  const policyMap = {};
  policies.forEach(p => { policyMap[p.policy_type] = p.content; });
  res.render('admin/policies', { title: 'Policies', policyMap });
});

router.post('/policies', requireAdmin, async (req, res) => {
  const { privacy, terms } = req.body;
  await run("UPDATE policies SET content = ?, updated_at = datetime('now') WHERE policy_type = 'privacy'", [privacy]);
  await run("UPDATE policies SET content = ?, updated_at = datetime('now') WHERE policy_type = 'terms'", [terms]);
  await logAdminAction(req.session.userId, 'Update Policies', '', req.ip);
  res.redirect('/admin/policies');
});

// ===== SETTINGS =====
router.get('/settings', requireAdmin, async (req, res) => {
  const settings = await getSettings();
  res.render('admin/settings', { title: 'Settings', settings });
});

router.post('/settings', requireAdmin, upload.single('logo'), async (req, res) => {
  const fields = ['site_name', 'logo_url', 'deposit_qr', 'upi_id', 'contact_number',
    'telegram_link', 'whatsapp_link', 'instagram_link', 'facebook_link', 'youtube_link', 'twitter_link',
    'min_deposit', 'max_deposit', 'deposit_bonus_percent', 'deposit_enabled',
    'otp_required_register', 'otp_required_login'];
  
  for (const key of fields) {
    let value = req.body[key] !== undefined ? req.body[key] : '';
    if (key === 'logo_url' && req.file) {
      value = '/uploads/' + req.file.filename;
    }
    await run('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [value, key]);
  }
  
  await logAdminAction(req.session.userId, 'Update Settings', '', req.ip);
  res.redirect('/admin/settings');
});

// ===== ADMIN MANAGEMENT (Super Admin Only) =====
router.get('/admins', requireSuperAdmin, async (req, res) => {
  const admins = await getAll('SELECT * FROM users WHERE is_admin = 1 ORDER BY created_at DESC');
  res.render('admin/admins', { title: 'Admin Management', admins });
});

router.post('/admins/create', requireSuperAdmin, async (req, res) => {
  const { full_name, username, email, password } = req.body;
  const existing = await getOne('SELECT id FROM users WHERE username = ? OR email = ?', [username, email]);
  if (existing) return res.redirect('/admin/admins');
  const hash = await bcrypt.hash(password, 10);
  await run('INSERT INTO users (full_name, username, email, password, api_address, is_admin) VALUES (?, ?, ?, ?, ?, 1)',
    [full_name, username, email, hash, 'ADMIN']);
  await logAdminAction(req.session.userId, 'Create Admin', username, req.ip);
  res.redirect('/admin/admins');
});

router.post('/admins/:id/delete', requireSuperAdmin, async (req, res) => {
  const adminId = req.params.id;
  // Don't delete self or super admin
  const target = await getOne('SELECT * FROM users WHERE id = ? AND is_admin = 1', [adminId]);
  if (target && !target.is_super_admin && adminId != req.session.userId) {
    await run('DELETE FROM admin_logs WHERE admin_id = ?', [adminId]);
    await run('DELETE FROM users WHERE id = ?', [adminId]);
    await logAdminAction(req.session.userId, 'Delete Admin', `Admin #${adminId}`, req.ip);
  }
  res.redirect('/admin/admins');
});

router.post('/admins/:id/toggle-super', requireSuperAdmin, async (req, res) => {
  const adminId = req.params.id;
  const target = await getOne('SELECT * FROM users WHERE id = ? AND is_admin = 1 AND id != ?', [adminId, req.session.userId]);
  if (target) {
    const newStatus = target.is_super_admin ? 0 : 1;
    await run('UPDATE users SET is_super_admin = ? WHERE id = ?', [newStatus, adminId]);
    await logAdminAction(req.session.userId, 'Toggle Super Admin', `Admin #${adminId} -> ${newStatus}`, req.ip);
  }
  res.redirect('/admin/admins');
});

// ===== ADMIN LOGS =====
router.get('/logs', requireAdmin, async (req, res) => {
  const logs = await getAll('SELECT al.*, u.username FROM admin_logs al JOIN users u ON al.admin_id = u.id ORDER BY al.created_at DESC LIMIT 200');
  res.render('admin/logs', { title: 'Activity Logs', logs });
});

module.exports = router;
