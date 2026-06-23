const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });

// 資料結構：儲存多個房間的狀態
// rooms[roomId] = { players: {}, pellets: [], usedColors: [], usedNames: [] }
let rooms = {};
const MAX_PELLETS = 50;
const WORLD_SIZE = 800; // 地圖範圍 -800 到 800

// 產生隨機房間代碼
function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// 在 3D 空間產生光點
function spawnPellet() {
    return { 
        x: (Math.random() - 0.5) * WORLD_SIZE * 2, 
        y: 4, // 光點貼在地上 (假設光點半徑為4)
        z: (Math.random() - 0.5) * WORLD_SIZE * 2 
    };
}

io.on('connection', (socket) => {
    console.log('新玩家連線:', socket.id);
    let currentRoom = null;

    // 1. 創建房間
    socket.on('create_room', () => {
        const roomId = generateRoomCode();
        rooms[roomId] = { players: {}, pellets: [], usedColors: [], usedNames: [] };
        
        // 初始生成光點
        for (let i = 0; i < MAX_PELLETS; i++) {
            rooms[roomId].pellets.push(spawnPellet());
        }

        socket.join(roomId);
        currentRoom = roomId;
        socket.emit('room_joined', roomId);
    });

    // 2. 加入房間
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

    // 2.5 預先檢查名稱與顏色是否可用 (點擊下一步時觸發)
    socket.on('check_availability', (data) => {
        const roomId = data.roomId;
        
        if (!rooms[roomId]) {
            return socket.emit('check_result', { valid: false, msg: '房間已不存在' });
        }
        if (rooms[roomId].usedColors.includes(data.color)) {
            return socket.emit('check_result', { valid: false, msg: '這個顏色已經被選走了，請換一個！' });
        }
        if (rooms[roomId].usedNames.includes(data.name)) {
            return socket.emit('check_result', { valid: false, msg: '這個名稱已經有人使用了，請換一個！' });
        }
        
        // 檢查通過
        socket.emit('check_result', { valid: true });
    });
    
    // 3. 選擇顏色、名稱並進入戰場
    socket.on('join_game', (data) => {
        const roomId = data.roomId;
        const color = data.color;
        const name = data.name || '無名氏'; // 取得名稱，若無則給預設值

        if (!rooms[roomId]) return socket.emit('color_error', '房間已不存在');
        
        // 檢查顏色是否重複
        if (rooms[roomId].usedColors.includes(color)) {
            return socket.emit('color_error', '這個顏色已經被選走了，請換一個！');
        }
        
        // 檢查名稱是否重複
        if (rooms[roomId].usedNames.includes(name)) {
            return socket.emit('name_error', '這個名稱已經有人使用了，請換一個！');
        }

        // 註冊玩家顏色、名稱與初始狀態 (3D 座標, 包含 y 軸和垂直速度 vy)
        rooms[roomId].usedColors.push(color);
        rooms[roomId].usedNames.push(name); // 記錄已被使用的名稱
        
        rooms[roomId].players[socket.id] = {
            x: (Math.random() - 0.5) * 500,
            y: 20, // 初始高度
            z: (Math.random() - 0.5) * 500,
            vy: 0, // 垂直速度 (重力用)
            radius: 20, // 基礎體積為 20 (即 0 能量)
            color: color,
            name: name, // 將名稱存入玩家物件，這樣遊戲迴圈廣播時前端才收得到
            input: { dx: 0, dz: 0, jump: false, dash: false } // 存放客戶端傳來的意圖，新增 dash
        };

        socket.emit('game_started');
        console.log(`玩家 ${socket.id} 加入房間 ${roomId} (名稱: ${name}, 顏色: ${color})`);
    });

    // 4. 接收玩家操作 (僅更新意圖，交由遊戲迴圈結算)
    socket.on('player_input', (input) => {
        if (currentRoom && rooms[currentRoom] && rooms[currentRoom].players[socket.id]) {
            rooms[currentRoom].players[socket.id].input = input;
        }
    });

    // 5. 斷線清理
    socket.on('disconnect', () => {
        if (currentRoom && rooms[currentRoom]) {
            const room = rooms[currentRoom];
            const player = room.players[socket.id];
            
            if (player) {
                // 同時釋放顏色與名稱，讓其他玩家可以使用
                room.usedColors = room.usedColors.filter(c => c !== player.color);
                room.usedNames = room.usedNames.filter(n => n !== player.name);
                delete room.players[socket.id];
            }

            // 如果房間空了，自動銷毀房間節省資源
            if (Object.keys(room.players).length === 0) {
                delete rooms[currentRoom];
                console.log(`房間 ${currentRoom} 已銷毀`);
            }
        }
        console.log('玩家離線:', socket.id);
    });
});

// --- 伺服器核心遊戲迴圈 (30ms) ---
setInterval(() => {
    for (let roomId in rooms) {
        let room = rooms[roomId];
        let players = room.players;
        let pellets = room.pellets;

        // 1. 玩家移動與物理 (重力與跳躍、衝刺)
        for (let id in players) {
            let p = players[id];
            let input = p.input;

            // 判斷是否正在衝刺（體積必須大於基礎值 20 才有能量加速）
            let isDashing = input.dash && p.radius > 20;

            // 統一基礎速度 7，衝刺時速度提升為 14
            let speed = isDashing ? 14 : 7;

            // 衝刺直接消耗體積 (能量)
            if (isDashing) {
                p.radius -= 0.05; // 每幀消耗體積
                if (p.radius < 20) p.radius = 20; // 體積最低保護為 20 (0 能量)
            }

            p.x += input.dx * speed;
            p.z += input.dz * speed;

            // Y 軸物理：重力
            p.vy -= 1.5; // 重力加速度
            p.y += p.vy;

            // 地板碰撞 (y = 0 是地面，球體的底部不能穿過地面)
            let isGrounded = false;
            // 必須在場地範圍內 (WORLD_SIZE) 才會有地板擋住，超過範圍球就會繼續往下掉
            if (Math.abs(p.x) <= WORLD_SIZE && Math.abs(p.z) <= WORLD_SIZE) {
                if (p.y <= p.radius) {
                    p.y = p.radius; // 卡在地表
                    p.vy = 0;
                    isGrounded = true;
                }
            }

            // 跳躍判定（只能在地板上跳躍）
            if (input.jump && isGrounded) {
                p.vy = 25; 
                input.jump = false; 
            }
        }

        // 2. 判定：玩家吃光點 (3D 距離判斷)
        for (let id in players) {
            let p = players[id];
            for (let i = pellets.length - 1; i >= 0; i--) {
                // 3D 空間距離公式
                let dist = Math.hypot(p.x - pellets[i].x, p.y - pellets[i].y, p.z - pellets[i].z);
                if (dist < p.radius) {
                    pellets.splice(i, 1);       
                    p.radius += 1; // 每個光點 +1 體積 (即 +1 能量)         
                    pellets.push(spawnPellet());
                }
            }
        }

        // 3. 玩家間的碰撞判定 (解決互相穿透、吸住與禁止互相踩踏跳躍的問題)
        let playerIds = Object.keys(players);
        for (let i = 0; i < playerIds.length; i++) {
            for (let j = i + 1; j < playerIds.length; j++) {
                let p1 = players[playerIds[i]];
                let p2 = players[playerIds[j]];
                if (!p1 || !p2) continue;

                // 計算 3D 空間中的距離
                let dx = p1.x - p2.x;
                let dy = p1.y - p2.y;
                let dz = p1.z - p2.z;
                let dist = Math.hypot(dx, dy, dz);
                let minDist = p1.radius + p2.radius;

                // 如果距離小於兩者半徑之和，代表發生碰撞（重疊了）
                if (dist < minDist && dist > 0) {
                    let overlap = minDist - dist;

                    // 限制排擠只在 X 和 Z 軸 (水平面) 上進行
                    // 這樣一來球體不會進行垂直 y 軸的強制分開推移，進而確保球體之間無法互相踩踏站立
                    let hDist = Math.hypot(dx, dz);
                    let hnx = hDist > 0 ? dx / hDist : 1;
                    let hnz = hDist > 0 ? dz / hDist : 0;

                    // 強制分離（僅水平推進分開）
                    p1.x += hnx * (overlap / 2);
                    p1.z += hnz * (overlap / 2);
                    
                    p2.x -= hnx * (overlap / 2);
                    p2.z -= hnz * (overlap / 2);

                    // 4. 大球撞小球的額外擊退效果 (已放大 3 倍，基礎撞擊力度 45)
                    let knockbackForce = 45; 
                    let p1Dashing = p1.input.dash && p1.radius > 20;
                    let p2Dashing = p2.input.dash && p2.radius > 20;

                    if (p1.radius > p2.radius * 1.1) {
                        // p1 大於 p2，將 p2 額外往後彈飛 (若衝刺中則力道放大 1.5 倍)
                        let force = p1Dashing ? knockbackForce * 1.5 : knockbackForce;
                        p2.x -= hnx * force;
                        p2.z -= hnz * force;
                        p2.vy = 15; // 給予被撞小球垂直向上的飛空力道
                    } else if (p2.radius > p1.radius * 1.1) {
                        // p2 大於 p1，將 p1 額外往後彈飛 (若衝刺中則力道放大 1.5 倍)
                        let force = p2Dashing ? knockbackForce * 1.5 : knockbackForce;
                        p1.x += hnx * force;
                        p1.z += hnz * force;
                        p1.vy = 15;
                    }
                }
            }
        }
        
        // 4. 邊界檢查與重生 
        for (let id in players) {
            let p = players[id];
            // 球的中心點 (p.y) 加上半徑 (p.radius) 小於 0，代表整顆球都掉到地板底下了
            if (p.y + p.radius < 0) {
                io.to(id).emit('you_lost', '你掉入虛空了！復活中...');
                
                // 重置狀態 (直接在當前房間給予隨機座標)
                p.x = (Math.random() - 0.5) * WORLD_SIZE;
                p.z = (Math.random() - 0.5) * WORLD_SIZE;
                p.y = 100;     // 從天上掉下來，比較有重生的感覺
                p.vy = 0;
                p.radius = 20; // 回復最小體型 (0 能量)
            }
        }

        // 5. 廣播給該房間的所有玩家 (此時 players 物件裡已經包含了玩家的 name)
        io.to(roomId).emit('update_game_state', { players, pellets });
    }
}, 30);

http.listen(3000, () => console.log('伺服器在 3000 port 運行中...'));
