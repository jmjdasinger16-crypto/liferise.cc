const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const fmt = (value) => value ? new Date(value).toLocaleString() : '—';

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) { window.location.href = 'index.html'; throw new Error('Session expired.'); }
  if (!response.ok) throw new Error(data.error || `Request failed with status ${response.status}.`);
  return data;
}

const statusLabels = { trial: 'Trial', active: 'Active', past_due: 'Past due', canceled: 'Canceled' };

function renderGoals(goals) {
  const list = $('[data-goals-list]');
  if (!goals.length) { list.innerHTML = '<p class="empty-state">No goals have been set yet. Request a call with your coach to get started.</p>'; return; }
  list.innerHTML = goals.map((goal) => `
    <div class="goal-card ${goal.status === 'completed' ? 'completed' : ''}">
      <h3>${esc(goal.title)}</h3>
      ${goal.description ? `<p>${esc(goal.description)}</p>` : ''}
      <div class="goal-meta">${goal.status === 'completed' ? 'Completed' : 'Active'}${goal.target_date ? ` · Target: ${esc(goal.target_date)}` : ''}</div>
    </div>
  `).join('');
}

function renderNotes(notes) {
  const list = $('[data-notes-list]');
  if (!notes.length) { list.innerHTML = '<p class="empty-state">No notes shared yet.</p>'; return; }
  list.innerHTML = notes.map((note) => `
    <div class="note-card">
      <p>${esc(note.content)}</p>
      <div class="note-meta">${fmt(note.created_at)}</div>
    </div>
  `).join('');
}

function renderCallRequests(requests) {
  const list = $('[data-call-requests-list]');
  if (!requests.length) { list.innerHTML = '<p class="empty-state">You haven\'t requested a call yet.</p>'; return; }
  list.innerHTML = requests.map((request) => `
    <div class="request-row">
      <span>${esc(request.preferred_time || 'Any time')} · ${fmt(request.created_at)}</span>
      <span class="rq-status ${esc(request.status)}">${esc(request.status)}</span>
    </div>
  `).join('');
}

function appendChatMessage(role, content, pending = false) {
  const log = $('[data-chat-log]');
  const div = document.createElement('div');
  div.className = `chat-msg ${role}${pending ? ' pending' : ''}`;
  div.textContent = content;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

async function loadDashboard() {
  const { client } = await api('/api/portal/me');
  $('[data-client-name-suffix]').textContent = client.name ? `, ${client.name}` : '';
  const pill = $('[data-status-pill]');
  pill.hidden = false;
  pill.className = `status-pill ${client.status}`;
  pill.textContent = statusLabels[client.status] || client.status;

  const [goalsRes, notesRes, callsRes, historyRes] = await Promise.all([
    api('/api/portal/goals'),
    api('/api/portal/notes'),
    api('/api/portal/call-requests'),
    api('/api/portal/chat/history')
  ]);

  renderGoals(goalsRes.goals || []);
  renderNotes(notesRes.notes || []);
  renderCallRequests(callsRes.call_requests || []);

  const log = $('[data-chat-log]');
  const history = historyRes.messages || [];
  if (!history.length) {
    appendChatMessage('assistant', "Hi! I'm here to help you work toward the goals your coach set for you. What would you like to focus on today?");
  } else {
    log.innerHTML = '';
    history.forEach((msg) => appendChatMessage(msg.role, msg.content));
  }
}

$('[data-logout]').addEventListener('click', async () => {
  try { await api('/api/portal/logout', { method: 'POST', body: '{}' }); } finally { window.location.href = 'index.html'; }
});

$('[data-call-form]').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const message = $('[data-call-message]');
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  message.hidden = false; message.className = 'form-message'; message.textContent = 'Sending your request…';
  try {
    const { call_request } = await api('/api/portal/call-requests', { method: 'POST', body: JSON.stringify({ preferred_time: form.preferred_time.value, reason: form.reason.value }) });
    message.textContent = 'Your call request has been sent to your coach.';
    form.reset();
    const listRes = await api('/api/portal/call-requests');
    renderCallRequests(listRes.call_requests || []);
  } catch (error) {
    message.className = 'form-message error';
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$('[data-chat-form]').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const input = $('[data-chat-input]');
  const text = input.value.trim();
  if (!text) return;
  const button = form.querySelector('button[type=submit]');

  appendChatMessage('user', text);
  input.value = '';
  button.disabled = true;
  const pendingMsg = appendChatMessage('assistant', 'Thinking…', true);

  try {
    const { reply } = await api('/api/portal/chat', { method: 'POST', body: JSON.stringify({ message: text }) });
    pendingMsg.textContent = reply;
    pendingMsg.classList.remove('pending');
  } catch (error) {
    pendingMsg.textContent = error.message || "I'm having trouble responding right now.";
    pendingMsg.classList.remove('pending');
  } finally {
    button.disabled = false;
    input.focus();
  }
});

loadDashboard().catch((error) => {
  if (error.message !== 'Session expired.') {
    $('[data-goals-list]').innerHTML = `<p class="empty-state">${esc(error.message)}</p>`;
  }
});
