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

    // --- Server-side voice activity detection -------------------------------
    // Gemini's built-in VAD proved unreliable for some voices/mics, so we mark
    // utterance boundaries ourselves: activityStart when speech energy appears,
    // activityEnd after a short silence. Each activityEnd yields a final segment;
    // interim results stream while the user is speaking.
    const VAD = { threshold: 0.012, hangoverMs: 700, maxUtteranceMs: 20000, prerollFrames: 3 };
    let speaking = false;
    let silenceMs = 0;
    let utteranceMs = 0;
    const preroll = [];

    const sendUp = (obj) => {
      const s = JSON.stringify(obj);
      if (ready && upstream.readyState === WebSocket.OPEN) upstream.send(s);
      else if (pending.length < 100) pending.push(s);
    };
    const audioMsg = (buf) => ({ realtimeInput: { audio: { data: buf.toString('base64'), mimeType: 'audio/pcm;rate=16000' } } });
    const endActivity = () => {
      if (!speaking) return;
      speaking = false;
      sendUp({ realtimeInput: { activityEnd: {} } });
    };

    function onAudio(buf) {
      const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
      let sum = 0;
      for (let i = 0; i < samples.length; i++) sum += (samples[i] / 32768) ** 2;
      const rms = Math.sqrt(sum / (samples.length || 1));
      const frameMs = (samples.length / 16000) * 1000;
      const voiced = rms > VAD.threshold;

      if (!speaking) {
        preroll.push(buf);
        if (preroll.length > VAD.prerollFrames) preroll.shift();
        if (!voiced) return;
        speaking = true; silenceMs = 0; utteranceMs = 0;
        sendUp({ realtimeInput: { activityStart: {} } });
        preroll.splice(0).forEach((b) => sendUp(audioMsg(b))); // includes current frame
        return;
      }
      sendUp(audioMsg(buf));
      utteranceMs += frameMs;
      silenceMs = voiced ? 0 : silenceMs + frameMs;
      if (silenceMs >= VAD.hangoverMs || utteranceMs >= VAD.maxUtteranceMs) endActivity();
    }

    upstream.on('open', () => {
      upstream.send(JSON.stringify({
        setup: {
          model: `models/${model}`,
          generationConfig: { responseModalities: ['TEXT'] },
          inputAudioTranscription: { languageCodes: lang },
          realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
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
      if (msg.error) {
        console.error('[gemini] error:', JSON.stringify(msg.error));
        send({ type: 'error', message: msg.error.message || 'Transcription service error' });
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
      if (isBinary) return onAudio(Buffer.from(data));
      let ctrl;
      try { ctrl = JSON.parse(data.toString()); } catch { return; }
      if (ctrl.type === 'stop' && upstream.readyState === WebSocket.OPEN) {
        // Flush: finalize the in-progress utterance, then close shortly after.
        endActivity();
        closeTimer = setTimeout(() => upstream.close(), 3000);
      }
    });

    client.on('close', () => {
      clearTimeout(closeTimer);
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
    });
  });
}

module.exports = { attachLiveProxy };
