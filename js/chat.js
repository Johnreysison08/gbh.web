// ═══════════════════════════════════════════════
// chat.js — Real-Time 1-on-1 Chat with Firebase
// Uses: Firestore (messages + typing) + RTDB (presence)
// Collection: chats/{chatId}/messages/{msgId}
// ═══════════════════════════════════════════════

'use strict';

// ── State ─────────────────────────────────────
let _chatId        = null;   // active chat ID
let _partnerUid    = null;   // other user's UID
let _partnerData   = null;   // { name, avatar }
let _unsubMsgs     = null;   // onSnapshot unsubscriber for messages
let _unsubChats    = null;   // onSnapshot unsubscriber for chat list
let _unsubTyping   = null;   // onSnapshot unsubscriber for typing
let _typingTimer   = null;   // debounce timer for "I'm typing"
let _allChats      = [];     // cached sidebar list
let _searchQ       = '';     // sidebar search query
let _presenceRefs  = {};     // uid → RTDB ref (for cleanup)

// ── Firestore / RTDB refs ─────────────────────
function _db()   { return firebase.firestore(); }
function _rtdb() {
  // Realtime Database may not be initialised — guard with try/catch
  try { return firebase.database(); } catch (e) { return null; }
}

// ── Build deterministic chatId from two UIDs ──
function buildChatId(uid1, uid2) {
  return [uid1, uid2].sort().join('_');
}

// ═══════════════════════════════════════════════
// PRESENCE (online / offline / last seen)
// Uses Firebase Realtime Database .info/connected
// ═══════════════════════════════════════════════
function initPresence(uid) {
  const rtdb = _rtdb();
  if (!rtdb) return;                         // RTDB not configured — skip

  const userStatusRef = rtdb.ref('/presence/' + uid);
  const connectedRef  = rtdb.ref('.info/connected');

  connectedRef.on('value', snap => {
    if (!snap.val()) return;
    // When we disconnect, set offline + timestamp
    userStatusRef.onDisconnect().set({
      online: false,
      lastSeen: firebase.database.ServerValue.TIMESTAMP,
    });
    // Mark online now
    userStatusRef.set({
      online: true,
      lastSeen: firebase.database.ServerValue.TIMESTAMP,
    });
  });

  _presenceRefs[uid] = userStatusRef;
}

function watchPresence(uid, callback) {
  const rtdb = _rtdb();
  if (!rtdb) { callback({ online: false, lastSeen: null }); return () => {}; }
  const ref = rtdb.ref('/presence/' + uid);
  const handler = snap => callback(snap.val() || { online: false, lastSeen: null });
  ref.on('value', handler);
  return () => ref.off('value', handler);  // unsubscriber
}

// ── Also mirror presence in Firestore for rules ──
function setFirestorePresence(uid, online) {
  _db().collection('users').doc(uid)
    .update({ online, lastSeen: firebase.firestore.FieldValue.serverTimestamp() })
    .catch(() => {});
}

// ═══════════════════════════════════════════════
// TYPING INDICATOR
// chats/{chatId}  → typingUsers: { uid: true/false }
// ═══════════════════════════════════════════════
function setTyping(chatId, uid, isTyping) {
  _db().collection('chats').doc(chatId)
    .set({ typingUsers: { [uid]: isTyping } }, { merge: true })
    .catch(() => {});
}

function onTypingInput() {
  if (!_chatId || !state.currentUser) return;
  const uid = state.currentUser.uid;
  setTyping(_chatId, uid, true);
  clearTimeout(_typingTimer);
  _typingTimer = setTimeout(() => setTyping(_chatId, uid, false), 2500);
}

function watchTyping(chatId, myUid, callback) {
  return _db().collection('chats').doc(chatId)
    .onSnapshot(snap => {
      const typingUsers = (snap.data() || {}).typingUsers || {};
      // Filter out myself
      const othersTyping = Object.entries(typingUsers)
        .filter(([uid, v]) => uid !== myUid && v === true)
        .map(([uid]) => uid);
      callback(othersTyping);
    }, () => {});
}

// ═══════════════════════════════════════════════
// CHAT LIST (sidebar)
// chats collection filtered by participants array
// ═══════════════════════════════════════════════
function startChatsListener() {
  if (_unsubChats) _unsubChats();
  const uid = state.currentUser.uid;

  _unsubChats = _db().collection('chats')
    .where('participants', 'array-contains', uid)
    .orderBy('updatedAt', 'desc')
    .onSnapshot(snap => {
      _allChats = snap.docs.map(doc => {
        const d = doc.data();
        const partnerId = (d.participants || []).find(id => id !== uid);
        return {
          chatId:      doc.id,
          partnerId,
          partnerName: (d.participantNames || {})[partnerId] || 'Unknown',
          partnerAvatar: (d.participantAvatars || {})[partnerId] || null,
          lastMessage: d.lastMessage || '',
          updatedAt:   d.updatedAt ? d.updatedAt.toDate().toISOString() : null,
          unread:      (d.unread || {})[uid] || 0,
        };
      });
      renderSidebar();
      updateTotalUnread();
    }, err => {
      console.error('[chat] startChatsListener error:', err);
      const el = document.getElementById('chatList');
      if (el) el.innerHTML = `
        <div class="chat-empty-sidebar">
          <div style="font-size:2rem;margin-bottom:8px">⚠️</div>
          <p>Could not load conversations.<br><small style="opacity:0.6">${err.message}</small></p>
        </div>`;
    });
}

function renderSidebar() {
  const q = _searchQ.toLowerCase();
  const list = q
    ? _allChats.filter(c => c.partnerName.toLowerCase().includes(q))
    : _allChats;

  const el = document.getElementById('chatList');
  if (!el) return;

  if (!list.length) {
    el.innerHTML = `
      <div class="chat-empty-sidebar">
        <div style="font-size:2rem;margin-bottom:8px">💬</div>
        <p>No conversations yet.<br>Visit a trade post and click "Message" to start chatting.</p>
      </div>`;
    return;
  }

  el.innerHTML = list.map(c => {
    const isActive = _chatId === c.chatId;
    const initials = (c.partnerName || '?')[0].toUpperCase();
    const preview  = escHtml(c.lastMessage || 'Start a conversation');
    const timeStr  = c.updatedAt ? formatRelativeTime(c.updatedAt) : '';
    return `
      <div class="chat-contact ${isActive ? 'active' : ''} ${c.unread > 0 ? 'has-unread' : ''}"
           onclick="openChat('${c.chatId}', '${escHtml(c.partnerId)}')">
        <div class="contact-avatar" id="avatar-${escHtml(c.partnerId)}">
          ${c.partnerAvatar
            ? `<img src="${escHtml(c.partnerAvatar)}" alt="">`
            : `<span>${initials}</span>`}
          <span class="presence-dot" id="dot-${escHtml(c.partnerId)}"></span>
        </div>
        <div class="contact-info">
          <div class="contact-name">${escHtml(c.partnerName)}</div>
          <div class="contact-preview">${preview}</div>
        </div>
        <div class="contact-meta">
          <span class="contact-time">${timeStr}</span>
          ${c.unread > 0
            ? `<span class="unread-badge">${c.unread > 99 ? '99+' : c.unread}</span>`
            : ''}
        </div>
      </div>`;
  }).join('');

  // Attach live presence dots for each contact
  list.forEach(c => attachPresenceDot(c.partnerId));
}

// Debounced search
let _sidebarSearchTimer = null;
function filterChats(q) {
  clearTimeout(_sidebarSearchTimer);
  _sidebarSearchTimer = setTimeout(() => { _searchQ = q; renderSidebar(); }, 150);
}

function updateTotalUnread() {
  const total = _allChats.reduce((s, c) => s + (c.unread || 0), 0);
  const badge = document.getElementById('totalUnreadBadge');
  if (!badge) return;
  if (total > 0) { badge.textContent = total > 99 ? '99+' : total; badge.style.display = 'inline-flex'; }
  else           { badge.style.display = 'none'; }
}

// Attach a live presence dot to sidebar avatar
let _presenceUnsubMap = {};
function attachPresenceDot(uid) {
  if (_presenceUnsubMap[uid]) return;   // already watching
  _presenceUnsubMap[uid] = watchPresence(uid, status => {
    const dot = document.getElementById('dot-' + uid);
    if (!dot) return;
    dot.className = 'presence-dot ' + (status && status.online ? 'online' : 'offline');
  });
}

// ═══════════════════════════════════════════════
// OPEN CHAT
// ═══════════════════════════════════════════════
async function openChat(chatId, partnerUid) {
  // Cleanup previous listeners
  if (_unsubMsgs)   { _unsubMsgs();   _unsubMsgs = null; }
  if (_unsubTyping) { _unsubTyping(); _unsubTyping = null; }

  _chatId     = chatId;
  _partnerUid = partnerUid;

  // Get partner info from cached chat list or Firestore
  const cached = _allChats.find(c => c.chatId === chatId);
  _partnerData = cached
    ? { name: cached.partnerName, avatar: cached.partnerAvatar }
    : await fetchUserBasic(partnerUid);

  renderSidebar();   // highlight active
  renderChatShell();
  startMessagesListener(chatId);

  // Typing indicator
  _unsubTyping = watchTyping(chatId, state.currentUser.uid, typing => {
    const el = document.getElementById('typingIndicator');
    if (!el) return;
    el.style.display = typing.length > 0 ? 'flex' : 'none';
  });

  // Mark read
  markRead(chatId);

  // Mobile: show chat panel
  if (window.innerWidth <= 768) {
    document.getElementById('chatSidebar').classList.add('mobile-hidden');
    document.getElementById('chatMain').classList.add('mobile-open');
  }
}

async function fetchUserBasic(uid) {
  try {
    const snap = await _db().collection('users').doc(uid).get();
    if (snap.exists) return { name: snap.data().name || 'Unknown', avatar: snap.data().avatar || null };
  } catch (_) {}
  return { name: 'Unknown', avatar: null };
}

// ── Render the right-side chat shell ──────────
function renderChatShell() {
  const p       = _partnerData;
  const initials = (p.name || '?')[0].toUpperCase();
  const avatarHtml = p.avatar
    ? `<img src="${escHtml(p.avatar)}" alt="">`
    : `<span>${initials}</span>`;

  document.getElementById('chatMain').innerHTML = `
    <div class="chat-header" id="chatHeader">
      <button class="back-btn" onclick="closeMobileChat()">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="15 18 9 12 15 6"/>
        </svg>
      </button>
      <div class="header-avatar" id="headerAvatar">
        ${avatarHtml}
        <span class="presence-dot" id="headerDot"></span>
      </div>
      <div class="header-info">
        <div class="header-name">${escHtml(p.name)}</div>
        <div class="header-status" id="headerStatus">Loading...</div>
      </div>
    </div>

    <div class="messages-area" id="messagesArea">
      <div class="loading-msgs">
        <div class="spinner"></div>
        <span>Loading messages…</span>
      </div>
    </div>

    <div class="typing-indicator" id="typingIndicator" style="display:none">
      <div class="typing-dots">
        <span></span><span></span><span></span>
      </div>
      <span>${escHtml(p.name)} is typing…</span>
    </div>

    <div class="input-area">
      <div class="emoji-wrap">
        <button class="emoji-toggle-btn" onclick="toggleEmojiPicker(event)" title="Emoji">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <path d="M8 13s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/>
            <line x1="15" y1="9" x2="15.01" y2="9"/>
          </svg>
        </button>
        <div class="emoji-picker" id="emojiPicker">
          ${['😀','😂','🥰','😎','🤔','🙄','😭','😡','🤣','❤️','👍','👎','🔥','💯','🎮','⚔️','🏆','💎','🚀','✨','🎉','💀','😤','🤯','👀','🫡','😴','🥳'].map(e =>
            `<span onclick="insertEmoji('${e}')">${e}</span>`).join('')}
        </div>
      </div>
      <textarea
        class="msg-input"
        id="msgInput"
        placeholder="Type a message…"
        rows="1"
        oninput="autoResize(this); onTypingInput()"
        onkeydown="handleKey(event)"
      ></textarea>
      <button class="send-btn" onclick="sendMessage()" title="Send">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="22" y1="2" x2="11" y2="13"/>
          <polygon points="22 2 15 22 11 13 2 9 22 2"/>
        </svg>
      </button>
    </div>
  `;

  // Live presence in header
  watchPresence(_partnerUid, status => {
    const dot = document.getElementById('headerDot');
    const txt = document.getElementById('headerStatus');
    if (!dot || !txt) return;
    if (status && status.online) {
      dot.className = 'presence-dot online';
      txt.innerHTML = '<span class="online-label">● Online</span>';
    } else {
      dot.className = 'presence-dot offline';
      const ts = status && status.lastSeen
        ? 'Last seen ' + formatRelativeTime(new Date(status.lastSeen).toISOString())
        : 'Offline';
      txt.textContent = ts;
    }
  });

  // Focus input
  setTimeout(() => document.getElementById('msgInput')?.focus(), 100);
}

// ═══════════════════════════════════════════════
// MESSAGES LISTENER
// chats/{chatId}/messages — ordered by createdAt asc
// ═══════════════════════════════════════════════
function startMessagesListener(chatId) {
  const uid = state.currentUser.uid;

  _unsubMsgs = _db()
    .collection('chats').doc(chatId)
    .collection('messages')
    .orderBy('createdAt', 'asc')
    .onSnapshot(snap => {
      const msgs = snap.docs.map(d => ({
        id:       d.id,
        senderId: d.data().senderId,
        text:     d.data().text,
        createdAt: d.data().createdAt
          ? d.data().createdAt.toDate().toISOString()
          : new Date().toISOString(),
        read:     d.data().read || false,
      }));
      renderMessages(msgs, uid);

      // Mark unread messages from partner as read (batch)
      const unread = snap.docs.filter(d =>
        d.data().senderId !== uid && !d.data().read
      );
      if (unread.length) {
        const batch = _db().batch();
        unread.forEach(d => batch.update(d.ref, { read: true }));
        batch.commit().catch(() => {});
        markRead(chatId);
      }
    }, () => {});
}

// ── Render messages into the area ─────────────
function renderMessages(msgs, myUid) {
  const area = document.getElementById('messagesArea');
  if (!area) return;

  const wasAtBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 100;

  if (!msgs.length) {
    area.innerHTML = `
      <div class="empty-chat">
        <div class="empty-chat-icon">👋</div>
        <p>Say hello! This is the start of your conversation with <strong>${escHtml(_partnerData?.name || 'them')}</strong>.</p>
      </div>`;
    return;
  }

  let html = '';
  let lastDateStr = '';

  msgs.forEach((m, i) => {
    const isMine  = m.senderId === myUid;
    const dateStr = new Date(m.createdAt).toLocaleDateString('en-PH', {
      weekday: 'long', month: 'long', day: 'numeric'
    });

    if (dateStr !== lastDateStr) {
      html += `<div class="date-divider"><span>${dateStr}</span></div>`;
      lastDateStr = dateStr;
    }

    const timeStr = new Date(m.createdAt).toLocaleTimeString('en-PH', {
      hour: 'numeric', minute: '2-digit', hour12: true
    });

    // Show read receipt only on last sent message
    const isLastSent = isMine && !msgs.slice(i + 1).some(x => x.senderId === myUid);
    const receipt    = isLastSent
      ? `<div class="read-receipt ${m.read ? 'seen' : ''}">${m.read ? '✓✓ Seen' : '✓ Sent'}</div>`
      : '';

    html += `
      <div class="msg-row ${isMine ? 'mine' : 'theirs'}">
        <div class="msg-bubble-wrap">
          <div class="msg-bubble">${escHtml(m.text)}</div>
          <div class="msg-time">${timeStr}</div>
          ${receipt}
        </div>
      </div>`;
  });

  area.innerHTML = html;

  if (wasAtBottom || msgs.length <= 1) {
    area.scrollTop = area.scrollHeight;
  }
}

// ═══════════════════════════════════════════════
// SEND MESSAGE
// ═══════════════════════════════════════════════
async function sendMessage() {
  const inputEl = document.getElementById('msgInput');
  const text = inputEl?.value.trim();
  if (!text || !_chatId) return;

  inputEl.value = '';
  inputEl.style.height = 'auto';

  const uid      = state.currentUser.uid;
  const now      = firebase.firestore.FieldValue.serverTimestamp();
  const db       = _db();
  const chatRef  = db.collection('chats').doc(_chatId);
  const msgRef   = chatRef.collection('messages').doc();

  // Build participant info from current user
  const myName   = state.currentUser.name   || 'Unknown';
  const myAvatar = state.currentUser.avatar || null;

  // Ensure chat document exists (merge), then add message
  try {
    const batch = db.batch();

    // Upsert chat metadata
    batch.set(chatRef, {
      participants:      firebase.firestore.FieldValue.arrayUnion(uid, _partnerUid),
      participantNames:  { [uid]: myName, [_partnerUid]: _partnerData?.name || 'Unknown' },
      participantAvatars:{ [uid]: myAvatar, [_partnerUid]: _partnerData?.avatar || null },
      lastMessage:       text.length > 60 ? text.slice(0, 57) + '…' : text,
      updatedAt:         now,
      [`unread.${_partnerUid}`]: firebase.firestore.FieldValue.increment(1),
    }, { merge: true });

    // New message doc
    batch.set(msgRef, {
      senderId:  uid,
      text,
      createdAt: now,
      read:      false,
    });

    await batch.commit();

    // Clear typing
    setTyping(_chatId, uid, false);
    clearTimeout(_typingTimer);
  } catch (e) {
    inputEl.value = text;
    showToast('Could not send message. Try again.', 'error');
  }
}

// ── Mark my unread counter to 0 ───────────────
function markRead(chatId) {
  const uid = state.currentUser.uid;
  _db().collection('chats').doc(chatId)
    .update({ [`unread.${uid}`]: 0 })
    .catch(() => {});
  const c = _allChats.find(x => x.chatId === chatId);
  if (c) { c.unread = 0; updateTotalUnread(); }
}

// ═══════════════════════════════════════════════
// OPEN CHAT WITH A SPECIFIC USER
// Called from browse/profile pages via:
//   openChatWith(targetUid)
// ═══════════════════════════════════════════════
async function openChatWith(targetUid) {
  if (!state.currentUser) {
    showToast('Please sign in first.', 'error');
    window.location.href = 'login.html';
    return;
  }
  const chatId = buildChatId(state.currentUser.uid, targetUid);
  // Navigate to messages page and pass chatId via sessionStorage
  sessionStorage.setItem('gbh_openChat', JSON.stringify({ chatId, partnerUid: targetUid }));
  window.location.href = 'messages.html';
}

// ═══════════════════════════════════════════════
// UI HELPERS
// ═══════════════════════════════════════════════
function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 130) + 'px';
}

function toggleEmojiPicker(e) {
  e.stopPropagation();
  document.getElementById('emojiPicker')?.classList.toggle('open');
}
document.addEventListener('click', () =>
  document.getElementById('emojiPicker')?.classList.remove('open')
);

function insertEmoji(emoji) {
  const inp = document.getElementById('msgInput');
  if (!inp) return;
  const pos = inp.selectionStart || inp.value.length;
  inp.value = inp.value.slice(0, pos) + emoji + inp.value.slice(pos);
  inp.focus();
  inp.setSelectionRange(pos + emoji.length, pos + emoji.length);
  document.getElementById('emojiPicker')?.classList.remove('open');
}

function closeMobileChat() {
  if (_unsubMsgs)   { _unsubMsgs();   _unsubMsgs = null; }
  if (_unsubTyping) { _unsubTyping(); _unsubTyping = null; }
  _chatId     = null;
  _partnerUid = null;
  renderSidebar();
  document.getElementById('chatSidebar')?.classList.remove('mobile-hidden');
  document.getElementById('chatMain')?.classList.remove('mobile-open');
  document.getElementById('chatMain').innerHTML = `
    <div class="chat-welcome">
      <div class="welcome-icon">💬</div>
      <h3>Your Messages</h3>
      <p>Select a conversation to start chatting, or head to a trade post and click "Message" to connect with a trader.</p>
    </div>`;
}

function escHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatRelativeTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60)    return 'Just now';
  const m = Math.floor(s / 60);
  if (m < 60)    return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24)    return h + 'h ago';
  const d = Math.floor(h / 24);
  if (d < 7)     return d + 'd ago';
  return new Date(iso).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
}

// ── Re-export formatTime alias if data.js doesn't define it ──
if (typeof formatTime === 'undefined') {
  window.formatTime = formatRelativeTime;
}
