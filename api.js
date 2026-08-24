// Thin wrapper around fetch(). Keeps the JWT in memory + localStorage
// (an auth token is credential cache, not app data — fine to persist so
// the user doesn't have to log in every time they reopen the app).
const HakyAPI = (() => {
  const BASE = window.HAKY_CONFIG.API_BASE_URL;
  let token = localStorage.getItem('haky_token') || null;

  function setToken(t) {
    token = t;
    if (t) localStorage.setItem('haky_token', t);
    else localStorage.removeItem('haky_token');
  }

  function getToken() {
    return token;
  }

  async function request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    let data = null;
    try {
      data = await res.json();
    } catch {
      // no JSON body (e.g. 204) — fine
    }

    if (!res.ok) {
      const message = (data && data.error) || `خطأ في الاتصال بالخادم (${res.status})`;
      throw new Error(message);
    }
    return data;
  }

  return {
    setToken,
    getToken,

    register: (username, password) => request('POST', '/auth/register', { username, password }),
    login: (username, password) => request('POST', '/auth/login', { username, password }),

    getPendingUsers: () => request('GET', '/admin/pending-users'),
    approveUser: (id) => request('POST', `/admin/users/${id}/approve`),
    rejectUser: (id) => request('POST', `/admin/users/${id}/reject`),

    listChats: (view) => request('GET', `/chats${view ? `?view=${view}` : ''}`),
    createChat: (payload) => request('POST', '/chats', payload),
    getMessages: (chatId, before) =>
      request('GET', `/chats/${chatId}/messages${before ? `?before=${before}` : ''}`),
    sendMessage: (chatId, payload) => request('POST', `/chats/${chatId}/messages`, payload),

    archiveChat: (chatId, archived) => request('POST', `/chats/${chatId}/archive`, { archived }),
    hideChat: (chatId, hidden) => request('POST', `/chats/${chatId}/hide`, { hidden }),
    lockChat: (chatId, passcode) => request('POST', `/chats/${chatId}/lock`, { passcode }),
    unlockChat: (chatId, passcode) => request('POST', `/chats/${chatId}/unlock`, { passcode }),

    presignUpload: (filename, contentType) =>
      request('POST', '/media/presign', { filename, contentType }),
  };
})();
