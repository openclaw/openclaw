// Workflow editor using Drawflow
let editor;
let configData = null;

async function initWorkflow() {
    const container = document.getElementById('drawflow');
    editor = new Drawflow(container);
    editor.reroute = true;
    editor.start();

    configData = await API.get('/api/config');
    renderWorkflowFromConfig(configData);

    // double-click node to edit
    editor.on('nodeSelected', (nodeId) => {
        const node = editor.getNodeFromId(nodeId);
        if (node && node.data) openNodeModal(nodeId, node.data);
    });
}

function renderWorkflowFromConfig(config) {
    editor.clear();
    const agents = config.agents || {};
    const defaults = agents.defaults || {};
    const models = Object.keys(defaults.models || {});
    const list = agents.list || [];

    // Model nodes (top row)
    const modelNodes = {};
    models.forEach((m, i) => {
        const shortName = m.split('/').pop();
        const isPrimary = defaults.model && defaults.model.primary === m;
        const html = `
      <div class="node-type">模型</div>
      <div class="title-box">${shortName}${isPrimary ? ' ★' : ''}</div>
      <div class="node-detail">${m.split('/')[0]}</div>
      <div class="node-detail">Context: ${isPrimary ? '主模型' : '可选'}</div>`;
        const id = editor.addNode(shortName, 1, 1, 100 + i * 250, 50, 'model-node', { type: 'model', fullName: m, isPrimary }, html);
        modelNodes[m] = id;
    });

    // Agent nodes (middle row)
    const agentNodes = {};
    list.forEach((agent, i) => {
        const toolProfile = agent.tools ? agent.tools.profile : 'default';
        const deny = agent.tools && agent.tools.deny ? agent.tools.deny.join(', ') : '';
        const html = `
      <div class="node-type">Agent</div>
      <div class="title-box">${agent.name} (${agent.id})</div>
      <div class="node-detail">工具: ${toolProfile}</div>
      ${deny ? `<div class="node-detail">禁用: ${deny}</div>` : ''}`;
        const id = editor.addNode(agent.id, 1, 1, 80 + i * 220, 280, 'agent-node', { type: 'agent', agentId: agent.id, ...agent }, html);
        agentNodes[agent.id] = id;
    });

    // Connect agents to primary model
    const primaryModel = defaults.model && defaults.model.primary;
    if (primaryModel && modelNodes[primaryModel]) {
        for (const [agentId, nodeId] of Object.entries(agentNodes)) {
            editor.addConnection(modelNodes[primaryModel], nodeId, 'output_1', 'input_1');
        }
    }

    // Subagent model
    const subModel = defaults.subagents && defaults.subagents.model;
    if (subModel && modelNodes[subModel]) {
        // show subagent connection differently via label
    }

    // Channel nodes (bottom row)
    const channels = config.plugins && config.plugins.entries ? Object.keys(config.plugins.entries) : [];
    channels.forEach((ch, i) => {
        if (['google-antigravity-auth'].includes(ch)) return;
        const enabled = config.plugins.entries[ch].enabled;
        const html = `
      <div class="node-type">通道</div>
      <div class="title-box">${ch}</div>
      <div class="node-detail">${enabled ? '✅ 启用' : '❌ 禁用'}</div>`;
        const id = editor.addNode(ch, 1, 0, 100 + i * 220, 500, 'channel-node', { type: 'channel', name: ch, enabled }, html);
        // connect owner agent to channels
        if (agentNodes['owner']) {
            editor.addConnection(agentNodes['owner'], id, 'output_1', 'input_1');
        }
    });

    // Tool nodes (right side)
    const toolList = ['exec', 'browser', 'web_search', 'web_fetch', 'cron', 'message', 'read', 'write', 'edit', 'canvas', 'image', 'tts'];
    toolList.forEach((t, i) => {
        const col = Math.floor(i / 6);
        const row = i % 6;
        const html = `
      <div class="node-type">工具</div>
      <div class="title-box">${t}</div>`;
        editor.addNode(t, 1, 0, 700 + col * 180, 50 + row * 80, 'tool-node', { type: 'tool', name: t }, html);
    });
}

function openNodeModal(nodeId, data) {
    const modal = document.getElementById('node-modal');
    const title = document.getElementById('modal-title');
    const body = document.getElementById('modal-body');
    modal.classList.remove('hidden');

    if (data.type === 'model') {
        title.textContent = '模型: ' + data.fullName;
        const isPrimary = data.isPrimary;
        body.innerHTML = `
      <label>完整名称</label>
      <input value="${data.fullName}" disabled>
      <label>
        <input type="checkbox" id="chk-primary" ${isPrimary ? 'checked' : ''}> 设为主模型
      </label>`;
    } else if (data.type === 'agent') {
        title.textContent = 'Agent: ' + data.name;
        const profile = data.tools ? data.tools.profile : 'full';
        const deny = data.tools && data.tools.deny ? data.tools.deny.join(', ') : '';
        const maxCtx = data.contextTokens || configData.agents.defaults.model.contextTokens || '';
        const budget = data.dailyBudget || '';
        const hours = data.workHours || '';
        body.innerHTML = `
      <label>ID</label>
      <input value="${data.agentId}" disabled>
      <label>工具权限</label>
      <select id="sel-profile">
        <option value="full" ${profile === 'full' ? 'selected' : ''}>full</option>
        <option value="messaging" ${profile === 'messaging' ? 'selected' : ''}>messaging</option>
        <option value="minimal" ${profile === 'minimal' ? 'selected' : ''}>minimal</option>
      </select>
      <label>禁用工具 (逗号分隔)</label>
      <input id="inp-deny" value="${deny}">
      <label>最大上下文 Tokens</label>
      <input id="inp-ctx" type="number" value="${maxCtx}" placeholder="如 400000" class="ctx-input">
      <label>每日 Token 预算</label>
      <input id="inp-budget" type="number" value="${budget}" placeholder="如 500000" class="budget-input">
      <label>工作时间 (如 09:00-22:00)</label>
      <input id="inp-hours" value="${hours}" placeholder="09:00-22:00" class="hours-input">`;
    } else if (data.type === 'channel') {
        title.textContent = '通道: ' + data.name;
        body.innerHTML = `
      <label>
        <input type="checkbox" id="chk-enabled" ${data.enabled ? 'checked' : ''}> 启用
      </label>`;
    } else {
        title.textContent = '工具: ' + data.name;
        body.innerHTML = `<p>工具节点暂不支持编辑</p>`;
    }

    // save handler
    document.getElementById('modal-save').onclick = async () => {
        if (data.type === 'model') {
            const checked = document.getElementById('chk-primary').checked;
            if (checked) {
                configData.agents.defaults.model.primary = data.fullName;
            }
        } else if (data.type === 'agent') {
            const agentIdx = configData.agents.list.findIndex(a => a.id === data.agentId);
            if (agentIdx >= 0) {
                const profile = document.getElementById('sel-profile').value;
                const deny = document.getElementById('inp-deny').value.split(',').map(s => s.trim()).filter(Boolean);
                configData.agents.list[agentIdx].tools = { profile };
                if (deny.length) configData.agents.list[agentIdx].tools.deny = deny;
                const ctx = document.getElementById('inp-ctx').value;
                if (ctx) configData.agents.list[agentIdx].contextTokens = parseInt(ctx);
                const budget = document.getElementById('inp-budget').value;
                if (budget) configData.agents.list[agentIdx].dailyBudget = parseInt(budget);
                const hours = document.getElementById('inp-hours').value;
                if (hours) configData.agents.list[agentIdx].workHours = hours;
            }
        } else if (data.type === 'channel') {
            const enabled = document.getElementById('chk-enabled').checked;
            configData.plugins.entries[data.name].enabled = enabled;
        }
        await API.put('/api/config', configData);
        toast('配置已保存');
        modal.classList.add('hidden');
        renderWorkflowFromConfig(configData);
    };
}

document.getElementById('modal-close').onclick = () => {
    document.getElementById('node-modal').classList.add('hidden');
};
