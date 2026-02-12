// OpenClaw Dashboard - Interactive Features

// Model switching
function switchModel(el) {
    document.querySelectorAll('.model-item').forEach(item => item.classList.remove('active'));
    el.classList.add('active');
    const modelName = el.querySelector('.model-name').textContent;
    showToast(`已切换到 ${modelName}`);
}

// Toast notification
function showToast(message) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    Object.assign(toast.style, {
        position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%) translateY(20px)',
        padding: '12px 24px', borderRadius: '12px', fontSize: '13px', fontWeight: '500',
        background: 'rgba(76,175,80,0.9)', color: '#fff', zIndex: '1000',
        backdropFilter: 'blur(10px)', boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
        opacity: '0', transition: 'all 0.3s ease', fontFamily: 'Inter, sans-serif'
    });
    document.body.appendChild(toast);

    requestAnimationFrame(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateX(-50%) translateY(0)';
    });

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(-50%) translateY(20px)';
        setTimeout(() => toast.remove(), 300);
    }, 2000);
}

// Intersection Observer for scroll animations
const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.style.animationPlayState = 'running';
            observer.unobserve(entry.target);
        }
    });
}, { threshold: 0.1 });

document.querySelectorAll('.card').forEach(card => {
    card.style.animationPlayState = 'paused';
    observer.observe(card);
});

// Live clock in header
function updateTime() {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Singapore' });
    const el = document.querySelector('.header-sub');
    if (el) {
        el.textContent = `酒酒的控制面板 · SGT ${timeStr}`;
    }
}
updateTime();
setInterval(updateTime, 60000);

// Tool chip hover effect
document.querySelectorAll('.tool-chip').forEach(chip => {
    chip.addEventListener('mouseenter', () => {
        chip.style.transform = 'scale(1.05)';
        chip.style.transition = 'transform 0.2s ease';
    });
    chip.addEventListener('mouseleave', () => {
        chip.style.transform = 'scale(1)';
    });
});

console.log('🍷 酒酒仪表盘已加载');
