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
        
        if (!room || room.phase !== 'SOLVING') return;
        
        if (index === null || index < 0 || !room.board[index]) {
            console.error(`⚠️ 收到無效的索引: ${index}`);
            return; 
        }

        if (room.turn === room.players[socket.id] && !room.board[index].isFixed) {
            room.board[index].val = val;
            room.lastError = null; 

            // --- 重點修改區域：重新定義「填滿」的標準 ---
            const isAllFilled = room.board.every(cell => {
                // 如果是題目預設的 7，我們直接判定為「已填滿」
                if (cell.isFixed && cell.val === 7) return true;
                // 其餘格子必須要有值（不是 null）
                return cell.val !== null;
            });

            if (isAllFilled) { 
                room.phase = 'CHECKING'; 
                room.completeVotes = []; 
            } else { 
                room.turn = (room.turn % room.maxPlayers) + 1; 
            }
            // ------------------------------------------

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
        // 1. 抓取這三組資料：橫行、直列、宮格
        let rowArr = [];
        let colArr = [];
        let blockArr = [];

        for (let j = 0; j < 6; j++) {
            // 橫行
            rowArr.push(b[i * 6 + j]);
            // 直列
            colArr.push(b[j * 6 + i]);
            // 2x3 宮格
            let br = Math.floor(i / 2) * 2 + Math.floor(j / 3);
            let bc = (i % 2) * 3 + (j % 3);
            blockArr.push(b[br * 6 + bc]);
        }

        // 2. 定義內部的檢查函數
        const isGroupValid = (arr) => {
            // 使用 == 確保字串 "7" 也能通過
            const count7 = arr.filter(n => n == 7).length; 
            const maxAllowed = 6 - count7;

            let seen = new Set();
            for (let num of arr) {
                if (num == 7) continue;

                // 修正點：定義 val 並確保它是數字
                const val = parseInt(num);

                // 檢查是否為有效數字、是否在 1 到 maxAllowed 之間
                if (isNaN(val) || val < 1 || val > maxAllowed) return false;
                
                // 檢查是否重複
                if (seen.has(val)) return false;
                seen.add(val);
            } 
                
            // 檢查該組是否填滿了所有應有的數字數量
            if (seen.size !== maxAllowed) return false;

            return true;
        };
            // 檢查該組是否填滿了所有應有的數字 (1 到 maxAllowed)
            // 這是為了確保玩家沒有漏掉數字或是填了無效組合
            if (seen.size !== maxAllowed) return false;

            return true;
        };

        // 3. 執行三向檢查
        if (!isGroupValid(rowArr)) return false;
        if (!isGroupValid(colArr)) return false;
        if (!isGroupValid(blockArr)) return false;
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