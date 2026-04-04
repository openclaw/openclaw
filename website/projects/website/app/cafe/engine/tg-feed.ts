// ── TG Feed (電報牆 — 唯讀佈告板) ────────────────────────────

type TgMessage = { time: string; text: string };
type TgEcho = { messages: TgMessage[]; updated_at: string; source: string };

const TgFeed = {
  _container: null as HTMLElement | null,
  _interval: null as ReturnType<typeof setInterval> | null,

  init() {
    this._container = document.getElementById('tg-bulletin');
    if (!this._container) return;
    this._fetch();
    // Refresh every 10 minutes
    this._interval = setInterval(() => this._fetch(), 600_000);
  },

  _fetch() {
    fetch('/cafe-game/data/tg-echo.json')
      .then(r => r.ok ? r.json() as Promise<TgEcho> : null)
      .then(data => { if (data) this._render(data); })
      .catch(() => {}); // silent
  },

  _render(data: TgEcho) {
    if (!this._container) return;
    if (!data.messages || data.messages.length === 0) {
      this._container.style.display = 'none';
      return;
    }

    this._container.style.display = 'flex';

    const header = `<div class="tg-header">電報牆</div>`;
    const msgs = data.messages.map(m => {
      const timeStr = m.time.split(' ')[1] || m.time; // show HH:MM only
      return `<div class="tg-msg">
        <span class="tg-time">${timeStr}</span>
        <span class="tg-text">${m.text.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</span>
      </div>`;
    }).join('');

    this._container.innerHTML = header + msgs;
  },
};

export default TgFeed;
