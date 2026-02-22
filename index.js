require('dotenv').config(); 
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { OAuth2Client } = require('google-auth-library');
const bcrypt = require('bcrypt');

// (Optional) Used for Telegram Bot notifications
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args)).catch(() => null);

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const ADMIN_EMAIL = 'nguitui.kamau@gmail.com';

// --- AUTO-DATABASE UPGRADE ON STARTUP ---
pool.connect(async (err, client, release) => {
  if (err) return console.error('Error acquiring cloud client', err.stack);
  console.log('✅ Successfully connected to Neon Cloud Database!');
  
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS theses (
        id SERIAL PRIMARY KEY,
        bet_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        market_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    // Auto-inject the new Creator/Approval columns without crashing
    await client.query('ALTER TABLE markets ADD COLUMN IF NOT EXISTS creator_id INTEGER REFERENCES users(id);');
    
    // We set default TRUE for existing markets so your old ones don't vanish!
    await client.query('ALTER TABLE markets ADD COLUMN IF NOT EXISTS is_approved BOOLEAN DEFAULT TRUE;');
    await client.query('ALTER TABLE markets ADD COLUMN IF NOT EXISTS admin_notes TEXT;');

    console.log('✅ Database Schema is fully up-to-date!');
  } catch (tableErr) {
    console.error('Error verifying tables:', tableErr);
  }
  release();
});

// --- AUTH ROUTES ---
app.post('/api/auth/login', async (req, res) => {
  const { credential } = req.body; 
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const email = payload.email.toLowerCase();
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length > 0) {
      res.json({ isNewUser: false, user: result.rows[0], email: email });
    } else {
      res.json({ isNewUser: true, email: email });
    }
  } catch (err) {
    res.status(401).json({ error: 'Invalid Google Security Token' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body;
  const cleanEmail = email.toLowerCase().trim();
  try {
    const existing = await pool.query('SELECT * FROM users WHERE email = $1', [cleanEmail]);
    if (existing.rows.length > 0) return res.status(400).json({ error: 'Email already registered.' });
    const hash = await bcrypt.hash(password, 10);
    await pool.query('INSERT INTO users (email, password_hash) VALUES ($1, $2)', [cleanEmail, hash]);
    res.json({ isNewUser: true, email: cleanEmail });
  } catch (err) {
    res.status(500).json({ error: 'Server error during registration' });
  }
});

app.post('/api/auth/login-email', async (req, res) => {
  const { email, password } = req.body;
  const cleanEmail = email.toLowerCase().trim();
  try {
    const userRes = await pool.query('SELECT * FROM users WHERE email = $1', [cleanEmail]);
    if (userRes.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials.' });
    const user = userRes.rows[0];
    if (!user.password_hash) return res.status(401).json({ error: 'Use Google Sign-In for this account.' });
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials.' });
    res.json({ isNewUser: user.nickname == null, user, email: cleanEmail });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// --- USER MANAGEMENT ---
app.put('/api/users/nickname', async (req, res) => {
  const { email, nickname, phone_number } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO users (email, nickname, phone_number, balance_kes) VALUES ($1, $2, $3, 0) ON CONFLICT (email) DO UPDATE SET nickname = $2, phone_number = $3 RETURNING *',
      [email, nickname, phone_number]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Nickname already taken!" });
  }
});

app.get('/api/balance/:email', async (req, res) => {
  try {
    const result = await pool.query('SELECT balance_kes FROM users WHERE email = $1', [req.params.email]);
    if (result.rows.length > 0) res.json({ balance_kes: result.rows[0].balance_kes });
    else res.status(404).json({ error: 'User not found' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- MARKETS & CREATION (WITH APPROVAL QUEUE) ---
app.get('/api/markets', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT m.*, COALESCE(COUNT(DISTINCT b.user_id), 0) AS traders_count
      FROM markets m
      LEFT JOIN bets b ON m.id = b.market_id
      WHERE m.is_approved = TRUE
      GROUP BY m.id
      ORDER BY m.id DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/markets', async (req, res) => {
  const { email, title, option_a, option_b, category, end_date } = req.body;
  const client = await pool.connect();
  const LISTING_FEE = 200;

  try {
    await client.query('BEGIN');
    const userRes = await client.query('SELECT id, balance_kes, is_admin FROM users WHERE email = $1', [email]);
    if (userRes.rows.length === 0) throw new Error('User not found.');
    const user = userRes.rows[0];

    // Deduct fee if not admin
    if (!user.is_admin) {
      if (parseFloat(user.balance_kes) < LISTING_FEE) throw new Error('Insufficient funds.');
      await client.query('UPDATE users SET balance_kes = balance_kes - $1 WHERE id = $2', [LISTING_FEE, user.id]);
    }

    const result = await client.query(
      'INSERT INTO markets (title, option_a, option_b, category, end_date, creator_id, is_approved) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [title, option_a, option_b, category, end_date, user.id, user.is_admin] 
    );

    // Telegram Bot Alert logic
    if (!user.is_admin && process.env.TELEGRAM_BOT_TOKEN) {
      const telegramMessage = `🚨 *New Market Pending!*\n\n👤 *Creator:* ${email}\n❓ *Question:* ${title}\n⚖️ *Options:* ${option_a} vs ${option_b}\n💰 *Escrow:* KES 200 collected.`;
      try {
        if (typeof fetch === 'function') {
           await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: telegramMessage, parse_mode: 'Markdown' })
           });
        }
      } catch (e) { console.error("Telegram error:", e); }
    }

    await client.query('COMMIT');
    res.json({ message: user.is_admin ? "Market created!" : "Market submitted for approval!", market: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// --- ADMIN APPROVAL ENGINE ---
app.get('/api/admin/pending-markets', async (req, res) => {
    try {
        const result = await pool.query('SELECT m.*, u.nickname as creator_name FROM markets m JOIN users u ON m.creator_id = u.id WHERE m.is_approved = FALSE');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/approve-market', async (req, res) => {
    const { market_id, action } = req.body; 
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        if (action === 'approve') {
            await client.query('UPDATE markets SET is_approved = TRUE WHERE id = $1', [market_id]);
        } else {
            const market = (await client.query('SELECT creator_id FROM markets WHERE id = $1', [market_id])).rows[0];
            await client.query('UPDATE users SET balance_kes = balance_kes + 200 WHERE id = $1', [market.creator_id]);
            await client.query('DELETE FROM markets WHERE id = $1', [market_id]);
        }
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// --- TRADING & RESOLUTION ---
app.post('/api/bet', async (req, res) => {
  const { email, market_id, chosen_option, amount_kes, thesis } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userRes = await client.query('SELECT id, balance_kes FROM users WHERE email = $1', [email]);
    if (userRes.rows.length === 0) throw new Error('User not found.');
    const user = userRes.rows[0];
    if (user.balance_kes < amount_kes) throw new Error('Insufficient balance.');

    await client.query('UPDATE users SET balance_kes = balance_kes - $1::numeric WHERE id = $2', [amount_kes, user.id]);
    const poolColumn = chosen_option === 'A' ? 'option_a_pool' : 'option_b_pool';
    await client.query(`UPDATE markets SET ${poolColumn} = ${poolColumn} + $1::numeric WHERE id = $2`, [amount_kes, market_id]);

    const betRes = await client.query(
      'INSERT INTO bets (user_id, market_id, chosen_option, amount_kes) VALUES ($1, $2, $3, $4) RETURNING *',
      [user.id, market_id, chosen_option, amount_kes]
    );

    if (thesis && thesis.trim() !== '' && amount_kes >= 50) {
      await client.query('INSERT INTO theses (bet_id, user_id, market_id, content) VALUES ($1, $2, $3, $4)', [betRes.rows[0].id, user.id, market_id, thesis]);
    }
    await client.query('COMMIT'); 
    res.json(betRes.rows[0]); 
  } catch (err) {
    await client.query('ROLLBACK'); 
    res.status(400).json({ message: err.message });
  } finally {
    client.release(); 
  }
});

// 🚨 RESTORED: GET A USER'S HISTORY 🚨
app.get('/api/bets', async (req, res) => {
  const { email } = req.query;
  try {
    const result = await pool.query(`
      SELECT b.id, b.chosen_option, b.amount_kes, b.placed_at,
             m.title, m.is_resolved, m.winning_option, m.option_a, m.option_b, 
             m.option_a_pool, m.option_b_pool
      FROM bets b
      JOIN users u ON b.user_id = u.id
      JOIN markets m ON b.market_id = m.id
      WHERE u.email = $1
      ORDER BY b.placed_at DESC
    `, [email]);

    const betsWithPayouts = result.rows.map(bet => {
      const stake = parseFloat(bet.amount_kes);
      let totalPayout = 0;
      let status = 'Pending';

      if (bet.is_resolved) {
        if (bet.winning_option === 'Refunded') {
          status = 'Refunded';
          totalPayout = stake; 
        } else if (bet.chosen_option === bet.winning_option) {
          status = 'Won';
          const poolA = parseFloat(bet.option_a_pool || 0);
          const poolB = parseFloat(bet.option_b_pool || 0);
          const totalPool = poolA + poolB;
          const winningPool = bet.winning_option === 'A' ? poolA : poolB;
          const losingPool = bet.winning_option === 'A' ? poolB : poolA;

          const fee = totalPool < 1000 ? 0 : 0.05;
          const distributableProfit = losingPool - (losingPool * fee);
          const share = stake / winningPool;

          totalPayout = stake + (share * distributableProfit);
        } else {
          status = 'Lost';
        }
      }
      return { ...bet, status, payout_kes: totalPayout };
    });
    res.json(betsWithPayouts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/resolve', async (req, res) => {
  const { market_id, winning_option } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const marketRes = await client.query('SELECT * FROM markets WHERE id = $1 FOR UPDATE', [market_id]);
    const market = marketRes.rows[0];
    if (market.is_resolved) throw new Error('Already resolved.');

    let winLetter = winning_option.toLowerCase().trim() === 'a' || winning_option.trim() === market.option_a ? 'A' : 'B';
    const poolA = parseFloat(market.option_a_pool || 0);
    const poolB = parseFloat(market.option_b_pool || 0);
    const totalPool = poolA + poolB;

    if (poolA === 0 || poolB === 0) {
      const allBets = await client.query('SELECT user_id, amount_kes FROM bets WHERE market_id = $1', [market_id]);
      for (const bet of allBets.rows) {
        await client.query('UPDATE users SET balance_kes = balance_kes + $1 WHERE id = $2', [bet.amount_kes, bet.user_id]);
      }
      await client.query("UPDATE markets SET is_resolved = TRUE, winning_option = 'Refunded' WHERE id = $1", [market_id]);
    } else {
      await client.query('UPDATE markets SET is_resolved = TRUE, winning_option = $1 WHERE id = $2', [winLetter, market_id]);
      const losingPool = winLetter === 'A' ? poolB : poolA;
      const winningPool = winLetter === 'A' ? poolA : poolB;

      const totalFee = totalPool < 1000 ? 0 : losingPool * 0.05;
      const creatorRoyalty = totalPool < 1000 ? 0 : losingPool * 0.005; // 0.5%
      const adminCut = totalFee - creatorRoyalty;

      if (creatorRoyalty > 0 && market.creator_id) {
        await client.query('UPDATE users SET balance_kes = balance_kes + $1 WHERE id = $2', [creatorRoyalty, market.creator_id]);
      }
      if (adminCut > 0) {
        await client.query('UPDATE users SET balance_kes = balance_kes + $1 WHERE email = $2', [adminCut, ADMIN_EMAIL]);
      }

      const winBets = await client.query('SELECT user_id, amount_kes FROM bets WHERE market_id = $1 AND chosen_option = $2', [market_id, winLetter]);
      for (const bet of winBets.rows) {
        const payout = parseFloat(bet.amount_kes) + (parseFloat(bet.amount_kes) / winningPool * (losingPool - totalFee));
        await client.query('UPDATE users SET balance_kes = balance_kes + $1 WHERE id = $2', [payout, bet.user_id]);
      }
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// --- UTILS ---
app.get('/api/theses/:market_id', async (req, res) => {
  try {
    const result = await pool.query('SELECT t.*, u.nickname, b.chosen_option, b.amount_kes FROM theses t JOIN users u ON t.user_id = u.id JOIN bets b ON t.bet_id = b.id WHERE t.market_id = $1 ORDER BY b.amount_kes DESC', [req.params.market_id]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const result = await pool.query(`SELECT u.id, u.nickname, u.email, u.balance_kes as balance, COUNT(b.id) as total_bets, COUNT(CASE WHEN m.is_resolved = TRUE AND b.chosen_option = m.winning_option THEN 1 END) as won_bets, COUNT(CASE WHEN m.is_resolved = TRUE THEN 1 END) as resolved_bets FROM users u LEFT JOIN bets b ON u.id = b.user_id LEFT JOIN markets m ON b.market_id = m.id WHERE u.nickname IS NOT NULL GROUP BY u.id, u.nickname, u.email, u.balance_kes ORDER BY won_bets DESC, balance DESC LIMIT 100`);
    res.json(result.rows.map(r => ({ ...r, winRate: r.resolved_bets > 0 ? Math.round((r.won_bets/r.resolved_bets)*100) : 0 })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/deposit', async (req, res) => {
  const { email, amount_kes } = req.body;
  try {
    const result = await pool.query('UPDATE users SET balance_kes = balance_kes + $1 WHERE email = $2 RETURNING balance_kes', [amount_kes, email]);
    res.json({ success: true, new_balance: result.rows[0].balance_kes });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(port, () => console.log(`🚀 UniStake Engine running on port ${port}`));