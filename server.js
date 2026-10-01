const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');

// Global error handlers to prevent crashes
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// =============== DATABASE (Postgres on Render via DATABASE_URL, SQLite locally) ===============
// Render's filesystem is ephemeral: database.sqlite is wiped on every deploy.
// If DATABASE_URL is set we use Postgres (persistent). Otherwise SQLite for local dev.
let db;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  const useSSL = !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: useSSL ? { rejectUnauthorized: false } : false
  });
  pool.on('error', (err) => console.error('Postgres pool error:', err.message));

  const toPg = (sql) => {
    let i = 0;
    return sql.replace(/\?/g, () => '$' + (++i));
  };

  db = {
    isPg: true,
    get(sql, params, cb) {
      if (typeof params === 'function') { cb = params; params = []; }
      pool.query(toPg(sql), params || []).then(
        (r) => cb(null, r.rows[0] === undefined ? undefined : r.rows[0]),
        (err) => cb(err)
      );
    },
    all(sql, params, cb) {
      if (typeof params === 'function') { cb = params; params = []; }
      pool.query(toPg(sql), params || []).then(
        (r) => cb(null, r.rows),
        (err) => cb(err)
      );
    },
    run(sql, params, cb) {
      if (typeof params === 'function') { cb = params; params = []; }
      let q = sql;
      // Translate SQLite upsert dialects to Postgres
      if (/^INSERT OR REPLACE INTO player_identities/i.test(q)) {
        q = q.replace(/^INSERT OR REPLACE INTO player_identities\s*\([^)]+\)\s*VALUES\s*\([^)]+\)/i,
          'INSERT INTO player_identities (id, username, tag, last_seen, is_registered, user_id) VALUES (?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT (id) DO UPDATE SET username=EXCLUDED.username, tag=EXCLUDED.tag, ' +
          'last_seen=EXCLUDED.last_seen, is_registered=EXCLUDED.is_registered, user_id=EXCLUDED.user_id');
      } else if (/^INSERT OR IGNORE INTO player_friends/i.test(q)) {
        q = q.replace(/^INSERT OR IGNORE INTO player_friends/i, 'INSERT INTO player_friends') + ' ON CONFLICT DO NOTHING';
      } else if (/^INSERT INTO users\s*\(username, password\)/i.test(q) && !/RETURNING/i.test(q)) {
        q = q + ' RETURNING id';
      }
      pool.query(toPg(q), params || []).then(
        (r) => {
          if (typeof cb !== 'function') return;
          if (r.rows && r.rows[0] && r.rows[0].id !== undefined) cb.call({ lastID: r.rows[0].id }, null);
          else cb.call({}, null);
        },
        (err) => { if (typeof cb === 'function') cb(err); else console.error('DB run error:', err.message); }
      );
    },
    serialize(fn) { if (typeof fn === 'function') fn(); },
    close(cb) {
      pool.end().then(() => { console.log('Postgres pool closed'); if (cb) cb(null); })
        .catch((err) => { if (cb) cb(err); });
    }
  };

  const pgInit = [
    "CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username TEXT UNIQUE, password TEXT)",
    "CREATE TABLE IF NOT EXISTS friends (user_id INTEGER, friend_id INTEGER, PRIMARY KEY(user_id, friend_id))",
    `CREATE TABLE IF NOT EXISTS player_identities (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      tag TEXT NOT NULL,
      last_seen BIGINT NOT NULL,
      is_registered INTEGER DEFAULT 0,
      user_id INTEGER REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS player_friends (
      player_id TEXT NOT NULL,
      friend_id TEXT NOT NULL,
      PRIMARY KEY(player_id, friend_id)
    )`,
    `CREATE TABLE IF NOT EXISTS leaderboard (
      user_id INTEGER PRIMARY KEY,
      username TEXT NOT NULL,
      wins INTEGER NOT NULL DEFAULT 0,
      games INTEGER NOT NULL DEFAULT 0,
      kills INTEGER NOT NULL DEFAULT 0
    )`
  ];
  (async () => {
    try {
      for (const q of pgInit) await pool.query(q);
      // Migration for databases created before the kills column existed
      await pool.query('ALTER TABLE leaderboard ADD COLUMN kills INTEGER NOT NULL DEFAULT 0').catch((e) => {
        if (!/already exists|duplicate/i.test(e.message)) throw e;
      });
      console.log('Connected to Postgres (persistent)');
    } catch (err) {
      console.error('Postgres init failed:', err.message);
    }
  })();
} else {
  const dbPath = path.join(__dirname, 'database.sqlite');
  const sqlite = new sqlite3.Database(dbPath, (err) => {
    if (err) {
      console.error('Failed to connect to database:', err);
    } else {
      console.log('Connected to SQLite database (local dev only, wiped on Render deploys):', dbPath);
    }
  });

  // Enable WAL mode for better concurrency
  sqlite.run('PRAGMA journal_mode=WAL;', (err) => {
    if (err) console.warn('Could not enable WAL mode:', err.message);
  });

  sqlite.serialize(() => {
    sqlite.run("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT)");
    sqlite.run("CREATE TABLE IF NOT EXISTS friends (user_id INTEGER, friend_id INTEGER, PRIMARY KEY(user_id, friend_id))");

    // Player identities and friendships
    sqlite.run(`CREATE TABLE IF NOT EXISTS player_identities (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      tag TEXT NOT NULL,
      last_seen INTEGER NOT NULL,
      is_registered INTEGER DEFAULT 0,
      user_id INTEGER REFERENCES users(id)
    )`);
    sqlite.run(`CREATE TABLE IF NOT EXISTS player_friends (
      player_id TEXT NOT NULL,
      friend_id TEXT NOT NULL,
      PRIMARY KEY(player_id, friend_id)
    )`);
    sqlite.run(`CREATE TABLE IF NOT EXISTS leaderboard (
      user_id INTEGER PRIMARY KEY,
      username TEXT NOT NULL,
      wins INTEGER NOT NULL DEFAULT 0,
      games INTEGER NOT NULL DEFAULT 0,
      kills INTEGER NOT NULL DEFAULT 0
    )`);
    // Migration for databases created before the kills column existed
    sqlite.run('ALTER TABLE leaderboard ADD COLUMN kills INTEGER NOT NULL DEFAULT 0', (err) => {
      if (err && !/duplicate/i.test(err.message)) console.error('leaderboard migration error:', err.message);
    });
  });

  db = sqlite;
}

app.use(express.json());
app.use(express.static(__dirname));

app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing username or password' });
  
  db.get("SELECT * FROM users WHERE username = ?", [username], (err, row) => {
    if (err) return res.status(500).json({ error: 'Server error' });
    
    if (row) {
      bcrypt.compare(password, row.password, (cmpErr, isMatch) => {
        if (isMatch) {
          return res.status(400).json({
            error: 'An account with this username and password already exists. Please sign in instead!',
            alreadyExistsWithPassword: true
          });
        } else {
          return res.status(400).json({
            error: 'Username is already taken. Please choose another username.'
          });
        }
      });
      return;
    }

    bcrypt.hash(password, 10, (hashErr, hash) => {
      if (hashErr) return res.status(500).json({ error: 'Server error' });
      db.run("INSERT INTO users (username, password) VALUES (?, ?)", [username, hash], function(insertErr) {
        if (insertErr) return res.status(400).json({ error: 'Username taken' });
        res.json({ id: this.lastID, username });
      });
    });
  });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing username or password' });
  db.get("SELECT * FROM users WHERE username = ?", [username], (err, row) => {
    if (err) return res.status(500).json({ error: 'Server error' });
    if (!row) return res.status(400).json({ error: 'No account found with this username. Please register first!' });
    bcrypt.compare(password, row.password, (cmpErr, result) => {
      if (result) res.json({ id: row.id, username: row.username });
      else res.status(400).json({ error: 'Incorrect password for this account.' });
    });
  });
});

const activeSockets = {}; // socket.id -> { id, username, tag }
const userToSocket = {}; // id -> socket.id

// Register or get player identity - now uses SQLite
app.post('/api/player/sync', (req, res) => {
  let { id, username, tag } = req.body;
  if (!id) {
    id = 'p_' + Math.random().toString(36).substring(2, 9);
  }
  username = (username || 'Player').trim();
  if (!tag) {
    const code = Math.floor(1000 + Math.random() * 9000);
    tag = `${username}#${code}`;
  }

  const isRegistered = id.startsWith('u_');
  const userId = isRegistered ? id.replace('u_', '') : null;
  
db.run(`INSERT OR REPLACE INTO player_identities (id, username, tag, last_seen, is_registered, user_id) 
            VALUES (?, ?, ?, ?, ?, ?)`,
      [id, username, tag, Date.now(), isRegistered ? 1 : 0, userId],
      (err) => {
        if (err) return res.status(500).json({ error: 'Server error' });
        res.json({ id, username, tag });
      });
});

// Get currently online players for effortless 1-click adding
app.get('/api/online-players', (req, res) => {
  const excludeId = req.query.exclude;
  const online = Object.values(activeSockets)
    .filter(p => p.id && p.id !== excludeId)
    .map(p => ({
      id: p.id,
      username: p.username,
      tag: p.tag,
      isOnline: true
    }));
  res.json(online);
});

app.get('/api/friends/:userId', (req, res) => {
  const userId = req.params.userId;
  
  db.all(`SELECT pf.friend_id, pi.username, pi.tag 
          FROM player_friends pf
          JOIN player_identities pi ON pf.friend_id = pi.id
          WHERE pf.player_id = ? AND pf.friend_id != ?`, 
    [userId, userId], (err, rows) => {
      if (err) return res.status(500).json({ error: 'Server error' });
      
      const list = (rows || []).map(row => ({
        id: row.friend_id,
        username: row.username,
        tag: row.tag,
        isOnline: !!userToSocket[row.friend_id]
      }));
      res.json(list);
    });
});

app.post('/api/friends', (req, res) => {
  const { userId, query } = req.body;
  if (!query || !userId) return res.status(400).json({ error: 'Please enter a username or player tag' });
  
  const q = query.trim().toLowerCase();
  
  // 1. Check known players in SQLite
  db.get(`SELECT id, username, tag FROM player_identities 
          WHERE id != ? AND (LOWER(tag) = ? OR LOWER(username) = ? OR LOWER(tag) LIKE ?)`,
    [userId, q, q, q + '%'], (err, target) => {
      if (err) return res.status(500).json({ error: 'Server error' });
      
      // 2. Check active online sockets
      if (!target) {
        target = Object.values(activeSockets).find(p => 
          p.id !== userId && (
            p.tag.toLowerCase() === q ||
            p.username.toLowerCase() === q ||
            p.tag.toLowerCase().startsWith(q)
          )
        );
      }

      // 3. Fallback: Check registered users in SQLite
      if (!target) {
        return db.get("SELECT id, username FROM users WHERE LOWER(TRIM(username)) = LOWER(?)", [q], (err, row) => {
          if (err || !row) {
            return res.status(404).json({ error: `Player "${query}" not found. Ensure they entered a nickname or are online.` });
          }
          const targetId = 'usr_' + row.id;
          const targetTag = `${row.username}#${row.id}`;
          // Upsert into player_identities
          db.run(`INSERT OR REPLACE INTO player_identities (id, username, tag, last_seen, is_registered, user_id) 
                  VALUES (?, ?, ?, ?, 1, ?)`,
            [targetId, row.username, targetTag, Date.now(), row.id],
            (err) => {
              if (err) return res.status(500).json({ error: 'Server error' });
              completeFriendAdd(userId, targetId, row.username, targetTag, res);
            });
        });
      }

      completeFriendAdd(userId, target.id, target.username, target.tag, res);
    });
});

function completeFriendAdd(u1, u2, friendName, friendTag, res) {
  if (u1 === u2) return res.status(400).json({ error: 'You cannot add yourself' });

  // Ensure both players exist in player_identities
  db.get(`SELECT id FROM player_identities WHERE id = ?`, [u2], (err, row) => {
    if (err) return res.status(500).json({ error: 'Server error' });
    if (!row) {
      return res.status(404).json({ error: 'Player not found' });
    }
    
    // Add friendship both ways
    db.run(`INSERT OR IGNORE INTO player_friends (player_id, friend_id) VALUES (?, ?)`, [u1, u2], (err) => {
      if (err) return res.status(500).json({ error: 'Server error' });
      db.run(`INSERT OR IGNORE INTO player_friends (player_id, friend_id) VALUES (?, ?)`, [u2, u1], (err) => {
        if (err) return res.status(500).json({ error: 'Server error' });
        io.emit('friends_updated');
        res.json({ id: u2, username: friendName, tag: friendTag });
      });
    });
  });
}

// Leaderboard: registered users only. Standard UPSERT works on both Postgres and modern SQLite.
function recordBoardResult(userId, username, isWin, kills) {
  const uid = parseInt(userId, 10);
  if (!uid || !username) return;
  const w = isWin ? 1 : 0;
  const k = Math.max(0, parseInt(kills, 10) || 0);
  db.run(`INSERT INTO leaderboard (user_id, username, wins, games, kills) VALUES (?, ?, ?, 1, ?)
          ON CONFLICT (user_id) DO UPDATE SET username=excluded.username,
          wins=leaderboard.wins+excluded.wins, games=leaderboard.games+1,
          kills=leaderboard.kills+excluded.kills`,
    [uid, String(username).trim().slice(0, 24), w, k],
    (err) => { if (err) console.error('leaderboard write error:', err.message); });
}

app.get('/api/leaderboard', (req, res) => {
  db.all(`SELECT user_id AS id, username, wins, games, kills FROM leaderboard
          ORDER BY wins DESC, kills DESC, games ASC LIMIT 50`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Server error' });
      res.json(rows || []);
    });
});

app.delete('/api/friends', (req, res) => {
  const { userId, friendId } = req.body;
  db.run(`DELETE FROM player_friends WHERE (player_id = ? AND friend_id = ?) OR (player_id = ? AND friend_id = ?)`,
    [userId, friendId, friendId, userId], (err) => {
      if (err) return res.status(500).json({ error: 'Server error' });
      io.emit('friends_updated');
      res.json({ success: true });
    });
});

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true, uptime: process.uptime(), rooms: Object.keys(rooms).length });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// rooms state
const rooms = {};

function getRoomState(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      slots: [null, null, null, null],
      playerNames: ['', '', '', ''],
      gameState: 'lobby', // 'lobby' | 'playing' | 'finished'
      gameSettings: { pegsPerPlayer: 4 },
      offlineSlots: [false, false, false, false],
      currentPlayer: 0,
      turnId: 0,
      turnWatchdog: null,
      lastTurnAdvance: 0,
      diceRolled: false,
      diceValue: null,
      moveExecutedThisTurn: false,
      finishOrder: [],
      finishMeta: [],
      boardState: null,
      moveLog: [],
      lastRoll: null,
      lastMove: null,
      endedAt: null
    };
  }
  return rooms[roomId];
}

function clearRoomTurnTimer(roomId) {
  const room = rooms[roomId];
  if (room && room.turnWatchdog) {
    clearTimeout(room.turnWatchdog);
    room.turnWatchdog = null;
  }
}

// A finished game goes back to being a fresh lobby (seats kept for rematch)
// so late rejoiners never land in a dead, unplayable room.
function resetRoomToLobby(roomId) {
  const state = rooms[roomId];
  if (!state) return;
  clearRoomTurnTimer(roomId);
  if (state.cleanupTimer) {
    clearTimeout(state.cleanupTimer);
    state.cleanupTimer = null;
  }
  state.gameState = 'lobby';
  state.finishOrder = [];
  state.finishMeta = [];
  state.boardState = null;
  state.moveLog = [];
  state.lastRoll = null;
  state.lastMove = null;
  state.offlineSlots = [false, false, false, false];
  state.currentPlayer = 0;
  state.turnId = 0;
  state.diceRolled = false;
  state.diceValue = null;
  state.moveExecutedThisTurn = false;
  state.endedAt = null;
}

// Moves missed while a client was away, so it can replay them onto a stale
// board snapshot and land exactly on the live position.
function getReplayMoves(state) {
  const baseTurn = (state.boardState && typeof state.boardState.turnId === 'number')
    ? state.boardState.turnId : 0;
  return (state.moveLog || []).filter(m => m.turnId > baseTurn);
}

// Spectators = sockets in the room holding no seat. Shown to the players
// being watched (as a 👁️ count), not to the watchers.
function getSpectatorCount(roomId) {
  try {
    const room = io.sockets.adapter.rooms.get(roomId);
    if (!room) return 0;
    const state = rooms[roomId];
    const seated = new Set((state ? state.slots : []).filter(s => s && s !== 'bot'));
    let n = 0;
    room.forEach(id => { if (!seated.has(id)) n++; });
    return n;
  } catch (e) { return 0; }
}

function emitSpectators(roomId) {
  io.to(roomId).emit('spectators_updated', { count: getSpectatorCount(roomId) });
}

// Start the recovery countdown when no online humans remain in a live game.
// Shared by disconnect and leave_room so both exits behave identically.
function maybeScheduleCleanup(roomId) {
  const state = rooms[roomId];
  if (!state || state.gameState !== 'playing' || state.cleanupTimer) return;
  const onlineHumans = state.slots.filter((s, i) => s !== null && s !== 'bot' && !state.offlineSlots[i]).length;
  if (onlineHumans === 0) {
    console.log(`All human players offline in room ${roomId}. Starting 15-minute recovery timer.`);
    state.cleanupTimer = setTimeout(() => {
      const current = rooms[roomId];
      if (!current) return;
      const recheck = current.slots.filter((s, i) => s !== null && s !== 'bot' && !current.offlineSlots[i]).length;
      if (recheck === 0) {
        delete rooms[roomId];
        console.log(`Recovery window expired. Deleted empty room: ${roomId}`);
      }
      broadcastOpenRooms();
    }, 900000); // 15 minutes
  }
}

// Elect a new host (first live human) and tell the room, so bot turns and
// board sync keep working after the previous host drops.
function migrateHost(roomId) {
  const state = rooms[roomId];
  if (!state) return;
  const liveHuman = state.slots.find((s, i) =>
    s !== null && s !== 'bot' && !state.offlineSlots[i] && io.sockets.sockets.get(s));
  const anyHuman = state.slots.find((s) => s !== null && s !== 'bot');
  state.host = liveHuman || anyHuman || null;
  io.to(roomId).emit('host_migrated', { host: state.host });
}

function advanceRoomTurn(roomId, forcedByWatchdog = false) {
  const state = rooms[roomId];
  if (!state || state.gameState !== 'playing') return;

  clearRoomTurnTimer(roomId);

  let next = state.currentPlayer;
  let attempts = 0;
  do {
    next = (next + 1) % 4;
    attempts++;
  } while ((!state.slots[next] || (state.finishOrder && state.finishOrder.includes(next))) && attempts < 10);

  state.currentPlayer = next;
  state.diceRolled = false;
  state.diceValue = null;
  state.moveExecutedThisTurn = false;
  state.turnId = (state.turnId || 0) + 1;
  state.lastTurnAdvance = Date.now();

  io.to(roomId).emit('turn_passed', {
    currentPlayer: state.currentPlayer,
    turnId: state.turnId,
    forced: forcedByWatchdog
  });

  // Watchdog: If bot or offline, allow 6s for host/bot to act. If not acted, server auto advances!
  // If human, allow 25s AFK timer.
  const isBotOrOffline = (state.slots[next] === 'bot' || state.offlineSlots[next]);
  const timeoutMs = isBotOrOffline ? 6000 : 25000;
  const currentTurnId = state.turnId;

  state.turnWatchdog = setTimeout(() => {
    const currentState = rooms[roomId];
    if (currentState && currentState.gameState === 'playing' && currentState.currentPlayer === next && currentState.turnId === currentTurnId) {
      console.log(`[Watchdog] Turn timed out for player ${next} in room ${roomId}. Auto-advancing turn.`);
      advanceRoomTurn(roomId, true);
    }
  }, timeoutMs);
}

function broadcastOpenRooms() {
  const list = Object.keys(rooms).map(roomId => {
    const room = rooms[roomId];
    // Count ONLINE humans only: exited/offline seats are kept for rejoin but
    // must not advertise the room as active (ghost bot lobbies in the list).
    const offline = room.offlineSlots || [];
    const humanCount = room.slots.filter((s, i) => s !== null && s !== 'bot' && !offline[i]).length;
    const totalCount = room.slots.filter(s => s !== null).length;
    return {
      roomId,
      gameState: room.gameState,
      humanCount,
      totalCount,
      playerNames: room.playerNames.filter(n => n !== '')
    };
  }).filter(r => r.humanCount > 0 && (r.gameState === 'lobby' || r.gameState === 'playing'));
  io.emit('open_rooms', list);
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  broadcastOpenRooms();

  socket.on('register_identity', (player) => {
    if (!player || !player.id) return;
    const id = player.id;
    const username = (player.username || 'Player').trim();
    const tag = player.tag || `${username}#${id.slice(-4)}`;

    const isRegistered = id.startsWith('u_');
    const userId = isRegistered ? id.replace('u_', '') : null;
    
    db.run(`INSERT OR REPLACE INTO player_identities (id, username, tag, last_seen, is_registered, user_id) 
            VALUES (?, ?, ?, ?, ?, ?)`,
      [id, username, tag, Date.now(), isRegistered ? 1 : 0, userId],
      (err) => {
        if (err) console.error('register_identity error:', err);
      });

    activeSockets[socket.id] = { id, username, tag };
    userToSocket[id] = socket.id;
    socket.userId = id;
    socket.playerTag = tag;
    socket.username = username;

    io.emit('friends_updated');
  });

  socket.on('register_user', (userId) => {
    if (userId) {
      userToSocket[userId] = socket.id;
      socket.userId = userId;
      io.emit('friends_updated');
    }
  });

  socket.on('send_friend_invite', (data) => {
    const { friendId, fromUsername, roomId, friendUsername } = data;
    const targetSocketId = userToSocket[friendId];
    if (targetSocketId && io.sockets.sockets.get(targetSocketId)) {
      io.to(targetSocketId).emit('receive_friend_invite', {
        fromUsername,
        roomId
      });
      socket.emit('invite_status', { success: true, message: `Invite sent to ${friendUsername || 'friend'}!` });
    } else {
      socket.emit('invite_status', { success: false, message: `Friend is offline. Game link copied to clipboard!` });
    }
  });
  
  socket.on('join_room', (data) => {
    const roomId = (typeof data === 'object' && data !== null) ? data.roomId : data;
    const playerName = (typeof data === 'object' && data !== null && data.playerName) ? data.playerName : null;
    const isSpectate = (typeof data === 'object' && data !== null && data.spectate === true);
    
    // Free any ghost seat this socket still holds in OTHER rooms (joining
    // a new room without leaving first must not leave a phantom player behind).
    Object.keys(rooms).forEach((otherId) => {
      if (otherId === roomId) return;
      const other = rooms[otherId];
      const idx = other.slots.indexOf(socket.id);
      if (idx !== -1) {
        if (other.gameState === 'lobby' || other.gameState === 'finished') {
          other.slots[idx] = null;
          other.playerNames[idx] = '';
          other.offlineSlots[idx] = false;
          io.to(otherId).emit('lobby_state', { ...other, roomId: otherId });
        } else {
          other.offlineSlots[idx] = true;
          io.to(otherId).emit('player_disconnected', idx);
          migrateHost(otherId);
        }
      }
    });

    Array.from(socket.rooms).forEach(r => {
      if(r !== socket.id) socket.leave(r);
    });
    socket.join(roomId);
    socket.roomId = roomId;
    socket.isSpectate = isSpectate;

    // Fresh = this room did not exist until this very join (e.g. the old one
    // died with a deploy/sleep). Auto-rejoin uses this to bounce home instead
    // of walking into yesterday's ghost.
    const isFreshRoom = !rooms[roomId];
    let state = getRoomState(roomId);

    // Rejoining an ended game starts a fresh lobby instead of a dead room
    if (state.gameState === 'finished') {
      resetRoomToLobby(roomId);
      state = getRoomState(roomId);
    }

    // Auto-claim first empty slot if player is not currently in a slot in lobby (not for spectators)
    if (state.gameState === 'lobby' && !isSpectate) {
      const existingSlot = state.slots.indexOf(socket.id);
      if (existingSlot === -1) {
        const freeSlot = state.slots.findIndex(s => s === null);
        if (freeSlot !== -1) {
          state.slots[freeSlot] = socket.id;
          state.playerNames[freeSlot] = playerName || `Player ${freeSlot + 1}`;
        }
      }
    }
    
    const firstHuman = state.slots.find(s => s !== null && s !== 'bot');
    state.host = firstHuman || socket.id;

    io.to(roomId).emit('lobby_state', { ...state, socketId: socket.id, roomId, fresh: isFreshRoom });

    // If game is already in progress, send current game state to the new spectator/player
    if (state.gameState === 'playing' && state.boardState) {
      io.to(socket.id).emit('game_started', { ...state, spectators: getSpectatorCount(roomId) });
      // Also send board state for immediate rendering, plus missed moves to replay
      setTimeout(() => {
        io.to(socket.id).emit('sync_data', state.boardState);
        io.to(socket.id).emit('replay_moves', { moves: getReplayMoves(state), finishOrder: state.finishOrder || [] });
      }, 100);
    }

    emitSpectators(roomId);
    broadcastOpenRooms();
  });

  // Bot takeover: a seatless spectator (or a finished player who is done)
  // may claim a bot's seat mid-game and play it themselves.
  socket.on('takeover_bot', (data) => {
    if (!socket.roomId) return;
    const state = getRoomState(socket.roomId);
    if (state.gameState !== 'playing') {
      return socket.emit('takeover_result', { ok: false, error: 'Game is not running' });
    }
    const slot = data && typeof data.slot === 'number' ? data.slot : -1;
    if (slot < 0 || slot > 3 || state.slots[slot] !== 'bot') {
      return socket.emit('takeover_result', { ok: false, error: 'That seat is not a bot' });
    }
    const cur = state.slots.indexOf(socket.id);
    if (cur !== -1 && !(state.finishOrder || []).includes(cur)) {
      return socket.emit('takeover_result', { ok: false, error: 'You already have a seat' });
    }
    state.slots[slot] = socket.id;
    state.offlineSlots[slot] = false;
    if (data && data.playerName) state.playerNames[slot] = data.playerName;
    if (state.boardState) {
      state.boardState.slots = [...state.slots];
      state.boardState.playerNames = [...state.playerNames];
    }
    socket.isSpectate = false;
    const firstHuman = state.slots.find(s => s !== null && s !== 'bot');
    state.host = firstHuman || socket.id;
    socket.emit('takeover_result', { ok: true, slot });
    io.to(socket.roomId).emit('lobby_state', { ...state, roomId: socket.roomId });
    io.to(socket.roomId).emit('player_reconnected', slot);
    emitSpectators(socket.roomId);
    broadcastOpenRooms();
  });

  socket.on('join_slot', (data) => {
    if (!socket.roomId) return;
    const state = getRoomState(socket.roomId);
    if (state.gameState !== 'lobby') return;
    
    const slotIndex = (typeof data === 'object' && data !== null) ? data.slotIndex : data;
    const name = (typeof data === 'object' && data !== null && data.playerName) ? data.playerName : `Player ${slotIndex + 1}`;
    
    if (slotIndex < 0 || slotIndex > 3) return;

    // If occupied by another human player, reject
    if (state.slots[slotIndex] && state.slots[slotIndex] !== socket.id && state.slots[slotIndex] !== 'bot') {
      return;
    }
    
    const oldSlot = state.slots.indexOf(socket.id);
    if (oldSlot !== -1 && oldSlot !== slotIndex) {
      state.slots[oldSlot] = null;
      state.playerNames[oldSlot] = '';
    }
    
    state.slots[slotIndex] = socket.id;
    state.playerNames[slotIndex] = name;
    
    const firstHuman = state.slots.find(s => s !== null && s !== 'bot');
    state.host = firstHuman || socket.id;
    
    io.to(socket.roomId).emit('lobby_state', { ...state, roomId: socket.roomId });
    broadcastOpenRooms();
  });

  socket.on('update_settings', (settings) => {
    if (!socket.roomId) return;
    const state = getRoomState(socket.roomId);
    if (state.gameState !== 'lobby') return;
    state.gameSettings = settings;
    io.to(socket.roomId).emit('lobby_state', { ...state, roomId: socket.roomId });
    broadcastOpenRooms();
  });

  socket.on('add_bot', (slot) => {
    if (!socket.roomId) return;
    const state = getRoomState(socket.roomId);
    if (state.gameState !== 'lobby') return;

    let targetSlot = (slot !== undefined && slot !== null) ? slot : state.slots.findIndex(s => s === null);
    if (targetSlot !== -1 && !state.slots[targetSlot]) {
      state.slots[targetSlot] = 'bot';
      state.playerNames[targetSlot] = `Bot P${targetSlot + 1} 🤖`;
      io.to(socket.roomId).emit('lobby_state', { ...state, roomId: socket.roomId });
      broadcastOpenRooms();
    }
  });

  socket.on('remove_bot', (slot) => {
    if (!socket.roomId) return;
    const state = getRoomState(socket.roomId);
    if (state.gameState === 'lobby' && state.slots[slot] === 'bot') {
      state.slots[slot] = null;
      state.playerNames[slot] = '';
      io.to(socket.roomId).emit('lobby_state', { ...state, roomId: socket.roomId });
      broadcastOpenRooms();
    }
  });

  socket.on('start_game', () => {
    if (!socket.roomId) return;
    const state = getRoomState(socket.roomId);
    if (state.gameState !== 'lobby') return;
    
    const hasHuman = state.slots.some(s => s !== null && s !== 'bot');
    const totalPlayers = state.slots.filter(s => s !== null).length;
    if (hasHuman && totalPlayers >= 2) {
      // 🔀 Every game starts fresh: randomly deal occupants (humans + bots)
      // onto random seats, so colors and neighbors change each match.
      const occupants = [];
      for (let i = 0; i < 4; i++) {
        if (state.slots[i] !== null) occupants.push({ seat: state.slots[i], name: state.playerNames[i] });
      }
      const order = [0, 1, 2, 3];
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      state.slots = [null, null, null, null];
      state.playerNames = ['', '', '', ''];
      occupants.forEach((o, k) => {
        state.slots[order[k]] = o.seat;
        state.playerNames[order[k]] = o.name;
      });
      // Bots take the name of their new seat for clarity
      for (let i = 0; i < 4; i++) {
        if (state.slots[i] === 'bot') state.playerNames[i] = `Bot P${i + 1} 🤖`;
      }
      const firstHuman = state.slots.find(s => s !== null && s !== 'bot');
      state.host = firstHuman || socket.id;

      state.gameState = 'playing';
      state.finishOrder = []; // reset finish rankings
      state.finishMeta = [];
      state.boardState = null;
      state.moveLog = [];
      state.lastRoll = null;
      state.lastMove = null;
      state.offlineSlots = [false, false, false, false];
      state.moveExecutedThisTurn = false;
      state.endedAt = null;
      // 🎲 Random starter every game (uniform over seated players)
      const activeSeats = state.slots.map((s, i) => s !== null ? i : null).filter(i => i !== null);
      state.currentPlayer = activeSeats[Math.floor(Math.random() * activeSeats.length)];
      state.turnId = 1;
      state.diceRolled = false;
      state.diceValue = null;
      state.lastTurnAdvance = Date.now();

      io.to(socket.roomId).emit('game_started', { ...state, spectators: getSpectatorCount(socket.roomId) });
      broadcastOpenRooms();

      // Schedule initial turn watchdog
      clearRoomTurnTimer(socket.roomId);
      const isBotOrOffline = (state.slots[state.currentPlayer] === 'bot' || state.offlineSlots[state.currentPlayer]);
      const timeoutMs = isBotOrOffline ? 6000 : 25000;
      const currentTurnId = state.turnId;
      const rId = socket.roomId;
      state.turnWatchdog = setTimeout(() => {
        const currentState = rooms[rId];
        if (currentState && currentState.gameState === 'playing' && currentState.turnId === currentTurnId) {
          console.log(`[Watchdog] Initial turn timed out for player ${currentState.currentPlayer} in room ${rId}. Advancing turn.`);
          advanceRoomTurn(rId, true);
        }
      }, timeoutMs);
    }
  });

  socket.on('roll_dice', (data) => {
    if (!socket.roomId) return;
    const state = getRoomState(socket.roomId);
    if (state.gameState !== 'playing') return;

    // Only the seated player (or the host rolling for a bot/offline seat) may roll.
    // Stale/phantom rolls from anyone else are ignored so one client can't jam the turn flow.
    const curSeat = state.slots[state.currentPlayer];
    const botTurn = curSeat === 'bot' || state.offlineSlots[state.currentPlayer];
    if (socket.id !== curSeat && !(botTurn && socket.id === state.host)) return;

    state.diceRolled = true;
    state.diceValue = data.value;
    state.moveExecutedThisTurn = false;
    state.lastRoll = {
      player: (typeof data === 'object' && typeof data.player === 'number') ? data.player : state.currentPlayer,
      value: data.value,
      turnId: state.turnId
    };

    // Refresh watchdog to allow animation and move execution
    clearRoomTurnTimer(socket.roomId);
    const rId = socket.roomId;
    const currentTurnId = state.turnId;
    const p = state.currentPlayer;
    const isBot = (state.slots[p] === 'bot' || state.offlineSlots[p]);
    state.turnWatchdog = setTimeout(() => {
      const currentState = rooms[rId];
      if (currentState && currentState.gameState === 'playing' && currentState.turnId === currentTurnId) {
        console.log(`[Watchdog] Move timed out after roll for player ${p} in room ${rId}. Advancing turn.`);
        advanceRoomTurn(rId, true);
      }
    }, isBot ? 5000 : 20000);

    io.to(socket.roomId).emit('dice_rolled', {
      player: (typeof data === 'object' && typeof data.player === 'number') ? data.player : state.currentPlayer,
      value: data.value,
      turnId: state.turnId
    });
  });

  // Echo confirmation: if a roller/mover missed their own broadcast echo
  // (one dropped packet wedges their client until the watchdog skips them),
  // re-send exactly what the server recorded instead of letting them act blind.
  socket.on('request_roll_echo', (data) => {
    if (!socket.roomId) return;
    const state = getRoomState(socket.roomId);
    if (state.gameState !== 'playing') return;
    if (state.lastRoll && (!data || typeof data.turnId !== 'number' || state.lastRoll.turnId === data.turnId)) {
      socket.emit('dice_rolled', {
        player: state.lastRoll.player,
        value: state.lastRoll.value,
        turnId: state.lastRoll.turnId
      });
    } else {
      socket.emit('roll_missing', { turnId: state.turnId });
    }
  });

  socket.on('request_move_echo', (data) => {
    if (!socket.roomId) return;
    const state = getRoomState(socket.roomId);
    if (state.gameState !== 'playing') return;
    if (state.lastMove && (!data || typeof data.turnId !== 'number' || state.lastMove.turnId === data.turnId)) {
      socket.emit('move_executed', state.lastMove);
    } else {
      socket.emit('move_missing', { turnId: state.turnId });
    }
  });

  socket.on('execute_move', (moveObj) => {
    if (!socket.roomId) return;
    const state = getRoomState(socket.roomId);
    if (state.gameState !== 'playing') return;

    // Only the seated player (or the host moving for a bot/offline seat) may move.
    const curSeat = state.slots[state.currentPlayer];
    const botTurn = curSeat === 'bot' || state.offlineSlots[state.currentPlayer];
    if (socket.id !== curSeat && !(botTurn && socket.id === state.host)) return;
    // Drop moves computed for an older turn (stale bot timers / animation races).
    if (moveObj && typeof moveObj.turnId === 'number' && moveObj.turnId !== state.turnId) {
      console.warn(`[Server] Rejected stale execute_move (turn ${moveObj.turnId} vs ${state.turnId}) in room ${socket.roomId}`);
      return;
    }
    // Strictly enforce exactly ONE move per dice roll
    if (!state.diceRolled || state.moveExecutedThisTurn) {
      console.warn(`[Server] Rejected duplicate execute_move in room ${socket.roomId}`);
      return;
    }
    state.moveExecutedThisTurn = true;

    state.lastMove = { pieceId: moveObj.pieceId, action: moveObj.action, target: moveObj.target, turnId: state.turnId };
    // Journal the move so rejoining clients can replay what they missed.
    if (!state.moveLog) state.moveLog = [];
    state.moveLog.push({ pieceId: moveObj.pieceId, action: moveObj.action, target: moveObj.target, turnId: state.turnId });
    if (state.moveLog.length > 300) state.moveLog.splice(0, state.moveLog.length - 300);

    // Refresh watchdog for follow-up roll or turn switch
    clearRoomTurnTimer(socket.roomId);
    const rId = socket.roomId;
    const currentTurnId = state.turnId;
    const p = state.currentPlayer;
    const isBot = (state.slots[p] === 'bot' || state.offlineSlots[p]);
    state.turnWatchdog = setTimeout(() => {
      const currentState = rooms[rId];
      if (currentState && currentState.gameState === 'playing' && currentState.turnId === currentTurnId) {
        console.log(`[Watchdog] Post-move timed out for player ${p} in room ${rId}. Advancing turn.`);
        advanceRoomTurn(rId, true);
      }
    }, isBot ? 5000 : 20000);

    io.to(socket.roomId).emit('move_executed', moveObj);
  });
  
  socket.on('next_turn', (data) => {
    if (!socket.roomId) return;
    const state = getRoomState(socket.roomId);
    if (state.gameState !== 'playing') return;

    // Drop stale turn-advance timers from a previous turn.
    if (data && typeof data.turnId === 'number' && data.turnId !== state.turnId) return;

    // Debounce rapid duplicate next_turn calls (min 350ms between turns)
    const now = Date.now();
    if (state.lastTurnAdvance && (now - state.lastTurnAdvance < 350)) {
      return;
    }

    advanceRoomTurn(socket.roomId);
  });

  socket.on('player_finished', (data) => {
    if (!socket.roomId) return;
    const state = getRoomState(socket.roomId);
    if (state.gameState !== 'playing') return;
    // Accept legacy slot number or { slot, userId, username, kills } from registered players
    const playerSlot = (typeof data === 'object' && data !== null) ? data.slot : data;
    const finUserId = (typeof data === 'object' && data !== null) ? data.userId : null;
    const finUsername = (typeof data === 'object' && data !== null) ? data.username : null;
    const finKills = (typeof data === 'object' && data !== null) ? data.kills : 0;
    if (typeof playerSlot !== 'number') return;
    if (!state.finishOrder) state.finishOrder = [];
    if (!state.finishMeta) state.finishMeta = [];
    if (!state.finishOrder.includes(playerSlot)) {
      state.finishOrder.push(playerSlot);
      state.finishMeta.push({ slot: playerSlot, userId: finUserId, username: finUsername, kills: finKills });
    }
    const rank = state.finishOrder.length;
    // Broadcast that this player finished with their rank
    io.to(socket.roomId).emit('player_ranked', { playerSlot, rank, finishOrder: state.finishOrder });

    // Count how many unfinished players remain
    const totalActive = state.slots.filter(s => s !== null).length;
    const unfinished = totalActive - state.finishOrder.length;
    if (unfinished <= 1) {
      // Game is truly over
      state.gameState = 'finished';
      state.endedAt = Date.now();
      clearRoomTurnTimer(socket.roomId);
      // Persist leaderboard results for registered finishers
      (state.finishMeta || []).forEach((m, idx) => {
        if (m && m.userId) recordBoardResult(m.userId, m.username, idx === 0, m.kills);
      });
      io.to(socket.roomId).emit('game_over', state.finishOrder);
    }
    broadcastOpenRooms();
  });

  socket.on('return_to_lobby', () => {
    if (!socket.roomId) return;
    resetRoomToLobby(socket.roomId);
    const state = getRoomState(socket.roomId);
    io.to(socket.roomId).emit('lobby_state', { ...state, roomId: socket.roomId });
    broadcastOpenRooms();
  });

  socket.on('update_board_state', (boardState) => {
    if (!socket.roomId) return;
    const state = getRoomState(socket.roomId);
    state.boardState = boardState;
  });

  // Lightweight turn snapshot for the heartbeat: heals clients that missed
  // a turn_passed/dice_rolled packet (their dice would otherwise stay dead
  // until the next turn). No board data, so no re-render storms.
  socket.on('request_turn', () => {
    if (!socket.roomId) return;
    const state = getRoomState(socket.roomId);
    socket.emit('turn_state', {
      gameState: state.gameState,
      currentPlayer: state.currentPlayer,
      turnId: state.turnId,
      diceRolled: state.diceRolled,
      finishOrder: state.finishOrder || []
    });
  });

  socket.on('request_sync', () => {
    if (!socket.roomId) return;
    socket.to(socket.roomId).emit('sync_requested', socket.id);

    // Also send the server's cached state directly as a fallback for bot-only matches
    const state = getRoomState(socket.roomId);
    if (state.boardState) {
      socket.emit('sync_data', state.boardState);
      socket.emit('replay_moves', { moves: getReplayMoves(state), finishOrder: state.finishOrder || [] });
    }
  });

  socket.on('send_sync', (data) => {
    io.to(data.targetSocket).emit('sync_data', data.state);
  });

  socket.on('reset_session', () => {
    if (!socket.roomId) return;
    const state = getRoomState(socket.roomId);
    state.slots = [null, null, null, null];
    state.playerNames = ['', '', '', ''];
    resetRoomToLobby(socket.roomId);
    io.to(socket.roomId).emit('lobby_state', { ...state, roomId: socket.roomId });
    broadcastOpenRooms();
  });

  socket.on('reclaim_slot', (data) => {
    if (!data || !data.roomId || typeof data.slot !== 'number' || data.slot < 0 || data.slot > 3) return;
    const isFreshRoom = !rooms[data.roomId];
    if (getRoomState(data.roomId).gameState === 'finished') {
      resetRoomToLobby(data.roomId);
    }
    const state = getRoomState(data.roomId);
    if (state.cleanupTimer) {
      clearTimeout(state.cleanupTimer);
      state.cleanupTimer = null;
      console.log(`Cancelled cleanup timer for room ${data.roomId} - player returned!`);
    }
    // Only reclaim if slot is empty, a bot placeholder, marked offline, or stale socket id
    const occupant = state.slots[data.slot];
    const occupantIsStale = occupant && occupant !== 'bot' && !io.sockets.sockets.get(occupant);
    if (!occupant || occupant === 'bot' || state.offlineSlots[data.slot] || occupantIsStale) {
      state.slots[data.slot] = socket.id;
      state.offlineSlots[data.slot] = false;
      if (data.playerName) {
        state.playerNames[data.slot] = data.playerName;
      } else if (!state.playerNames[data.slot]) {
        state.playerNames[data.slot] = `Player ${data.slot + 1}`;
      }
      if (state.boardState) {
        state.boardState.slots = [...state.slots];
        state.boardState.playerNames = [...state.playerNames];
      }
    }
    socket.roomId = data.roomId;
    socket.join(data.roomId);
    socket.isSpectate = false;

    // Recompute host: a reclaimed socket id may be the host's new identity.
    const reclaimFirstHuman = state.slots.find(s => s !== null && s !== 'bot');
    state.host = reclaimFirstHuman || socket.id;

    // Directly send current state to the recovering player
    socket.emit('lobby_state', { ...state, roomId: data.roomId, fresh: isFreshRoom });
    if (state.gameState === 'playing' && state.boardState) {
      socket.emit('sync_data', state.boardState);
      socket.emit('replay_moves', { moves: getReplayMoves(state), finishOrder: state.finishOrder || [] });
    }
    io.to(data.roomId).emit('player_reconnected', data.slot);
    emitSpectators(data.roomId);
    broadcastOpenRooms();
  });

  socket.on('leave_room', () => {
    if (!socket.roomId) return;
    clearRoomTurnTimer(socket.roomId);
    const state = getRoomState(socket.roomId);
    const oldSlot = state.slots.indexOf(socket.id);
    if (oldSlot !== -1) {
      if (state.gameState === 'lobby' || state.gameState === 'finished') {
        state.slots[oldSlot] = null;
        state.playerNames[oldSlot] = '';
        state.offlineSlots[oldSlot] = false;
        io.to(socket.roomId).emit('lobby_state', { ...state, roomId: socket.roomId });

        // Leaving an empty lobby deletes it (mirrors the disconnect path)
        const humanCount = state.slots.filter(s => s !== null && s !== 'bot').length;
        if (humanCount === 0) {
          delete rooms[socket.roomId];
          console.log(`Deleted empty lobby: ${socket.roomId}`);
        }
      } else {
        state.offlineSlots[oldSlot] = true;
        io.to(socket.roomId).emit('player_disconnected', oldSlot);
        migrateHost(socket.roomId);
        maybeScheduleCleanup(socket.roomId);
      }
    }
    const leftRoom = socket.roomId;
    socket.leave(socket.roomId);
    socket.roomId = null;
    socket.isSpectate = false;
    emitSpectators(leftRoom);
    broadcastOpenRooms();
  });

  // Emote rate limiter storage: max 12 emotes per sec per socket
  const socketEmoteTimestamps = [];
  socket.on('send_emote', (data) => {
    if (!socket.roomId) return;
    const now = Date.now();
    // Keep only timestamps from last 1000ms
    while (socketEmoteTimestamps.length > 0 && now - socketEmoteTimestamps[0] > 1000) {
      socketEmoteTimestamps.shift();
    }
    if (socketEmoteTimestamps.length >= 12) return; // rate limit: prevent abuse/crash
    socketEmoteTimestamps.push(now);

    const state = getRoomState(socket.roomId);
    if (state.gameState !== 'playing') return;
    
    let slotIndex;
    let emoji;
    if (typeof data === 'object' && data !== null) {
      slotIndex = data.player;
      emoji = data.emoji;
    } else {
      slotIndex = state.slots.indexOf(socket.id);
      emoji = data;
    }
    
    if (slotIndex !== -1 && slotIndex !== null && slotIndex !== undefined && emoji) {
      io.to(socket.roomId).emit('receive_emote', { player: slotIndex, emoji });
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    if (activeSockets[socket.id]) {
      const p = activeSockets[socket.id];
      delete userToSocket[p.id];
      delete activeSockets[socket.id];
    }
    if (socket.userId) {
      delete userToSocket[socket.userId];
    }
    io.emit('friends_updated');
    if (!socket.roomId) return;
    const state = getRoomState(socket.roomId);
    const oldSlot = state.slots.indexOf(socket.id);
    if (oldSlot !== -1) {
      if (state.gameState === 'lobby' || state.gameState === 'finished') {
        state.slots[oldSlot] = null;
        state.playerNames[oldSlot] = '';
        state.offlineSlots[oldSlot] = false;
        io.to(socket.roomId).emit('lobby_state', { ...state, roomId: socket.roomId });

        // Lobby empty cleanup
        const humanCount = state.slots.filter(s => s !== null && s !== 'bot').length;
        if (humanCount === 0) {
          delete rooms[socket.roomId];
          console.log(`Deleted empty lobby: ${socket.roomId}`);
        }
      } else {
        state.offlineSlots[oldSlot] = true;
        io.to(socket.roomId).emit('player_disconnected', oldSlot);
        migrateHost(socket.roomId);

        // Active game: DO NOT delete room immediately! 15-minute grace period
        // so closed/reopened apps can always rejoin the live match.
        maybeScheduleCleanup(socket.roomId);
      }
    }
    if (socket.roomId) emitSpectators(socket.roomId);
    broadcastOpenRooms();
  });
});

const PORT = process.env.PORT || 8085;
const server = http.listen(PORT, () => {
  console.log(`Multiplayer Server running on port ${PORT}`);
});
// Fail fast if the port can't bind: a process that swallows EADDRINUSE would
// sit there serving nothing while the orchestrator thinks it's alive.
server.on('error', (err) => {
  console.error('Server listen error:', err.message);
  process.exit(1);
});

// Safety net: every 60s, delete non-playing rooms with no live humans
// (abandoned lobbies, finished games nobody returns to). Playing rooms
// are governed by the recovery timer instead, so live games are untouched.
const sweeper = setInterval(() => {
  try {
    let changed = false;
    Object.keys(rooms).forEach((roomId) => {
      const state = rooms[roomId];
      if (!state || state.gameState === 'playing' || state.cleanupTimer) return;
      const liveHumans = state.slots.filter(s => s && s !== 'bot' && io.sockets.sockets.get(s)).length;
      if (liveHumans === 0) {
        delete rooms[roomId];
        changed = true;
        console.log(`Sweeper deleted idle room: ${roomId}`);
      }
    });
    if (changed) broadcastOpenRooms();
  } catch (e) {
    console.error('Sweeper error:', e.message);
  }
}, 60000);

function gracefulShutdown(signal) {
  console.log(`Received ${signal}, shutting down gracefully...`);
  try {
    clearInterval(sweeper);
    Object.keys(rooms).forEach(clearRoomTurnTimer);
    Object.values(rooms).forEach(r => {
      if (r.cleanupTimer) clearTimeout(r.cleanupTimer);
    });
  } catch (e) {}
  server.close(() => {
    console.log('HTTP server closed');
    db.close((err) => {
      if (err) console.error('DB close error:', err.message);
      else console.log('DB closed');
      process.exit(0);
    });
    // Force exit if DB close hangs (Render gives limited shutdown time)
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
