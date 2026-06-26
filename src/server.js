const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });

let rooms = {};
const SPIKE_RADIUS = 15; // 尖刺的物理半徑

// 產生隨機房間代碼
function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// 產生光點 (現在需要傳入該房間的地圖大小)
function spawnPellet(worldSize) {
    return { 
        x: (Math.random() - 0.5) * worldSize * 2, 
        y: 4, 
        z: (Math.random() - 0.5) * worldSize * 2 
    };
}

// 產生紅色尖刺
function spawnSpike(worldSize) {
    return {
        x: (Math.random() - 0.5) * worldSize * 1.8,
        z: (Math.random() - 0.5) * worldSize * 1.8
    };
}

// 產生加速陣
function spawnBoostPad(worldSize) {
    return {
        x: (Math.random() - 0.5) * worldSize * 1.6,
        z: (Math.random() - 0.5) * worldSize * 1.6,
        radius: 25
    };
}
// 產生岩漿
function spawnMagma(worldSize, magmaBaseSize) {
    return {
        x: (Math.random() - 0.5) * worldSize * 1.5,
        z: (Math.random() - 0.5) * worldSize * 1.5,
        radius: magmaBaseSize * (0.6 + Math.random() * 0.8)
    };
}

const CONVEYOR_CYCLE_MS = 30000;
const CONVEYOR_FORCE = 0.5;
const conveyorDirections = [
    { x: 1, z: 0 },
    { x: 0, z: 1 },
    { x: -1, z: 0 },
    { x: 0, z: -1 }
];

io.on('connection', (socket) => {
    console.log('新玩家連線:', socket.id);
    let currentRoom = null;

    // 接收房主的自訂參數
    socket.on('create_room', (config = {}) => {
        const roomId = generateRoomCode();
        
        // 解析參數，若未提供則使用預設值
        const mapSize = config.mapSize || 800;
        const pelletCount = config.pelletCount !== undefined ? config.pelletCount : 50;
        const spikeCount = config.spikeCount !== undefined ? config.spikeCount : 15;
        const boostCount = config.boostCount !== undefined ? config.boostCount : 8;
        const magmaCount = config.magmaCount !== undefined ? config.magmaCount : 0;
        const magmaSize = config.magmaSize !== undefined ? config.magmaSize : 100;
        const baseImpactForce = config.baseImpactForce !== undefined ? config.baseImpactForce : 15;
        const conveyorForce = config.conveyorForce !== undefined ? config.conveyorForce : 0.5;
        const conveyorSwitchTime = config.conveyorSwitchTime !== undefined ? config.conveyorSwitchTime : 30;
        const iceFriction = config.iceFriction !== undefined ? config.iceFriction : 0.97;
        const spikeDamage = config.spikeDamage !== undefined ? config.spikeDamage : 20;
        const globalReverse = config.globalReverse || false;
        const boostForce = config.boostForce !== undefined ? config.boostForce : 45;
        const magmaBurn = config.magmaBurn !== undefined ? config.magmaBurn : 5;
        const mapType = config.mapType || 'normal';
        
        // 依照設定決定光點數量
        const maxPellets = pelletCount;

        rooms[roomId] = { 
            players: {}, 
            pellets: [], 
            spikes: [], 
            boostPads: [], 
            magmas: [],
            usedColors: [], 
            usedNames: [],
            worldSize: mapSize,      // 將地圖大小存入該房間專屬設定
            maxPellets: maxPellets,  // 該房間最大光點數量
            mapType: mapType,
            baseImpactForce: baseImpactForce,
            conveyorForce: conveyorForce,
            conveyorSwitchTime: conveyorSwitchTime,
            iceFriction: iceFriction,
            spikeDamage: spikeDamage,
            globalReverse: globalReverse,
            boostForce: boostForce,
            magmaBurn: magmaBurn,
            currentConveyorDirIndex: 0,
            lastConveyorSwitchTime: Date.now()
        };
        
        for (let i = 0; i < maxPellets; i++) rooms[roomId].pellets.push(spawnPellet(mapSize));
        for (let i = 0; i < spikeCount; i++) rooms[roomId].spikes.push(spawnSpike(mapSize));
        for (let i = 0; i < boostCount; i++) rooms[roomId].boostPads.push(spawnBoostPad(mapSize)); 
        for (let i = 0; i < magmaCount; i++) rooms[roomId].magmas.push(spawnMagma(mapSize, magmaSize));

        socket.join(roomId);
        currentRoom = roomId;
        // 將房間代碼和地圖大小回傳給前端，讓前端同步地圖網格
        socket.emit('room_joined', { roomId: roomId, mapSize: mapSize });
    });

    socket.on('join_room', (roomId) => {
        roomId = roomId.toUpperCase();
        if (rooms[roomId]) {
            socket.join(roomId);
            currentRoom = roomId;
            // 加入的玩家也需要知道該房間的地圖大小
            socket.emit('room_joined', { roomId: roomId, mapSize: rooms[roomId].worldSize });
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
        
        const mapSize = rooms[roomId].worldSize;

        rooms[roomId].players[socket.id] = {
            x: (Math.random() - 0.5) * mapSize * 0.8, y: 20, z: (Math.random() - 0.5) * mapSize * 0.8,
            vx: 0, vy: 0, vz: 0, boostCooldown: 0, boostEffect: 0, damageEffect: 0,
            radius: 20, color: color, name: name,
            inMagma: false, magmaBurnTimer: 0, isGrounded: true,
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
        let magmas = room.magmas;
        let worldSize = room.worldSize;
        let mapType = room.mapType;
        let now = Date.now();

        let currentConveyorForce = { x: 0, z: 0 };
        let conveyorIsWarning = false;
        if (mapType === 'conveyor') {
            let switchMs = (room.conveyorSwitchTime || 30) * 1000;
            if (now - room.lastConveyorSwitchTime >= switchMs) {
                let nextDir;
                do { nextDir = Math.floor(Math.random() * 4); } while (nextDir === room.currentConveyorDirIndex);
                room.currentConveyorDirIndex = nextDir;
                room.lastConveyorSwitchTime = now;
            } else if (now - room.lastConveyorSwitchTime >= switchMs - 3000) {
                conveyorIsWarning = true;
            }
            let dirObj = conveyorDirections[room.currentConveyorDirIndex];
            let cForce = room.conveyorForce || 0.5;
            currentConveyorForce.x = dirObj.x * cForce;
            currentConveyorForce.z = dirObj.z * cForce;
        }

        // 1. 移動與物理
        for (let id in players) {
            let p = players[id];
            
            p.vx = p.vx || 0;
            p.vz = p.vz || 0;
            p.boostCooldown = p.boostCooldown || 0;
            p.boostEffect = p.boostEffect || 0;
            p.damageEffect = p.damageEffect || 0;

            if (p.boostCooldown > 0) p.boostCooldown--;
            if (p.boostEffect > 0) p.boostEffect--;
            if (p.damageEffect > 0) p.damageEffect--;
            p.inMagma = false;

            for(let i=0; i<magmas.length; i++) {
                if (Math.hypot(p.x - magmas[i].x, p.z - magmas[i].z) < p.radius + magmas[i].radius) {
                    p.inMagma = true;
                    p.magmaBurnTimer = (room.magmaBurn !== undefined ? room.magmaBurn : 5) * 33; 
                }
            }

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
                            let angle = Math.random() * Math.PI * 2;
                            bx = Math.cos(angle);
                            bz = Math.sin(angle);
                        }
                        
                        let bForce = room.boostForce || 45;
                        p.vx += bx * bForce; 
                        p.vz += bz * bForce;
                        p.boostCooldown = 90; 
                        p.boostEffect = 15;   
                    }
                }
            }

            let isDashing = input.dash && p.radius > 20 && !p.inMagma;
            let sizeFactor = Math.max(0, p.radius - 20); 
            let baseSpeed = Math.max(3, 8 - Math.sqrt(sizeFactor) * 0.41); 
            let dashMult = Math.max(1.2, 2.0 - sizeFactor * 0.0053); 
            let dashCost = 0.05 + sizeFactor * 0.0026;

            let speed = isDashing ? baseSpeed * dashMult : baseSpeed;
            if (p.inMagma) speed *= 0.4;

            if (isDashing) {
                p.radius -= dashCost; 
                if (p.radius < 20) p.radius = 20; 
            }
            
            if (p.magmaBurnTimer > 0) {
                p.magmaBurnTimer--;
                p.radius -= 1/33;
                if (p.radius < 20) p.radius = 20;
                p.damageEffect = Math.max(p.damageEffect, 2);
            }

            let isIce = mapType === 'ice';
            let baseFriction = 0.85;
            let iceFriction = room.iceFriction || 0.97;
            let friction = (isIce && p.isGrounded) ? iceFriction : baseFriction;

            let playerMoveX, playerMoveZ;
            if (isIce) {
                let accelRate = p.isGrounded ? 0.04 : 0.01;
                p.vx += input.dx * (speed * accelRate);
                p.vz += input.dz * (speed * accelRate);
                playerMoveX = p.vx;
                playerMoveZ = p.vz;
            } else {
                playerMoveX = input.dx * speed + p.vx;
                playerMoveZ = input.dz * speed + p.vz;
            }

            let environmentForceX = 0, environmentForceZ = 0;
            if (mapType === 'conveyor') {
                let forceMulti = p.isGrounded ? 1.0 : 0.3;
                environmentForceX = currentConveyorForce.x * forceMulti;
                environmentForceZ = currentConveyorForce.z * forceMulti;
            }

            p.x += playerMoveX + environmentForceX;
            p.z += playerMoveZ + environmentForceZ;

            p.vx *= friction; 
            p.vz *= friction;
            if (Math.abs(p.vx) < 0.1) p.vx = 0;
            if (Math.abs(p.vz) < 0.1) p.vz = 0;

            p.vy -= 1.5; 
            p.y += p.vy;
            p.isGrounded = false;

            if (Math.abs(p.x) <= worldSize && Math.abs(p.z) <= worldSize) {
                if (p.y <= p.radius) {
                    p.y = p.radius; p.vy = 0; p.isGrounded = true;
                }
            }

            if (input.jump && p.isGrounded) {
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
                    if (pellets.length < room.maxPellets) {
                        pellets.push(spawnPellet(worldSize));
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

                    p.x += nx * overlap;
                    p.z += nz * overlap;

                    if (p.radius > 40) {
                        let dmgPercent = room.spikeDamage !== undefined ? room.spikeDamage : 20;
                        let lostEnergy = (p.radius - 20) * (dmgPercent / 100);
                        p.radius -= lostEnergy;
                        p.vy = 20; 
                        p.vx += nx * 35; 
                        p.vz += nz * 35;
                        p.damageEffect = 15;

                        let dropCount = Math.min(30, Math.floor(lostEnergy));
                        for (let d = 0; d < dropCount; d++) {
                            let dropAngle = Math.random() * Math.PI * 2;
                            let dropDist = SPIKE_RADIUS + 10 + Math.random() * 60;
                            if (pellets.length >= room.maxPellets) {
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

                    let baseForce1 = room.baseImpactForce || 15;
                    let baseForce2 = room.baseImpactForce || 15;

                    if (room.mapType === 'ice') {
                        baseForce1 += Math.hypot(p1.vx, p1.vz) * 0.8;
                        baseForce2 += Math.hypot(p2.vx, p2.vz) * 0.8;
                    }

                    let p1Dashing = p1.input.dash && p1.radius > 20;
                    let p2Dashing = p2.input.dash && p2.radius > 20;

                    let f1on2 = baseForce1;
                    let f2on1 = baseForce2;

                    if (p1Dashing && !p2Dashing) {
                        f1on2 = baseForce1 * 2; 
                    } else if (p2Dashing && !p1Dashing) {
                        f2on1 = baseForce2 * 2; 
                    } else if (p1Dashing && p2Dashing) {
                        f1on2 = baseForce1 * 1.5;
                        f2on1 = baseForce2 * 1.5;
                    }

                    if (p1.boostEffect > 0) f1on2 *= 3;
                    if (p2.boostEffect > 0) f2on1 *= 3;

                    let res1 = Math.max(0.4, 20 / p1.radius); 
                    let res2 = Math.max(0.4, 20 / p2.radius);

                    let totalRadius = p1.radius + p2.radius;
                    let p1OverlapRatio = p2.radius / totalRadius; 
                    let p2OverlapRatio = p1.radius / totalRadius;

                    p1.x += hnx * overlap * p1OverlapRatio;
                    p1.z += hnz * overlap * p1OverlapRatio;
                    p2.x -= hnx * overlap * p2OverlapRatio;
                    p2.z -= hnz * overlap * p2OverlapRatio;

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
                p.x = (Math.random() - 0.5) * worldSize; p.z = (Math.random() - 0.5) * worldSize;
                p.y = 100; p.vy = 0; p.radius = 20; 
                p.vx = 0; p.vz = 0; p.boostCooldown = 0; p.boostEffect = 0; p.damageEffect = 0; p.magmaBurnTimer = 0; p.inMagma = false;
            }
        }

        io.to(roomId).emit('update_game_state', { 
            players, pellets, spikes, boostPads, magmas: room.magmas, 
            mapType: room.mapType, 
            currentConveyorDirIndex: room.currentConveyorDirIndex,
            conveyorIsWarning: conveyorIsWarning,
            globalReverse: room.globalReverse
        });
    }
}, 30);

http.listen(3000, () => console.log('伺服器在 3000 port 運行中...'));
