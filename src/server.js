const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });

let players = {};
let pellets = [];
const MAX_PELLETS = 50;

// 初始化產生光點
function spawnPellet() {
    return { x: Math.random() * 800, y: Math.random() * 600 };
}
for (let i = 0; i < MAX_PELLETS; i++) pellets.push(spawnPellet());

io.on('connection', (socket) => {
    console.log('新玩家加入:', socket.id);
    
    // 初始化玩家狀態：加入 radius 屬性
    players[socket.id] = { 
        x: Math.random() * 800, 
        y: Math.random() * 600, 
        radius: 20,
        color: '#' + Math.floor(Math.random()*16777215).toString(16) 
    };

    // 接收玩家移動指令 (僅更新座標，不立即廣播)
    socket.on('player_move', (data) => {
        let p = players[socket.id];
        if (!p) return;

        // 速度計算：越大的球速度越慢，最低保底速度為 1.5
        let speed = Math.max(1.5, 5 - (p.radius - 20) * 0.1); 
        
        p.x += data.dx * speed;
        p.y += data.dy * speed;
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        console.log('玩家離線:', socket.id);
    });
});

// 伺服器遊戲迴圈：每 30 毫秒執行一次統一結算 (約 33 FPS)
setInterval(() => {
    // 1. 判定：玩家吃光點
    for (let id in players) {
        let p = players[id];
        for (let i = pellets.length - 1; i >= 0; i--) {
            let dist = Math.hypot(p.x - pellets[i].x, p.y - pellets[i].y);
            // 距離小於半徑即判定吃到
            if (dist < p.radius) {
                pellets.splice(i, 1);       // 移除光點
                p.radius += 1;              // 增加體積
                pellets.push(spawnPellet());// 隨機補充新光點
            }
        }
    }

    // 2. 判定：玩家大吃小
    let playerIds = Object.keys(players);
    for (let i = 0; i < playerIds.length; i++) {
        for (let j = i + 1; j < playerIds.length; j++) {
            let p1 = players[playerIds[i]];
            let p2 = players[playerIds[j]];
            if (!p1 || !p2) continue;

            let dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
            // 發生碰撞
            if (dist < p1.radius + p2.radius) {
                // 體積需大於對方 20% 才能吞噬
                if (p1.radius > p2.radius * 1.2) {
                    p1.radius += p2.radius * 0.5;
                    io.to(playerIds[j]).emit('you_lost', '你被吃掉了！');
                    delete players[playerIds[j]];
                } else if (p2.radius > p1.radius * 1.2) {
                    p2.radius += p1.radius * 0.5;
                    io.to(playerIds[i]).emit('you_lost', '你被吃掉了！');
                    delete players[playerIds[i]];
                }
            }
        }
    }

    // 3. 統一廣播當前最新狀態
    io.emit('update_game_state', { players, pellets });

}, 30);

http.listen(3000, () => console.log('伺服器在 3000 port 運行中...'));
