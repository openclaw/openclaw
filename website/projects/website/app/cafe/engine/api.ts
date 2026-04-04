// ── CafeAPI (靜默後端接線員) ───────────────────────────────────
import type { CoffeeResult, VisitResult, CafeState } from './types';

const CafeAPI = {
  visitorId: (() => {
    try {
      let id = localStorage.getItem('cafe_visitor_id');
      if (!id) {
        id = 'v_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
        localStorage.setItem('cafe_visitor_id', id);
      }
      return id;
    } catch {
      return 'anon_' + Math.random().toString(36).slice(2, 9);
    }
  })(),

  recordVisit(): Promise<VisitResult | null> {
    return fetch('/api/cafe/visit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitorId: this.visitorId, path: ['cafe'] }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  },

  fetchState(): Promise<CafeState | null> {
    return fetch(`/api/cafe/state?visitorId=${encodeURIComponent(this.visitorId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  },

  sendCoffee(npcId: string): Promise<CoffeeResult | null> {
    return fetch('/api/cafe/coffee', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ npcId, visitorId: this.visitorId }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  },
};

export default CafeAPI;
