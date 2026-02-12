// Cron job management
let cronJobs = [];

async function initCron() {
    cronJobs = await API.get('/api/cron');
    renderCron();
}

function renderCron() {
    const el = document.getElementById('cron-list');
    el.innerHTML = cronJobs.map((job, i) => {
        const enabled = job.enabled;
        const schedule = job.schedule || {};
        const expr = schedule.expr || '';
        const tz = schedule.tz || '';
        const state = job.state || {};
        const lastRun = state.lastCompletedAt ? new Date(state.lastCompletedAt).toLocaleString() : '无';
        const status = state.lastStatus || '';
        return `
      <div class="cron-item">
        <button class="cron-toggle ${enabled ? 'on' : ''}" onclick="toggleCron(${i})"></button>
        <div>
          <div class="cron-name">${escCron(job.name || job.id)}</div>
          <div class="cron-schedule">${expr} (${tz})</div>
          <div class="cron-status">上次: ${lastRun} ${status ? `<span class="${status === 'ok' ? 'ok' : 'err'}">${status}</span>` : ''}</div>
        </div>
        <div class="cron-actions">
          <button onclick="editCron(${i})">编辑</button>
        </div>
      </div>`;
    }).join('');
}

async function toggleCron(idx) {
    cronJobs[idx].enabled = !cronJobs[idx].enabled;
    await API.put('/api/cron', cronJobs);
    toast(cronJobs[idx].name + (cronJobs[idx].enabled ? ' 已启用' : ' 已禁用'));
    renderCron();
}

function editCron(idx) {
    const job = cronJobs[idx];
    const modal = document.getElementById('node-modal');
    const title = document.getElementById('modal-title');
    const body = document.getElementById('modal-body');
    modal.classList.remove('hidden');

    title.textContent = '编辑: ' + (job.name || job.id);
    const schedule = job.schedule || {};
    const payload = job.payload || {};
    body.innerHTML = `
    <label>名称</label>
    <input id="cron-name" value="${escCron(job.name || '')}">
    <label>Cron 表达式</label>
    <input id="cron-expr" value="${schedule.expr || ''}" placeholder="0 9 * * 1-5">
    <label>时区</label>
    <input id="cron-tz" value="${schedule.tz || ''}" placeholder="Asia/Singapore">
    <label>Agent ID</label>
    <input id="cron-agent" value="${job.agentId || ''}">
    <label>消息 Payload</label>
    <textarea id="cron-msg">${escCron(payload.message || '')}</textarea>
  `;

    document.getElementById('modal-save').onclick = async () => {
        cronJobs[idx].name = document.getElementById('cron-name').value;
        cronJobs[idx].schedule = {
            kind: 'cron',
            expr: document.getElementById('cron-expr').value,
            tz: document.getElementById('cron-tz').value
        };
        cronJobs[idx].agentId = document.getElementById('cron-agent').value;
        cronJobs[idx].payload = {
            kind: 'agentTurn',
            message: document.getElementById('cron-msg').value
        };
        await API.put('/api/cron', cronJobs);
        toast('已保存');
        modal.classList.add('hidden');
        renderCron();
    };
}

function escCron(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }
