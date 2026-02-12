// App initialization and tab routing
document.addEventListener('DOMContentLoaded', () => {
    const tabs = document.querySelectorAll('.tab');
    const panels = document.querySelectorAll('.panel');
    const loaded = {};

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const target = tab.dataset.panel;
            tabs.forEach(t => t.classList.remove('active'));
            panels.forEach(p => p.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById('panel-' + target).classList.add('active');

            // lazy-load panels
            if (!loaded[target]) {
                loaded[target] = true;
                switch (target) {
                    case 'workflow': initWorkflow(); break;
                    case 'monitor': initMonitor(); break;
                    case 'cron': initCron(); break;
                    case 'editor': initEditor(); break;
                }
            }
        });
    });

    // auto-load first tab
    initWorkflow();
    loaded['workflow'] = true;
});
