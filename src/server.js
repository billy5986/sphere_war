const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });

// 存放所有玩家的物件
let players = {};

io.on('connection', (socket) => {
    console.log('新玩家加入:', socket.id);
    
    // 初始化玩家資料
    players[socket.id] = { x: 100, y: 100, color: '#' + Math.floor(Math.random()*16777215).toString(16) };

    // 通知所有人有新玩家
    io.emit('update_players', players);

    // 接收玩家移動指令
    socket.on('player_move', (data) => {
        if (players[socket.id]) {
            players[socket.id].x += data.dx;
            players[socket.id].y += data.dy;
            // 廣播最新位置
            io.emit('update_players', players);
        }
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('update_players', players);
        console.log('玩家離線:', socket.id);
    });
});

http.listen(3000, () => console.log('伺服器在 3000 port 運行中...'));
