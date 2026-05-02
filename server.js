const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const fs = require('fs');
const path = require('path'); // 提到前面，確保後面能使用
const os = require('os');

// 1. 設定靜態檔案讀取（重要：讓 Render 找得到你的 index.html 和其他檔案）
app.use(express.static(__dirname));

// 2. 設定首頁路由
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- 以下是你原本的邏輯 ---
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
        return { "1": [{ id: "ERR", data: "0".repeat(36) }] };
    }
}

// Socket.io 遊戲邏輯
io.on('connection', (socket) => {
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
            board: puzzle.data.split('').map(num => ({ val: num !== '0' ? parseInt(num) : null, isFixed: num !== '0' }))
        };
        socket.join(roomId);
        socket.emit('joined', { roomId, pNum: 1, state: rooms[roomId] });
    });

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
            room.phase = 'DRAFTING';
            room.readyPlayers = []; room.changeRequests = []; room.completeVotes = []; room.turn = 1;
            io.to(roomId).emit('sync', room);
        } else {
            io.to(roomId).emit('sync', room);
        }
    });

    socket.on('reportIssue', (data) => {
        const { roomId, puzzleId, board, reason } = data;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = `report_${puzzleId}_${timestamp}.txt`;
        const content = `時間: ${new Date().toLocaleString()}\n原因: ${reason}\n房間: ${roomId}\n盤面: ${JSON.stringify(board)}\n`;
        fs.writeFile(path.join(ERROR_DIR, fileName), content, (err) => {});
    });

    socket.on('fill', (data) => {
        const { roomId, index, val } = data;
        const room = rooms[roomId];
        if (!room || room.phase !== 'SOLVING') return;
        if (room.turn === room.players[socket.id] && !room.board[index].isFixed) {
            room.board[index].val = val;
            if (room.board.every(cell => cell.val !== null)) { room.phase = 'CHECKING'; room.completeVotes = []; }
            else { room.turn = (room.turn % room.maxPlayers) + 1; }
            io.to(roomId).emit('sync', room);
        }
    });

    socket.on('voteComplete', (data) => {
        const { roomId, agree } = data;
        const room = rooms[roomId];
        if (!room || room.phase !== 'CHECKING') return;
        if (agree) {
            const pNum = room.players[socket.id];
            if (!room.completeVotes.includes(pNum)) room.completeVotes.push(pNum);
            const th = room.maxPlayers === 1 ? 1 : Math.ceil((room.maxPlayers + 1) / 2);
            if (room.completeVotes.length >= th) room.phase = 'RESULT';
        } else { room.phase = 'SOLVING'; room.completeVotes = []; }
        io.to(roomId).emit('sync', room);
    });

    socket.on('checkRoom', (rid) => { if(rooms[rid]) socket.emit('roomStatus', { occupiedNums: rooms[rid].occupiedNums, maxPlayers: rooms[rid].maxPlayers }); });
    
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
        const r = rooms[rid]; if(!r) return;
        const n = r.players[socket.id]; delete r.players[socket.id];
        r.occupiedNums = r.occupiedNums.filter(x => x !== n);
        socket.leave(rid); socket.emit('left');
        if(Object.keys(r.players).length > 0) io.to(rid).emit('sync', r); else delete rooms[rid];
    });

    socket.on('destroyRoom', (rid) => { if(rooms[rid] && rooms[rid].players[socket.id] === 1) { io.to(rid).emit('roomDestroyed'); delete rooms[rid]; } });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log('\x1b[36m%s\x1b[0m', '==============================================');
    console.log('\x1b[32m%s\x1b[0m', '   🚀 數獨連線遊戲伺服器已成功啟動！');
    console.log('\x1b[36m%s\x1b[0m', '==============================================');
    console.log(`   🏠 本機存取地址: http://localhost:${PORT}`);
    const interfaces = os.networkInterfaces();
    for (let devName in interfaces) {
        interfaces[devName].forEach((details) => {
            if (details.family === 'IPv4' && !details.internal) {
                console.log(`   🌐 區域網路地址: http://${details.address}:${PORT}`);
            }
        });
    }
    console.log('\x1b[36m%s\x1b[0m', '==============================================');
});