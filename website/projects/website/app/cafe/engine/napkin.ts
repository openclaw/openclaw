// ── Napkin (餐巾紙神諭) ───────────────────────────────────────

const Napkin = {
  quotes: [
    '有些 bug 不需要修，它會長成 feature。',
    '你今天寫的 code，十年後沒人記得。但你今天沒睡的覺，身體替你記著。',
    '最難的不是找到答案，是承認問題不存在。',
    '如果你在這裡看到這段話，代表你今天至少做對了一件事——你停下來了。',
    '公司倒了可以再開。但你給孩子的那個眼神，收不回來。',
    '恐慌發作不是身體在背叛你。是它終於有機會開口說話了。',
    '一人公司最大的敵人不是市場，是那個凌晨兩點懷疑自己的你。',
    '代碼可以重構。童年不行。',
    '你以為你在做產品，其實你在做自己的倒影。',
    '不是所有的 pivot 都叫放棄。有些叫做看清楚了。',
    '最好的 API 文件是讓對方根本不需要問你。最好的關係也是。',
    '你離開菲律賓的那天，你帶走的不只是行李。',
    '深呼吸不是在逃跑。是在補給。',
    '當你開始覺得「反正沒差」，那才是真正的警報。',
    '有些人進你的生命是來當 dependency 的，不是 collaborator。',
    '不要把「我很忙」當成人格。',
    '你不需要先解決所有問題才能休息。',
    '數據會說謊。但沉默從不撒謊。',
    '最貴的技術債不是在 codebase 裡，是在關係裡。',
    '你建了多少個系統，就逃避了多少個對話。',
    '孩子不記得你說了什麼，但他記得你在不在。',
    '把 commit 記錄想成日記。你願意讓誰看？',
    '凌晨三點的想法不一定錯，但凌晨三點不是做決定的時候。',
    '自動化了一切，卻忘了自動化休息。',
    '有些對話只能在咖啡廳的角落裡說。這裡算。',
    '不是所有的沉默都是冷漠，有些是在聽你說話之前先把自己清空。',
    '你怕的不是失敗，是失敗之後那個解釋給自己聽的夜晚。',
    '越精密的系統，越怕那顆沒接好的線。你知道你的那顆在哪裡。',
    '讓事情 work 很容易，讓它優雅地 work 需要一種你在某個下午突然明白的東西。',
    '你今天還在這裡。這已經是答案了。',
  ] as string[],

  getDayQuote(): string {
    const now = new Date();
    const start = new Date(now.getFullYear(), 0, 0);
    const diff = now.getTime() - start.getTime();
    const dayOfYear = Math.floor(diff / (1000 * 60 * 60 * 24));
    return this.quotes[dayOfYear % this.quotes.length];
  },

  hasSeenToday(): boolean {
    try {
      const stored = localStorage.getItem('cafe_napkin_date');
      const today = new Date().toISOString().slice(0, 10);
      return stored === today;
    } catch {
      return false;
    }
  },

  markSeen() {
    try {
      const today = new Date().toISOString().slice(0, 10);
      localStorage.setItem('cafe_napkin_date', today);
    } catch {
      /* silent */
    }
  },

  show() {
    if (this.hasSeenToday()) return;
    const el = document.getElementById('napkin-oracle');
    if (!el) return;
    const textEl = el.querySelector('.napkin-text') as HTMLElement | null;
    if (textEl) textEl.innerText = `「${this.getDayQuote()}」`;
    el.style.display = 'flex';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.classList.add('napkin-visible');
      });
    });
  },

  dismiss() {
    const el = document.getElementById('napkin-oracle');
    if (!el) return;
    this.markSeen();
    el.classList.remove('napkin-visible');
    el.classList.add('napkin-fly');
    setTimeout(() => {
      el.style.display = 'none';
      el.classList.remove('napkin-fly');
    }, 900);
  },
};

export default Napkin;
