const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');

const db = new sqlite3.Database(path.join(__dirname, 'database.sqlite'));

db.serialize(() => {
  db.run("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT)");
  db.run("CREATE TABLE IF NOT EXISTS friends (user_id INTEGER, friend_id INTEGER, PRIMARY KEY(user_id, friend_id))");
});

app.use(express.json());
app.use(express.static(__dirname));

app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing username or password' });
  bcrypt.hash(password, 10, (err, hash) => {
    if (err) return res.status(500).json({ error: 'Server error' });
    db.run("INSERT INTO users (username, password) VALUES (?, ?)", [username, hash], function(err) {
      if (err) return res.status(400).json({ error: 'Username taken' });
      res.json({ id: this.lastID, username });
    });
  });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  db.get("SELECT * FROM users WHERE username = ?", [username], (err, row) => {
    if (err || !row) return res.status(400).json({ error: 'Invalid username or password' });
    bcrypt.compare(password, row.password, (err, result) => {
      if (result) res.json({ id: row.id, username: row.username });
      else res.status(400).json({ error: 'Invalid username or password' });
    });
  });
});

const fs = require('fs');

// Persistent JSON store for players and friendships so redeploys never wipe accounts
const STORE_PATH = path.join(__dirname, 'players_store.json');
let playerStore = { players: {}, friends: {} }; // players: id -> { id, username, tag, lastSeen }, friends: id -> [friendIds]

try {
  if (fs.existsSync(STORE_PATH)) {
    playerStore = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  }
} catch (e) {
  console.log('Using fresh playerStore');
}

function persistStore() {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(playerStore, null, 2));
  } catch (e) {}
}

const activeSockets = {}; // socket.id -> { id, username, tag }
const userToSocket = {}; // id -> socket.id

// Register or get player identity
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

  playerStore.players[id] = { id, username, tag, lastSeen: Date.now() };
  if (!playerStore.friends[id]) playerStore.friends[id] = [];
  persistStore();

  res.json({ id, username, tag });
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
  const friendIds = playerStore.friends[userId] || [];
  
  const list = friendIds.map(fId => {
    const p = playerStore.players[fId] || { id: fId, username: 'Friend', tag: `#${fId.slice(-4)}` };
    const isOnline = !!userToSocket[fId];
    return {
      id: p.id,
      username: p.username,
      tag: p.tag,
      isOnline
    };
  });

  res.json(list);
});

app.post('/api/friends', (req, res) => {
  const { userId, query } = req.body;
  if (!query || !userId) return res.status(400).json({ error: 'Please enter a username or player tag' });
  
  const q = query.trim().toLowerCase();
  
  // 1. Check known players store
  let target = Object.values(playerStore.players).find(p => 
    p.id !== userId && (
      p.tag.toLowerCase() === q ||
      p.username.toLowerCase() === q ||
      p.tag.toLowerCase().startsWith(q)
    )
  );

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

  // 3. Fallback: Check SQLite
  if (!target) {
    return db.get("SELECT id, username FROM users WHERE LOWER(TRIM(username)) = LOWER(?)", [q], (err, row) => {
      if (err || !row) {
        return res.status(404).json({ error: `Player "${query}" not found. Ensure they entered a nickname or are online.` });
      }
      const targetId = 'usr_' + row.id;
      const targetTag = `${row.username}#${row.id}`;
      playerStore.players[targetId] = { id: targetId, username: row.username, tag: targetTag, lastSeen: Date.now() };
      completeFriendAdd(userId, targetId, row.username, targetTag, res);
    });
  }

  completeFriendAdd(userId, target.id, target.username, target.tag, res);
});

function completeFriendAdd(u1, u2, friendName, friendTag, res) {
  if (u1 === u2) return res.status(400).json({ error: 'You cannot add yourself' });
  if (!playerStore.friends[u1]) playerStore.friends[u1] = [];
  if (!playerStore.friends[u2]) playerStore.friends[u2] = [];

  if (playerStore.friends[u1].includes(u2)) {
    return res.status(400).json({ error: 'Already friends' });
  }

  playerStore.friends[u1].push(u2);
  playerStore.friends[u2].push(u1);
  persistStore();

  io.emit('friends_updated');
  res.json({ id: u2, username: friendName, tag: friendTag });
}

app.delete('/api/friends', (req, res) => {
  const { userId, friendId } = req.body;
  if (playerStore.friends[userId]) {
    playerStore.friends[userId] = playerStore.friends[userId].filter(id => id !== friendId);
  }
  if (playerStore.friends[friendId]) {
    playerStore.friends[friendId] = playerStore.friends[friendId].filter(id => id !== userId);
  }
  persistStore();
  io.emit('friends_updated');
  res.json({ success: true });
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
      offlineSlots: [false, false, false, false]
    };
  }
  return rooms[roomId];
}

function broadcastOpenRooms() {
  const list = Object.keys(rooms).map(roomId => {
    const room = rooms[roomId];
    const humanCount = room.slots.filter(s => s !== null && s !== 'bot').length;
    const totalCount = room.slots.filter(s => s !== null).length;
    return {
      roomId,
      gameState: room.gameState,
      humanCount,
      totalCount,
      playerNames: room.playerNames.filter(n => n !== '')
    };
  }).filter(r => r.humanCount > 0);
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

    playerStore.players[id] = { id, username, tag, lastSeen: Date.now() };
    if (!playerStore.friends[id]) playerStore.friends[id] = [];
    persistStore();

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
    
    Array.from(socket.rooms).forEach(r => {
      if(r !== socket.id) socket.leave(r);
    });
    socket.join(roomId);
    socket.roomId = roomId;
    
    const state = getRoomState(roomId);

    // Auto-claim first empty slot if player is not currently in a slot in lobby
    if (state.gameState === 'lobby') {
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

    io.to(roomId).emit('lobby_state', { ...state, socketId: socket.id, roomId });
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
      state.gameState = 'playing';
      state.finishOrder = []; // reset finish rankings
      io.to(socket.roomId).emit('game_started', state);
      broadcastOpenRooms();
    }
  });

  socket.on('roll_dice', (data) => {
    if (!socket.roomId) return;
    const state = getRoomState(socket.roomId);
    if (state.gameState !== 'playing') return;
    io.to(socket.roomId).emit('dice_rolled', data);
  });

  socket.on('execute_move', (moveObj) => {
    if (!socket.roomId) return;
    const state = getRoomState(socket.roomId);
    if (state.gameState !== 'playing') return;
    io.to(socket.roomId).emit('move_executed', moveObj);
  });
  
  socket.on('next_turn', () => {
     if (!socket.roomId) return;
     io.to(socket.roomId).emit('turn_passed');
  });

  socket.on('player_finished', (playerSlot) => {
    if (!socket.roomId) return;
    const state = getRoomState(socket.roomId);
    if (state.gameState !== 'playing') return;
    if (!state.finishOrder) state.finishOrder = [];
    if (!state.finishOrder.includes(playerSlot)) {
      state.finishOrder.push(playerSlot);
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
      io.to(socket.roomId).emit('game_over', state.finishOrder);
    }
    broadcastOpenRooms();
  });

  socket.on('return_to_lobby', () => {
    if (!socket.roomId) return;
    const state = getRoomState(socket.roomId);
    state.gameState = 'lobby';
    io.to(socket.roomId).emit('lobby_state', { ...state, roomId: socket.roomId });
    broadcastOpenRooms();
  });

  socket.on('update_board_state', (boardState) => {
    if (!socket.roomId) return;
    const state = getRoomState(socket.roomId);
    state.boardState = boardState;
  });

  socket.on('request_sync', () => {
    if (!socket.roomId) return;
    socket.to(socket.roomId).emit('sync_requested', socket.id);
    
    // Also send the server's cached state directly as a fallback for bot-only matches
    const state = getRoomState(socket.roomId);
    if (state.boardState) {
      socket.emit('sync_data', state.boardState);
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
    state.gameState = 'lobby';
    io.to(socket.roomId).emit('lobby_state', { ...state, roomId: socket.roomId });
    broadcastOpenRooms();
  });

  socket.on('reclaim_slot', (data) => {
    const state = getRoomState(data.roomId);
    if (state.gameState === 'playing') {
      if (state.cleanupTimer) {
        clearTimeout(state.cleanupTimer);
        state.cleanupTimer = null;
        console.log(`Cancelled cleanup timer for room ${data.roomId} - player returned!`);
      }
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
      socket.roomId = data.roomId;
      socket.join(data.roomId);
      
      // Directly send current state to the recovering player
      socket.emit('lobby_state', { ...state, roomId: data.roomId });
      if (state.boardState) {
        socket.emit('sync_data', state.boardState);
      }
      io.to(data.roomId).emit('player_reconnected', data.slot);
      broadcastOpenRooms();
    }
  });

  socket.on('leave_room', () => {
    if (!socket.roomId) return;
    const state = getRoomState(socket.roomId);
    const oldSlot = state.slots.indexOf(socket.id);
    if (oldSlot !== -1) {
      if (state.gameState === 'lobby') {
        state.slots[oldSlot] = null;
        state.playerNames[oldSlot] = '';
        io.to(socket.roomId).emit('lobby_state', { ...state, roomId: socket.roomId });
      } else {
        state.offlineSlots[oldSlot] = true;
        io.to(socket.roomId).emit('player_disconnected', oldSlot);
      }
    }
    socket.leave(socket.roomId);
    socket.roomId = null;
    broadcastOpenRooms();
  });

  socket.on('send_emote', (data) => {
    if (!socket.roomId) return;
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
    
    if (slotIndex !== -1 && slotIndex !== null && slotIndex !== undefined) {
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
      if (state.gameState === 'lobby') {
        state.slots[oldSlot] = null;
        state.playerNames[oldSlot] = '';
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

        // Active game: DO NOT delete room immediately! Give 5 minutes grace period
        const onlineHumans = state.slots.filter((s, i) => s !== null && s !== 'bot' && !state.offlineSlots[i]).length;
        if (onlineHumans === 0 && !state.cleanupTimer) {
          console.log(`All human players offline in room ${socket.roomId}. Starting 5-minute recovery timer.`);
          state.cleanupTimer = setTimeout(() => {
            const recheck = state.slots.filter((s, i) => s !== null && s !== 'bot' && !state.offlineSlots[i]).length;
            if (recheck === 0) {
              delete rooms[socket.roomId];
              console.log(`Recovery window expired. Deleted empty room: ${socket.roomId}`);
            }
          }, 300000); // 5 minutes
        }
      }
    }
    broadcastOpenRooms();
  });
});

const PORT = process.env.PORT || 8085;
http.listen(PORT, () => {
  console.log(`Multiplayer Server running on port ${PORT}`);
});
