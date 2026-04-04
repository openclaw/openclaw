# AI 禮包系統完整實作計劃

## 🎯 專案目標

建立一個多禮包管理系統，透過密碼驗證進入不同的客製化禮包頁面。

**核心特色：**
- 單一入口網址：`https://thinker.cafe/ai/gift`
- 密碼驗證系統，支援 50+ 個不同禮包
- 每個禮包完全客製化（獨立 HTML + JSON 配置）
- 下拉選單降低 0 基礎用戶門檻
- 過期管理、追蹤、Email 收集

---

## 📂 最終檔案結構

```
public/ai/
├── gift.html                    # 主頁面（驗證入口）
├── gift-index.json              # 密碼索引檔
├── gift-config.json             # 所有禮包配置（Cruz 提供）
├── gift-app.js                  # 共用邏輯（我們開發）
├── gift-styles.css              # 共用樣式（我們開發）
└── templates/
    ├── gift_CRUZ2025_20250131_普發1萬的11門課廣告禮包.html
    ├── gift_GROW2025_20250228_IG直播限定效率包.html
    └── ... (50+ 個 HTML 框架，Cruz 提供)
```

---

## 🔧 實作步驟

### Phase 1: 基礎架構建立

#### 步驟 1.1：建立 `public/ai/gift.html`（驗證入口）

**功能需求：**
- 顯示密碼輸入表單
- 驗證密碼（查找 `gift-index.json`）
- 錯誤提示
- 跳轉到對應 HTML 框架

**參考範本：**
```html
<!DOCTYPE html>
<html lang="zh-TW">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI 禮包 | ThinkerCafe</title>
    <meta name="robots" content="noindex, nofollow">
    <link rel="stylesheet" href="/ai/gift-styles.css">
</head>
<body>
    <div class="container">
        <div id="verify-page" class="card fade-in">
            <div class="verify-box">
                <h1>🎁 AI 禮包</h1>
                <p class="subtitle">請輸入你的專屬密碼</p>

                <input
                    type="text"
                    id="access-code"
                    placeholder="請輸入密碼"
                    maxlength="20"
                    autocomplete="off"
                >
                <div id="verify-error" class="error hidden">密碼錯誤或禮包不存在</div>

                <button class="btn" onclick="verifyAccess()">進入禮包</button>
            </div>
        </div>
    </div>

    <script>
        async function verifyAccess() {
            const password = document.getElementById('access-code').value.trim().toUpperCase();
            const errorDiv = document.getElementById('verify-error');

            try {
                // 查找索引
                const index = await fetch('/ai/gift-index.json').then(r => r.json());
                const htmlFile = index[password];

                if (!htmlFile) {
                    errorDiv.classList.remove('hidden');
                    return;
                }

                // 儲存密碼到 localStorage
                localStorage.setItem('gift_password', password);

                // 跳轉到對應的 HTML 框架
                window.location.href = `/ai/templates/${htmlFile}`;
            } catch (error) {
                console.error('驗證錯誤:', error);
                errorDiv.classList.remove('hidden');
            }
        }

        // Enter 鍵支援
        document.getElementById('access-code')?.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                verifyAccess();
            }
        });
    </script>
</body>
</html>
```

#### 步驟 1.2：建立 `public/ai/gift-index.json`（密碼索引）

**格式規範：**
```json
{
  "PASSWORD": "gift_PASSWORD_YYYYMMDD_描述.html"
}
```

**初始範例：**
```json
{
  "CRUZ2025": "gift_CRUZ2025_20250131_普發1萬的11門課廣告禮包.html",
  "GROW2025": "gift_GROW2025_20250228_IG直播限定效率包.html",
  "WRITE2025": "gift_WRITE2025_false_電子報訂閱者內容創作包.html",
  "VIP2025": "gift_VIP2025_20250115_VIP客戶專屬全能包.html"
}
```

#### 步驟 1.3：建立 `public/ai/gift-styles.css`（共用樣式）

**來源：**
- 從現有 `docs/gift-fortune.html` 抽取所有 `<style>` 內容
- 增加下拉選單樣式
- 增加範本按鈕樣式

**新增樣式：**
```css
/* 下拉選單 */
select {
    width: 100%;
    padding: 12px;
    border: 2px solid #ddd;
    border-radius: 8px;
    font-size: 1em;
    font-family: inherit;
    background: white;
    cursor: pointer;
    transition: border-color 0.2s;
}

select:focus {
    outline: none;
    border-color: #667eea;
}

select:hover {
    border-color: #aaa;
}

/* 範本按鈕 */
.template-btn {
    padding: 8px 16px;
    background: #f8f9fa;
    border: 2px solid #ddd;
    border-radius: 8px;
    font-size: 0.9em;
    cursor: pointer;
    margin-right: 8px;
    margin-bottom: 8px;
    transition: all 0.2s;
}

.template-btn:hover {
    background: white;
    border-color: #667eea;
    color: #667eea;
}

.template-btn:active {
    transform: scale(0.98);
}

/* 自訂輸入框（隱藏狀態） */
.custom-input {
    margin-top: 10px;
}
```

---

### Phase 2: 動態渲染邏輯

#### 步驟 2.1：建立 `public/ai/gift-app.js`（核心邏輯）

**功能模組清單：**

```javascript
// ===== 全域變數 =====
let currentGiftConfig = null;
let currentGift = '';
let userEmail = '';
let completedPrompts = 0;

// ===== 初始化 =====
async function initGiftPage() {
    const password = localStorage.getItem('gift_password');
    if (!password) {
        window.location.href = '/ai/gift';
        return;
    }

    try {
        const allConfigs = await fetch('/ai/gift-config.json').then(r => r.json());
        const config = allConfigs[password];

        if (!config) {
            alert('配置檔案錯誤');
            window.location.href = '/ai/gift';
            return;
        }

        // 檢查過期
        if (config.meta.expires !== 'false' && new Date() > new Date(config.meta.expires)) {
            showExpired();
            return;
        }

        // 儲存配置
        currentGiftConfig = config;

        // 渲染頁面
        renderPage(config);

        // 追蹤
        trackEvent('gift_page_loaded', {
            password: password,
            source: config.meta.source
        });
    } catch (error) {
        console.error('載入配置失敗:', error);
        alert('系統錯誤，請重新整理');
    }
}

// ===== 渲染頁面 =====
function renderPage(config) {
    // 更新標題
    document.getElementById('gift-title').textContent = config.meta.title;
    document.getElementById('gift-subtitle').textContent = config.meta.subtitle;

    // 顯示對應的禮包選項
    updateAvailableGifts(config.gifts);
}

// ===== 顯示/隱藏禮包選項 =====
function updateAvailableGifts(allowedGifts) {
    const allGifts = ['efficiency', 'content', 'decision'];
    allGifts.forEach(gift => {
        const element = document.querySelector(`[data-gift-type="${gift}"]`);
        if (element) {
            if (allowedGifts.includes(gift)) {
                element.style.display = 'block';
            } else {
                element.style.display = 'none';
            }
        }
    });
}

// ===== 選擇禮包 =====
function selectGift(giftType) {
    currentGift = giftType;

    // 隱藏選擇頁面，顯示體驗頁面
    document.getElementById('select-page').classList.add('hidden');
    document.getElementById('experience-page').classList.remove('hidden');

    // 動態生成表單
    generateAllForms(giftType);

    trackEvent('gift_selected', { gift_type: giftType });
}

// ===== 動態生成所有提示詞的表單 =====
function generateAllForms(giftType) {
    const prompts = currentGiftConfig.prompts[giftType];
    if (!prompts) return;

    Object.keys(prompts).forEach((promptKey, index) => {
        const promptNum = index + 1;
        const promptConfig = prompts[promptKey];

        // 更新標題和場景
        document.querySelector(`#prompt-${promptNum} h3`).textContent = promptConfig.title;
        document.querySelector(`#prompt-${promptNum} .scenario`).innerHTML =
            `<strong>場景：</strong>${promptConfig.scenario}`;

        // 生成表單欄位
        const fieldsContainer = document.querySelector(`#prompt-${promptNum} .input-fields`);
        fieldsContainer.innerHTML = '';

        promptConfig.fields.forEach(field => {
            const formGroup = createFormField(field, promptNum);
            fieldsContainer.appendChild(formGroup);
        });
    });
}

// ===== 建立表單欄位 =====
function createFormField(fieldConfig, promptNum) {
    const div = document.createElement('div');
    div.className = 'input-group';

    const label = document.createElement('label');
    label.textContent = fieldConfig.label;
    div.appendChild(label);

    if (fieldConfig.type === 'select') {
        // 下拉選單
        const select = document.createElement('select');
        select.id = `input-${promptNum}-${fieldConfig.id}`;

        // 預設選項
        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = '請選擇...';
        select.appendChild(defaultOption);

        // 一般選項
        fieldConfig.options.forEach(option => {
            const opt = document.createElement('option');
            opt.value = option;
            opt.textContent = option;
            select.appendChild(opt);
        });

        div.appendChild(select);

        // 如果最後一個選項是「其他」，加入自訂輸入框
        if (fieldConfig.options[fieldConfig.options.length - 1] === '其他') {
            const customInput = document.createElement('input');
            customInput.type = 'text';
            customInput.id = `input-${promptNum}-${fieldConfig.id}-custom`;
            customInput.className = 'hidden custom-input';
            customInput.placeholder = '請輸入...';
            div.appendChild(customInput);

            // 監聽選單變化
            select.addEventListener('change', function() {
                if (this.value === '其他') {
                    customInput.classList.remove('hidden');
                    customInput.focus();
                } else {
                    customInput.classList.add('hidden');
                }
            });
        }
    } else if (fieldConfig.type === 'textarea') {
        // 文字區域
        const textarea = document.createElement('textarea');
        textarea.id = `input-${promptNum}-${fieldConfig.id}`;
        textarea.placeholder = fieldConfig.placeholder || '';
        div.appendChild(textarea);
    } else {
        // 一般輸入框
        const input = document.createElement('input');
        input.type = 'text';
        input.id = `input-${promptNum}-${fieldConfig.id}`;
        input.placeholder = fieldConfig.placeholder || '';
        div.appendChild(input);
    }

    return div;
}

// ===== 生成提示詞 =====
function generatePrompt(promptNum) {
    const giftType = currentGift;
    const promptConfig = currentGiftConfig.prompts[giftType][`prompt${promptNum}`];
    let template = promptConfig.promptTemplate;

    // 取得所有欄位值
    promptConfig.fields.forEach(field => {
        let value = '';
        const selectElement = document.getElementById(`input-${promptNum}-${field.id}`);

        if (field.type === 'select' && selectElement.value === '其他') {
            // 使用自訂輸入的值
            const customInput = document.getElementById(`input-${promptNum}-${field.id}-custom`);
            value = customInput.value || '請填寫';
        } else {
            value = selectElement.value || field.placeholder || '請填寫';
        }

        // 替換模板變數
        template = template.replace(`{${field.id}}`, value);
    });

    // 顯示結果
    document.getElementById(`prompt-${promptNum}-text`).textContent = template;
    document.getElementById(`result-${promptNum}`).classList.remove('hidden');
    document.getElementById(`hint-${promptNum}`).classList.remove('hidden');

    // 更新進度
    completedPrompts = Math.max(completedPrompts, promptNum);
    updateProgress();

    // 第一個提示詞完成後顯示 Email Gate
    if (promptNum === 1) {
        setTimeout(() => {
            document.getElementById('email-gate-1').classList.remove('hidden');
        }, 500);
    }

    // 第二個提示詞完成後顯示「解鎖第三個」按鈕
    if (promptNum === 2) {
        setTimeout(() => {
            document.getElementById('next-2').classList.remove('hidden');
        }, 500);
    }

    // 第三個提示詞完成後顯示「完成」按鈕
    if (promptNum === 3) {
        setTimeout(() => {
            document.getElementById('complete-btn').classList.remove('hidden');
        }, 500);
    }

    trackEvent('prompt_generated', {
        gift_type: giftType,
        prompt_num: promptNum
    });
}

// ===== 複製提示詞 =====
function copyPrompt(promptNum) {
    const promptText = document.getElementById(`prompt-${promptNum}-text`).textContent;
    const btn = event.target;

    navigator.clipboard.writeText(promptText).then(() => {
        const originalText = btn.textContent;
        btn.textContent = '已複製!';
        btn.classList.add('copied');

        setTimeout(() => {
            btn.textContent = originalText;
            btn.classList.remove('copied');
        }, 2000);

        trackEvent('prompt_copied', {
            gift_type: currentGift,
            prompt_num: promptNum
        });
    });
}

// ===== 範本按鈕功能 =====
function fillTemplate(templateType) {
    const templates = {
        'ecommerce': '1. 每天檢查 5 個競品網站的價格變化\n2. 從後台匯出訂單資料，整理到 Excel 表格\n3. 回覆 10-20 封格式相似的客服問題',
        'marketing': '1. 每天發布 3 則社群貼文（FB、IG、LinkedIn）\n2. 從各平台匯出數據，整理成每週報表\n3. 追蹤 5 個競品的廣告投放和內容策略',
        'admin': '1. 審核員工的請假申請並更新系統\n2. 整理會議記錄，發送給參與者\n3. 更新專案進度到管理系統（Jira、Trello 等）'
    };

    // 找到對應的 textarea（假設是提示詞 3 的第二個欄位）
    const textarea = document.querySelector('#prompt-3 textarea');
    if (textarea) {
        textarea.value = templates[templateType];
    }
}

// ===== 提交 Email =====
function submitEmail() {
    const email = document.getElementById('user-email').value.trim();
    const errorDiv = document.getElementById('email-error');

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailRegex.test(email)) {
        errorDiv.classList.remove('hidden');
        return;
    }

    errorDiv.classList.add('hidden');
    userEmail = email;

    // 隱藏 Email Gate，顯示第二個提示詞
    document.getElementById('email-gate-1').classList.add('hidden');
    showPrompt(2);

    // TODO: 提交到後端 (Supabase)
    console.log('提交 Email:', email);

    trackEvent('email_submitted', {
        email: email,
        gift_type: currentGift,
        completed_prompts: completedPrompts
    });
}

// ===== 顯示下一個提示詞 =====
function showPrompt(promptNum) {
    document.getElementById(`prompt-${promptNum}`).classList.remove('hidden');

    setTimeout(() => {
        document.getElementById(`prompt-${promptNum}`).scrollIntoView({
            behavior: 'smooth',
            block: 'start'
        });
    }, 100);
}

// ===== 更新進度條 =====
function updateProgress() {
    const percentage = (completedPrompts / 3) * 100;
    document.getElementById('progress-fill').style.width = percentage + '%';
    document.getElementById('progress-num').textContent = completedPrompts;
}

// ===== 顯示過期頁面 =====
function showExpired() {
    document.body.innerHTML = `
        <div class="container">
            <div class="card" style="text-align: center; padding: 60px 20px;">
                <div style="font-size: 4em; margin-bottom: 20px;">⏰</div>
                <h1>此禮包已過期</h1>
                <p class="subtitle" style="margin: 20px 0;">限量已領完，敬請期待下次活動！</p>
                <a href="https://thinker.cafe/products" class="btn">查看所有課程</a>
            </div>
        </div>
    `;
}

// ===== 顯示完成頁面 =====
function goToCompletion() {
    document.getElementById('experience-page').classList.add('hidden');
    document.getElementById('completion-page').classList.remove('hidden');

    window.scrollTo({ top: 0, behavior: 'smooth' });

    trackEvent('all_prompts_completed', {
        gift_type: currentGift,
        email: userEmail
    });
}

// ===== 事件追蹤 =====
function trackEvent(eventName, data) {
    console.log('追蹤事件:', eventName, data);

    // Google Analytics 4
    if (typeof gtag !== 'undefined') {
        gtag('event', eventName, data);
    }
}

// ===== 頁面載入完成 =====
window.addEventListener('load', function() {
    if (typeof initGiftPage === 'function') {
        initGiftPage();
    }
});
```

---

### Phase 3: HTML 框架改版

#### 步驟 3.1：改版 `docs/gift-fortune.html`

**改動重點：**
1. 移除 `<style>` 區塊，改用 `<link rel="stylesheet" href="/ai/gift-styles.css">`
2. 移除驗證頁面（第一步）
3. 保留選擇禮包頁面（第二步）
4. 保留體驗頁面（第三步）
5. 保留完成頁面（第四步）
6. 移除內嵌的 `<script>`，改用 `<script src="/ai/gift-app.js"></script>`
7. 在每個輸入欄位的 `.input-group` 中增加 `class="input-fields"` 容器，方便 JS 動態生成

**改版後的結構：**
```html
<!DOCTYPE html>
<html lang="zh-TW">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI 禮包 | ThinkerCafe</title>
    <meta name="robots" content="noindex, nofollow">
    <link rel="stylesheet" href="/ai/gift-styles.css">
</head>
<body>
    <div class="container">

        <!-- 第二步：選擇禮包 -->
        <div id="select-page" class="card">
            <h1 id="gift-title">選擇你的發財路線</h1>
            <p id="gift-subtitle" class="subtitle">三條路線，各有 3 個實戰提示詞。選一條最適合你的開始吧!</p>

            <div class="gift-cards">
                <div class="gift-card" data-gift-type="efficiency" onclick="selectGift('efficiency')">
                    <div class="icon">⏰</div>
                    <h3>AI 效率淘金包</h3>
                    <div class="target">適合：忙碌上班族、專案經理</div>
                    <div class="preview">
                        ✓ 20 頁報告秒變 3 句重點<br>
                        ✓ 會議錄音自動生成行動清單<br>
                        ✓ 找出最值得自動化的工作
                    </div>
                </div>

                <div class="gift-card" data-gift-type="content" onclick="selectGift('content')">
                    <div class="icon">✍️</div>
                    <h3>AI 內容印鈔機</h3>
                    <div class="target">適合：創作者、行銷人員、小編</div>
                    <div class="preview">
                        ✓ 萃取你的個人寫作風格<br>
                        ✓ 一個想法變 5 天內容<br>
                        ✓ 快速生成爆款視覺圖
                    </div>
                </div>

                <div class="gift-card" data-gift-type="decision" onclick="selectGift('decision')">
                    <div class="icon">🧠</div>
                    <h3>AI 決策智囊團</h3>
                    <div class="target">適合：創業者、高階主管、策略規劃者</div>
                    <div class="preview">
                        ✓ AI 魔鬼代言人壓力測試<br>
                        ✓ 多角色決策圓桌會議<br>
                        ✓ 偵察競品致命弱點
                    </div>
                </div>
            </div>
        </div>

        <!-- 第三步：互動式體驗 -->
        <div id="experience-page" class="card hidden">
            <div class="progress-bar">
                <div id="progress-fill" class="progress-fill" style="width: 0%"></div>
            </div>
            <div class="progress-text">已完成 <span id="progress-num">0</span>/3 個提示詞</div>

            <!-- 提示詞 1 -->
            <div id="prompt-1" class="prompt-step">
                <h3>提示詞 1</h3>
                <div class="scenario">
                    <strong>場景：</strong>（由 JS 動態填充）
                </div>

                <div class="input-fields">
                    <!-- 由 JS 動態生成 -->
                </div>

                <button class="btn" onclick="generatePrompt(1)">生成我的專屬提示詞</button>

                <div id="result-1" class="prompt-result hidden">
                    <button class="copy-btn" onclick="copyPrompt(1)">複製</button>
                    <pre id="prompt-1-text"></pre>
                </div>

                <div id="hint-1" class="hint hidden">
                    ✅ 提示詞已生成! 複製後前往 <a href="https://chatgpt.com" target="_blank" style="color: #667eea; font-weight: bold;">ChatGPT</a> 貼上使用
                </div>

                <!-- Email Gate -->
                <div id="email-gate-1" class="email-gate hidden">
                    <h2>🎉 想解鎖剩下 2 個提示詞？</h2>
                    <p class="subtitle">留下 email，完整禮包與早鳥優惠將發送給你</p>

                    <input
                        type="email"
                        id="user-email"
                        placeholder="your@email.com"
                        required
                    >

                    <button class="btn" onclick="submitEmail()">解鎖剩下的提示詞</button>
                    <div id="email-error" class="error hidden">請輸入有效的 email</div>
                </div>
            </div>

            <!-- 提示詞 2 -->
            <div id="prompt-2" class="prompt-step hidden">
                <h3>提示詞 2</h3>
                <div class="scenario">
                    <strong>場景：</strong>（由 JS 動態填充）
                </div>

                <div class="input-fields">
                    <!-- 由 JS 動態生成 -->
                </div>

                <button class="btn" onclick="generatePrompt(2)">生成我的專屬提示詞</button>

                <div id="result-2" class="prompt-result hidden">
                    <button class="copy-btn" onclick="copyPrompt(2)">複製</button>
                    <pre id="prompt-2-text"></pre>
                </div>

                <div id="hint-2" class="hint hidden">
                    ✅ 又省下 30 分鐘整理時間!
                </div>

                <div id="next-2" class="hidden" style="margin-top: 20px; text-align: center;">
                    <button class="btn" onclick="showPrompt(3)">解鎖最後一個提示詞 →</button>
                </div>
            </div>

            <!-- 提示詞 3 -->
            <div id="prompt-3" class="prompt-step hidden">
                <h3>提示詞 3</h3>
                <div class="scenario">
                    <strong>場景：</strong>（由 JS 動態填充）
                </div>

                <div class="input-fields">
                    <!-- 由 JS 動態生成 -->
                </div>

                <button class="btn" onclick="generatePrompt(3)">生成我的專屬提示詞</button>

                <div id="result-3" class="prompt-result hidden">
                    <button class="copy-btn" onclick="copyPrompt(3)">複製</button>
                    <pre id="prompt-3-text"></pre>
                </div>

                <div id="hint-3" class="hint hidden">
                    🎯 這個分析將幫你找到最值得投資的自動化項目!
                </div>

                <div id="complete-btn" class="hidden" style="margin-top: 30px; text-align: center;">
                    <button class="btn" onclick="goToCompletion()">查看完整禮包與課程優惠 →</button>
                </div>
            </div>
        </div>

        <!-- 第四步：完成頁面 -->
        <div id="completion-page" class="card hidden">
            <div class="completion">
                <div class="icon">🎉</div>
                <h1>恭喜!你已解鎖全部 3 個提示詞</h1>
                <p class="subtitle">完整禮包 PDF 已發送到你的信箱<br>接下來，要不要升級你的 AI 協作能力？</p>

                <div class="cta-box">
                    <h3>🚀 人生駭客手冊：AI 時代生存指南</h3>
                    <p>從痛點到自動化，從思考到執行<br>11 門課程，打造你的 AI 作業系統</p>

                    <div class="price">
                        <span class="original-price">NT$ 9,800</span><br>
                        早鳥優惠 NT$ 4,980
                    </div>

                    <a href="https://thinker.cafe/products" class="btn btn-cta">立即查看課程</a>
                </div>

                <div class="hint">
                    💡 這個禮包只是開始。真正的價值，在於建立一套屬於你自己的 AI 協作系統。
                </div>
            </div>
        </div>

    </div>

    <script src="/ai/gift-app.js"></script>
</body>
</html>
```

#### 步驟 3.2：建立範本檔 `public/ai/templates/gift_TEMPLATE.html`

**說明：**
- 複製改版後的 HTML 作為範本
- Cruz 可以基於此範本建立新的禮包 HTML
- 只需複製並重新命名即可

---

### Phase 4: JSON 配置規範

#### 步驟 4.1：設計 `gift-config.json` 格式規範

請參考 `GIFT_CONFIG_GUIDE.md`（下一個文檔）

#### 步驟 4.2：建立範例配置

```json
{
  "CRUZ2025": {
    "meta": {
      "password": "CRUZ2025",
      "title": "🎁 AI 發財提示詞禮包",
      "subtitle": "感謝你在 Reels 留下「有趣」！",
      "description": "普發1萬的11門課廣告禮包",
      "expires": "2025-01-31",
      "source": "fb-ad-jan"
    },
    "gifts": ["efficiency", "content", "decision"],
    "prompts": {
      "efficiency": {
        "prompt1": {
          "title": "20 頁報告 → 3 句重點",
          "scenario": "老闆丟來一份 20 頁的報告，10 分鐘後就要開會。",
          "fields": [
            {
              "id": "role",
              "label": "你的角色是？",
              "type": "select",
              "options": ["產品經理", "行銷主管", "專案經理", "業務主管", "財務分析師", "其他"]
            },
            {
              "id": "goal",
              "label": "你需要從報告中看出什麼？",
              "type": "select",
              "options": ["市場機會和潛在風險", "競爭對手分析", "財務健康度評估", "技術可行性", "用戶需求洞察", "其他"]
            },
            {
              "id": "content",
              "label": "貼上報告內容（或摘要）",
              "type": "textarea",
              "placeholder": "貼上報告內容..."
            }
          ],
          "promptTemplate": "想像你是 {role}，老闆只給你 10 分鐘，要你從這份報告裡抓出「能賺錢的機會」和「會踩雷的風險」。\n\n分析角度：{goal}\n\n請用投資人的角度來分析，只關注 ROI 和風險。\n\n文本：\n{content}"
        },
        "prompt2": {
          "title": "會議錄音 → 行動清單",
          "scenario": "剛開完 1 小時的腦力激盪會議，內容雜亂無章。",
          "fields": [
            {
              "id": "topic",
              "label": "會議主題是？",
              "type": "select",
              "options": ["Q4 行銷策略討論", "新產品開發會議", "客戶需求訪談", "團隊復盤會議", "預算規劃會議", "其他"]
            },
            {
              "id": "content",
              "label": "貼上會議逐字稿或重點記錄",
              "type": "textarea",
              "placeholder": "貼上會議內容..."
            }
          ],
          "promptTemplate": "會議開了 1 小時，但有用的結論只有 3 分鐘。這是一份「{topic}」的會議逐字稿。\n\n請幫我：\n1. **摘要：** 用 3 句話總結會議核心\n2. **決議事項：** 列出所有已達成的共識\n3. **行動清單 (To-Do List)：** 格式為「[任務] - [負責人] - [截止日期]」\n\n逐字稿：\n{content}"
        },
        "prompt3": {
          "title": "工作流自動化啟發",
          "scenario": "每天都在做重複的雜事，想自動化卻沒頭緒。",
          "fields": [
            {
              "id": "role",
              "label": "你的職位是？",
              "type": "select",
              "options": ["電商營運專員", "行政助理", "社群小編", "客服人員", "數據分析師", "其他"]
            },
            {
              "id": "tasks",
              "label": "列出你每天的 3 個重複任務",
              "type": "textarea",
              "placeholder": "1. 檢查 5 個競品網站的價格\n2. 整理客戶訂單到 Excel\n3. 回覆相似的客服問題",
              "templates": ["ecommerce", "marketing", "admin"]
            }
          ],
          "promptTemplate": "我是一名 {role}，我每天的重複任務有：\n\n{tasks}\n\n請擔任 AI 自動化顧問，分析上述任務：\n1. 哪一項最適合用 AI 自動化？\n2. 為什麼？（ROI 最高、最容易實現？）\n3. 要實現這個自動化，我的第一步該做什麼？\n\n請給我具體的行動建議，而不是空泛的概念。"
        }
      }
    }
  }
}
```

---

### Phase 5: 整合與測試

#### 步驟 5.1：Next.js 路由設定

編輯 `next.config.mjs`：
```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: '/ai/gift',
        destination: '/ai/gift.html',
      },
    ];
  },
  // ... 其他設定
};

export default nextConfig;
```

#### 步驟 5.2：robots.txt 設定

編輯 `public/robots.txt`：
```
User-agent: *
Disallow: /ai/
```

#### 步驟 5.3：測試清單

- [ ] **密碼驗證**
  - [ ] 輸入正確密碼 → 跳轉到對應 HTML
  - [ ] 輸入錯誤密碼 → 顯示錯誤訊息
  - [ ] 輸入過期密碼 → 顯示過期頁面

- [ ] **禮包選擇**
  - [ ] 只顯示配置中指定的禮包選項
  - [ ] 點擊禮包 → 進入體驗頁面

- [ ] **動態表單**
  - [ ] 表單欄位根據 JSON 配置正確生成
  - [ ] 下拉選單選「其他」→ 顯示自訂輸入框
  - [ ] 範本按鈕 → 正確填入範例

- [ ] **提示詞生成**
  - [ ] 生成的提示詞正確替換變數
  - [ ] 複製按鈕功能正常

- [ ] **Email 收集**
  - [ ] Email 格式驗證
  - [ ] 提交後解鎖第二個提示詞

- [ ] **追蹤功能**
  - [ ] 所有事件正確觸發
  - [ ] Console 顯示追蹤資訊

- [ ] **響應式設計**
  - [ ] 手機版體驗流暢
  - [ ] 選單、按鈕、輸入框正常運作

---

### Phase 6: 部署與文檔

#### 步驟 6.1：部署到 Vercel

```bash
git add public/ai/ next.config.mjs public/robots.txt
git commit -m "feat: 建立 AI 禮包系統"
git push
```

#### 步驟 6.2：建立文檔

- `README_GIFT_SYSTEM.md` - 系統說明
- `GIFT_CONFIG_GUIDE.md` - 配置檔指南
- `HTML_TEMPLATE_GUIDE.md` - HTML 框架指南

---

## 📋 交付清單

### 技術團隊開發：
- [ ] `public/ai/gift.html` - 驗證入口
- [ ] `public/ai/gift-app.js` - 核心邏輯
- [ ] `public/ai/gift-styles.css` - 共用樣式
- [ ] `public/ai/gift-index.json` - 索引範例
- [ ] `public/ai/templates/gift_TEMPLATE.html` - HTML 框架範本
- [ ] `next.config.mjs` - 路由設定
- [ ] `public/robots.txt` - SEO 設定
- [ ] 文檔（3 份）

### Cruz 提供：
- [ ] `public/ai/gift-config.json` - 完整配置
- [ ] 各禮包的 HTML 框架（基於範本）
- [ ] 內容策略（提示詞、選項、文案）

---

## 🚀 使用流程

### Cruz 新增禮包：
1. 複製 `gift_TEMPLATE.html` → 重新命名為 `gift_NEWPASS_20250131_描述.html`
2. 在 `gift-config.json` 新增配置
3. 在 `gift-index.json` 新增密碼對應
4. Git commit & push

### 用戶使用：
1. 訪問 `https://thinker.cafe/ai/gift`
2. 輸入密碼（例如：NEWPASS）
3. 系統載入對應 HTML + JSON 配置
4. 互動體驗 → Email 收集 → 完成

### 數據追蹤：
- Google Analytics 事件追蹤
- Supabase Email 收集（待串接）
- 後台查看各禮包使用情況

---

## ⚠️ 注意事項

1. **安全性：**
   - `/ai/` 路徑不被搜尋引擎收錄
   - 密碼驗證在前端（適合引流，非高安全需求）
   - 過期禮包自動失效

2. **效能：**
   - `gift-config.json` 可能會變大，考慮分檔或壓縮
   - HTML 框架共用 CSS/JS，減少重複載入

3. **維護性：**
   - 配置檔格式統一，方便管理
   - HTML 框架基於範本，降低出錯率
   - 文檔完善，未來可交接

---

## ✅ 驗收標準

- [ ] 可以用密碼進入不同禮包
- [ ] 每個禮包的內容完全客製化
- [ ] 下拉選單「其他」功能正常
- [ ] 範本按鈕能填充範例
- [ ] 提示詞生成正確
- [ ] Email 收集與追蹤功能運作
- [ ] 過期禮包無法訪問
- [ ] 手機版體驗流暢
- [ ] 文檔完整，Cruz 能自行新增禮包
