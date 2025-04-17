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
const roomInput = document.getElementById('roomId');
const statusText = document.getElementById('status');
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const chatBox = document.getElementById('chat-box');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const joinBtn = document.getElementById('joinBtn');
const videoToggleBtn = document.getElementById('videoToggleBtn');
const audioToggleBtn = document.getElementById('audioToggleBtn');

let currentRoom = null;
let videoEnabled = true;
let audioEnabled = true;
let isComposing = false;
let mirroredStream;
let peerConnection;
let dataChannel;
let pendingCandidates = [];

const config = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

socket.on('full', () => {
    currentRoom = null;
    statusText.innerText = '🚫 房间已满';
});
socket.on('peer-left', () => {
    remoteVideo.srcObject = null;
    statusText.innerText = '👋 对方离开了房间';
})

function appendChat(from, msg, self = false) {
    const div = document.createElement('div');
    div.className = `chat-msg ${self ? 'me' : 'other'}`;
    div.textContent = `${from}: ${msg}`;
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
}

sendBtn.onclick = () => {
    const message = chatInput.value;
    if (message && dataChannel?.readyState === 'open') {
        dataChannel.send(message);
        appendChat('我', message, true);
        chatInput.value = '';
    }
};

chatInput.addEventListener('compositionstart', () => {
    isComposing = true;
});

chatInput.addEventListener('compositionend', () => {
    isComposing = false;
});

chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !isComposing) {
        const message = chatInput.value;
        if (message && dataChannel?.readyState === 'open') {
            dataChannel.send(message);
            appendChat('我', message, true);
            chatInput.value = '';
        }
    }
});

async function createMirroredStream(userStream, fps = 30) {
    return new Promise(async (resolve) => {
        const video = document.createElement('video');
        video.srcObject = userStream;
        video.muted = true;
        video.playsInline = true;

        // 强制显示（避免优化）
        Object.assign(video.style, {
            position: 'absolute',
            opacity: '0',
            pointerEvents: 'none',
            width: '1px',
            height: '1px',
            top: '-9999px',
        });
        document.body.appendChild(video);

        await video.play();
        await new Promise((res) => {
            if (video.readyState >= 2) res();
            else video.onloadedmetadata = res;
        });

        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');

        // 强制 canvas 出现在 DOM 以避免渲染暂停
        Object.assign(canvas.style, {
            position: 'absolute',
            width: '1px',
            height: '1px',
            top: '-9999px',
        });
        document.body.appendChild(canvas);

        setInterval(() => {
            ctx.save();
            ctx.scale(-1, 1);
            ctx.drawImage(video, -canvas.width, 0, canvas.width, canvas.height);
            ctx.restore();
        }, 1000 / fps);

        const mirroredStream = canvas.captureStream(fps);

        // 把音频轨道直接拼上去（不从 canvas 来）
        userStream.getAudioTracks().forEach(track => {
            mirroredStream.addTrack(track);
        });

        resolve(mirroredStream);
    });
}

function resetConnection(stream) {
    try {
        if (peerConnection) {
            peerConnection.close();
            peerConnection = null;
        }
    } catch (e) {
        console.error('关闭旧连接时出错:', e);
    }

    dataChannel = null;
    remoteVideo.srcObject = null;

    // 创建新的 RTCPeerConnection
    peerConnection = new RTCPeerConnection(config);

    // 添加所有轨道到 peer connection
    stream.getTracks().forEach(track => {
        console.log('添加轨道到 peerConnection:', track.kind);
        peerConnection.addTrack(track, stream);
    });

    // 设置事件处理程序
    peerConnection.ontrack = e => {
        console.log('📹 收到远端轨道:', e.track.kind);
        if (e.streams && e.streams[0]) {
            remoteVideo.srcObject = e.streams[0];
            console.log('📹 远端视频流设置成功');
        }
    };

    peerConnection.onicecandidate = e => {
        if (e.candidate) {
            console.log('ICE 候选者生成:', e.candidate);
            socket.emit('signal', {
                room: currentRoom,
                data: {
                    type: 'candidate',
                    candidate: e.candidate
                }
            });
        }
    };

    peerConnection.ondatachannel = e => {
        console.log('数据通道已接收');
        dataChannel = e.channel;
        dataChannel.onmessage = e => appendChat('对方', e.data);
    };

    peerConnection.oniceconnectionstatechange = () => {
        console.log('ICE 连接状态变化:', peerConnection.iceConnectionState);
    };
}

socket.once('join-success', async () => {
    try {
        const realStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        mirroredStream = await createMirroredStream(realStream);
        localVideo.srcObject = mirroredStream;

        resetConnection(mirroredStream);

        socket.emit('join-ready', currentRoom);
    } catch (err) {
        statusText.innerText = `获取媒体设备失败: ${err.message}`;
        console.error("获取摄像头和麦克风失败:", err);
    }
});

socket.on('joined', async (id) => {
    console.log('👋 对方加入了，我发起连接');
    resetConnection(mirroredStream);
    dataChannel = peerConnection.createDataChannel('chat');
    dataChannel.onmessage = e => appendChat('对方', e.data);

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('signal', { room: currentRoom, data: offer });
    statusText.innerText = '👋 发起连接...';
});

socket.on('signal', async ({ data }) => {
    console.log('📩 收到信令:', data.type);

    if (!peerConnection) {
        console.warn('⚠️ peerConnection 尚未初始化');
        return;
    }

    console.log('📡 当前 ICE 状态:', peerConnection.iceConnectionState);

    try {
        if (data.type === 'offer') {
            console.log('处理 offer...');
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data));
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            socket.emit('signal', { room: currentRoom, data: answer });
            statusText.innerText = '💡 收到 offer，返回 answer';
            for (const c of pendingCandidates) {
                await peerConnection.addIceCandidate(new RTCIceCandidate(c));
            }
            pendingCandidates = [];
        } else if (data.type === 'answer') {
            console.log('处理 answer...');
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data));
            statusText.innerText = '✅ 通话建立！';
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
    } catch (err) {
        console.error('❌ 信令处理失败:', err);
        statusText.innerText = `❌ 信令处理失败: ${err.message}`;
    }
});

async function joinRoom() {
    const room = roomInput.value;
    if (!room) return alert('请输入房间号');
    currentRoom = room;
    socket.emit('join', room);
}

function toggleVideo() {
    const videoTrack = mirroredStream?.getVideoTracks()[0];
    if (!videoTrack) return;

    videoEnabled = !videoEnabled;
    videoTrack.enabled = videoEnabled;

    videoToggleBtn.textContent = videoEnabled ? '关闭摄像头' : '开启摄像头';
}

function toggleAudio() {
    const audioTrack = mirroredStream?.getAudioTracks()[0];
    if (!audioTrack) return;

    audioEnabled = !audioEnabled;
    audioTrack.enabled = audioEnabled;

    audioToggleBtn.textContent = audioEnabled ? '关闭麦克风' : '开启麦克风';
}

joinBtn.addEventListener('click', joinRoom);
videoToggleBtn.addEventListener('click', toggleVideo);
audioToggleBtn.addEventListener('click', toggleAudio);