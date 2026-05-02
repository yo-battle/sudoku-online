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

// --- [新增] 幽靈數字邏輯 (不影響原本功能) ---
let virtualBase = Math.floor(Math.random() * 3) + 3; 
setInterval(() => {
    const change = Math.random() > 0.5 ? 1 : -1;
    virtualBase += change;
    if (virtualBase < 3) virtualBase = 3; 
    if (virtualBase > 6) virtualBase = 5; 
}, Math.random() * 300000 + 300000);

let rooms = {};
let roomCounters = { "1": 1, "2": 1, "3": 1, "4": 1 }; 

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
    
    // --- [新增] 進入大廳立刻發送人數資訊 ---
    const sendLobbyStats = () => {
        const allRooms = Object.values(rooms);
        const realPlayers = allRooms.reduce((sum, r) => sum + Object.keys(r.players).length, 0);
        socket.emit('lobbyStats', { 
            onlineCount: realPlayers + virtualBase,
            roomCount: allRooms.length 
        });
    };
    sendLobbyStats();

    // 重新回到草稿狀態 (原本功能)
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
            room.readyPlayers = []; room.changeRequests = []; room.completeVotes = []; room.lastError = null; room.turn = 1;
            io.to(roomId).emit('sync', room);
        }
    });

    // 創建房間 (原本功能)
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
            answer: puzzle.answer, lastError: null
        };
        socket.join(roomId);
        socket.emit('joined', { roomId, pNum: 1, state: rooms[roomId] });
        sendLobbyStats(); // 更新大廳人數
    });

    // 換題邏輯 (原本功能)
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
            room.answer = puzzle.answer; room.lastError = null; room.phase = 'DRAFTING';
            room.readyPlayers = []; room.changeRequests = []; room.completeVotes = []; room.turn = 1;
            io.to(roomId).emit('sync', room);
        } else {
            io.to(roomId).emit('sync', room);
        }
    });

    // 填字邏輯 (原本功能)
    socket.on('fill', (data) => {
        const { roomId, index, val } = data;
        const room = rooms[roomId];
        if (!room || room.phase !== 'SOLVING') return;
        if (index === null || index < 0 || !room.board[index]) return;
        if (room.turn === room.players[socket.id] && !room.board[index].isFixed) {
            room.board[index].val = val; room.lastError = null; 
            if (room.board.every(cell => cell.val !== null)) { 
                room.phase = 'CHECKING'; room.completeVotes = []; 
            } else { 
                room.turn = (room.turn % room.maxPlayers) + 1; 
            }
            io.to(roomId).emit('sync', room);
        }
    });

    // 完成投票邏輯 (原本功能)
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
                    room.phase = 'RESULT'; room.lastError = null;
                } else {
                    room.phase = 'SOLVING'; room.completeVotes = []; 
                    room.lastError = "答案有誤（行列或宮格重複），請再檢查！";
                }
            }
        } else { 
            room.phase = 'SOLVING'; room.completeVotes = []; room.lastError = null;
        }
        io.to(roomId).emit('sync', room);
    });

    // 基礎房間操作 (原本功能)
    socket.on('checkRoom', (rid) => { 
        if(rooms[rid]) socket.emit('roomStatus', { occupiedNums: rooms[rid].occupiedNums, maxPlayers: rooms[rid].maxPlayers }); 
    });
    
    socket.on('selectPos', (d) => {
        const r = rooms[d.roomId];
        if(r && !r.occupiedNums.includes(d.pNum)) {
            r.players[socket.id] = d.pNum; r.occupiedNums.push(d.pNum);
            socket.join(d.roomId); socket.emit('joined', { roomId: d.roomId, pNum: d.pNum, state: r });
            io.to(d.roomId).emit('sync', r);
            sendLobbyStats();
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
        if(Object.keys(r.players).length > 0) {
            io.to(rid).emit('sync', r); 
        } else {
            delete rooms[rid]; 
        }
        sendLobbyStats();
    });

    socket.on('destroyRoom', (rid) => { 
        if(rooms[rid] && rooms[rid].players[socket.id] === 1) { 
            io.to(rid).emit('roomDestroyed'); delete rooms[rid]; 
            sendLobbyStats();
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

// 驗證邏輯 (原本功能)
function validateSudoku6x6(b) {
    for (let i = 0; i < 6; i++) {
        let row = new Set(), col = new Set(), block = new Set();
        for (let j = 0; j < 6; j++) {
            let rVal = b[i * 6 + j]; if (row.has(rVal)) return false; row.add(rVal);
            let cVal = b[j * 6 + i]; if (col.has(cVal)) return false; col.add(cVal);
            let br = Math.floor(i / 2) * 2 + Math.floor(j / 3);
            let bc = (i % 2) * 3 + (j % 3);
            let bVal = b[br * 6 + bc]; if (block.has(bVal)) return false; block.add(bVal);
        }
    }
    return true;
}

// 伺服器啟動 (原本功能)
const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log('\x1b[36m%s\x1b[0m', '==============================================');
    console.log('\x1b[32m%s\x1b[0m', '    🚀 數獨連線遊戲伺服器已啟動！');
    console.log('\x1b[36m%s\x1b[0m', '==============================================');
});

// --- [新增] 營運監控小工具 (一小時更新一次) ---
setInterval(() => {
    const allRooms = Object.values(rooms);
    const realPlayers = allRooms.reduce((sum, r) => sum + Object.keys(r.players).length, 0);
    const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    console.log('\x1b[36m%s\x1b[0m', `--- 📅 ${now} 營運快報 ---`);
    console.log(`真實人數: ${realPlayers} | 幽靈加成: +${virtualBase} | 顯示總數: ${realPlayers + virtualBase}`);
    console.log(`總房間數: ${allRooms.length}`);
    console.log('\x1b[36m%s\x1b[0m', '-----------------------------------');
}, 3600000);