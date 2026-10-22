const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const WebSocket = require('ws');

const config = JSON.parse(readFileSync(process.argv[2] || '.local/dva.config.json', 'utf8'));
app.commandLine.appendSwitch('force_high_performance_gpu');
app.commandLine.appendSwitch('enable-features', 'WebRtcHWH264Encoding');
const getIce = () => new Promise((resolve, reject) => {
  const socket = new WebSocket(config.server.url); const timer = setTimeout(() => reject(new Error('ICE login timeout')), 10000);
  socket.on('error', reject);
  socket.on('open', () => socket.send(JSON.stringify({ version: 1, type: 'auth.login', requestId: randomUUID(), payload: config.auth })));
  socket.on('message', raw => { const packet = JSON.parse(raw); if (packet.type === 'auth.ok') { clearTimeout(timer); socket.close(); resolve(packet.payload.ice); } });
});

app.whenReady().then(async () => {
  let rendererGone;
  try {
    const ice = await getIce();
    const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, sandbox: false } });
    window.webContents.on('render-process-gone', (_event, details) => { rendererGone = details; });
    await window.loadURL('data:text/html,<meta charset=utf-8>');
    const result = await window.webContents.executeJavaScript(`(async () => { let stage = 'configuration'; try {
      const configuration = { iceServers: ${JSON.stringify(ice.iceServers)}, iceTransportPolicy: 'relay', bundlePolicy: 'max-bundle' };
      const a = new RTCPeerConnection(configuration), b = new RTCPeerConnection(configuration);
      a.onicecandidate = e => { if (e.candidate) b.addIceCandidate(e.candidate); };
      b.onicecandidate = e => { if (e.candidate) a.addIceCandidate(e.candidate); };
      const channel = a.createDataChannel('probe');
      const withVideo = ${process.argv.includes('--video')};
      const video = withVideo ? a.addTransceiver('video', { direction: 'recvonly' }) : undefined;
      const capabilities = RTCRtpReceiver.getCapabilities('video');
      if (video && capabilities) video.setCodecPreferences([...capabilities.codecs].sort((x, y) => Number(y.mimeType.toLowerCase() === 'video/h264') - Number(x.mimeType.toLowerCase() === 'video/h264')));
      const connected = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('TURN data channel timeout')), 15000); b.ondatachannel = e => { e.channel.onopen = () => { clearTimeout(timer); resolve(true); }; }; });
      stage = 'offer'; await a.setLocalDescription(await a.createOffer()); await b.setRemoteDescription(a.localDescription);
      let sender, animation;
      if (withVideo) { const canvas = document.createElement('canvas'); canvas.width = 3840; canvas.height = 2160; const context = canvas.getContext('2d'); context.fillStyle = '#182030'; context.fillRect(0, 0, canvas.width, canvas.height);
        let frame = 0; animation = setInterval(() => { context.fillStyle = frame++ % 2 ? '#182030' : '#192131'; context.fillRect(0, 0, canvas.width, canvas.height); }, 16);
        const stream = canvas.captureStream(60); sender = b.addTrack(stream.getVideoTracks()[0], stream); }
      stage = 'answer'; await b.setLocalDescription(await b.createAnswer()); await a.setRemoteDescription(b.localDescription);
      if (sender) { const parameters = sender.getParameters(); if (parameters.encodings?.length) { parameters.encodings[0].maxBitrate = 16000000; parameters.encodings[0].maxFramerate = 60; await sender.setParameters(parameters); } }
      stage = 'connect'; await connected; if (withVideo) await new Promise(resolve => setTimeout(resolve, 2000)); const stats = await b.getStats(); let relay = false, encoder, powerEfficientEncoder, framesEncoded; stats.forEach(v => { if (v.type === 'local-candidate' && v.candidateType === 'relay') relay = true; if (v.type === 'outbound-rtp' && (v.kind === 'video' || v.mediaType === 'video')) { encoder = v.encoderImplementation; powerEfficientEncoder = v.powerEfficientEncoder; framesEncoded = v.framesEncoded; } });
      clearInterval(animation); a.close(); b.close(); return { connected: true, relay, encoder, powerEfficientEncoder, framesEncoded };
      } catch (error) { return { connected: false, stage, name: error?.name, message: error?.message, text: String(error) }; }
    })()`);
    result.gpuFeatureStatus = app.getGPUFeatureStatus();
    result.gpuDevices = (await app.getGPUInfo('basic')).gpuDevice;
    writeFileSync('.local/electron-turn-smoke-result.json', JSON.stringify({ ok: true, result }, null, 2));
    console.log(JSON.stringify(result)); app.exit(result.connected && result.relay ? 0 : 2);
  } catch (error) { writeFileSync('.local/electron-turn-smoke-result.json', JSON.stringify({ ok: false, error: String(error), name: error?.name, message: error?.message, stack: error?.stack, rendererGone }, null, 2)); console.error(error); app.exit(1); }
});
