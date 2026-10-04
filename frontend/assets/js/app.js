/* ═══════════════════════════════════════════════════════════════
   DISASTER MIS — GLOBAL UTILITIES
   ═══════════════════════════════════════════════════════════════ */

const API_BASE = (['localhost', '127.0.0.1', ''].includes(window.location.hostname) || window.location.protocol === 'file:')
  ? 'http://localhost:5000/api'
  : '/api';

// ─── Auth Store ───────────────────────────────────────────────
const Auth = {
  getToken: () => localStorage.getItem('dis_token'),
  getUser:  () => { try { return JSON.parse(localStorage.getItem('dis_user')); } catch { return null; } },
  setSession: (token, user) => {
    localStorage.setItem('dis_token', token);
    localStorage.setItem('dis_user', JSON.stringify(user));
  },
  clearSession: () => {
    localStorage.removeItem('dis_token');
    localStorage.removeItem('dis_user');
  },
  isLoggedIn: () => !!localStorage.getItem('dis_token'),
  hasRole: (roles) => {
    const user = Auth.getUser();
    if (!user) return false;
    const allowed = Array.isArray(roles) ? roles : [roles];
    return allowed.includes(user.role);
  },
  requireAuth: () => {
    if (!Auth.isLoggedIn()) {
      window.location.href = '/pages/login.html';
      return false;
    }
    return true;
  },
};

// ─── API Client ───────────────────────────────────────────────
const API = {
  request: async (method, endpoint, body = null) => {
    const headers = { 'Content-Type': 'application/json' };
    const token = Auth.getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(`${API_BASE}${endpoint}`, opts);

    if (res.status === 401) {
      Auth.clearSession();
      window.location.href = '/pages/login.html';
      return;
    }
    return res.json();
  },
  get:    (ep)       => API.request('GET', ep),
  post:   (ep, data) => API.request('POST', ep, data),
  put:    (ep, data) => API.request('PUT', ep, data),
  patch:  (ep, data) => API.request('PATCH', ep, data),
  delete: (ep)       => API.request('DELETE', ep),
};

// ─── Toast ────────────────────────────────────────────────────
const Toast = {
  show: (message, type = 'success', duration = 3500) => {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      document.body.appendChild(container);
    }
    const icons = { success: '✓', error: '✕', warning: '⚠' };
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `<span>${icons[type] || '●'}</span><span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity 0.3s'; setTimeout(() => toast.remove(), 300); }, duration);
  },
  success: (msg) => Toast.show(msg, 'success'),
  error:   (msg) => Toast.show(msg, 'error'),
  warning: (msg) => Toast.show(msg, 'warning'),
};

// ─── Modal ────────────────────────────────────────────────────
const Modal = {
  open: (id) => document.getElementById(id)?.classList.remove('hidden'),
  close: (id) => document.getElementById(id)?.classList.add('hidden'),
  create: ({ id, title, bodyHTML, onConfirm, confirmText = 'Confirm', confirmClass = 'btn-primary' }) => {
    const existing = document.getElementById(id);
    if (existing) existing.remove();
    const el = document.createElement('div');
    el.id = id;
    el.className = 'modal-overlay';
    el.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <span class="modal-title">${title}</span>
          <button class="btn btn-ghost btn-icon btn-sm" onclick="Modal.close('${id}')">✕</button>
        </div>
        <div class="modal-body">${bodyHTML}</div>
        <div class="modal-footer">
          <button class="btn btn-ghost" onclick="Modal.close('${id}')">Cancel</button>
          <button class="btn ${confirmClass}" id="${id}-confirm">${confirmText}</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    document.getElementById(`${id}-confirm`).onclick = () => { onConfirm(); Modal.close(id); };
    el.addEventListener('click', (e) => { if (e.target === el) Modal.close(id); });
  },
};

// ─── Sidebar Setup ────────────────────────────────────────────
const Sidebar = {
  init: () => {
    const user = Auth.getUser();
    if (!user) return;

    // Inject user card
    const userCard = document.getElementById('user-card');
    if (userCard) {
      userCard.querySelector('.user-avatar').textContent = user.fullName?.charAt(0).toUpperCase() || '?';
      userCard.querySelector('.user-name').textContent = user.fullName || user.username;
      userCard.querySelector('.user-role').textContent = user.role;
    }

    // Mark active nav item
    const current = window.location.pathname.split('/').pop();
    document.querySelectorAll('.nav-item[data-page]').forEach(item => {
      if (item.dataset.page === current) item.classList.add('active');
      item.addEventListener('click', () => {
        window.location.href = item.dataset.page;
      });
    });

    // Hide elements based on role globally across the entire page
    document.querySelectorAll('[data-roles]').forEach(item => {
      const roles = item.dataset.roles.split(',').map(r => r.trim()); // Trim spaces!
      if (!roles.includes(user.role)) {
        item.style.display = 'none';
      }
    });
  },
  logout: () => {
    Auth.clearSession();
    window.location.href = '/pages/login.html';
  },
};

// ─── Format Helpers ───────────────────────────────────────────
const Format = {
  date: (d) => d ? new Date(d).toLocaleDateString('en-PK', { day:'2-digit', month:'short', year:'numeric' }) : '—',
  datetime: (d) => d ? new Date(d).toLocaleString('en-PK', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }) : '—',
  currency: (n, cur = 'PKR') => n != null ? `${cur} ${Number(n).toLocaleString('en-PK', { minimumFractionDigits: 0 })}` : '—',
  number: (n) => n != null ? Number(n).toLocaleString() : '0',
  timeAgo: (d) => {
    const diff = Date.now() - new Date(d);
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h/24)}d ago`;
  },
  badge: (text, type) => `<span class="badge badge-${(type||text).toLowerCase()}">${text}</span>`,
  severityBadge: (s) => {
    const map = { Critical:'critical', High:'high', Medium:'medium', Low:'low' };
    return Format.badge(s, map[s] || 'low');
  },
  statusBadge: (s) => {
    const map = { Pending:'pending', Active:'active', Assigned:'assigned', Resolved:'resolved',
                  Available:'available', Busy:'busy', Completed:'resolved' };
    return Format.badge(s, map[s] || 'pending');
  },
};

// ─── Table Builder ────────────────────────────────────────────
const Table = {
  render: (tbodyId, rows, cols) => {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;
    if (!rows || !rows.length) {
      tbody.innerHTML = `<tr><td colspan="${cols.length}" style="text-align:center;padding:32px;color:var(--text-muted);font-family:var(--font-mono);font-size:11px;">NO DATA AVAILABLE</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(row =>
      `<tr>${cols.map(col => `<td>${col.render ? col.render(row) : (row[col.key] ?? '—')}</td>`).join('')}</tr>`
    ).join('');
  },
};

// ─── Clock ────────────────────────────────────────────────────
const Clock = {
  start: (elId) => {
    const el = document.getElementById(elId);
    if (!el) return;
    const tick = () => {
      el.textContent = new Date().toLocaleString('en-PK', {
        weekday:'short', month:'short', day:'numeric',
        hour:'2-digit', minute:'2-digit', second:'2-digit', hour12: false,
      });
    };
    tick();
    setInterval(tick, 1000);
  },
};

