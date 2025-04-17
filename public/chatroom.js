let socket = null;
let socketConfig = {};

async function loadConfig() {
    const res = await fetch('config.json');
    socketConfig = await res.json();
    initSocket();
}

function initSocket() {
    socket = io(`ws://${socketConfig.server}:${socketConfig.port}`);
}

await loadConfig();
const roomInput = document.getElementById('roomInput');
const nicknameInput = document.getElementById('nicknameInput');
const chatBox = document.getElementById('chat-box');
const messageInput = document.getElementById('messageInput');
const userList = document.getElementById('user-list');
const joinBtn = document.getElementById('joinBtn');
const sendBtn = document.getElementById('sendBtn');
const config = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

let peerConnection = null;
let currentRoom = null;
let sharedKey = null;
let nickname = '';
let isComposing = false;
let hasJoined = false;

let pendingCandidates = [];

socket.on('chat-join-failed', ({ reason }) => {
    alert(reason || '加入聊天室失败');
});

socket.on('init-host', async () => {
    await initKeyIfNeeded();
});

// 密钥生成
async function initKeyIfNeeded() {
    if (!sharedKey) {
        sharedKey = await crypto.subtle.generateKey(
            { name: 'AES-GCM', length: 128 },
            true,                     // ✅ 是否可导出
            ['encrypt', 'decrypt']
        );
        console.log('🧪 生成共享密钥');
    }
}

function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

async function encryptString(str) {
    const iv = crypto.getRandomValues(new Uint8Array(12)); // 12字节 IV
    const encoded = new TextEncoder().encode(str);         // 转字节
    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        sharedKey,
        encoded
    );
    return {
        iv: arrayBufferToBase64(iv),
        data: arrayBufferToBase64(encrypted)
    };
}

async function decryptToString({ iv, data }) {
    const ivBytes = Uint8Array.from(atob(iv), c => c.charCodeAt(0));
    const encryptedBytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
    const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: ivBytes },
        sharedKey,
        encryptedBytes
    );
    return new TextDecoder().decode(decrypted);
}

async function sendEncryptedPayload(type, value) {
    if (!sharedKey) return alert('共享密钥获取失败，无法进行端到端加密通信');
    const encrypted = await encryptString(value);
    socket.emit('chat-message', { room: currentRoom, encrypted });
    if (type === 'text') {
        appendMessage(`${nickname}：${value}`, true);
    } else if (type === 'image') {
        appendImage(nickname, value, true);
    }
}

function createPeerConnection(to) {
    peerConnection = new RTCPeerConnection(config);
    peerConnection.onicecandidate = (e) => {
        console.log('ICE 状态:', peerConnection.iceConnectionState);
        if (e.candidate) socket.emit('signal', { to, data: { candidate: e.candidate } });
    };

    if (sharedKey !== null) {
        const channel = peerConnection.createDataChannel('key');
        channel.onopen = async () => {
            const raw = await crypto.subtle.exportKey('raw', sharedKey);
            channel.send(btoa(String.fromCharCode(...new Uint8Array(raw))));
        };
        return offerNow(to);
    }
    peerConnection.ondatachannel = (e) => {
        e.channel.onmessage = async (evt) => {
            const raw = Uint8Array.from(atob(evt.data), c => c.charCodeAt(0));
            sharedKey = await crypto.subtle.importKey("raw", raw, "AES-GCM", true, ["encrypt", "decrypt"]);
            console.log("✅ 已通过 DataChannel 接收到共享密钥");
        };
    };
}

async function offerNow(to) {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('signal', { to, data: offer });
}

function appendMessage(text, self = false) {
    const div = document.createElement('div');
    div.className = `msg ${self ? 'me' : 'other'}`;
    div.textContent = text;
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
}

function appendImage(from, base64, self = false) {
    const div = document.createElement('div');
    div.className = `msg ${self ? 'me' : 'other'}`;
    const img = document.createElement('img');
    img.src = base64;
    img.className = 'chat-image';
    img.onclick = () => {
        document.getElementById('preview-img').src = base64;
        document.getElementById('preview-modal').style.display = 'flex';
    };
    div.innerHTML = `${from}:<br/>`;
    div.appendChild(img);
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
}

function joinRoom() {
    const room = roomInput.value.trim();
    nickname = nicknameInput.value.trim() || '匿名';
    if (!room) return alert('请输入房间号');
    if (currentRoom && currentRoom !== room) {
        socket.emit('leave-chatroom', { room: currentRoom });
        hasJoined = false;
    }
    currentRoom = room;
    socket.emit('join-chatroom', { room, nickname });
}

async function sendMessage() {
    const message = messageInput.value.trim();
    if (!message || !currentRoom) return;
    await sendEncryptedPayload('text', message);
    messageInput.value = '';
}

function handleDrop(e) {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file || !file.type.startsWith('image/')) return;

    const reader = new FileReader();
    reader.onload = async () => {
        const base64 = reader.result;
        await sendEncryptedPayload('image', base64);
    };
    reader.readAsDataURL(file);
}

function handlePasteImage(e) {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
        if (item.type.startsWith('image/')) {
            const file = item.getAsFile();
            const reader = new FileReader();
            reader.onload = async () => {
                const base64 = reader.result;
                await sendEncryptedPayload('image', base64);
            };
            reader.readAsDataURL(file);
            e.preventDefault(); // 防止粘贴到 input 框里
            break;
        }
    }
}

window.addEventListener('paste', handlePasteImage);

messageInput.addEventListener('compositionstart', () => {
    isComposing = true;
});
messageInput.addEventListener('compositionend', () => {
    isComposing = false;
});
messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !isComposing) sendMessage();
});

socket.on('chat-message', async ({ from, message, encrypted }) => {
    if (message) return appendMessage(`${from}：${message}`, true);
    if (!sharedKey) return;
    const raw = await decryptToString(encrypted);

    if (raw.startsWith('data:image/')) {
        appendImage(from, raw, from === nickname);
    } else {
        appendMessage(`${from}：${raw}`, from === nickname);
    }
});

socket.on('chat-userlist', ({ users }) => {
    userList.textContent = `👥 当前在线人数：${users.length} ｜ 成员：${users.join('、')}`;
    if (!hasJoined) {
        appendMessage(`你已加入房间 ${currentRoom}`, true);
        hasJoined = true;
    }
});

socket.on('connect-to', ({ id }) => {
    createPeerConnection(id);
});

socket.on('signal', async ({ from, data }) => {
    if (!peerConnection) createPeerConnection(from);
    if (data.type === 'offer') {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data));

        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket.emit('signal', { room, data: answer });

        // 🔄 设置完成后处理候选
        for (const c of pendingCandidates) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(c));
        }
        pendingCandidates = [];

    } else if (data.type === 'answer') {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data));

        for (const c of pendingCandidates) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(c));
        }
        pendingCandidates = [];

    } else if (data.candidate) {
        if (peerConnection.remoteDescription) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
        } else {
            pendingCandidates.push(data.candidate);
        }
    }
});

window.addEventListener('beforeunload', () => {
    if (currentRoom && nickname) {
        socket.emit('leaving', { room: currentRoom, nickname, type: 'chat' });
    }
});

joinBtn.addEventListener('click', joinRoom);
chatBox.addEventListener('drop', handleDrop);
sendBtn.addEventListener('click', sendMessage);