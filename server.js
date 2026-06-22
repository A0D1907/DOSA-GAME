// server.js
const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(__dirname));

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
      gameSettings: { pegsPerPlayer: 4 }
    };
  }
  return rooms[roomId];
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  socket.on('join_room', (roomId) => {
    Array.from(socket.rooms).forEach(r => {
      if(r !== socket.id) socket.leave(r);
    });
    socket.join(roomId);
    socket.roomId = roomId;
    
    const state = getRoomState(roomId);
    socket.emit('lobby_state', { ...state, socketId: socket.id, roomId });
  });

  socket.on('join_slot', (slotIndex) => {
    if (!socket.roomId) return;
    const state = getRoomState(socket.roomId);
    if (state.gameState !== 'lobby') return;
    
    const oldSlot = state.slots.indexOf(socket.id);
    if (oldSlot !== -1) {
      state.slots[oldSlot] = null;
      state.playerNames[oldSlot] = '';
    }
    
    if (!state.slots[slotIndex]) {
      state.slots[slotIndex] = socket.id;
      state.playerNames[slotIndex] = `Player ${slotIndex + 1}`;
    }
    
    io.to(socket.roomId).emit('lobby_state', { ...state, roomId: socket.roomId });
  });

  socket.on('update_settings', (settings) => {
    if (!socket.roomId) return;
    const state = getRoomState(socket.roomId);
    if (state.gameState !== 'lobby') return;
    state.gameSettings = settings;
    io.to(socket.roomId).emit('lobby_state', { ...state, roomId: socket.roomId });
  });

  socket.on('start_game', () => {
    if (!socket.roomId) return;
    const state = getRoomState(socket.roomId);
    if (state.gameState !== 'lobby') return;
    state.gameState = 'playing';
    io.to(socket.roomId).emit('game_started', state);
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

  socket.on('player_won', (pName) => {
    if (!socket.roomId) return;
    const state = getRoomState(socket.roomId);
    state.gameState = 'finished';
    io.to(socket.roomId).emit('game_over', pName);
  });

  socket.on('return_to_lobby', () => {
    if (!socket.roomId) return;
    const state = getRoomState(socket.roomId);
    state.gameState = 'lobby';
    io.to(socket.roomId).emit('lobby_state', { ...state, roomId: socket.roomId });
  });

  socket.on('request_sync', () => {
    if (!socket.roomId) return;
    socket.to(socket.roomId).emit('sync_requested', socket.id);
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
  });

  socket.on('reclaim_slot', (data) => {
    const state = getRoomState(data.roomId);
    if (state.gameState === 'playing' && !state.slots[data.slot]) {
      state.slots[data.slot] = socket.id;
      socket.roomId = data.roomId;
      socket.join(data.roomId);
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    if (!socket.roomId) return;
    const state = getRoomState(socket.roomId);
    const oldSlot = state.slots.indexOf(socket.id);
    if (oldSlot !== -1) {
      state.slots[oldSlot] = null;
      state.playerNames[oldSlot] = '';
      if (state.gameState === 'lobby') {
        io.to(socket.roomId).emit('lobby_state', { ...state, roomId: socket.roomId });
      } else {
        io.to(socket.roomId).emit('player_disconnected', oldSlot);
      }
    }
  });
});

const PORT = 8085;
http.listen(PORT, () => {
  console.log(`Multiplayer Server running on http://localhost:${PORT}`);
});
