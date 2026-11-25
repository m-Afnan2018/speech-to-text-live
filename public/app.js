/* Speech to Text – frontend */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2500);
}

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

/* ---------- Tabs ---------- */
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${b.dataset.view}`));
  if (b.dataset.view === 'history') loadHistory();
}));

api('/health').then((h) => {
  const el = $('#health');
  el.textContent = h.gemini ? 'online' : 'no API key';
  el.className = `pill ${h.gemini ? 'ok' : 'bad'}`;
}).catch(() => { $('#health').textContent = 'offline'; $('#health').className = 'pill bad'; });

/* ---------- Live transcription ---------- */
const state = { recording: false, finals: [], interim: '', ws: null, ctx: null, stream: null, node: null, startedAt: 0, elapsed: 0, timer: null };

function render() {
  const el = $('#transcript');
  const finalText = state.finals.join(' ').replace(/\s+/g, ' ').trim();
  if (!finalText && !state.interim) {
    el.innerHTML = '<span class="placeholder">Your words will appear here in real time…</span>';
  } else {
    el.innerHTML = `${esc(finalText)}${state.interim ? ` <span class="interim">${esc(state.interim)}</span>` : ''}`;
  }
  el.scrollTop = el.scrollHeight;
  const has = Boolean(finalText);
  $('#save').disabled = !has || state.recording;
  $('#clear').disabled = !has || state.recording;
  $('#speak').disabled = !has;
}

function currentText() {
  const el = $('#transcript');
  return el.isContentEditable ? el.innerText.trim() : state.finals.join(' ').replace(/\s+/g, ' ').trim();
}

function tick() {
  const ms = state.elapsed + (state.recording ? Date.now() - state.startedAt : 0);
  const s = Math.floor(ms / 1000);
  $('#timer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

async function start() {
  if (!navigator.mediaDevices?.getUserMedia) return toast('Microphone not supported in this browser');
  $('#transcript').contentEditable = 'false';
  $('#status').textContent = 'Requesting microphone…';
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch {
    $('#status').textContent = 'Microphone permission denied';
    return;
  }
  state.ctx = new AudioContext();
  await state.ctx.audioWorklet.addModule('pcm-worklet.js');
  const src = state.ctx.createMediaStreamSource(state.stream);
  state.node = new AudioWorkletNode(state.ctx, 'pcm-encoder');
  src.connect(state.node);

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/transcribe?lang=${$('#lang').value}`);
  ws.binaryType = 'arraybuffer';
  state.ws = ws;

  state.node.port.onmessage = ({ data }) => {
    if (data.pcm && ws.readyState === WebSocket.OPEN) ws.send(data.pcm);
    if (data.level !== undefined) $('#ring').style.transform = `scale(${1 + Math.min(data.level * 2.5, 0.4)})`;
  };

  ws.onopen = () => { $('#status').textContent = 'Connecting to transcription engine…'; };
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    switch (msg.type) {
      case 'ready': $('#status').textContent = 'Listening… speak in any language'; break;
      case 'interim': state.interim = msg.text; render(); break;
      case 'final': if (msg.text.trim()) state.finals.push(msg.text.trim()); state.interim = ''; render(); break;
      case 'warning': toast(msg.message); break;
      case 'error': toast(msg.message); $('#status').textContent = msg.message; break;
    }
  };
  ws.onclose = () => { if (state.recording) stop(true); };

  state.recording = true;
  state.startedAt = Date.now();
  state.timer = setInterval(tick, 250);
  $('#mic').classList.add('recording');
  $('#lang').disabled = true;
  render();
}

function stop(remoteClosed = false) {
  if (!state.recording) return;
  state.recording = false;
  state.elapsed += Date.now() - state.startedAt;
  clearInterval(state.timer); tick();
  state.stream?.getTracks().forEach((t) => t.stop());
  state.node?.disconnect();
  state.ctx?.close();
  if (!remoteClosed && state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'stop' })); // server flushes the final segment, then closes
  }
  $('#mic').classList.remove('recording');
  $('#ring').style.transform = '';
  $('#lang').disabled = false;
  $('#status').textContent = 'Stopped. Edit the text if needed, then save.';
  setTimeout(() => { if (state.interim) { state.finals.push(state.interim); state.interim = ''; } render(); enableEdit(); }, 2600);
  render();
}

function enableEdit() {
  if (state.recording || !state.finals.length) return;
  const el = $('#transcript');
  el.contentEditable = 'true';
  el.textContent = state.finals.join(' ').replace(/\s+/g, ' ').trim();
}

$('#mic').addEventListener('click', () => (state.recording ? stop() : start()));

$('#clear').addEventListener('click', () => {
  Object.assign(state, { finals: [], interim: '', elapsed: 0 });
  $('#transcript').contentEditable = 'false';
  $('#title').value = ''; tick(); render();
  $('#status').textContent = 'Tap the mic and start speaking';
});

$('#save').addEventListener('click', async () => {
  const content = currentText();
  if (!content) return;
  try {
    await api('/transcriptions', {
      method: 'POST',
      body: JSON.stringify({ title: $('#title').value || content.slice(0, 60), content, language: $('#lang').value, duration_ms: state.elapsed }),
    });
    toast('Saved to history');
    $('#clear').click();
  } catch (e) { toast(`Save failed: ${e.message}`); }
});

/* ---------- Text to Speech (browser-native, on-device) ---------- */
function speak(text, lang) {
  if (!('speechSynthesis' in window)) return toast('Text-to-speech not supported');
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  // Devanagari present → prefer a Hindi voice, otherwise Indian English.
  u.lang = /[ऀ-ॿ]/.test(text) || lang === 'hi' ? 'hi-IN' : 'en-IN';
  const voice = speechSynthesis.getVoices().find((v) => v.lang.replace('_', '-') === u.lang);
  if (voice) u.voice = voice;
  speechSynthesis.speak(u);
}
$('#speak').addEventListener('click', () => speak(currentText(), $('#lang').value));

/* ---------- History dashboard (CRUD) ---------- */
const hist = { offset: 0, limit: 10, q: '', items: [] };

async function loadHistory() {
  try {
    const qs = new URLSearchParams({ limit: hist.limit, offset: hist.offset, q: hist.q });
    const { total, items } = await api(`/transcriptions?${qs}`);
    hist.items = items;
    $('#count').textContent = `(${total})`;
    const page = Math.floor(hist.offset / hist.limit) + 1;
    const pages = Math.max(1, Math.ceil(total / hist.limit));
    $('#page').textContent = `Page ${page} of ${pages}`;
    $('#prev').disabled = hist.offset === 0;
    $('#next').disabled = hist.offset + hist.limit >= total;
    $('#list').innerHTML = items.length ? items.map((t) => `
      <article class="item" data-id="${t.id}">
        <div class="item-head">
          <h4>${esc(t.title)}</h4>
          <span class="meta">${new Date(t.created_at).toLocaleString()} · ${esc(t.language)}${t.duration_ms ? ` · ${Math.round(t.duration_ms / 1000)}s` : ''}${t.updated_at !== t.created_at ? ' · edited' : ''}</span>
        </div>
        <p>${esc(t.content)}</p>
        <div class="item-actions">
          <button class="btn ghost sm" data-act="speak">🔊 Play</button>
          <button class="btn ghost sm" data-act="copy">Copy</button>
          <button class="btn ghost sm" data-act="edit">Edit</button>
          <button class="btn danger sm" data-act="delete">Delete</button>
        </div>
      </article>`).join('') : '<div class="empty">No transcriptions yet. Record one from the Live tab.</div>';
  } catch (e) { toast(`Could not load history: ${e.message}`); }
}

$('#list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.closest('.item').dataset.id);
  const item = hist.items.find((x) => x.id === id);
  switch (btn.dataset.act) {
    case 'speak': speak(item.content, item.language); break;
    case 'copy': await navigator.clipboard.writeText(item.content); toast('Copied'); break;
    case 'edit': openEditor(item); break;
    case 'delete':
      if (!confirm('Delete this transcription?')) return;
      try { await api(`/transcriptions/${id}`, { method: 'DELETE' }); toast('Deleted'); loadHistory(); }
      catch (err) { toast(err.message); }
  }
});

let searchT;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchT);
  searchT = setTimeout(() => { hist.q = e.target.value; hist.offset = 0; loadHistory(); }, 300);
});
$('#prev').addEventListener('click', () => { hist.offset = Math.max(0, hist.offset - hist.limit); loadHistory(); });
$('#next').addEventListener('click', () => { hist.offset += hist.limit; loadHistory(); });

let editingId = null;
function openEditor(item) {
  editingId = item ? item.id : null;
  $('#editHeading').textContent = item ? 'Edit transcription' : 'New transcription';
  const f = $('#editForm');
  f.title.value = item?.title || '';
  f.language.value = item?.language || 'auto';
  f.content.value = item?.content || '';
  $('#editor').showModal();
}
$('#new').addEventListener('click', () => openEditor(null));

$('#editor').addEventListener('close', async () => {
  if ($('#editor').returnValue !== 'save') return;
  const f = $('#editForm');
  const body = JSON.stringify({ title: f.title.value, language: f.language.value, content: f.content.value });
  try {
    if (editingId) await api(`/transcriptions/${editingId}`, { method: 'PUT', body });
    else await api('/transcriptions', { method: 'POST', body });
    toast(editingId ? 'Updated' : 'Created');
    loadHistory();
  } catch (e) { toast(e.message); }
});

render();
