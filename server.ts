const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const CHAT_PREFIX = 'chatroom:';
const WEBRTC_PREFIX = 'webrtc:';
const chatRoomUsers = new Map<string, Set<string>>();

const app = express();
app.use(express.static('public'));

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
  },
});

io.on('connection', (socket: any) => {
  console.log(`[连接] 用户 ${socket.id} 已连接`);

  // 用户加入房间
  socket.on('join', (room: string) => {
    const fullRoom = `${WEBRTC_PREFIX}${room}`;
    const clients = io.sockets.adapter.rooms.get(fullRoom) || new Set();
    const numClients = clients.size;
    if (numClients > 1) {
      socket.emit("full");
      return;
    }
    // 加入房间
    socket.join(fullRoom);
    socket.data.room = room;
    socket.data.type = 'webrtc';
    socket.emit('join-success');
    console.log(`${socket.id} 加入 ${room}`);
  });

  socket.on('join-ready', (room: string) => {
    const fullRoom = `${WEBRTC_PREFIX}${room}`;
    const clients: Set<string> = io.sockets.adapter.rooms.get(fullRoom) || new Set();
    console.log('clients: ', clients);
    if (clients.size === 2) {
      // 找出先加入的那个人
      for (const id of clients) {
        if (id !== socket.id) {
          // 通知他现在可以开始发起连接了
          io.to(id).emit('joined', socket.id); // 让他 createOffer
          break;
        }
      }
    }
  });

  // 转发 offer/answer/candidate
  socket.on('signal', ({ to, room, data }: { to: string, room: string; data: any }) => {
    if (socket.data.type === 'webrtc') {
      const fullRoom = `${WEBRTC_PREFIX}${room}`;
      return socket.to(fullRoom).emit('signal', { from: socket.id, data });
    }
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('disconnect', () => {
    console.log(`[断开] 用户 ${socket.id} 已断开`);
    if (socket.data.type === 'webrtc') {
      const room = socket.data.room;
      const fullRoom = `${WEBRTC_PREFIX}${room}`;
      socket.to(fullRoom).emit('peer-left');
      return;
    }
  });

  socket.on('disconnecting', () => {
    if (socket.data.type === 'webrtc') return;
    const fullRoom = `${CHAT_PREFIX}${socket.data.room}`;
    const nickname = socket.data.nickname;
    if (chatRoomUsers.has(fullRoom)) {
      chatRoomUsers.get(fullRoom)!.delete(nickname);
      if (chatRoomUsers.get(fullRoom)!.size === 0) {
        chatRoomUsers.delete(fullRoom);
        return;
      }

      // 广播更新成员列表
      io.to(fullRoom).emit('chat-userlist', {
        users: [...chatRoomUsers.get(fullRoom)!],
      });

      socket.to(fullRoom).emit('chat-message', {
        from: '系统',
        message: `${nickname} 离开了聊天室`,
      });
    }
  });

  socket.on('join-chatroom', ({ room, nickname }: { room: string, nickname: string }) => {
    const fullRoom = `${CHAT_PREFIX}${room}`;
    const safeName = nickname || '匿名';
    let isInit = false;
    if (!chatRoomUsers.has(fullRoom)) {
      chatRoomUsers.set(fullRoom, new Set());
      socket.emit('init-host');
      isInit = true;
    }
    const roomUsers = chatRoomUsers.get(fullRoom);
    if (roomUsers!.has(safeName)) {
      socket.emit('chat-join-failed', {
        reason: `昵称「${safeName}」已被占用，请更换后再试`,
      });
      return;
    }
    // 加入之前需要先获取密钥，随机选择一个room内的client构建webrtc连接
    if (!isInit) {
      const sockets = io.sockets.adapter.rooms.get(fullRoom);
      const ids = [...sockets!];
      const randomId = ids[Math.floor(Math.random() * ids.length)];
      io.to(randomId).emit('connect-to', { id: socket.id });
    }

    socket.join(fullRoom);
    socket.data.nickname = safeName;
    socket.data.room = room;
    socket.data.type = 'chat';
    roomUsers!.add(safeName);
    console.log(`[chat] ${socket.data.nickname} 加入了房间 ${room}`);

    io.to(fullRoom).emit('chat-userlist', {
      users: [...roomUsers!],
    });

    socket.to(fullRoom).emit('chat-message', {
      from: '系统',
      message: `${socket.data.nickname} 加入了聊天室`
    });
  });

  socket.on('leave-chatroom', ({ room }: { room: string }) => {
    const fullRoom = `${CHAT_PREFIX}${room}`;
    const nickname = socket.data.nickname;
    socket.leave(fullRoom);
    const users = chatRoomUsers.get(fullRoom);
    if (users) {
      users.delete(nickname);
      if (users.size === 0) {
        chatRoomUsers.delete(fullRoom);
        return;
      }
      io.to(fullRoom).emit('chat-userlist', {
        users: [...users],
      });
      socket.to(fullRoom).emit('chat-message', {
        from: '系统',
        message: `${nickname} 离开了聊天室`,
      });
    }
  });

  socket.on('chat-message', ({ room, encrypted }: { room: string; encrypted: any }) => {
    const fullRoom = `${CHAT_PREFIX}${room}`;
    socket.to(fullRoom).emit('chat-message', {
      from: socket.data.nickname || '匿名',
      encrypted,
    });
  });
});

const configPath = path.join(__dirname, 'public', 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
const PORT = config.port || 3000;
const HOST = '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`🚀 Signaling Server 正在运行：http://${HOST}:${PORT}`);
});