require('dotenv').config(); //  This loads .env file
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { OAuth2Client } = require('google-auth-library');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Google Bouncer using the hidden .env variable
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// --- CLOUD DATABASE CONNECTION (Neon) ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // <-- CRITICAL: Required for connecting to secure cloud databases like Neon!
  }
});

// Test the connection to the cloud
pool.connect((err, client, release) => {
  if (err) {
    return console.error('Error acquiring cloud client', err.stack);
  }
  console.log('✅ Successfully connected to Neon Cloud Database!');
  release();
});

// --- 1. SECURE GOOGLE AUTH / LOGIN ---
app.post('/api/auth/login', async (req, res) => {
  const { credential } = req.body; // We now receive a secure token, not just text!

  try {
    // 1. Decrypt and verify the Google Token
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    
    const payload = ticket.getPayload();
    const email = payload.email.toLowerCase();

    // 2. THE STRATHMORE BOUNCER
    if (!email.endsWith('@strathmore.edu')) {
      return res.status(403).json({ error: 'Access Denied. Only @strathmore.edu emails are allowed.' });
    }

    // 3. Check if user exists in the database
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    
    if (result.rows.length > 0) {
      // Returning user
      res.json({ isNewUser: false, user: result.rows[0], email: email });
    } else {
      // Brand new user (send them to Onboarding!)
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

// --- 4. MARKETS (Strictly counts UNIQUE human traders) ---
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
    
    // We send the data exactly as the frontend expects it
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

// --- 5. DEPOSIT (Test Environment) ---
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

// --- 6. PLACE A BET ---
app.post('/api/bet', async (req, res) => {
  const { email, market_id, chosen_option, amount_kes } = req.body;
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

    await client.query('COMMIT'); 
    res.json(betRes.rows[0]); 
  } catch (err) {
    await client.query('ROLLBACK'); 
    console.error("Betting Error:", err);
    res.status(400).json({ message: err.message });
  } finally {
    client.release(); 
  }
});

// --- 7. GET A USER'S BET HISTORY ---
app.get('/api/bets', async (req, res) => {
  const { email } = req.query;
  try {
    const result = await pool.query(`
      SELECT b.id, b.chosen_option, b.amount_kes, b.placed_at,
             m.title, m.is_resolved, m.winning_option, m.option_a, m.option_b
      FROM bets b
      JOIN users u ON b.user_id = u.id
      JOIN markets m ON b.market_id = m.id
      WHERE u.email = $1
      ORDER BY b.placed_at DESC
    `, [email]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- 8. RESOLVE MARKET ENGINE ---
app.post('/api/resolve', async (req, res) => {
  const { market_id, winning_option } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    
    const marketRes = await client.query('SELECT * FROM markets WHERE id = $1 FOR UPDATE', [market_id]);
    if (marketRes.rows.length === 0) throw new Error('Market not found.');
    const market = marketRes.rows[0];

    let winLetter = '';
    let winName = '';
    const inputOpt = winning_option.toLowerCase().trim();
    
    if (inputOpt === 'a' || inputOpt === market.option_a.toLowerCase().trim()) {
      winLetter = 'A';
      winName = market.option_a;
    } else if (inputOpt === 'b' || inputOpt === market.option_b.toLowerCase().trim()) {
      winLetter = 'B';
      winName = market.option_b;
    } else {
      throw new Error('Winning option matched neither A nor B.');
    }

    await client.query('UPDATE markets SET is_resolved = TRUE, winning_option = $1 WHERE id = $2', [winLetter, market_id]);

    const allBetsRes = await client.query('SELECT * FROM bets WHERE market_id = $1', [market_id]);
    
    let absoluteTotalPool = 0;
    let absoluteWinningPool = 0;
    const winningBets = [];

    for (const bet of allBetsRes.rows) {
      const amt = parseFloat(bet.amount_kes);
      absoluteTotalPool += amt;
      
      const userPick = bet.chosen_option.toLowerCase().trim();
      const safeWinLetter = winLetter.toLowerCase().trim();
      const safeWinName = winName.toLowerCase().trim();
      
      if (userPick === safeWinLetter || userPick === safeWinName) {
        absoluteWinningPool += amt;
        winningBets.push(bet);
      }
    }

    console.log(`\n--- RESOLVING MARKET ${market_id} ---`);
    console.log(`Total Pool: ${absoluteTotalPool} | Winning Pool: ${absoluteWinningPool}`);

    if (absoluteWinningPool > 0) {
      for (const bet of winningBets) {
        const betAmount = parseFloat(bet.amount_kes);
        const payout = (betAmount / absoluteWinningPool) * absoluteTotalPool;
        
        console.log(`Paying User ID ${bet.user_id}: Bet ${betAmount} -> Payout ${payout}`);
        
        await client.query(
          'UPDATE users SET balance_kes = balance_kes + $1::numeric WHERE id = $2', 
          [payout, bet.user_id]
        );
      }
      console.log(`--- PAYOUT COMPLETE ---\n`);
    } else {
      console.log(`--- NO WINNING BETS TO PAY OUT ---\n`);
    }

    await client.query('COMMIT');
    res.json({ success: true, message: 'Market resolved!' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error("Resolve Error:", err);
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
      ORDER BY u.balance_kes DESC
      LIMIT 100;
    `;
    const result = await pool.query(query);
    
    // Calculate the Win Rate percentage before sending it to React
    const leaderboard = result.rows.map((row) => {
      const resolved = parseInt(row.resolved_bets) || 0;
      const won = parseInt(row.won_bets) || 0;
      const winRate = resolved > 0 ? Math.round((won / resolved) * 100) : 0;
      
      return {
        id: row.id.toString(),
        nickname: row.nickname,
        email: row.email, // Passing email so we can securely identify the current user
        phoneNumber: row.phone_number,
        balance: parseFloat(row.balance),
        totalBets: parseInt(row.total_bets),
        winRate: winRate
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