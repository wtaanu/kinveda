/**
 * KinVeda Frontend API Helper — v2.0
 * Include on every page. Handles:
 *  - Token management + auto-refresh
 *  - Auth guards (role-aware)
 *  - Chat widget injection
 *  - Razorpay checkout helper (INR)
 *  - Quick Exit (safe navigation)
 *  - Jitsi video call launcher
 *  - Favicon + page title icon injection
 */

const KV = (() => {
  // In production (Hostinger), the API and frontend are served by the same Express
  // server, so API calls go to the same origin. In local dev, point to localhost:3001.
  const API_BASE = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ? 'http://localhost:3001'
    : window.location.origin;
  const RAZORPAY_KEY = 'rzp_live_SWMqW8tn9NHHwB';
  const JITSI_DOMAIN = 'meet.jit.si';

  // ─── Token & User Helpers ────────────────────────────────────────────────────
  function getToken()  { return localStorage.getItem('kv_token'); }
  function getUser()   { try { return JSON.parse(localStorage.getItem('kv_user')); } catch { return null; } }
  function clearAuth() { localStorage.removeItem('kv_token'); localStorage.removeItem('kv_user'); }

  // ─── API Fetch (auto-refresh on 401) ─────────────────────────────────────────
  async function apiFetch(path, options = {}) {
    const token = getToken();
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    let res = await fetch(`${API_BASE}${path}`, { ...options, headers, credentials: 'include' });

    if (res.status === 401) {
      const body = await res.json().catch(() => ({}));
      if (body.code === 'TOKEN_EXPIRED') {
        const refreshRes = await fetch(`${API_BASE}/api/auth/refresh`, { method: 'POST', credentials: 'include' });
        if (refreshRes.ok) {
          const d = await refreshRes.json();
          localStorage.setItem('kv_token', d.accessToken);
          headers['Authorization'] = `Bearer ${d.accessToken}`;
          res = await fetch(`${API_BASE}${path}`, { ...options, headers, credentials: 'include' });
        } else {
          clearAuth();
          window.location.href = 'kinveda-signin.html';
          return null;
        }
      } else {
        clearAuth();
        window.location.href = 'kinveda-signin.html';
        return null;
      }
    }
    return res;
  }

  const get   = (path)       => apiFetch(path, { method: 'GET' });
  const post  = (path, body) => apiFetch(path, { method: 'POST',  body: JSON.stringify(body) });
  const put   = (path, body) => apiFetch(path, { method: 'PUT',   body: JSON.stringify(body) });
  const patch = (path, body) => apiFetch(path, { method: 'PATCH', body: JSON.stringify(body) });
  const del   = (path)       => apiFetch(path, { method: 'DELETE' });

  // ─── Auth Guard ───────────────────────────────────────────────────────────────
  function requireAuth(expectedRole) {
    const user = getUser();
    if (!user || !getToken()) { window.location.href = 'kinveda-signin.html'; return null; }
    if (expectedRole && user.role !== expectedRole) { window.location.href = 'kinveda-signin.html'; return null; }
    return user;
  }

  async function signOut() {
    await post('/api/auth/signout', {}).catch(() => {});
    clearAuth();
    // GDPR: clear any locally stored photo/preferences on signout
    try {
      localStorage.removeItem('kv_photo');
    } catch (e) { /* ignore */ }
    window.location.href = 'kinveda-landing.html';
  }

  // ─── Favicon + Page Title Icon Injection ─────────────────────────────────────
  function injectFavicon() {
    if (!document.querySelector('link[rel="icon"]')) {
      const link = document.createElement('link');
      link.rel  = 'icon';
      link.href = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🌿</text></svg>`;
      document.head.appendChild(link);
    }
  }

  // ─── Quick Exit (Safe Navigation) ────────────────────────────────────────────
  // Replaces browser history entry so "Back" doesn't return to KinVeda
  function quickExit() {
    // Log SOS event (best-effort, non-blocking)
    const token = getToken();
    if (token) {
      fetch(`${API_BASE}/api/kinmember/sos/quick-exit`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        credentials: 'include'
      }).catch(() => {});
    }
    // Navigate away — replace() removes KinVeda from browser history
    window.location.replace('https://www.google.com/search?q=weather+today');
  }

  // ─── XSS Sanitiser (SAST) ────────────────────────────────────────────────────
  // Use esc() for ALL user-supplied text inserted via innerHTML / template literals.
  // This prevents stored/reflected XSS if a mentor bio or name contains HTML tags.
  function esc(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
      .replace(/\//g, '&#x2F;');
  }

  // ─── Date Formatter (IST) ─────────────────────────────────────────────────────
  function fmtDate(unixTs, opts = {}) {
    if (!unixTs) return '—';
    const defaults = { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' };
    return new Date(unixTs * 1000).toLocaleString('en-IN', { ...defaults, ...opts });
  }

  function fmtDateTime(unixTs) {
    return fmtDate(unixTs, { hour: '2-digit', minute: '2-digit', hour12: true });
  }

  function fmtINR(amount) {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(amount || 0);
  }

  // ─── Razorpay Checkout ────────────────────────────────────────────────────────
  // Opens the Razorpay payment modal. Calls onSuccess(paymentData) or onFailure(error)
  function openRazorpayCheckout({ orderId, amount, currency = 'INR', name = 'KinVeda', description,
    prefillName, prefillEmail, onSuccess, onFailure }) {

    if (typeof window.Razorpay === 'undefined') {
      // Dynamically load Razorpay script
      const script = document.createElement('script');
      script.src = 'https://checkout.razorpay.com/v1/checkout.js';
      script.onload = () => _launchRzp({ orderId, amount, currency, name, description, prefillName, prefillEmail, onSuccess, onFailure });
      script.onerror = () => { if (onFailure) onFailure(new Error('Could not load payment gateway')); };
      document.head.appendChild(script);
    } else {
      _launchRzp({ orderId, amount, currency, name, description, prefillName, prefillEmail, onSuccess, onFailure });
    }
  }

  function _launchRzp({ orderId, amount, currency, name, description, prefillName, prefillEmail, onSuccess, onFailure }) {
    const options = {
      key:         RAZORPAY_KEY,
      amount,
      currency,
      name:        'KinVeda',
      description: description || 'KinVeda Wellness Session',
      image:       `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🌿</text></svg>`,
      order_id:    orderId,
      prefill:     { name: prefillName || '', email: prefillEmail || '', contact: '' },
      notes:       { service: 'KinVeda Family Wellness' },
      theme:       { color: '#2D7D6F' },
      handler: function (response) {
        if (onSuccess) onSuccess(response);
      },
      modal: {
        ondismiss: function() {
          if (onFailure) onFailure(new Error('Payment cancelled by user'));
        }
      }
    };
    const rzp = new window.Razorpay(options);
    rzp.on('payment.failed', function(response) {
      if (onFailure) onFailure(response.error);
    });
    rzp.open();
  }

  // ─── Pay for Session ──────────────────────────────────────────────────────────
  async function payForSession(sessionId, onComplete) {
    try {
      const orderRes = await post('/api/payment/order', { sessionId });
      if (!orderRes || !orderRes.ok) {
        const d = await orderRes?.json().catch(() => ({}));
        alert(d.message || 'Could not initiate payment. Please try again.');
        return;
      }
      const order = await orderRes.json();
      const user  = getUser();

      openRazorpayCheckout({
        orderId:      order.orderId,
        amount:       order.amount,
        description:  `Wellness Session Payment`,
        prefillName:  user?.name || '',
        prefillEmail: user?.email || '',
        onSuccess: async (paymentData) => {
          const verifyRes = await post('/api/payment/verify', {
            razorpay_order_id:   paymentData.razorpay_order_id,
            razorpay_payment_id: paymentData.razorpay_payment_id,
            razorpay_signature:  paymentData.razorpay_signature,
            sessionId
          });
          if (verifyRes?.ok) {
            showToast('✅ Payment successful! Session confirmed.', 'success');
            if (onComplete) onComplete(true);
          } else {
            showToast('⚠️ Payment received but verification failed. Please contact support.', 'error');
          }
        },
        onFailure: (err) => {
          showToast('❌ Payment failed: ' + (err?.description || err?.message || 'Unknown error'), 'error');
          if (onComplete) onComplete(false);
        }
      });
    } catch (err) {
      console.error('[KV] payForSession error:', err);
      alert('Payment initiation failed. Please try again.');
    }
  }

  // ─── Subscribe (Monthly Package) ─────────────────────────────────────────────
  async function subscribe(mentorId, onComplete) {
    try {
      const orderRes = await post('/api/payment/subscription', { mentorId });
      if (!orderRes || !orderRes.ok) {
        const d = await orderRes?.json().catch(() => ({}));
        alert(d.message || 'Could not start subscription. Please try again.');
        return;
      }
      const order = await orderRes.json();
      const user  = getUser();

      openRazorpayCheckout({
        orderId:      order.orderId,
        amount:       order.amount,
        description:  'Monthly Care Package — 8 sessions',
        prefillName:  user?.name || '',
        prefillEmail: user?.email || '',
        onSuccess: async (paymentData) => {
          const verifyRes = await post('/api/payment/subscription/verify', {
            razorpay_order_id:   paymentData.razorpay_order_id,
            razorpay_payment_id: paymentData.razorpay_payment_id,
            razorpay_signature:  paymentData.razorpay_signature,
            subscriptionId:      order.subscriptionId
          });
          if (verifyRes?.ok) {
            showToast('✅ Subscription activated! You now have 8 sessions for the month.', 'success');
            if (onComplete) onComplete(true);
          } else {
            showToast('⚠️ Payment received but activation failed. Please contact support.', 'error');
          }
        },
        onFailure: (err) => {
          showToast('❌ Payment failed: ' + (err?.description || err?.message || 'Unknown error'), 'error');
          if (onComplete) onComplete(false);
        }
      });
    } catch (err) {
      console.error('[KV] subscribe error:', err);
      alert('Subscription initiation failed.');
    }
  }

  // ─── Jitsi Video Call ─────────────────────────────────────────────────────────
  function joinVideoCall(roomName, displayName) {
    const url = `https://${JITSI_DOMAIN}/${roomName}#userInfo.displayName="${encodeURIComponent(displayName || 'Guest')}"`;
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  // ─── Toast Notification ───────────────────────────────────────────────────────
  function showToast(message, type = 'info', duration = 4000) {
    let container = document.getElementById('kv-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'kv-toast-container';
      container.style.cssText = 'position:fixed;top:20px;right:20px;z-index:99999;display:flex;flex-direction:column;gap:10px;';
      document.body.appendChild(container);
    }

    const colors = { success: '#059669', error: '#DC2626', info: '#2D7D6F', warning: '#D97706' };
    const toast = document.createElement('div');
    toast.style.cssText = `background:${colors[type]||colors.info};color:white;padding:13px 18px;border-radius:10px;font-size:14px;font-weight:500;max-width:340px;box-shadow:0 4px 20px rgba(0,0,0,0.2);line-height:1.5;animation:kvSlideIn .3s ease;`;
    toast.textContent = message;
    container.appendChild(toast);

    if (!document.getElementById('kv-toast-style')) {
      const s = document.createElement('style');
      s.id = 'kv-toast-style';
      s.textContent = '@keyframes kvSlideIn{from{transform:translateX(120%);opacity:0}to{transform:translateX(0);opacity:1}}';
      document.head.appendChild(s);
    }

    setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity .4s'; setTimeout(() => toast.remove(), 400); }, duration);
  }

  // ─── Chat Widget ──────────────────────────────────────────────────────────────
  function injectChatWidget() {
    const style = document.createElement('style');
    style.textContent = `
      #kv-chat-btn{position:fixed;bottom:28px;left:28px;z-index:9999;background:#2D7D6F;color:white;border:none;width:58px;height:58px;border-radius:50%;font-size:24px;cursor:pointer;box-shadow:0 4px 20px rgba(45,125,111,0.45);transition:all .2s;display:flex;align-items:center;justify-content:center;}
      #kv-chat-btn:hover{background:#1E5C51;transform:scale(1.08);}
      #kv-chat-btn .kv-notif{position:absolute;top:2px;right:2px;width:16px;height:16px;background:#E8734A;border-radius:50%;font-size:10px;display:flex;align-items:center;justify-content:center;font-weight:700;}
      #kv-chat-panel{position:fixed;bottom:100px;left:28px;z-index:9999;width:340px;background:white;border-radius:18px;box-shadow:0 8px 40px rgba(0,0,0,0.18);border:1px solid #E2EAE8;overflow:hidden;display:none;flex-direction:column;max-height:500px;}
      #kv-chat-panel.open{display:flex;}
      .kv-chat-header{background:linear-gradient(135deg,#2D7D6F,#4A9D8E);padding:16px 20px;color:white;display:flex;align-items:center;gap:12px;}
      .kv-chat-header h4{font-size:15px;font-weight:700;margin:0;}
      .kv-chat-header p{font-size:12px;opacity:.85;margin:2px 0 0;}
      .kv-chat-header .close-btn{margin-left:auto;background:rgba(255,255,255,.2);border:none;color:white;width:28px;height:28px;border-radius:50%;cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center;}
      .kv-chat-body{padding:16px;flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:10px;}
      .kv-chat-msg{max-width:85%;padding:10px 14px;border-radius:12px;font-size:13px;line-height:1.5;}
      .kv-chat-msg.bot{background:#EEF7F5;color:#1A2E2A;align-self:flex-start;border-bottom-left-radius:4px;}
      .kv-chat-msg.user{background:#2D7D6F;color:white;align-self:flex-end;border-bottom-right-radius:4px;}
      .kv-chat-footer{padding:12px;border-top:1px solid #E2EAE8;display:flex;gap:8px;}
      .kv-chat-footer input{flex:1;padding:9px 14px;border:1.5px solid #E2EAE8;border-radius:8px;font-size:13px;font-family:inherit;outline:none;}
      .kv-chat-footer input:focus{border-color:#2D7D6F;}
      .kv-chat-footer button{background:#2D7D6F;color:white;border:none;padding:9px 16px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;}
      .kv-chat-footer button:disabled{opacity:.6;cursor:not-allowed;}
      .kv-chat-name-row{display:flex;gap:8px;padding:0 16px 12px;}
      .kv-chat-name-row input{flex:1;padding:8px 12px;border:1.5px solid #E2EAE8;border-radius:8px;font-size:13px;font-family:inherit;outline:none;}
      .kv-chat-name-row input:focus{border-color:#2D7D6F;}
    `;
    document.head.appendChild(style);

    // GDPR: Never pre-fill user's personal data in shared/landing page chat widget.
    // Only pre-fill on authenticated portal pages where the user is already signed in.
    const isPortal = ['kinveda-kinmember.html', 'kinveda-kinmentor.html']
      .some(p => window.location.pathname.includes(p));
    const user = isPortal ? getUser() : null;

    const btn  = document.createElement('div');
    btn.innerHTML = `
      <button id="kv-chat-btn" onclick="KV.toggleChat()" title="Chat with KinVeda">💬<span class="kv-notif">1</span></button>
      <div id="kv-chat-panel">
        <div class="kv-chat-header">
          <span style="font-size:22px">🌿</span>
          <div><h4>Chat with KinVeda</h4><p>We respond within 2 hours</p></div>
          <button class="close-btn" onclick="KV.toggleChat()">✕</button>
        </div>
        <div class="kv-chat-body" id="kvChatBody">
          <div class="kv-chat-msg bot">👋 Hi there! How can we help you today? Leave your message and our team will reach out shortly.</div>
        </div>
        <div class="kv-chat-name-row" id="kvNameRow">
          <input id="kvChatName" placeholder="Your name (optional)" autocomplete="off">
          <input id="kvChatEmail" type="email" placeholder="Email (optional)" autocomplete="off">
        </div>
        <div class="kv-chat-footer">
          <input id="kvChatInput" placeholder="Type your message..." onkeydown="if(event.key==='Enter')KV.sendChat()" autocomplete="off">
          <button id="kvChatSendBtn" onclick="KV.sendChat()">Send</button>
        </div>
      </div>
    `;
    document.body.appendChild(btn);
  }

  function toggleChat() {
    const panel = document.getElementById('kv-chat-panel');
    if (!panel) return;
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) {
      const notif = document.querySelector('#kv-chat-btn .kv-notif');
      if (notif) notif.style.display = 'none';
      document.getElementById('kvChatInput')?.focus();
    }
  }

  async function sendChat() {
    const input   = document.getElementById('kvChatInput');
    const nameEl  = document.getElementById('kvChatName');
    const emailEl = document.getElementById('kvChatEmail');
    const btn     = document.getElementById('kvChatSendBtn');
    const msg     = input?.value.trim();
    if (!msg) return;

    const body = document.getElementById('kvChatBody');
    const bubble = document.createElement('div');
    bubble.className = 'kv-chat-msg user';
    bubble.textContent = msg;
    body.appendChild(bubble);
    body.scrollTop = body.scrollHeight;
    input.value = '';
    btn.disabled = true;
    document.getElementById('kvNameRow').style.display = 'none';

    try {
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name:       nameEl?.value.trim() || undefined,
          email:      emailEl?.value.trim() || undefined,
          message:    msg,
          sourcePage: window.location.pathname
        })
      });
      const data = await res.json();
      const reply = document.createElement('div');
      reply.className = 'kv-chat-msg bot';
      reply.textContent = data.success
        ? '✅ Thanks! Our team has been notified and will reach out within 2 hours.'
        : '⚠️ Something went wrong. Please email us at support@kinveda.in';
      body.appendChild(reply);
      body.scrollTop = body.scrollHeight;
    } catch {
      const err = document.createElement('div');
      err.className = 'kv-chat-msg bot';
      err.textContent = '⚠️ Could not send. Please check your connection.';
      body.appendChild(err);
    } finally {
      btn.disabled = false;
    }
  }

  // ─── GDPR Cookie Consent Banner ───────────────────────────────────────────────
  function injectCookieConsent() {
    // Skip if already decided or if on portal pages (authenticated users already consented at signup)
    const portalPages = ['kinveda-kinmember.html', 'kinveda-kinmentor.html', 'kinveda-admin'];
    const isPortalPage = portalPages.some(p => window.location.pathname.includes(p));
    if (isPortalPage) return;
    if (localStorage.getItem('kv_cookie_consent')) return;

    const style = document.createElement('style');
    style.id = 'kv-gdpr-style';
    style.textContent = `
      #kv-cookie-banner{position:fixed;bottom:0;left:0;right:0;z-index:999999;background:#1A2E2A;color:#E8F4F2;padding:18px 24px;display:flex;flex-wrap:wrap;align-items:center;gap:14px;font-size:13.5px;line-height:1.55;box-shadow:0 -4px 24px rgba(0,0,0,.28);}
      #kv-cookie-banner a{color:#7DD3C8;text-decoration:underline;}
      #kv-cookie-banner p{margin:0;flex:1;min-width:240px;}
      .kv-cookie-btns{display:flex;gap:10px;flex-shrink:0;}
      .kv-cookie-accept{background:#2D7D6F;color:white;border:none;padding:9px 22px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;transition:background .2s;}
      .kv-cookie-accept:hover{background:#1E5C51;}
      .kv-cookie-decline{background:transparent;color:#A8C5C0;border:1px solid #4A7A72;padding:9px 18px;border-radius:8px;font-size:13px;cursor:pointer;transition:all .2s;}
      .kv-cookie-decline:hover{background:#243330;color:#E8F4F2;}
      @media(max-width:600px){#kv-cookie-banner{padding:14px 16px;font-size:13px;}.kv-cookie-btns{width:100%;}.kv-cookie-accept,.kv-cookie-decline{flex:1;text-align:center;}}
    `;
    document.head.appendChild(style);

    const banner = document.createElement('div');
    banner.id = 'kv-cookie-banner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Cookie consent');
    banner.innerHTML = `
      <p>🍪 KinVeda uses essential cookies to keep your session secure and improve your experience. We do <strong>not</strong> share your personal data with advertisers. By continuing, you agree to our <a href="/kinveda-privacy.html" target="_blank" rel="noopener">Privacy Policy</a>.</p>
      <div class="kv-cookie-btns">
        <button class="kv-cookie-accept" onclick="KV._cookieAccept()">Accept &amp; Continue</button>
        <button class="kv-cookie-decline" onclick="KV._cookieDecline()">Essential Only</button>
      </div>
    `;
    document.body.appendChild(banner);
  }

  function _cookieAccept() {
    localStorage.setItem('kv_cookie_consent', JSON.stringify({ decision: 'accepted', ts: Date.now() }));
    const b = document.getElementById('kv-cookie-banner');
    if (b) { b.style.transform = 'translateY(110%)'; b.style.transition = 'transform .4s ease'; setTimeout(() => b.remove(), 420); }
  }

  function _cookieDecline() {
    localStorage.setItem('kv_cookie_consent', JSON.stringify({ decision: 'essential-only', ts: Date.now() }));
    const b = document.getElementById('kv-cookie-banner');
    if (b) { b.style.transform = 'translateY(110%)'; b.style.transition = 'transform .4s ease'; setTimeout(() => b.remove(), 420); }
  }

  // ─── Auto-init ────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    injectFavicon();
    // Inject chat widget on non-portal pages (landing, about, etc.)
    // Portal pages have their own chat/messaging — skip to avoid duplicates
    const portalPages = ['kinveda-kinmember.html', 'kinveda-kinmentor.html', 'kinveda-admin'];
    const isPortalPage = portalPages.some(p => window.location.pathname.includes(p));
    if (!isPortalPage) {
      injectChatWidget();
    }
    // GDPR: cookie consent banner on all public-facing pages
    injectCookieConsent();
  });

  // ─── Expose Public API ────────────────────────────────────────────────────────
  return {
    API_BASE,
    get,
    post,
    put,
    patch,
    del,
    requireAuth,
    signOut,
    getToken,
    getUser,
    quickExit,
    fmtDate,
    fmtDateTime,
    fmtINR,
    openRazorpayCheckout,
    payForSession,
    subscribe,
    joinVideoCall,
    showToast,
    toggleChat,
    sendChat,
    injectFavicon,
    injectChatWidget,
    injectCookieConsent,
    _cookieAccept,
    _cookieDecline,
    esc
  };
})();
