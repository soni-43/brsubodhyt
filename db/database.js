const path = require('path');

let db;
let dbType;

function initDatabase() {
  if (process.env.DATABASE_URL) {
    dbType = 'mysql';
    const mysql = require('mysql2/promise');
    db = mysql.createPool(process.env.DATABASE_URL, {
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });
    console.log('[DB] Using MySQL (production)');
  } else {
    dbType = 'sqlite';
    const Database = require('better-sqlite3');
    db = new Database(path.join(__dirname, '..', 'data.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    console.log('[DB] Using SQLite (local)');
  }
}

// Unified query interface
async function query(sql, params = []) {
  if (dbType === 'sqlite') {
    const trimmed = sql.trim().toUpperCase();
    if (trimmed.startsWith('INSERT')) {
      const stmt = db.prepare(sql);
      const info = stmt.run(...params);
      return { insertId: info.lastInsertRowid, affectedRows: info.changes };
    } else if (trimmed.startsWith('UPDATE') || trimmed.startsWith('DELETE')) {
      const stmt = db.prepare(sql);
      const info = stmt.run(...params);
      return { affectedRows: info.changes };
    } else if (trimmed.startsWith('CREATE') || trimmed.startsWith('ALTER') || trimmed.startsWith('DROP')) {
      db.exec(sql);
      return {};
    } else {
      const stmt = db.prepare(sql);
      return stmt.all(...params);
    }
  } else {
    // MySQL
    const trimmed = sql.trim().toUpperCase();
    // Convert ? placeholders to ? (both use ? so no conversion needed)
    if (trimmed.startsWith('INSERT') || trimmed.startsWith('UPDATE') || trimmed.startsWith('DELETE')) {
      const [result] = await db.execute(sql, params);
      return { insertId: result.insertId, affectedRows: result.affectedRows };
    } else if (trimmed.startsWith('CREATE') || trimmed.startsWith('ALTER') || trimmed.startsWith('DROP')) {
      await db.execute(sql);
      return {};
    } else {
      const [rows] = await db.execute(sql, params);
      return rows;
    }
  }
}

async function getOne(sql, params = []) {
  const rows = await query(sql, params);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function getAll(sql, params = []) {
  const rows = await query(sql, params);
  return Array.isArray(rows) ? rows : [];
}

async function run(sql, params = []) {
  return query(sql, params);
}

async function migrate() {
  const isSQLite = dbType === 'sqlite';
  const AI = isSQLite ? 'AUTOINCREMENT' : 'AUTO_INCREMENT';
  const INT = isSQLite ? 'INTEGER' : 'INT';
  const BOOL = isSQLite ? 'INTEGER' : 'TINYINT(1)';
  const DEC = isSQLite ? 'REAL' : 'DECIMAL(12,2)';
  const DEC10 = isSQLite ? 'REAL' : 'DECIMAL(10,2)';
  const TS = isSQLite ? "TEXT DEFAULT (datetime('now'))" : 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP';

  const tables = [
    `CREATE TABLE IF NOT EXISTS users (
      id ${INT} PRIMARY KEY ${AI},
      full_name VARCHAR(255) NOT NULL,
      username VARCHAR(100) UNIQUE NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      mobile VARCHAR(20),
      api_address VARCHAR(500) NOT NULL,
      balance ${DEC} DEFAULT 0,
      total_deposits ${DEC} DEFAULT 0,
      total_purchases INTEGER DEFAULT 0,
      is_admin ${BOOL} DEFAULT 0,
      is_super_admin ${BOOL} DEFAULT 0,
      is_banned ${BOOL} DEFAULT 0,
      last_login ${TS},
      created_at ${TS}
    )`,
    `CREATE TABLE IF NOT EXISTS apis (
      id ${INT} PRIMARY KEY ${AI},
      title VARCHAR(255) NOT NULL,
      category VARCHAR(100) NOT NULL,
      price ${DEC10} NOT NULL,
      label VARCHAR(50) DEFAULT 'Random',
      description TEXT,
      api_details TEXT,
      total_quantity INTEGER DEFAULT 0,
      available_quantity INTEGER DEFAULT 0,
      is_active ${BOOL} DEFAULT 1,
      created_at ${TS}
    )`,
    `CREATE TABLE IF NOT EXISTS purchases (
      id ${INT} PRIMARY KEY ${AI},
      user_id INTEGER NOT NULL,
      api_id INTEGER NOT NULL,
      price ${DEC10} NOT NULL,
      status VARCHAR(50) DEFAULT 'waiting',
      api_details TEXT,
      rejection_reason TEXT,
      created_at ${TS},
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (api_id) REFERENCES apis(id)
    )`,
    `CREATE TABLE IF NOT EXISTS deposits (
      id ${INT} PRIMARY KEY ${AI},
      user_id INTEGER NOT NULL,
      amount ${DEC10} NOT NULL,
      transaction_id VARCHAR(255) NOT NULL,
      status VARCHAR(50) DEFAULT 'pending',
      created_at ${TS},
      FOREIGN KEY (user_id) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS notifications (
      id ${INT} PRIMARY KEY ${AI},
      user_id INTEGER NOT NULL,
      title VARCHAR(255) NOT NULL,
      message TEXT,
      is_read ${BOOL} DEFAULT 0,
      created_at ${TS},
      FOREIGN KEY (user_id) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS settings (
      id ${INT} PRIMARY KEY ${AI},
      setting_key VARCHAR(100) UNIQUE NOT NULL,
      setting_value TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS otp_codes (
      id ${INT} PRIMARY KEY ${AI},
      mobile VARCHAR(20) NOT NULL,
      code VARCHAR(10) NOT NULL,
      purpose VARCHAR(50) NOT NULL,
      expires_at ${TS},
      used ${BOOL} DEFAULT 0,
      created_at ${TS}
    )`,
    `CREATE TABLE IF NOT EXISTS feedbacks (
      id ${INT} PRIMARY KEY ${AI},
      user_id ${INT} NOT NULL,
      deposit_id ${INT},
      purchase_id ${INT},
      type VARCHAR(50) NOT NULL,
      name VARCHAR(255) NOT NULL,
      rating ${INT} NOT NULL,
      message TEXT,
      status VARCHAR(50) DEFAULT 'pending',
      is_hidden ${BOOL} DEFAULT 0,
      created_at ${TS},
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (deposit_id) REFERENCES deposits(id),
      FOREIGN KEY (purchase_id) REFERENCES purchases(id)
    )`,
    `CREATE TABLE IF NOT EXISTS social_tasks (
      id ${INT} PRIMARY KEY ${AI},
      platform VARCHAR(100) NOT NULL,
      task_name VARCHAR(255) NOT NULL,
      task_url TEXT,
      reward ${DEC10} DEFAULT 0,
      is_active ${BOOL} DEFAULT 1,
      created_at ${TS}
    )`,
    `CREATE TABLE IF NOT EXISTS task_completions (
      id ${INT} PRIMARY KEY ${AI},
      user_id ${INT} NOT NULL,
      task_id ${INT} NOT NULL,
      status VARCHAR(50) DEFAULT 'pending',
      created_at ${TS},
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (task_id) REFERENCES social_tasks(id)
    )`,
    `CREATE TABLE IF NOT EXISTS admin_logs (
      id ${INT} PRIMARY KEY ${AI},
      admin_id ${INT} NOT NULL,
      action VARCHAR(255) NOT NULL,
      details TEXT,
      ip_address VARCHAR(50),
      created_at ${TS},
      FOREIGN KEY (admin_id) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS policies (
      id ${INT} PRIMARY KEY ${AI},
      policy_type VARCHAR(50) UNIQUE NOT NULL,
      content TEXT,
      updated_at ${TS}
    )`
  ];

  for (const sql of tables) {
    await query(sql);
  }

  // Add new columns to existing tables (safe migration)
  const addColumnSafe = async (table, column, definition) => {
    try {
      if (dbType === 'sqlite') {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all();
        if (!cols.find(c => c.name === column)) {
          await query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        }
      } else {
        const [cols] = await db.query(`SHOW COLUMNS FROM ${table} LIKE '${column}'`);
        if (cols.length === 0) {
          await query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        }
      }
    } catch (e) { /* column may already exist */ }
  };

  await addColumnSafe('users', 'mobile', 'VARCHAR(20)');
  await addColumnSafe('users', 'is_super_admin', `${BOOL} DEFAULT 0`);
  await addColumnSafe('users', 'last_login', TS);
  await addColumnSafe('purchases', 'rejection_reason', 'TEXT');

  // Insert default settings if not exist
  const defaultSettings = [
    ['site_name', 'BR SUBODH YT'],
    ['logo_url', ''],
    ['deposit_qr', ''],
    ['upi_id', ''],
    ['contact_number', ''],
    ['telegram_link', ''],
    ['whatsapp_link', ''],
    ['instagram_link', ''],
    ['facebook_link', ''],
    ['youtube_link', ''],
    ['twitter_link', ''],
    ['admin_username', 'admin'],
    ['admin_password_hash', ''],
    ['min_deposit', '100'],
    ['max_deposit', '50000'],
    ['deposit_bonus_percent', '0'],
    ['deposit_enabled', '1'],
    ['otp_required_register', '1'],
    ['otp_required_login', '0']
  ];

  for (const [key, value] of defaultSettings) {
    const existing = await getOne('SELECT id FROM settings WHERE setting_key = ?', [key]);
    if (!existing) {
      await run('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)', [key, value]);
    }
  }

  // Create default admin if not exists
  const admin = await getOne('SELECT id FROM users WHERE is_admin = 1');
  if (!admin) {
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('admin123', 10);
    await run(
      'INSERT INTO users (full_name, username, email, password, api_address, is_admin, is_super_admin) VALUES (?, ?, ?, ?, ?, 1, 1)',
      ['Super Admin', 'admin', 'admin@brsubodh.com', hash, 'ADMIN']
    );
    console.log('[DB] Default super admin created (admin / admin123)');
  }

  // Insert default policies if not exist
  const defaultPolicies = [
    ['privacy', 'Privacy Policy\n\nWe respect your privacy. Your data is used only for account management and service delivery.'],
    ['terms', 'Terms & Conditions\n\nBy using this service, you agree to our terms. Misuse may result in account ban.']
  ];

  for (const [type, content] of defaultPolicies) {
    const existing = await getOne('SELECT id FROM policies WHERE policy_type = ?', [type]);
    if (!existing) {
      await run('INSERT INTO policies (policy_type, content) VALUES (?, ?)', [type, content]);
    }
  }

  console.log('[DB] Migration complete');
}

module.exports = { initDatabase, migrate, query, getOne, getAll, run, getDbType: () => dbType };
