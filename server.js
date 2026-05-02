const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const fs = require('fs');
const path = require('path');
const os = require('os');

// 1. 設定靜態檔案與路由
app.use(express.static(__dirname));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

let rooms = {};
let roomCounters = {}; 

const ERROR_DIR = './error';
if (!fs.existsSync(ERROR_DIR)) fs.mkdirSync(ERROR_DIR);

// 讀取題庫
function loadPuzzles() {
    try {
        const data = fs.readFileSync('./puzzles.json', 'utf8');
        return JSON.parse(data);
    } catch (err) {
        return { "1": [{ id: "ERR", data: "0".repeat(36), answer: "0".repeat(36) }] };
    }
}

// Socket.io 遊戲邏輯
io.on('connection', (socket) => {
    
    // 新增：處理房長開啟下一局的請求
    socket.on('backToDraft', (roomId) => {
        const room = rooms[roomId];
        // 安全檢查：只有房長 (pNum === 1) 且房間存在時才能重啟
        if (room && room.players[socket.id] === 1) {
            const puzzles = loadPuzzles();
            const pList = puzzles[room.difficulty] || puzzles["1"];
            const puzzle = pList[Math.floor(Math.random() * pList.length)];
            
            // 1. 更新盤面與答案
            room.puzzleId = puzzle.id;
            room.board = puzzle.data.split('').map(num => ({ 
                val: num !== '0' ? parseInt(num) : null, 
                isFixed: num !== '0' 
            }));
            room.answer = puzzle.answer;
            
            // 2. 重置房間狀態，但保留玩家
            room.phase = 'DRAFTING';
            room.readyPlayers = [];    // 清空準備狀態
            room.changeRequests = [];  // 清空換題投票
            room.completeVotes = [];   // 清空完成投票
            room.lastError = null;     // 清除錯誤訊息
            room.turn = 1;             // 輪次歸零
            
            // 3. 通知所有人同步
            io.to(roomId).emit('sync', room);
        }
    });

    // 創建房間
    socket.on('createRoom', (data) => {
        const puzzles = loadPuzzles();
        const pCount = parseInt(data.p) || 2;
        const diff = data.d ? data.d.toString() : "1";
        const pList = puzzles[diff] || puzzles["1"];
        const puzzle = pList[Math.floor(Math.random() * pList.length)];
        const prefix = `${pCount}${diff}`;
        roomCounters[prefix] = (roomCounters[prefix] || 0) + 1;
        const roomId = prefix + roomCounters[prefix].toString().padStart(2, '0');

        rooms[roomId] = {
            id: roomId, maxPlayers: pCount, difficulty: diff, puzzleId: puzzle.id,
            phase: 'DRAFTING', readyPlayers: [], changeRequests: [], completeVotes: [],
            players: { [socket.id]: 1 }, occupiedNums: [1], turn: 1,
            board: puzzle.data.split('').map(num => ({ val: num !== '0' ? parseInt(num) : null, isFixed: num !== '0' })),
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
            room.lastError = null; 

            room.phase = 'DRAFTING';
            room.readyPlayers = []; room.changeRequests = []; room.completeVotes = []; room.turn = 1;
            io.to(roomId).emit('sync', room);
        } else {
            io.to(roomId).emit('sync', room);
        }
    });

    // 填字邏輯 (已加上安全檢查)
    socket.on('fill', (data) => {
        const { roomId, index, val } = data;
        const room = rooms[roomId];
        
        // 1. 基本檢查：房間是否存在、是否在解題階段
        if (!room || room.phase !== 'SOLVING') return;
        
        // 2. 安全檢查：確保 index 在 0~35 之間且該位置真的存在
        if (index === null || index < 0 || !room.board[index]) {
            console.error(`⚠️ 收到無效的索引: ${index}`);
            return; 
        }

        // 3. 檢查是否輪到該玩家，且該格不是固定數字
        if (room.turn === room.players[socket.id] && !room.board[index].isFixed) {
            room.board[index].val = val;
            room.lastError = null; 

            if (room.board.every(cell => cell.val !== null)) { 
                room.phase = 'CHECKING'; 
                room.completeVotes = []; 
            } else { 
                room.turn = (room.turn % room.maxPlayers) + 1; 
            }
            io.to(roomId).emit('sync', room);
        }
    });

    // 完成投票邏輯
    socket.on('voteComplete', (data) => {
        const { roomId, agree } = data;
        const room = rooms[roomId]; // 1. 先抓出房間
        
        // 2. 基礎安全檢查
        if (!room || room.phase !== 'CHECKING') return;

        // 3. 確保玩家在房間內
        const pNum = room.players[socket.id];
        if (!pNum) return; 

        if (agree) {
            // 4. 防止重複投票
            if (!room.completeVotes.includes(pNum)) {
                room.completeVotes.push(pNum);
            }
            
            const th = room.maxPlayers === 1 ? 1 : Math.ceil((room.maxPlayers + 1) / 2);

            if (room.completeVotes.length >= th) {
                // 取得純數字陣列進行驗證
                const boardValues = room.board.map(cell => cell.val);

                // 5. 呼叫外部的驗證函式
                if (validateSudoku6x6(boardValues)) {
                    room.phase = 'RESULT';
                    room.lastError = null;
                } else {
                    room.phase = 'SOLVING';
                    room.completeVotes = []; 
                    room.lastError = "答案有誤（行列或宮格重複），請再檢查！";
                }
            }
        } else { 
            // 有人點「否」，退回解題狀態
            room.phase = 'SOLVING'; 
            room.completeVotes = []; 
            room.lastError = null;
        }
        
        io.to(roomId).emit('sync', room);
    });

    // 基礎房間操作
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

    socket.on('ready', (rid) => {
        const r = rooms[rid]; if(!r) return;
        const n = r.players[socket.id]; if(!r.readyPlayers.includes(n)) r.readyPlayers.push(n);
        if(r.readyPlayers.length >= r.maxPlayers) r.phase = 'SOLVING';
        io.to(rid).emit('sync', r);
    });

    socket.on('leaveRoom', (rid) => {
        const r = rooms[rid]; 
        if(!r) return;
        
        const n = r.players[socket.id]; 
        delete r.players[socket.id];
        r.occupiedNums = r.occupiedNums.filter(x => x !== n);
        
        socket.leave(rid); 
        socket.emit('left'); 
        
        if(Object.keys(r.players).length > 0) {
            io.to(rid).emit('sync', r); 
        } else {
            delete rooms[rid]; 
        }
    });

    socket.on('destroyRoom', (rid) => { 
        if(rooms[rid] && rooms[rid].players[socket.id] === 1) { 
            io.to(rid).emit('roomDestroyed'); 
            delete rooms[rid]; 
        } 
    });

    socket.on('reportIssue', (data) => {
        const { roomId, puzzleId, board, reason } = data;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = `report_${puzzleId}_${timestamp}.txt`;
        const content = `時間: ${new Date().toLocaleString()}\n原因: ${reason}\n房間: ${roomId}\n盤面: ${JSON.stringify(board)}\n`;
        fs.writeFile(path.join(ERROR_DIR, fileName), content, (err) => {});
    });
});

// 在 io.on 外部定義檢查邏輯
function validateSudoku6x6(b) {
    for (let i = 0; i < 6; i++) {
        let row = new Set();
        let col = new Set();
        let block = new Set();

        for (let j = 0; j < 6; j++) {
            // 橫行檢查 (Row)
            let rVal = b[i * 6 + j];
            if (row.has(rVal)) return false;
            row.add(rVal);

            // 直列檢查 (Column)
            let cVal = b[j * 6 + i];
            if (col.has(cVal)) return false;
            col.add(cVal);

            // 2x3 宮格檢查 (Block)
            let br = Math.floor(i / 2) * 2 + Math.floor(j / 3);
            let bc = (i % 2) * 3 + (j % 3);
            let bVal = b[br * 6 + bc];
            if (block.has(bVal)) return false;
            block.add(bVal);
        }
    }
    return true;
}

// 伺服器啟動
const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log('\x1b[36m%s\x1b[0m', '==============================================');
    console.log('\x1b[32m%s\x1b[0m', '    🚀 數獨連線遊戲伺服器已成功啟動！');
    console.log(`    🏠 地址: http://localhost:${PORT}`);
    console.log('\x1b[36m%s\x1b[0m', '==============================================');
});