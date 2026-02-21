require('dotenv').config(); 
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { OAuth2Client } = require('google-auth-library');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// --- CLOUD DATABASE CONNECTION (Neon) ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false 
  }
});

// Test the connection to the cloud & Initialize New Tables!
pool.connect(async (err, client, release) => {
  if (err) {
    return console.error('Error acquiring cloud client', err.stack);
  }
  console.log('✅ Successfully connected to Neon Cloud Database!');
  
  // NEW: Auto-create the theses table for Phase 1 if it doesn't exist
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
    console.log('✅ Theses table is ready!');
  } catch (tableErr) {
    console.error('Error creating theses table:', tableErr);
  }
  
  release();
});

// --- 1. SECURE GOOGLE AUTH / LOGIN ---
app.post('/api/auth/login', async (req, res) => {
  const { credential } = req.body; 

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    
    const payload = ticket.getPayload();
    const email = payload.email.toLowerCase();

    // UPDATE: Removed @strathmore.edu restriction! Any valid email works.
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    
    if (result.rows.length > 0) {
      res.json({ isNewUser: false, user: result.rows[0], email: email });
    } else {
      res.json({ isNewUser: true, email: email });
    }
  } catch (err) {
    console.error("Auth Error:", err);
    res.status(401).json({ error: 'Invalid Google Security Token' });
  }
});

// --- 2. UPDATE NICKNAME ---
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

// --- 3. LIVE BALANCE SYNC ---
app.get('/api/balance/:email', async (req, res) => {
  try {
    const result = await pool.query('SELECT balance_kes FROM users WHERE email = $1', [req.params.email]);
    if (result.rows.length > 0) {
      res.json({ balance_kes: result.rows[0].balance_kes });
    } else {
      res.status(404).json({ error: 'User not found' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- 4. MARKETS ---
app.get('/api/markets', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        m.*, 
        COALESCE(COUNT(DISTINCT b.user_id), 0) AS traders_count
      FROM markets m
      LEFT JOIN bets b ON m.id = b.market_id
      GROUP BY m.id
      ORDER BY m.id DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("Market Fetch Error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/markets', async (req, res) => {
  const { title, option_a, option_b, category, end_date } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO markets (title, option_a, option_b, category, end_date) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [title, option_a, option_b, category, end_date]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- 5. DEPOSIT ---
app.post('/api/deposit', async (req, res) => {
  const { email, amount_kes } = req.body;
  try {
    const result = await pool.query(
      'UPDATE users SET balance_kes = balance_kes + $1::numeric WHERE email = $2 RETURNING balance_kes',
      [amount_kes, email]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'User not found.' });
    res.json({ success: true, message: 'Deposit successful!', new_balance: result.rows[0].balance_kes });
  } catch (err) {
    console.error("Deposit Error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- 6. PLACE A TRADE (WITH THESIS) ---
app.post('/api/bet', async (req, res) => {
  // NEW: Accepting 'thesis' from the frontend
  const { email, market_id, chosen_option, amount_kes, thesis } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const userRes = await client.query('SELECT id, balance_kes FROM users WHERE email = $1', [email]);
    if (userRes.rows.length === 0) throw new Error('User not found.');
    
    const user = userRes.rows[0];
    if (user.balance_kes < amount_kes) throw new Error('Insufficient KES balance.');

    await client.query('UPDATE users SET balance_kes = balance_kes - $1::numeric WHERE id = $2', [amount_kes, user.id]);

    const poolColumn = chosen_option === 'A' ? 'option_a_pool' : 'option_b_pool';
    await client.query(`UPDATE markets SET ${poolColumn} = ${poolColumn} + $1::numeric WHERE id = $2`, [amount_kes, market_id]);

    const betRes = await client.query(
      'INSERT INTO bets (user_id, market_id, chosen_option, amount_kes) VALUES ($1, $2, $3, $4) RETURNING *',
      [user.id, market_id, chosen_option, amount_kes]
    );

    // NEW: The "Skin in the Game" Thesis insertion!
    if (thesis && thesis.trim() !== '' && amount_kes >= 50) {
      await client.query(
        'INSERT INTO theses (bet_id, user_id, market_id, content) VALUES ($1, $2, $3, $4)',
        [betRes.rows[0].id, user.id, market_id, thesis.trim()]
      );
    }

    await client.query('COMMIT'); 
    res.json(betRes.rows[0]); 
  } catch (err) {
    await client.query('ROLLBACK'); 
    console.error("Trading Error:", err);
    res.status(400).json({ message: err.message });
  } finally {
    client.release(); 
  }
});

// --- 7. GET A USER'S HISTORY ---
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
          totalPayout = 0;
        }
      }

      return {
        ...bet,
        status, 
        payout_kes: totalPayout 
      };
    });

    res.json(betsWithPayouts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- 8. RESOLVE MARKET ENGINE ---
app.post('/api/resolve', async (req, res) => {
  const { market_id, winning_option } = req.body;
  const client = await pool.connect();
  const ADMIN_EMAIL = 'nguitui.kamau@gmail.com'; // Updated your admin email

  try {
    await client.query('BEGIN');
    
    const marketRes = await client.query('SELECT * FROM markets WHERE id = $1 FOR UPDATE', [market_id]);
    if (marketRes.rows.length === 0) throw new Error('Market not found.');
    const market = marketRes.rows[0];

    if (market.is_resolved) throw new Error('Market is already resolved.');

    let winLetter = '';
    const inputOpt = winning_option.toLowerCase().trim();
    if (inputOpt === 'a' || inputOpt === market.option_a.toLowerCase().trim()) {
      winLetter = 'A';
    } else if (inputOpt === 'b' || inputOpt === market.option_b.toLowerCase().trim()) {
      winLetter = 'B';
    } else {
      throw new Error('Winning option matched neither A nor B.');
    }

    const poolA = parseFloat(market.option_a_pool || 0);
    const poolB = parseFloat(market.option_b_pool || 0);
    const totalPool = poolA + poolB;

    if (poolA === 0 || poolB === 0) {
      const allBets = await client.query('SELECT user_id, amount_kes FROM bets WHERE market_id = $1', [market_id]);
      for (const bet of allBets.rows) {
        await client.query(
          'UPDATE users SET balance_kes = balance_kes + $1::numeric WHERE id = $2',
          [bet.amount_kes, bet.user_id]
        );
      }
      await client.query(
        "UPDATE markets SET is_resolved = TRUE, winning_option = 'Refunded', category = 'Cancelled (Refund)' WHERE id = $1", 
        [market_id]
      );
      await client.query('COMMIT');
      return res.json({ success: true, message: 'Unanimous market! Everyone has been fully refunded.' });
    }

    await client.query('UPDATE markets SET is_resolved = TRUE, winning_option = $1 WHERE id = $2', [winLetter, market_id]);

    const winningPool = winLetter === 'A' ? poolA : poolB;
    const losingPool = winLetter === 'A' ? poolB : poolA;
    const HOUSE_FEE_PERCENTAGE = totalPool < 1000 ? 0 : 0.05;
    
    const houseCut = losingPool * HOUSE_FEE_PERCENTAGE;
    const distributableProfit = losingPool - houseCut;

    if (houseCut > 0) {
      await client.query(
        'UPDATE users SET balance_kes = balance_kes + $1::numeric WHERE email = $2',
        [houseCut, ADMIN_EMAIL]
      );
    }

    const winningBets = await client.query(
      'SELECT user_id, amount_kes FROM bets WHERE market_id = $1 AND chosen_option = $2',
      [market_id, winLetter]
    );

    for (const bet of winningBets.rows) {
      const userStake = parseFloat(bet.amount_kes);
      const userSharePercentage = userStake / winningPool;
      const totalPayout = userStake + (userSharePercentage * distributableProfit);

      await client.query(
        'UPDATE users SET balance_kes = balance_kes + $1::numeric WHERE id = $2',
        [totalPayout, bet.user_id]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, message: `Market resolved! House took ${houseCut} KES.` });

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// --- 9. LEADERBOARD ---
app.get('/api/leaderboard', async (req, res) => {
  try {
    const query = `
      SELECT 
        u.id, 
        u.nickname, 
        u.email,
        u.phone_number, 
        u.balance_kes as balance,
        COUNT(b.id) as total_bets,
        COUNT(CASE WHEN m.is_resolved = TRUE AND b.chosen_option = m.winning_option THEN 1 END) as won_bets,
        COUNT(CASE WHEN m.is_resolved = TRUE THEN 1 END) as resolved_bets
      FROM users u
      LEFT JOIN bets b ON u.id = b.user_id
      LEFT JOIN markets m ON b.market_id = m.id
      WHERE u.nickname IS NOT NULL AND u.nickname != '' 
      GROUP BY u.id
      ORDER BY won_bets DESC, u.balance_kes DESC
      LIMIT 100;
    `;
    const result = await pool.query(query);
    
    const leaderboard = result.rows.map((row) => {
      const resolved = parseInt(row.resolved_bets) || 0;
      const won = parseInt(row.won_bets) || 0;
      const winRate = resolved > 0 ? Math.round((won / resolved) * 100) : 0;
      
      return {
        id: row.id.toString(),
        nickname: row.nickname,
        email: row.email, 
        phoneNumber: row.phone_number,
        balance: parseFloat(row.balance),
        totalBets: parseInt(row.total_bets),
        winRate: winRate,
        wonBets: won,
      };
    });

    res.json(leaderboard);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => {
  console.log(`🚀 UniStake Engine running at http://localhost:${port}`);
});