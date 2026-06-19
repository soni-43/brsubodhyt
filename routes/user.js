const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { getOne, getAll, run } = require('../db/database');
const { requireLogin, requireGuest } = require('../middleware/auth');

// ===== HOME =====
router.get('/', async (req, res) => {
  const apis = await getAll('SELECT * FROM apis WHERE is_active = 1 ORDER BY created_at DESC');
  const feedbacks = await getAll("SELECT f.*, u.username FROM feedbacks f JOIN users u ON f.user_id = u.id WHERE f.status = 'approved' AND f.is_hidden = 0 ORDER BY f.created_at DESC LIMIT 10");
  const tasks = await getAll('SELECT * FROM social_tasks WHERE is_active = 1 ORDER BY created_at DESC');
  // Check if user can give deposit feedback (has approved deposit without feedback)
  let canDepositFeedback = false;
  let canPurchaseFeedback = false;
  if (req.session && req.session.userId) {
    const userId = req.session.userId;
    const approvedDeposits = await getAll("SELECT d.id FROM deposits d WHERE d.user_id = ? AND d.status = 'approved'", [userId]);
    for (const dep of approvedDeposits) {
      const existing = await getOne('SELECT id FROM feedbacks WHERE deposit_id = ? AND user_id = ?', [dep.id, userId]);
      if (!existing) { canDepositFeedback = true; break; }
    }
    const approvedPurchases = await getAll("SELECT p.id FROM purchases p WHERE p.user_id = ? AND p.status = 'activated'", [userId]);
    for (const pur of approvedPurchases) {
      const existing = await getOne('SELECT id FROM feedbacks WHERE purchase_id = ? AND user_id = ?', [pur.id, userId]);
      if (!existing) { canPurchaseFeedback = true; break; }
    }
  }
  res.render('home', { apis, feedbacks, tasks, canDepositFeedback, canPurchaseFeedback, title: 'Home' });
});

// ===== LOGIN =====
router.get('/login', requireGuest, (req, res) => {
  res.render('login', { title: 'Login', error: null, otpRequired: false });
});

router.post('/login', requireGuest, async (req, res) => {
  const { username, password, otp } = req.body;
  const user = await getOne('SELECT * FROM users WHERE (username = ? OR email = ?) AND is_banned = 0', [username, username]);
  
  if (!user) {
    return res.render('login', { title: 'Login', error: 'Invalid credentials', otpRequired: false });
  }
  
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    return res.render('login', { title: 'Login', error: 'Invalid credentials', otpRequired: false });
  }

  // Check if login OTP is required
  const otpSetting = await getOne("SELECT setting_value FROM settings WHERE setting_key = 'otp_required_login'");
  if (otpSetting && otpSetting.setting_value === '1' && user.mobile) {
    if (!otp) {
      // Generate and send OTP
      const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
      await run('INSERT INTO otp_codes (mobile, code, purpose, expires_at) VALUES (?, ?, ?, datetime("now", "+5 minutes"))',
        [user.mobile, otpCode, 'login']);
      return res.render('login', { title: 'Login', error: null, otpRequired: true, otpSent: true, username, password, mobile: user.mobile });
    }
    // Verify OTP
    const otpRecord = await getOne("SELECT * FROM otp_codes WHERE mobile = ? AND code = ? AND purpose = 'login' AND used = 0 AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1", [user.mobile, otp]);
    if (!otpRecord) {
      return res.render('login', { title: 'Login', error: 'Invalid or expired OTP', otpRequired: true, username, password });
    }
    await run('UPDATE otp_codes SET used = 1 WHERE id = ?', [otpRecord.id]);
  }
  
  req.session.userId = user.id;
  req.session.isAdmin = !!user.is_admin;
  req.session.isSuperAdmin = !!user.is_super_admin;
  
  if (user.is_admin) return res.redirect('/admin');
  res.redirect('/');
});

// ===== REGISTER =====
router.get('/register', requireGuest, (req, res) => {
  res.render('register', { title: 'Register', error: null, step: 'form' });
});

router.post('/register/send-otp', requireGuest, async (req, res) => {
  const { mobile } = req.body;
  if (!mobile || mobile.length < 10) {
    return res.json({ success: false, message: 'Valid mobile number required' });
  }
  // Generate OTP
  const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
  await run("INSERT INTO otp_codes (mobile, code, purpose, expires_at) VALUES (?, ?, 'register', datetime('now', '+5 minutes'))",
    [mobile, otpCode]);
  // In production, send via SMS API. For now, return OTP (dev mode)
  console.log(`[OTP] Registration OTP for ${mobile}: ${otpCode}`);
  res.json({ success: true, message: 'OTP sent', devOtp: otpCode });
});

router.post('/register', requireGuest, async (req, res) => {
  const { full_name, username, email, password, confirm_password, api_address, mobile, otp } = req.body;
  
  if (!full_name || !username || !email || !password || !api_address || !mobile) {
    return res.render('register', { title: 'Register', error: 'All fields are required', step: 'form' });
  }
  if (password !== confirm_password) {
    return res.render('register', { title: 'Register', error: 'Passwords do not match', step: 'form' });
  }
  if (password.length < 6) {
    return res.render('register', { title: 'Register', error: 'Password must be at least 6 characters', step: 'form' });
  }

  // Check OTP requirement
  const otpSetting = await getOne("SELECT setting_value FROM settings WHERE setting_key = 'otp_required_register'");
  if (otpSetting && otpSetting.setting_value === '1') {
    if (!otp) {
      return res.render('register', { title: 'Register', error: 'OTP verification required', step: 'otp', formData: req.body });
    }
    const otpRecord = await getOne("SELECT * FROM otp_codes WHERE mobile = ? AND code = ? AND purpose = 'register' AND used = 0 AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1", [mobile, otp]);
    if (!otpRecord) {
      return res.render('register', { title: 'Register', error: 'Invalid or expired OTP', step: 'otp', formData: req.body });
    }
    await run('UPDATE otp_codes SET used = 1 WHERE id = ?', [otpRecord.id]);
  }
  
  // Check duplicates
  const existing = await getOne('SELECT id FROM users WHERE username = ? OR email = ?', [username, email]);
  if (existing) {
    return res.render('register', { title: 'Register', error: 'Username or email already exists', step: 'form' });
  }
  
  // Check mobile duplicate
  const mobileExist = await getOne('SELECT id FROM users WHERE mobile = ?', [mobile]);
  if (mobileExist) {
    return res.render('register', { title: 'Register', error: 'Mobile number already registered', step: 'form' });
  }

  // Check API address limit
  const addrCount = await getOne('SELECT COUNT(*) as count FROM users WHERE api_address = ?', [api_address]);
  if (addrCount && addrCount.count >= 2) {
    return res.render('register', { title: 'Register', error: 'Maximum 2 accounts allowed per API address', step: 'form' });
  }
  
  const hash = await bcrypt.hash(password, 10);
  const result = await run(
    'INSERT INTO users (full_name, username, email, password, mobile, api_address) VALUES (?, ?, ?, ?, ?, ?)',
    [full_name, username, email, hash, mobile, api_address]
  );
  
  req.session.userId = result.insertId;
  req.session.isAdmin = false;
  req.session.isSuperAdmin = false;
  res.redirect('/');
});

// ===== LOGOUT =====
router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// ===== DEPOSIT =====
router.get('/deposit', requireLogin, async (req, res) => {
  const depositEnabled = await getOne("SELECT setting_value FROM settings WHERE setting_key = 'deposit_enabled'");
  const minDeposit = await getOne("SELECT setting_value FROM settings WHERE setting_key = 'min_deposit'");
  const maxDeposit = await getOne("SELECT setting_value FROM settings WHERE setting_key = 'max_deposit'");
  const bonusPercent = await getOne("SELECT setting_value FROM settings WHERE setting_key = 'deposit_bonus_percent'");
  
  res.render('deposit', {
    title: 'Deposit',
    success: null,
    error: null,
    depositEnabled: depositEnabled ? depositEnabled.setting_value === '1' : true,
    minDeposit: minDeposit ? minDeposit.setting_value : '100',
    maxDeposit: maxDeposit ? maxDeposit.setting_value : '50000',
    bonusPercent: bonusPercent ? bonusPercent.setting_value : '0'
  });
});

router.post('/deposit', requireLogin, async (req, res) => {
  const { amount, transaction_id } = req.body;
  
  // Check deposit enabled
  const depositEnabled = await getOne("SELECT setting_value FROM settings WHERE setting_key = 'deposit_enabled'");
  if (depositEnabled && depositEnabled.setting_value !== '1') {
    return res.render('deposit', { title: 'Deposit', success: null, error: 'Deposits are currently disabled', depositEnabled: false, minDeposit: '100', maxDeposit: '50000', bonusPercent: '0' });
  }
  
  const minDep = await getOne("SELECT setting_value FROM settings WHERE setting_key = 'min_deposit'");
  const maxDep = await getOne("SELECT setting_value FROM settings WHERE setting_key = 'max_deposit'");
  const minAmount = parseFloat(minDep ? minDep.setting_value : '100');
  const maxAmount = parseFloat(maxDep ? maxDep.setting_value : '50000');
  
  if (!amount || !transaction_id) {
    return res.render('deposit', { title: 'Deposit', success: null, error: 'All fields are required', depositEnabled: true, minDeposit: minAmount, maxDeposit: maxAmount, bonusPercent: '0' });
  }
  
  const amt = parseFloat(amount);
  if (amt < minAmount) {
    return res.render('deposit', { title: 'Deposit', success: null, error: `Minimum deposit is ₹${minAmount}`, depositEnabled: true, minDeposit: minAmount, maxDeposit: maxAmount, bonusPercent: '0' });
  }
  if (amt > maxAmount) {
    return res.render('deposit', { title: 'Deposit', success: null, error: `Maximum deposit is ₹${maxAmount}`, depositEnabled: true, minDeposit: minAmount, maxDeposit: maxAmount, bonusPercent: '0' });
  }
  
  await run('INSERT INTO deposits (user_id, amount, transaction_id) VALUES (?, ?, ?)',
    [req.session.userId, amt, transaction_id]);
  
  res.render('deposit', { title: 'Deposit', success: 'Deposit request submitted successfully!', error: null, depositEnabled: true, minDeposit: minAmount, maxDeposit: maxAmount, bonusPercent: '0' });
});

// ===== DEPOSIT FEEDBACK =====
router.post('/deposit/feedback', requireLogin, async (req, res) => {
  const { deposit_id, name, rating, message } = req.body;
  const userId = req.session.userId;
  
  // Verify deposit is approved and belongs to user
  const deposit = await getOne("SELECT * FROM deposits WHERE id = ? AND user_id = ? AND status = 'approved'", [deposit_id, userId]);
  if (!deposit) {
    return res.json({ success: false, message: 'Invalid deposit' });
  }
  
  // Check if feedback already exists for this deposit
  const existing = await getOne('SELECT id FROM feedbacks WHERE deposit_id = ? AND user_id = ?', [deposit_id, userId]);
  if (existing) {
    return res.json({ success: false, message: 'Feedback already submitted for this deposit' });
  }
  
  await run(
    'INSERT INTO feedbacks (user_id, deposit_id, type, name, rating, message) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, deposit_id, 'deposit', name, parseInt(rating), message]
  );
  
  res.json({ success: true });
});

// ===== PURCHASE FEEDBACK =====
router.post('/purchase/feedback', requireLogin, async (req, res) => {
  const { purchase_id, name, rating, message } = req.body;
  const userId = req.session.userId;
  
  // Verify purchase is activated and belongs to user
  const purchase = await getOne("SELECT * FROM purchases WHERE id = ? AND user_id = ? AND status = 'activated'", [purchase_id, userId]);
  if (!purchase) {
    return res.json({ success: false, message: 'Invalid purchase' });
  }
  
  // Check if feedback already exists
  const existing = await getOne('SELECT id FROM feedbacks WHERE purchase_id = ? AND user_id = ?', [purchase_id, userId]);
  if (existing) {
    return res.json({ success: false, message: 'Feedback already submitted for this purchase' });
  }
  
  await run(
    'INSERT INTO feedbacks (user_id, purchase_id, type, name, rating, message) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, purchase_id, 'purchase', name, parseInt(rating), message]
  );
  
  res.json({ success: true });
});

// ===== PROFILE =====
router.get('/profile', requireLogin, async (req, res) => {
  const user = await getOne('SELECT * FROM users WHERE id = ?', [req.session.userId]);
  // Get eligible deposits for feedback
  const depositsForFeedback = await getAll(
    "SELECT d.* FROM deposits d WHERE d.user_id = ? AND d.status = 'approved' AND NOT EXISTS (SELECT 1 FROM feedbacks f WHERE f.deposit_id = d.id AND f.user_id = d.user_id)",
    [req.session.userId]
  );
  // Get eligible purchases for feedback
  const purchasesForFeedback = await getAll(
    "SELECT p.*, a.title as api_name FROM purchases p JOIN apis a ON p.api_id = a.id WHERE p.user_id = ? AND p.status = 'activated' AND NOT EXISTS (SELECT 1 FROM feedbacks f WHERE f.purchase_id = p.id AND f.user_id = p.user_id)",
    [req.session.userId]
  );
  res.render('profile', { title: 'Profile', user, depositsForFeedback, purchasesForFeedback });
});

// ===== TRANSACTIONS =====
router.get('/transactions', requireLogin, async (req, res) => {
  const userId = req.session.userId;
  const deposits = await getAll('SELECT * FROM deposits WHERE user_id = ? ORDER BY created_at DESC', [userId]);
  const purchases = await getAll('SELECT p.*, a.title as api_name FROM purchases p JOIN apis a ON p.api_id = a.id WHERE p.user_id = ? ORDER BY p.created_at DESC', [userId]);
  res.render('transactions', { title: 'Transactions', deposits, purchases });
});

// ===== API HISTORY =====
router.get('/api-history', requireLogin, async (req, res) => {
  const userId = req.session.userId;
  const purchases = await getAll(
    'SELECT p.*, a.title as api_name, a.category FROM purchases p JOIN apis a ON p.api_id = a.id WHERE p.user_id = ? ORDER BY p.created_at DESC',
    [userId]
  );
  res.render('api-history', { title: 'API History', purchases });
});

// ===== PURCHASE API =====
router.post('/purchase/:id', requireLogin, async (req, res) => {
  const apiId = req.params.id;
  const userId = req.session.userId;
  
  const api = await getOne('SELECT * FROM apis WHERE id = ? AND is_active = 1', [apiId]);
  if (!api) return res.json({ success: false, message: 'API not found' });
  
  const user = await getOne('SELECT * FROM users WHERE id = ?', [userId]);
  if (user.balance < api.price) return res.json({ success: false, message: 'Insufficient balance' });
  if (api.available_quantity <= 0) return res.json({ success: false, message: 'API out of stock' });
  
  await run('UPDATE users SET balance = balance - ?, total_purchases = total_purchases + 1 WHERE id = ?', [api.price, userId]);
  await run('UPDATE apis SET available_quantity = available_quantity - 1 WHERE id = ?', [apiId]);
  await run('INSERT INTO purchases (user_id, api_id, price) VALUES (?, ?, ?)', [userId, apiId, api.price]);
  await run('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)',
    [userId, 'API Purchased', `You purchased "${api.title}" for ₹${api.price}. Waiting for activation.`]);
  
  res.json({ success: true, message: 'API purchased successfully!' });
});

// ===== SOCIAL TASKS =====
router.post('/task/complete/:id', requireLogin, async (req, res) => {
  const taskId = req.params.id;
  const userId = req.session.userId;
  
  const task = await getOne('SELECT * FROM social_tasks WHERE id = ? AND is_active = 1', [taskId]);
  if (!task) return res.json({ success: false, message: 'Task not found' });
  
  // Check if already completed
  const existing = await getOne('SELECT * FROM task_completions WHERE user_id = ? AND task_id = ?', [userId, taskId]);
  if (existing) return res.json({ success: false, message: 'Task already submitted' });
  
  await run('INSERT INTO task_completions (user_id, task_id) VALUES (?, ?)', [userId, taskId]);
  await run('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)',
    [userId, 'Task Submitted', `Your task "${task.task_name}" is pending verification.`]);
  
  res.json({ success: true, message: 'Task submitted for verification!' });
});

// ===== NOTIFICATIONS =====
router.get('/notifications', requireLogin, async (req, res) => {
  const userId = req.session.userId;
  const notifications = await getAll('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [userId]);
  await run('UPDATE notifications SET is_read = 1 WHERE user_id = ?', [userId]);
  res.render('notifications', { title: 'Notifications', notifications });
});

router.get('/api/unread-count', requireLogin, async (req, res) => {
  const notif = await getOne('SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0', [req.session.userId]);
  res.json({ count: notif ? notif.count : 0 });
});

// ===== PRIVACY POLICY =====
router.get('/privacy', (req, res) => {
  res.render('policy', { title: 'Privacy Policy', policyType: 'privacy' });
});

// ===== TERMS & CONDITIONS =====
router.get('/terms', (req, res) => {
  res.render('policy', { title: 'Terms & Conditions', policyType: 'terms' });
});

module.exports = router;
