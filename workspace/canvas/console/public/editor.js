// File editor with CodeMirror
let cm = null;
let currentFile = null;

async function initEditor() {
    const files = await API.get('/api/files');
    const listEl = document.getElementById('file-list');
    listEl.innerHTML = files.map(f =>
        `<div class="file-item" onclick="loadFile('${f}')">${f.split('/').pop()}</div>`
    ).join('');

    document.getElementById('btn-save').onclick = saveFile;
}

async function loadFile(filePath) {
    const data = await API.get('/api/file?path=' + encodeURIComponent(filePath));
    currentFile = filePath;

    document.getElementById('editor-filename').textContent = filePath;
    document.getElementById('btn-save').disabled = false;

    // highlight active
    document.querySelectorAll('.file-item').forEach(el => {
        el.classList.toggle('active', el.textContent === filePath.split('/').pop());
    });

    // init or update codemirror
    const wrap = document.getElementById('codemirror-wrap');
    if (cm) {
        cm.setValue(data.content);
    } else {
        wrap.innerHTML = '';
        cm = CodeMirror(wrap, {
            value: data.content,
            mode: filePath.endsWith('.json') ? 'application/json' : 'markdown',
            theme: 'material-darker',
            lineNumbers: true,
            lineWrapping: true
        });
    }
    // update mode
    cm.setOption('mode', filePath.endsWith('.json') ? 'application/json' : 'markdown');
}

async function saveFile() {
    if (!currentFile || !cm) return;
    await API.put('/api/file', { path: currentFile, content: cm.getValue() });
    toast(currentFile.split('/').pop() + ' 已保存');
}
