// Token monitoring
let chartDaily, chartModel, chartAgent;

async function initMonitor() {
    const sessions = await API.get('/api/sessions');
    const config = await API.get('/api/config');

    // --- Aggregate data ---
    const byDay = {};
    const byModel = {};
    const byAgent = {};
    const actionList = [];

    sessions.forEach(s => {
        // by day
        const day = new Date(s.updatedAt).toISOString().slice(0, 10);
        if (!byDay[day]) byDay[day] = { input: 0, output: 0, total: 0 };
        byDay[day].input += s.inputTokens;
        byDay[day].output += s.outputTokens;
        byDay[day].total += s.totalTokens;

        // by model
        const model = s.model || 'unknown';
        if (!byModel[model]) byModel[model] = 0;
        byModel[model] += s.totalTokens;

        // by agent
        if (!byAgent[s.agentId]) byAgent[s.agentId] = 0;
        byAgent[s.agentId] += s.totalTokens;

        // top actions
        if (s.totalTokens > 0) {
            actionList.push({
                label: s.label || s.key,
                tokens: s.totalTokens,
                model: s.model,
                agent: s.agentId,
                date: day
            });
        }
    });

    // sort days
    const days = Object.keys(byDay).sort();
    const last30 = days.slice(-30);

    // --- Daily chart ---
    const ctxD = document.getElementById('chart-daily').getContext('2d');
    chartDaily = new Chart(ctxD, {
        type: 'line',
        data: {
            labels: last30,
            datasets: [
                { label: 'Input', data: last30.map(d => byDay[d].input), borderColor: '#4fc3f7', tension: 0.3, fill: false },
                { label: 'Output', data: last30.map(d => byDay[d].output), borderColor: '#66bb6a', tension: 0.3, fill: false },
                { label: 'Total', data: last30.map(d => byDay[d].total), borderColor: '#ffb74d', tension: 0.3, fill: false }
            ]
        },
        options: { responsive: true, scales: { y: { beginAtZero: true } }, plugins: { legend: { labels: { color: '#e0e0e0' } } } }
    });

    // --- Model distribution ---
    const ctxM = document.getElementById('chart-model').getContext('2d');
    const modelNames = Object.keys(byModel);
    chartModel = new Chart(ctxM, {
        type: 'doughnut',
        data: {
            labels: modelNames,
            datasets: [{ data: modelNames.map(m => byModel[m]), backgroundColor: ['#4fc3f7', '#66bb6a', '#ffb74d', '#ef5350', '#ab47bc'] }]
        },
        options: { responsive: true, plugins: { legend: { labels: { color: '#e0e0e0' } } } }
    });

    // --- Agent bar chart ---
    const ctxA = document.getElementById('chart-agent').getContext('2d');
    const agentNames = Object.keys(byAgent);
    chartAgent = new Chart(ctxA, {
        type: 'bar',
        data: {
            labels: agentNames,
            datasets: [{ label: 'Total Tokens', data: agentNames.map(a => byAgent[a]), backgroundColor: '#4fc3f7' }]
        },
        options: { responsive: true, indexAxis: 'y', scales: { x: { beginAtZero: true } }, plugins: { legend: { display: false } } }
    });

    // --- Top token actions ---
    actionList.sort((a, b) => b.tokens - a.tokens);
    const top20 = actionList.slice(0, 20);
    const topEl = document.getElementById('top-actions');
    topEl.innerHTML = `<table>
    <tr><th>动作/会话</th><th>模型</th><th>Tokens</th><th>日期</th></tr>
    ${top20.map(a => `<tr>
      <td>${escHtml(truncate(a.label, 50))}</td>
      <td>${a.model}</td>
      <td>${a.tokens.toLocaleString()}</td>
      <td>${a.date}</td>
    </tr>`).join('')}
  </table>`;

    // --- Agent config table (context, budget, hours) ---
    const agentList = config.agents && config.agents.list || [];
    const defaults = config.agents && config.agents.defaults || {};
    const agentCfg = document.getElementById('agent-config');
    agentCfg.innerHTML = `<table>
    <tr><th>Agent</th><th>最大上下文</th><th>每日预算</th><th>工作时间</th><th></th></tr>
    ${agentList.map(a => {
        const ctx = a.contextTokens || '';
        const budget = a.dailyBudget || '';
        const hours = a.workHours || '';
        return `<tr>
        <td>${a.name}</td>
        <td><input class="ctx-input" data-id="${a.id}" data-field="contextTokens" value="${ctx}" placeholder="${defaults.model && defaults.model.contextTokens || 400000}"></td>
        <td><input class="budget-input" data-id="${a.id}" data-field="dailyBudget" value="${budget}" placeholder="无限制"></td>
        <td><input class="hours-input" data-id="${a.id}" data-field="workHours" value="${hours}" placeholder="全天"></td>
        <td><button onclick="saveAgentConfig('${a.id}')">保存</button></td>
      </tr>`;
    }).join('')}
  </table>`;
}

async function saveAgentConfig(agentId) {
    const config = await API.get('/api/config');
    const agent = config.agents.list.find(a => a.id === agentId);
    if (!agent) return;

    const row = document.querySelector(`input[data-id="${agentId}"][data-field="contextTokens"]`).closest('tr');
    const inputs = row.querySelectorAll('input');
    inputs.forEach(inp => {
        const field = inp.dataset.field;
        const val = inp.value.trim();
        if (field === 'contextTokens' || field === 'dailyBudget') {
            if (val) agent[field] = parseInt(val);
            else delete agent[field];
        } else if (field === 'workHours') {
            if (val) agent[field] = val;
            else delete agent[field];
        }
    });

    await API.put('/api/config', config);
    toast(`${agent.name} 配置已保存`);
}

function escHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
function truncate(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }
