/**
 * WebSocket bridge: browser <-> this server <-> Gemini Live API.
 *
 * The browser streams raw 16 kHz / 16-bit / mono PCM frames as binary messages.
 * We forward them to Gemini as realtimeInput.audio and relay interim / final
 * transcription events back as small JSON messages. The API key never leaves
 * the server.
 */
const WebSocket = require('ws');

const GEMINI_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

const LANGUAGE_PRESETS = {
  auto: [],                    // automatic detection, handles code-switching
  'hi-en': ['hi-IN', 'en-IN'], // Hinglish
  en: ['en-IN'],
  hi: ['hi-IN'],
};

function attachLiveProxy(server) {
  const wss = new WebSocket.WebSocketServer({ server, path: '/ws/transcribe', maxPayload: 1 << 20 });

  wss.on('connection', (client, req) => {
    const url = new URL(req.url, 'http://x');
    const lang = LANGUAGE_PRESETS[url.searchParams.get('lang')] ?? [];
    const send = (obj) => client.readyState === WebSocket.OPEN && client.send(JSON.stringify(obj));

    if (!process.env.GEMINI_API_KEY) {
      send({ type: 'error', message: 'Server is missing GEMINI_API_KEY' });
      return client.close();
    }

    const model = process.env.GEMINI_MODEL || 'gemini-3.5-transcribe-live';
    const upstream = new WebSocket(`${GEMINI_URL}?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`);
    let ready = false;
    const pending = [];
    let closeTimer = null;

    upstream.on('open', () => {
      upstream.send(JSON.stringify({
        setup: {
          model: `models/${model}`,
          generationConfig: { responseModalities: ['TEXT'] },
          inputAudioTranscription: { languageCodes: lang },
        },
      }));
    });

    upstream.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.setupComplete) {
        ready = true;
        send({ type: 'ready', model });
        pending.splice(0).forEach((m) => upstream.send(m));
        return;
      }
      const sc = msg.serverContent;
      if (sc?.interimInputTranscription?.text !== undefined) {
        send({ type: 'interim', text: sc.interimInputTranscription.text });
      }
      if (sc?.inputTranscription) {
        send({ type: 'final', text: sc.inputTranscription.text || '' });
      }
      if (msg.goAway) send({ type: 'warning', message: 'Session ending soon (Gemini 10 min limit)' });
    });

    upstream.on('close', (code, reason) => {
      send({ type: 'closed', code, reason: reason.toString() });
      if (client.readyState === WebSocket.OPEN) client.close();
    });
    upstream.on('error', (err) => {
      console.error('[gemini] upstream error:', err.message);
      send({ type: 'error', message: 'Transcription service error' });
    });

    client.on('message', (data, isBinary) => {
      if (isBinary) {
        const frame = JSON.stringify({
          realtimeInput: { audio: { data: Buffer.from(data).toString('base64'), mimeType: 'audio/pcm;rate=16000' } },
        });
        if (ready && upstream.readyState === WebSocket.OPEN) upstream.send(frame);
        else if (pending.length < 50) pending.push(frame);
        return;
      }
      let ctrl;
      try { ctrl = JSON.parse(data.toString()); } catch { return; }
      if (ctrl.type === 'stop' && upstream.readyState === WebSocket.OPEN) {
        // Flush: ask Gemini to finalize the last utterance, then close shortly after.
        upstream.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
        closeTimer = setTimeout(() => upstream.close(), 2500);
      }
    });

    client.on('close', () => {
      clearTimeout(closeTimer);
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
    });
  });
}

module.exports = { attachLiveProxy };
