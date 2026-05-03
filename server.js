const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const fs = require('fs');
const path = require('path');

// 1. 設定靜態檔案與路由
app.use(express.static(__dirname));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

let rooms = {};
let roomCounters = {}; 
let currentNotice = "歡迎來到連線數獨！請點擊『快速加入』開始遊戲。"; // 新增這一行

const ERROR_DIR = './error';
if (!fs.existsSync(ERROR_DIR)) fs.mkdirSync(ERROR_DIR);

// 讀取題庫
function loadPuzzles() {
    try {
        const data = fs.readFileSync('./puzzles.json', 'utf8');
        return JSON.parse(data);
    } catch (err) {
        // 預防萬一題庫讀取失敗的備援
        return { "1": [{ id: "ERR", data: "0".repeat(36), answer: "0".repeat(36) }] };
    }
}

// 驗證邏輯：核心在於排除 7 (牆壁) 後的重複性檢查
function validateSudoku6x6(b) {
    const isGroupValid = (arr) => {
        let seen = new Set();
        for (let num of arr) {
            if (num == 7 || num === null) continue; // 跳過牆壁與空格
            const val = parseInt(num);
            if (isNaN(val) || val < 1 || val > 6) return false;
            if (seen.has(val)) return false; // 發現重複數字
            seen.add(val);
        }
        return true;
    };

    // 1. 檢查所有「橫列」 (Rows)
    for (let r = 0; r < 6; r++) {
        let rowArr = b.slice(r * 6, r * 6 + 6);
        if (!isGroupValid(rowArr)) return false;
    }

    // 2. 檢查所有「直行」 (Cols)
    for (let c = 0; c < 6; c++) {
        let colArr = [];
        for (let r = 0; r < 6; r++) {
            colArr.push(b[r * 6 + c]);
        }
        if (!isGroupValid(colArr)) return false;
    }

    // 3. 檢查所有「宮格」 (Blocks - 2x3 結構)
    // 6x6 數獨通常分為 6 個 2x3 的小矩形
    for (let r = 0; r < 6; r += 2) {      // 垂直跳 2 格
        for (let c = 0; c < 6; c += 3) {  // 水平跳 3 格
            let blockArr = [];
            for (let i = 0; i < 2; i++) {     // 內部高度 2
                for (let j = 0; j < 3; j++) { // 內部寬度 3
                    blockArr.push(b[(r + i) * 6 + (c + j)]);
                }
            }
            if (!isGroupValid(blockArr)) return false;
        }
    }

    return true;
}

// Socket.io 遊戲邏輯
io.on('connection', (socket) => {
    io.emit('updateOnlineCount', io.engine.clientsCount);
    socket.emit('updateNotice', currentNotice);

    // 2. 管理員修改公告指令
    socket.on('adminSetNotice', (data) => {
        const ADMIN_KEY = "yobattlesudoku"; // 這裡改一個你記得住的詞
        if (data && data.key === ADMIN_KEY) {
            currentNotice = data.msg;
            io.emit('updateNotice', currentNotice); 
            console.log(`[公告更新] ${data.msg}`);
        }
    });

    // 斷線清理 (放在最上層，確保隨時監聽)
    socket.on('disconnect', () => {
        for (const rid in rooms) {
            const r = rooms[rid];
            if (r.players[socket.id]) {
                const pNum = r.players[socket.id];
                delete r.players[socket.id];
                r.occupiedNums = r.occupiedNums.filter(x => x !== pNum);
                
                if (Object.keys(r.players).length === 0) {
                    delete rooms[rid];
                } else {
                    io.to(rid).emit('sync', r);
                }
                break; // 跳出房間搜尋迴圈
            }
        }
        // --- 補在這裡 ---
        // 不論他有沒有在房間內，只要斷開連線，就對全服廣播最新人數
        io.emit('updateOnlineCount', io.engine.clientsCount);
        // ----------------
    });

    // 處理房長開啟下一局
    socket.on('backToDraft', (roomId) => {
        const room = rooms[roomId];
        if (room && room.players[socket.id] === 1) {
            const puzzles = loadPuzzles();
            const pList = puzzles[room.difficulty] || puzzles["1"];
            const puzzle = pList[Math.floor(Math.random() * pList.length)];
            
            room.puzzleId = puzzle.id;
            room.board = puzzle.data.split('').map(num => ({ 
                val: num !== '0' ? parseInt(num) : null, 
                isFixed: num !== '0' 
            }));
            room.answer = puzzle.answer;
            room.phase = 'DRAFTING';
            room.readyPlayers = [];
            room.changeRequests = [];
            room.completeVotes = [];
            room.lastError = null;
            room.turn = 1;
            
            io.to(roomId).emit('sync', room);
        }
    });

    // 創建房間
    socket.on('createRoom', (data) => {
        const puzzles = loadPuzzles();
        const pCount = parseInt(data.p) || 2;
        const diff = data.d ? data.d.toString() : "1"; // 這裡的 diff 就是 1, 2 或 3
        
        // 從對應題庫抓題
        const pList = puzzles[diff] || puzzles["1"];
        const puzzle = pList[Math.floor(Math.random() * pList.length)];
        
        // --- 房號生成邏輯：人數 + 題庫號 + 流水號 ---
        const prefix = `${pCount}${diff}`; 
        roomCounters[prefix] = (roomCounters[prefix] || 0) + 1;
        // 如果流水號超過 99，會自動變成 3 位數，維持 4-5 位數房號
        const roomId = prefix + roomCounters[prefix].toString().padStart(2, '0');

        rooms[roomId] = {
            id: roomId, maxPlayers: pCount, difficulty: diff, puzzleId: puzzle.id,
            phase: 'DRAFTING', readyPlayers: [], changeRequests: [], completeVotes: [],
            players: { [socket.id]: 1 }, occupiedNums: [1], turn: 1,
            // 這裡會正確把 '7' 轉成數字 7，前端 renderBoard 就會把它畫成牆壁
            board: puzzle.data.split('').map(num => ({ 
                val: num !== '0' ? parseInt(num) : null, 
                isFixed: num !== '0' 
            })),
            answer: puzzle.answer, 
            lastError: null
        };
        socket.join(roomId);
        socket.emit('joined', { roomId, pNum: 1, state: rooms[roomId] });
    });

    // 換題邏輯
    socket.on('requestChangePuzzle', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        const pNum = room.players[socket.id];
        if (!room.changeRequests.includes(pNum)) room.changeRequests.push(pNum);
        const threshold = room.maxPlayers === 1 ? 1 : Math.ceil((room.maxPlayers + 1) / 2);

        if (room.changeRequests.length >= threshold) {
            const puzzles = loadPuzzles();
            const pList = puzzles[room.difficulty] || puzzles["1"];
            const puzzle = pList[Math.floor(Math.random() * pList.length)];
            
            room.puzzleId = puzzle.id;
            room.board = puzzle.data.split('').map(num => ({ val: num !== '0' ? parseInt(num) : null, isFixed: num !== '0' }));
            room.answer = puzzle.answer; 
            room.phase = 'DRAFTING';
            room.readyPlayers = []; room.changeRequests = []; room.completeVotes = []; room.turn = 1;
            room.lastError = null;
            io.to(roomId).emit('sync', room);
        } else {
            io.to(roomId).emit('sync', room);
        }
    });

    // 填字邏輯 (強化安全版)
    socket.on('fill', (data) => {
        const { roomId, index, val } = data;
        const room = rooms[roomId];

        // 1. 基礎存在檢查
        if (!room || room.phase !== 'SOLVING') return;
        
        // 2. 玩家身份與回合檢查 (防止非當前玩家或路人填值)
        const pNum = room.players[socket.id];
        if (!pNum || room.turn !== pNum) return;

        // 3. 數值合法性檢查 (最高防禦等級)
        // 只允許 1-6，異世界模式額外允許 7 (牆壁)
        const allowedValues = [1, 2, 3, 4, 5, 6, 7];
        if (!allowedValues.includes(val)) {
            console.log(`[警報] 攔截非法數值填入: ${val} 來自 ${socket.id}`);
            return;
        }

        // 4. 索引位置與固定格檢查
        // 確保 index 是數字，且在 0-35 之間，並且該格不是題目預設的 Fixed
        if (typeof index !== 'number' || index < 0 || index >= 36) return;
        if (!room.board[index] || room.board[index].isFixed) return;

        // --- 通過所有門檻，開始處理邏輯 ---
        
        room.board[index].val = val;
        room.lastError = null; 

        // 檢查全盤是否填滿 (排除 null 的情況)
        const isAllFilled = room.board.every(cell => cell.val !== null);

        if (isAllFilled) { 
            room.phase = 'CHECKING'; 
            room.completeVotes = []; 
        } else { 
            // 切換回合邏輯
            room.turn = (room.turn % room.maxPlayers) + 1; 
        }

        // 同步狀態給房間內所有人
        io.to(roomId).emit('sync', room);
    });
    // 投票完成
    socket.on('voteComplete', (data) => {
        const { roomId, agree } = data;
        const room = rooms[roomId];
        if (!room || room.phase !== 'CHECKING') return;
        const pNum = room.players[socket.id];
        if (!pNum) return; 

        if (agree) {
            if (!room.completeVotes.includes(pNum)) room.completeVotes.push(pNum);
            const th = room.maxPlayers === 1 ? 1 : Math.ceil((room.maxPlayers + 1) / 2);

            if (room.completeVotes.length >= th) {
                const boardValues = room.board.map(cell => cell.val);
                if (validateSudoku6x6(boardValues)) {
                    room.phase = 'RESULT';
                } else {
                    room.phase = 'SOLVING';
                    room.lastError = "答案有誤，請再檢查！";
                    room.completeVotes = [];
                }
            }
        } else { 
            room.phase = 'SOLVING'; 
            room.completeVotes = []; 
        }
        io.to(roomId).emit('sync', room);
    });

    // 基礎房間操作 (checkRoom, selectPos, ready, leaveRoom, destroyRoom 等同你之前的邏輯)
    socket.on('checkRoom', (rid) => { 
        if(rooms[rid]) socket.emit('roomStatus', { occupiedNums: rooms[rid].occupiedNums, maxPlayers: rooms[rid].maxPlayers }); 
    });
    
    socket.on('selectPos', (d) => {
        const r = rooms[d.roomId];
        if(r && !r.occupiedNums.includes(d.pNum)) {
            r.players[socket.id] = d.pNum; r.occupiedNums.push(d.pNum);
            socket.join(d.roomId); socket.emit('joined', { roomId: d.roomId, pNum: d.pNum, state: r });
            io.to(d.roomId).emit('sync', r);
        }
    });

    // 在伺服器端 socket.on 區塊內新增
    socket.on('quickJoin', () => {
        // 尋找符合條件的房間：
        // 1. 狀態是 DRAFTING (還沒開始)
        // 2. 目前人數 < 最大人數
        const targetRoomId = Object.keys(rooms).find(rid => {
            const r = rooms[rid];
            return r.phase === 'DRAFTING' && r.occupiedNums.length < r.maxPlayers;
        });

        if (targetRoomId) {
            // 找到了，告訴前端準備加入這個房間
            socket.emit('quickJoinResult', { success: true, roomId: targetRoomId });
        } else {
            // 沒找到，告訴前端目前沒空位
            socket.emit('quickJoinResult', { success: false, msg: '目前沒有排隊中的空房間，自己開一間吧！' });
        }
    });

    socket.on('ready', (rid) => {
        const r = rooms[rid]; if(!r) return;
        const n = r.players[socket.id]; if(!r.readyPlayers.includes(n)) r.readyPlayers.push(n);
        if(r.readyPlayers.length >= r.maxPlayers) r.phase = 'SOLVING';
        io.to(rid).emit('sync', r);
    });

    socket.on('leaveRoom', (rid) => {
        const r = rooms[rid]; if(!r) return;
        const n = r.players[socket.id]; 
        delete r.players[socket.id];
        r.occupiedNums = r.occupiedNums.filter(x => x !== n);
        socket.leave(rid); socket.emit('left'); 
        if(Object.keys(r.players).length > 0) io.to(rid).emit('sync', r); 
        else delete rooms[rid];
    });

    socket.on('destroyRoom', (rid) => { 
        if(rooms[rid] && rooms[rid].players[socket.id] === 1) { 
            io.to(rid).emit('roomDestroyed'); delete rooms[rid]; 
        } 
    });
});

// 伺服器啟動
const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    process.stdin.on('data', (data) => {
    const input = data.toString().trim();
    if (input === 'clear') {
        currentNotice = "";
        io.emit('updateNotice', "");
        console.log(" [系統] 已清除全服公告");
    } else if (input !== "") {
        currentNotice = input;
        io.emit('updateNotice', currentNotice);
        console.log(` [系統] 發送公告：${currentNotice}`);
    }
});
    console.log('🚀 Sudoku Server Running on Port ' + PORT);
});

// 在檔案最末端新增定期報數監控
setInterval(() => {
    const totalRooms = Object.keys(rooms).length;
    // 這個 log 會顯示在 Render 的 Dashboard -> Logs 裡面
    console.log(`📊 [系統狀態] 在線人數: ${io.engine.clientsCount} | 進行中房間: ${totalRooms}`);
}, 60000);