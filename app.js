// Haky Chat — app logic. Every function name here matches an onclick= in
// index.html on purpose, so the markup barely had to change — only what
// happens INSIDE each function changed, from localStorage reads/writes to
// real network calls.

let currentUser = null;      // { id, username, role }
let currentChatId = null;    // uuid of the open chat
let chatsById = new Map();   // uuid -> chat object from the last /chats fetch
let ws = null;
const unlockedThisSession = new Set(); // chat ids the user already entered the passcode for

// ---------- Auth ----------

async function registerNewAccount() {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value.trim();
  const statusText = document.getElementById('auth-status');

  if (!username || !password) {
    statusText.style.color = '#dc3545';
    statusText.textContent = 'الرجاء إدخال اسم المستخدم وكلمة المرور.';
    return;
  }

  try {
    const data = await HakyAPI.register(username, password);
    statusText.style.color = '#2b7ade';
    statusText.textContent = data.message;
  } catch (err) {
    statusText.style.color = '#dc3545';
    statusText.textContent = err.message;
  }
}

async function loginUser() {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value.trim();
  const statusText = document.getElementById('auth-status');

  if (!username || !password) {
    statusText.style.color = '#dc3545';
    statusText.textContent = 'الرجاء إدخال اسم المستخدم وكلمة المرور.';
    return;
  }

  try {
    const data = await HakyAPI.login(username, password);
    HakyAPI.setToken(data.token);
    currentUser = data.user;

    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('app-container').style.display = 'flex';
    document.getElementById('logged-user-label').textContent = currentUser.username;
    document.getElementById('admin-dashboard-btn').style.display =
      currentUser.role === 'admin' ? 'inline-block' : 'none';

    connectWebSocket();
    await loadChats();
  } catch (err) {
    statusText.style.color = '#dc3545';
    statusText.textContent = err.message;
  }
}

function logout() {
  HakyAPI.setToken(null);
  if (ws) ws.close();
  location.reload();
}

// Try to resume a session on page load if a token is already stored.
async function tryResumeSession() {
  if (!HakyAPI.getToken()) return;
  try {
    // No /auth/me endpoint yet (see backend README "Next steps") — for now
    // we just trust the stored token and let the first API call fail loudly
    // if it's expired, which loginUser()'s catch-all patterns don't cover
    // here, so we do a lightweight probe instead.
    const chats = await HakyAPI.listChats();
    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('app-container').style.display = 'flex';
    connectWebSocket();
    renderChatList(chats.chats);
  } catch {
    HakyAPI.setToken(null); // stale/invalid token
  }
}

// ---------- WebSocket (real-time delivery) ----------

function connectWebSocket() {
  const token = HakyAPI.getToken();
  ws = new WebSocket(`${window.HAKY_CONFIG.WS_BASE_URL}/ws?token=${encodeURIComponent(token)}`);

  ws.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    if (payload.event === 'message:new') {
      // Refresh the sidebar preview regardless of which chat is open.
      loadChats();
      if (payload.message.chat_id === currentChatId) {
        renderIncomingMessage(payload.message);
      }
    }
  };

  ws.onclose = () => {
    // Simple reconnect with backoff — real-time delivery is the riskiest
    // part of this system, so don't leave the client silently disconnected.
    setTimeout(() => {
      if (currentUser) connectWebSocket();
    }, 3000);
  };
}

// ---------- Admin approval ----------

function openAdminModal() {
  renderAdminRequests();
  document.getElementById('admin-modal').style.display = 'flex';
}
function closeAdminModal() {
  document.getElementById('admin-modal').style.display = 'none';
}

async function renderAdminRequests() {
  const listDiv = document.getElementById('requests-list');
  const { pending } = await HakyAPI.getPendingUsers();

  if (pending.length === 0) {
    listDiv.innerHTML = `<p style="color:#666;font-size:13px;">لا توجد طلبات معلقة.</p>`;
    return;
  }
  listDiv.innerHTML = pending.map((u) => `
    <div class="user-request-card">
      <span><b>${escapeHtml(u.username)}</b></span>
      <div>
        <button class="btn-approve" onclick="approveUser('${u.id}')">قبول</button>
        <button class="btn-reject" onclick="rejectUser('${u.id}')">رفض</button>
      </div>
    </div>`).join('');
}

async function approveUser(id) {
  const data = await HakyAPI.approveUser(id);
  await renderAdminRequests();
  alert(data.message);
}

async function rejectUser(id) {
  await HakyAPI.rejectUser(id);
  await renderAdminRequests();
  alert('تم رفض وحذف الطلب.');
}

// ---------- Chat list ----------

async function loadChats() {
  const { chats } = await HakyAPI.listChats();
  renderChatList(chats);
}

function renderChatList(chats) {
  chatsById = new Map(chats.map((c) => [c.id, c]));
  const listEl = document.getElementById('chat-list');
  listEl.innerHTML = chats.map((c) => `
    <div class="chat-item" onclick="switchChat('${c.id}')">
      <span>${escapeHtml(chatTitle(c))} ${c.locked ? '🔒' : ''}</span>
    </div>`).join('');
}

function chatTitle(chat) {
  return chat.is_group ? `${chat.name} (مجموعة)` : chat.name || 'محادثة';
}

// ---------- Switching / opening a chat ----------

async function switchChat(chatId) {
  currentChatId = chatId;
  const chat = chatsById.get(chatId);
  document.getElementById('current-chat-title').textContent = chat ? chatTitle(chat) : '';

  const lockScreen = document.getElementById('lock-screen');
  if (chat?.locked && !unlockedThisSession.has(chatId)) {
    lockScreen.style.display = 'flex';
    document.getElementById('chat-lock-pass').value = '';
    toggleMenu();
    return; // don't load messages until unlocked
  }
  lockScreen.style.display = 'none';

  const { messages } = await HakyAPI.getMessages(chatId);
  const container = document.getElementById('messages');
  container.innerHTML = messages.map(renderMessageHtml).join('');
  container.scrollTop = container.scrollHeight;

  ws?.send(JSON.stringify({ type: 'subscribe', chatId }));
  toggleMenu();
}

function renderMessageHtml(m) {
  const mine = m.sender_id === currentUser.id;
  const cls = mine ? 'outgoing' : 'incoming';
  let content;
  if (m.type === 'text') content = escapeHtml(m.body);
  else if (m.type === 'image') content = `<img src="${m.media_url}" style="max-width:180px;border-radius:5px;"><br>`;
  else if (m.type === 'video') content = `<video src="${m.media_url}" controls style="max-width:180px;"></video><br>`;
  else if (m.type === 'voice') content = `🎤 رسالة صوتية<br>`;
  else content = `📄 مستند مرفق: <b>${escapeHtml(m.body || '')}</b><br>`;

  return `<div class="message ${cls}" data-id="${m.id}">
    ${content}
    <span class="delete-options" onclick="deleteMessage(this)">حذف</span>
  </div>`;
}

function renderIncomingMessage(m) {
  const container = document.getElementById('messages');
  container.insertAdjacentHTML('beforeend', renderMessageHtml(m));
  container.scrollTop = container.scrollHeight;
}

// ---------- Sending ----------

function handleSendButton() {
  const input = document.getElementById('message-input');
  if (input.value.trim() !== '') sendMessage();
  else sendVoiceNote();
}

async function sendMessage() {
  const input = document.getElementById('message-input');
  const text = input.value.trim();
  if (!text || !currentChatId) return;

  input.value = '';
  await HakyAPI.sendMessage(currentChatId, { type: 'text', body: text });
  // No optimistic render needed — our own broadcast comes back over the
  // WebSocket like everyone else's, keeping a single source of truth for
  // message ordering instead of two (local echo + server copy).
}

function checkEnter(e) {
  if (e.key === 'Enter') sendMessage();
}

async function sendFile(input, type) {
  const file = input.files?.[0];
  if (!file || !currentChatId) return;

  try {
    const { uploadUrl, fileUrl } = await HakyAPI.presignUpload(file.name, file.type);
    await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });

    const msgType = type === 'media'
      ? (file.type.startsWith('video/') ? 'video' : 'image')
      : 'document';

    await HakyAPI.sendMessage(currentChatId, { type: msgType, body: file.name, mediaUrl: fileUrl });
  } catch (err) {
    alert(err.message);
  } finally {
    input.value = '';
  }
}

async function sendVoiceNote() {
  // Recording + upload wiring is the same presign flow as sendFile() once
  // you have a Blob from the MediaRecorder API — left as a follow-up since
  // it needs a native permissions prompt that behaves differently inside
  // a TWA-wrapped app vs. a plain browser tab.
  alert('تسجيل الرسائل الصوتية غير مفعّل بعد في هذه النسخة.');
}

function deleteMessage(element) {
  // Visual-only for now — there's no DELETE /messages/:id endpoint yet
  // (see backend README "Next steps"), so this doesn't delete server-side.
  element.parentElement.remove();
}

function clearChat() {
  // Same limitation as deleteMessage(): clears the local view only, the
  // messages still exist server-side. A real "clear chat" needs a backend
  // endpoint that either soft-deletes for this user only (matching the
  // per-user pattern used for archive/hide/lock) or for everyone — worth
  // deciding deliberately rather than defaulting to one.
  document.getElementById('messages').innerHTML = '';
  toggleMenu();
}

// ---------- Archive / hide / lock (per-user, via backend) ----------

async function archiveChat() {
  if (!currentChatId) return;
  await HakyAPI.archiveChat(currentChatId, true);
  await loadChats();
  toggleMenu();
}

async function openArchiveModal() {
  const { chats } = await HakyAPI.listChats('archived');
  const listDiv = document.getElementById('archive-list');
  listDiv.innerHTML = chats.length === 0
    ? `<p style="color:#666;font-size:13px;">لا توجد محادثات مؤرشفة.</p>`
    : chats.map((c) => `
        <div class="user-request-card">
          <span><b>${escapeHtml(chatTitle(c))}</b></span>
          <button class="btn-approve" onclick="unarchiveChat('${c.id}')">استعادة</button>
        </div>`).join('');
  document.getElementById('archive-modal').style.display = 'flex';
}
function closeArchiveModal() {
  document.getElementById('archive-modal').style.display = 'none';
}
async function unarchiveChat(chatId) {
  await HakyAPI.archiveChat(chatId, false);
  closeArchiveModal();
  await loadChats();
  switchChat(chatId);
}

async function lockChatModal() {
  if (!currentChatId) return;
  const pass = prompt('أدخل رمز المرور لقفل هذه المحادثة:');
  if (pass) {
    await HakyAPI.lockChat(currentChatId, pass);
    unlockedThisSession.delete(currentChatId);
    await loadChats();
    alert('تم قفل المحادثة بنجاح.');
  }
  toggleMenu();
}

async function unlockChat() {
  const inputPass = document.getElementById('chat-lock-pass').value;
  try {
    await HakyAPI.unlockChat(currentChatId, inputPass);
    unlockedThisSession.add(currentChatId);
    document.getElementById('lock-screen').style.display = 'none';
    switchChat(currentChatId); // now loads messages since it's unlocked
  } catch (err) {
    alert(err.message);
  }
}

async function hideChat() {
  if (!currentChatId) return;
  await HakyAPI.hideChat(currentChatId, true);
  document.getElementById('main-chat-area').style.display = 'none';
  document.getElementById('hidden-chats-bar').style.display = 'flex';
  await loadChats();
  alert("تم إخفاء المحادثة. يمكنك إظهارها بالنقر على خيار 'إظهار المحادثة المخفية'.");
  toggleMenu();
}

async function unhideCurrentChat() {
  const { chats } = await HakyAPI.listChats('hidden');
  for (const c of chats) {
    await HakyAPI.hideChat(c.id, false);
  }
  document.getElementById('main-chat-area').style.display = 'flex';
  document.getElementById('hidden-chats-bar').style.display = 'none';
  await loadChats();
  alert('تم إظهار المحادثة بنجاح.');
}

// ---------- Groups ----------

function openGroupModal() {
  document.getElementById('group-modal').style.display = 'flex';
  toggleMenu();
}
function closeGroupModal() {
  document.getElementById('group-modal').style.display = 'none';
}

async function createGroup() {
  const nameInput = document.getElementById('group-name');
  const name = nameInput.value.trim();
  if (!name) {
    alert('الرجاء إدخال اسم المجموعة.');
    return;
  }
  // NOTE: creating a group with just a name and no other members matches
  // the prototype's UI (it never asked who to add). A real member picker
  // is a small follow-up — createChat() already accepts memberUsernames[].
  try {
    const { chat } = await HakyAPI.createChat({ isGroup: true, name, memberUsernames: [] });
    nameInput.value = '';
    closeGroupModal();
    await loadChats();
    switchChat(chat.id);
  } catch (err) {
    alert(err.message);
  }
}

// ---------- Misc UI (unchanged from the prototype — no backend involved) ----------

function toggleMenu() {
  const menu = document.getElementById('dropdown-menu');
  menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
}
window.onclick = (event) => {
  if (!event.target.matches('.menu-btn')) {
    const menu = document.getElementById('dropdown-menu');
    if (menu && menu.style.display === 'block') menu.style.display = 'none';
  }
};

function toggleEmojiPicker() {
  const picker = document.getElementById('emoji-picker');
  picker.style.display = picker.style.display === 'block' ? 'none' : 'block';
}
function addEmoji(emoji) {
  const input = document.getElementById('message-input');
  input.value += emoji;
  document.getElementById('emoji-picker').style.display = 'none';
  input.focus();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

// ---------- Boot ----------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./service-worker.js'));
}
tryResumeSession();
