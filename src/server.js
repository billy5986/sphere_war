const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });

let rooms = {};
const MAX_PELLETS = 50;
const MAX_SPIKES = 15;
const WORLD_SIZE = 800; 

function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function spawnPellet() {
    return { 
        x: (Math.random() - 0.5) * WORLD_SIZE * 2, 
        y: 4, 
        z: (Math.random() - 0.5) * WORLD_SIZE * 2 
    };
}

function spawnSpike() {
    return {
        x: (Math.random() - 0.5) * WORLD_SIZE * 1.8,
        z: (Math.random() - 0.5) * WORLD_SIZE * 1.8
    };
}

io.on('connection', (socket) => {
    console.log('新玩家連線:', socket.id);
    let currentRoom = null;

    socket.on('create_room', () => {
        const roomId = generateRoomCode();
        rooms[roomId] = { players: {}, pellets: [], spikes: [], usedColors: [], usedNames: [] };
        
        for (let i = 0; i < MAX_PELLETS; i++) rooms[roomId].pellets.push(spawnPellet());
        for (let i = 0; i < MAX_SPIKES; i++) rooms[roomId].spikes.push(spawnSpike());

        socket.join(roomId);
        currentRoom = roomId;
        socket.emit('room_joined', roomId);
    });

    socket.on('join_room', (roomId) => {
        roomId = roomId.toUpperCase();
        if (rooms[roomId]) {
            socket.join(roomId);
            currentRoom = roomId;
            socket.emit('room_joined', roomId);
        } else {
            socket.emit('room_error', '找不到該房間！');
        }
    });

    socket.on('check_availability', (data) => {
        const roomId = data.roomId;
        if (!rooms[roomId]) return socket.emit('check_result', { valid: false, msg: '房間已不存在' });
        if (rooms[roomId].usedColors.includes(data.color)) return socket.emit('check_result', { valid: false, msg: '這個顏色已經被選走了，請換一個！' });
        if (rooms[roomId].usedNames.includes(data.name)) return socket.emit('check_result', { valid: false, msg: '這個名稱已經有人使用了，請換一個！' });
        socket.emit('check_result', { valid: true });
    });
    
    socket.on('join_game', (data) => {
        const roomId = data.roomId;
        const color = data.color;
        const name = data.name || '無名氏';

        if (!rooms[roomId]) return socket.emit('color_error', '房間已不存在');
        if (rooms[roomId].usedColors.includes(color)) return socket.emit('color_error', '這個顏色已經被選走了！');
        if (rooms[roomId].usedNames.includes(name)) return socket.emit('name_error', '這個名稱已經有人使用了！');

        rooms[roomId].usedColors.push(color);
        rooms[roomId].usedNames.push(name);
        
        rooms[roomId].players[socket.id] = {
            x: (Math.random() - 0.5) * 500, y: 20, z: (Math.random() - 0.5) * 500,
            vy: 0, radius: 20, color: color, name: name,
            input: { dx: 0, dz: 0, jump: false, dash: false }
        };

        socket.emit('game_started');
    });

    socket.on('player_input', (input) => {
        if (currentRoom && rooms[currentRoom] && rooms[currentRoom].players[socket.id]) {
            rooms[currentRoom].players[socket.id].input = input;
        }
    });

    socket.on('disconnect', () => {
        if (currentRoom && rooms[currentRoom]) {
            const room = rooms[currentRoom];
            const player = room.players[socket.id];
            if (player) {
                room.usedColors = room.usedColors.filter(c => c !== player.color);
                room.usedNames = room.usedNames.filter(n => n !== player.name);
                delete room.players[socket.id];
            }
            if (Object.keys(room.players).length === 0) delete rooms[currentRoom];
        }
    });
});

setInterval(() => {
    for (let roomId in rooms) {
        let room = rooms[roomId];
        let players = room.players;
        let pellets = room.pellets;
        let spikes = room.spikes;

        // 1. 移動與物理 (動態速度與衝刺耗損)
        for (let id in players) {
            let p = players[id];
            let input = p.input;
            let isDashing = input.dash && p.radius > 20;

            let sizeFactor = Math.max(0, p.radius - 20); 
            let baseSpeed = Math.max(3, 8 - sizeFactor * 0.025); // 修改: 吃200光點降到最低
            let dashMult = Math.max(1.2, 2.0 - sizeFactor * 0.004); // 修改: 吃200光點降到最低
            let dashCost = 0.05 + sizeFactor * 0.002;

            let speed = isDashing ? baseSpeed * dashMult : baseSpeed;

            if (isDashing) {
                p.radius -= dashCost; 
                if (p.radius < 20) p.radius = 20; 
            }

            p.x += input.dx * speed;
            p.z += input.dz * speed;
            p.vy -= 1.5; 
            p.y += p.vy;

            let isGrounded = false;
            if (Math.abs(p.x) <= WORLD_SIZE && Math.abs(p.z) <= WORLD_SIZE) {
                if (p.y <= p.radius) {
                    p.y = p.radius; p.vy = 0; isGrounded = true;
                }
            }

            if (input.jump && isGrounded) {
                p.vy = 25; input.jump = false; 
            }
        }

        // 2. 吃光點
        for (let id in players) {
            let p = players[id];
            for (let i = pellets.length - 1; i >= 0; i--) {
                let dist = Math.hypot(p.x - pellets[i].x, p.y - pellets[i].y, p.z - pellets[i].z);
                if (dist < p.radius + 15) {
                    pellets.splice(i, 1);       
                    p.radius += 1;          
                    pellets.push(spawnPellet());
                }
            }
        }

        // 3. 尖刺陷阱判定 (大於 40 半徑 / 20 能量觸發)
        for (let id in players) {
            let p = players[id];
            for (let i = 0; i < spikes.length; i++) {
                let spike = spikes[i];
                let dist = Math.hypot(p.x - spike.x, p.z - spike.z);
                if (dist < p.radius + 10) {
                    if (p.radius > 40) {
                        let energy = p.radius - 20;
                        let lostEnergy = energy * 0.2; 
                        p.radius -= lostEnergy;
                        
                        p.vy = 20; 
                        let angle = Math.atan2(p.z - spike.z, p.x - spike.x);
                        p.x += Math.cos(angle) * 40; 
                        p.z += Math.sin(angle) * 40;

                        // 噴灑光點
                        let dropCount = Math.min(30, Math.floor(lostEnergy));
                        for (let d = 0; d < dropCount; d++) {
                            let dropAngle = Math.random() * Math.PI * 2;
                            let dropDist = 20 + Math.random() * 60;
                            pellets.push({
                                x: spike.x + Math.cos(dropAngle) * dropDist, y: 4,
                                z: spike.z + Math.sin(dropAngle) * dropDist
                            });
                        }
                    }
                }
            }
        }

        // 4. 玩家碰撞判定
        let playerIds = Object.keys(players);
        for (let i = 0; i < playerIds.length; i++) {
            for (let j = i + 1; j < playerIds.length; j++) {
                let p1 = players[playerIds[i]];
                let p2 = players[playerIds[j]];
                if (!p1 || !p2) continue;

                let dx = p1.x - p2.x, dy = p1.y - p2.y, dz = p1.z - p2.z;
                let dist = Math.hypot(dx, dy, dz);
                let minDist = p1.radius + p2.radius;

                if (dist < minDist && dist > 0) {
                    let overlap = minDist - dist;
                    let hDist = Math.hypot(dx, dz);
                    let hnx = hDist > 0 ? dx / hDist : 1;
                    let hnz = hDist > 0 ? dz / hDist : 0;

                    p1.x += hnx * (overlap / 2); p1.z += hnz * (overlap / 2);
                    p2.x -= hnx * (overlap / 2); p2.z -= hnz * (overlap / 2);

                    let baseForce = 200;
                    let p1Dashing = p1.input.dash && p1.radius > 20;
                    let p2Dashing = p2.input.dash && p2.radius > 20;

                    let f1on2 = 0; 
                    let f2on1 = 0; 

                    if (p1.radius > p2.radius * 1.1) {
                        f1on2 = p1Dashing ? baseForce * 1.5 : baseForce;
                    } else if (p1Dashing && !p2Dashing) {
                        f1on2 = baseForce * 1.2; 
                    }

                    if (p2.radius > p1.radius * 1.1) {
                        f2on1 = p2Dashing ? baseForce * 1.5 : baseForce;
                    } else if (p2Dashing && !p1Dashing) {
                        f2on1 = baseForce * 1.2;
                    }

                    let res1 = Math.max(0.2, 20 / p1.radius);
                    let res2 = Math.max(0.2, 20 / p2.radius);

                    p1.x += hnx * (f2on1 * res1);
                    p1.z += hnz * (f2on1 * res1);
                    p2.x -= hnx * (f1on2 * res2);
                    p2.z -= hnz * (f1on2 * res2);
                }
            }
        }
        
        // 5. 虛空判定
        for (let id in players) {
            let p = players[id];
            if (p.y + p.radius < 0) {
                io.to(id).emit('you_lost', '你掉入虛空了！復活中...');
                p.x = (Math.random() - 0.5) * WORLD_SIZE; p.z = (Math.random() - 0.5) * WORLD_SIZE;
                p.y = 100; p.vy = 0; p.radius = 20; 
            }
        }

        io.to(roomId).emit('update_game_state', { players, pellets, spikes });
    }
}, 30);

http.listen(3000, () => console.log('伺服器在 3000 port 運行中...'));
