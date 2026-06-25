const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });

let rooms = {};
const MAX_PELLETS = 50;
const MAX_SPIKES = 15;
const MAX_BOOST_PADS = 8; // 新增：加速陣數量
const WORLD_SIZE = 800; 
const SPIKE_RADIUS = 15; // 尖刺的物理半徑

// 產生隨機房間代碼
function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// 產生光點
function spawnPellet() {
    return { 
        x: (Math.random() - 0.5) * WORLD_SIZE * 2, 
        y: 4, 
        z: (Math.random() - 0.5) * WORLD_SIZE * 2 
    };
}

// 產生紅色尖刺
function spawnSpike() {
    return {
        x: (Math.random() - 0.5) * WORLD_SIZE * 1.8,
        z: (Math.random() - 0.5) * WORLD_SIZE * 1.8
    };
}

// 產生加速陣
function spawnBoostPad() {
    return {
        x: (Math.random() - 0.5) * WORLD_SIZE * 1.6,
        z: (Math.random() - 0.5) * WORLD_SIZE * 1.6,
        radius: 25
    };
}

io.on('connection', (socket) => {
    console.log('新玩家連線:', socket.id);
    let currentRoom = null;

    socket.on('create_room', () => {
        const roomId = generateRoomCode();
        rooms[roomId] = { players: {}, pellets: [], spikes: [], boostPads: [], usedColors: [], usedNames: [] };
        
        for (let i = 0; i < MAX_PELLETS; i++) rooms[roomId].pellets.push(spawnPellet());
        for (let i = 0; i < MAX_SPIKES; i++) rooms[roomId].spikes.push(spawnSpike());
        for (let i = 0; i < MAX_BOOST_PADS; i++) rooms[roomId].boostPads.push(spawnBoostPad()); // 初始化加速陣

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
        
        // 賦予新的物理變數 (vx, vz, 特效計時器)
        rooms[roomId].players[socket.id] = {
            x: (Math.random() - 0.5) * 500, y: 20, z: (Math.random() - 0.5) * 500,
            vx: 0, vy: 0, vz: 0, boostCooldown: 0, boostEffect: 0, damageEffect: 0,
            radius: 20, color: color, name: name,
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
        let boostPads = room.boostPads;

        // 1. 移動與物理
        for (let id in players) {
            let p = players[id];
            
            // 確保具備物理速度與特效的變數 (防呆)
            p.vx = p.vx || 0;
            p.vz = p.vz || 0;
            p.boostCooldown = p.boostCooldown || 0;
            p.boostEffect = p.boostEffect || 0;
            p.damageEffect = p.damageEffect || 0;

            // 遞減特效計時器
            if (p.boostCooldown > 0) p.boostCooldown--;
            if (p.boostEffect > 0) p.boostEffect--;
            if (p.damageEffect > 0) p.damageEffect--;

            let input = p.input;

            // 檢查是否踩到加速帶
            for (let i = 0; i < boostPads.length; i++) {
                let pad = boostPads[i];
                if (Math.hypot(p.x - pad.x, p.z - pad.z) < p.radius + pad.radius) {
                    if (p.boostCooldown <= 0) {
                        let speedDir = Math.hypot(input.dx, input.dz);
                        let bx = 0, bz = 0;
                        
                        if (speedDir > 0) {
                            bx = (input.dx / speedDir);
                            bz = (input.dz / speedDir);
                        } else if (p.vx !== 0 || p.vz !== 0) {
                            let vDir = Math.hypot(p.vx, p.vz);
                            bx = p.vx / vDir;
                            bz = p.vz / vDir;
                        } else {
                            // 靜止時隨機方向衝刺
                            let angle = Math.random() * Math.PI * 2;
                            bx = Math.cos(angle);
                            bz = Math.sin(angle);
                        }
                        
                        p.vx += bx * 45; 
                        p.vz += bz * 45;
                        p.boostCooldown = 90; // 3 秒 CD
                        p.boostEffect = 15;   // 0.5 秒特效
                    }
                }
            }

            let isDashing = input.dash && p.radius > 20;
            let sizeFactor = Math.max(0, p.radius - 20); 
            let baseSpeed = Math.max(3, 8 - Math.sqrt(sizeFactor) * 0.41); 
            let dashMult = Math.max(1.2, 2.0 - sizeFactor * 0.0053); 
            let dashCost = 0.05 + sizeFactor * 0.0026;

            let speed = isDashing ? baseSpeed * dashMult : baseSpeed;

            if (isDashing) {
                p.radius -= dashCost; 
                if (p.radius < 20) p.radius = 20; 
            }

            // A. 主動操作移動
            p.x += input.dx * speed;
            p.z += input.dz * speed;

            // B. 物理慣性移動 (碰撞擊退、加速陣)
            p.x += p.vx;
            p.z += p.vz;

            // C. 摩擦力 (減速)
            p.vx *= 0.85; 
            p.vz *= 0.85;
            if (Math.abs(p.vx) < 0.1) p.vx = 0;
            if (Math.abs(p.vz) < 0.1) p.vz = 0;

            // 重力與跳躍
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
                    if (pellets.length < MAX_PELLETS) {
                        pellets.push(spawnPellet());
                    }
                }
            }
        }

        // 3. 尖刺陷阱判定
        for (let id in players) {
            let p = players[id];
            for (let i = 0; i < spikes.length; i++) {
                let spike = spikes[i];
                let dist = Math.hypot(p.x - spike.x, p.z - spike.z);
                let minDist = p.radius + SPIKE_RADIUS;

                if (dist < minDist) {
                    let overlap = minDist - dist;
                    let nx = dist > 0 ? (p.x - spike.x) / dist : 1;
                    let nz = dist > 0 ? (p.z - spike.z) / dist : 0;

                    // 物理排擠
                    p.x += nx * overlap;
                    p.z += nz * overlap;

                    // 巨球懲罰判定
                    if (p.radius > 40) {
                        let energy = p.radius - 20;
                        let lostEnergy = energy * 0.2; 
                        p.radius -= lostEnergy;
                        
                        p.vy = 20; 
                        
                        // 套用慣性擊退速度
                        p.vx += nx * 35; 
                        p.vz += nz * 35;
                        p.damageEffect = 15; // 受傷紅光特效

                        // 噴灑光點
                        let dropCount = Math.min(30, Math.floor(lostEnergy));
                        for (let d = 0; d < dropCount; d++) {
                            let dropAngle = Math.random() * Math.PI * 2;
                            let dropDist = SPIKE_RADIUS + 10 + Math.random() * 60;
                            if (pellets.length >= MAX_PELLETS) {
                                pellets.shift();
                            }
                            pellets.push({
                                x: spike.x + Math.cos(dropAngle) * dropDist, y: 4,
                                z: spike.z + Math.sin(dropAngle) * dropDist
                            });
                        }
                    }
                }
            }
        }

        // 4. 玩家碰撞判定 (完整物理反作用力版)
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

                    let baseForce = 15;
                    let p1Dashing = p1.input.dash && p1.radius > 20;
                    let p2Dashing = p2.input.dash && p2.radius > 20;

                    let f1on2 = baseForce;
                    let f2on1 = baseForce;

                    if (p1Dashing && !p2Dashing) {
                        f1on2 = baseForce * 2; 
                    } else if (p2Dashing && !p1Dashing) {
                        f2on1 = baseForce * 2; 
                    } else if (p1Dashing && p2Dashing) {
                        f1on2 = baseForce * 1.5;
                        f2on1 = baseForce * 1.5;
                    }

                    // 衝刺陣的強化狀態
                    if (p1.boostEffect > 0) f1on2 *= 3;
                    if (p2.boostEffect > 0) f2on1 *= 3;

                    let res1 = Math.max(0.4, 20 / p1.radius); 
                    let res2 = Math.max(0.4, 20 / p2.radius);

                    let totalRadius = p1.radius + p2.radius;
                    let p1OverlapRatio = p2.radius / totalRadius; 
                    let p2OverlapRatio = p1.radius / totalRadius;

                    // A. 座標直接排擠 (防止球體穿透)
                    p1.x += hnx * overlap * p1OverlapRatio;
                    p1.z += hnz * overlap * p1OverlapRatio;
                    p2.x -= hnx * overlap * p2OverlapRatio;
                    p2.z -= hnz * overlap * p2OverlapRatio;

                    // B. 賦予物理反作用力速度 (vx, vz)
                    p1.vx += hnx * (f2on1 * res1);
                    p1.vz += hnz * (f2on1 * res1);

                    p2.vx -= hnx * (f1on2 * res2);
                    p2.vz -= hnz * (f1on2 * res2);
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
                p.vx = 0; p.vz = 0; p.boostCooldown = 0; p.boostEffect = 0; p.damageEffect = 0; // 重置狀態
            }
        }

        // 回傳完整的遊戲狀態 (包含新增的 boostPads)
        io.to(roomId).emit('update_game_state', { players, pellets, spikes, boostPads });
    }
}, 30);

http.listen(3000, () => console.log('伺服器在 3000 port 運行中...'));
