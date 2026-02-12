// API helper
const API = {
    async get(url) {
        const r = await fetch(url);
        return r.json();
    },
    async put(url, body) {
        const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return r.json();
    }
};

function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2000);
}
