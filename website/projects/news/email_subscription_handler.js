// Email 訂閱處理系統
// 用於網站表單提交到 Supabase

class EmailSubscriptionHandler {
    constructor() {
        // Supabase 配置 (使用環境變數或直接配置)
        this.supabaseUrl = 'https://ygcmxeimfjaivzdtzpct.supabase.co';
        this.supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlnY214ZWltZmphaXZ6ZHR6cGN0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg0NTI5MjYsImV4cCI6MjA3NDAyODkyNn0.qWA3Jj0muFqZbVx-3Jf2JKfb3Ch9Pb5VbpsU_nD8x5A';
    }

    async subscribeEmail(email, name = '', interests = []) {
        try {
            // 驗證 email 格式
            if (!this.validateEmail(email)) {
                throw new Error('請輸入有效的電子郵件地址');
            }

            // 使用統一的會員系統 JSON 結構
            const memberProfile = {
                // === 基本資料 ===
                identity: {
                    email: email.toLowerCase().trim(),
                    name: name.trim(),
                    member_id: `member_${Date.now()}_${email.split('@')[0]}`,
                    source: 'thinker_news_website',
                    registration_date: new Date().toISOString(),
                    status: 'active'
                },
                
                // === 訂閱偏好 ===
                subscription: {
                    email_notifications: true,
                    frequency: 'weekly',
                    interested_topics: interests,
                    content_formats: ['email', 'web'],
                    timezone: 'Asia/Taipei',
                    last_interaction: new Date().toISOString()
                },
                
                // === 個人化 AI 提示詞系統 ===
                ai_preferences: {
                    preferred_agents: ['007'],
                    communication_style: 'professional',
                    complexity_level: interests.includes('AI開發') ? 'intermediate' : 'beginner',
                    response_length: 'concise',
                    language: 'zh-TW',
                    custom_prompts: {
                        daily_insights: {
                            template: `請用專業的語調，為我總結今天的 ${interests.join('、')} 重點`,
                            active: true
                        }
                    }
                },
                
                // === 學習軌跡 ===
                learning_journey: {
                    skill_interests: interests,
                    current_goals: [],
                    completed_courses: [],
                    learning_style: 'visual',
                    progress_tracking: {
                        total_interactions: 1,
                        favorite_topics: interests.reduce((acc, topic) => {acc[topic] = 1; return acc;}, {}),
                        engagement_score: 1
                    }
                },
                
                // === CRM 資訊 ===
                crm_data: {
                    lifecycle_stage: 'subscriber',
                    value_score: 1,
                    churn_risk: 'low',
                    last_engagement: new Date().toISOString(),
                    total_value: 0,
                    interaction_history: [{
                        type: 'email_subscription',
                        date: new Date().toISOString(),
                        source: 'thinker_news_website'
                    }]
                }
            };
            
            const subscriptionData = {
                conversation_id: this.generateUUID(),
                content: JSON.stringify(memberProfile),
                importance: 5,
                category: 'member_profile',
                context: `Member profile for ${email.toLowerCase().trim()}`
            };
            
            // 不提供 id 欄位，讓 Supabase 自動生成 UUID

            const response = await fetch(`${this.supabaseUrl}/rest/v1/semantic_insights`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': this.supabaseAnonKey,
                    'Authorization': `Bearer ${this.supabaseAnonKey}`,
                    'Prefer': 'return=representation'
                },
                body: JSON.stringify(subscriptionData)
            });

            const result = await response.json();

            if (response.ok) {
                return {
                    success: true,
                    message: '🎉 訂閱成功！感謝您對學習洞察的興趣',
                    data: result
                };
            } else {
                // 處理重複訂閱
                if (result.code === '23505') { // unique_violation
                    return {
                        success: false,
                        message: '📧 此電子郵件已經訂閱了洞察更新',
                        code: 'already_subscribed'
                    };
                }
                throw new Error(result.message || '訂閱失敗，請稍後再試');
            }

        } catch (error) {
            console.error('訂閱錯誤:', error);
            return {
                success: false,
                message: error.message || '訂閱過程發生錯誤，請稍後再試',
                error: error
            };
        }
    }

    validateEmail(email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(email);
    }

    generateUUID() {
        // 生成 UUID v4 格式
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0;
            const v = c == 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    // 顯示訂閱表單
    showSubscriptionForm() {
        const formHtml = `
            <div id="subscription-modal" style="
                position: fixed; top: 0; left: 0; width: 100%; height: 100%;
                background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center;
                z-index: 1000; backdrop-filter: blur(5px);
            ">
                <div style="
                    background: white; padding: 40px; border-radius: 20px; max-width: 500px; width: 90%;
                    box-shadow: 0 20px 40px rgba(0,0,0,0.2); position: relative;
                ">
                    <button onclick="closeSubscriptionForm()" style="
                        position: absolute; top: 15px; right: 20px; background: none; border: none;
                        font-size: 24px; cursor: pointer; color: #999;
                    ">×</button>
                    
                    <h3 style="color: #667eea; margin-bottom: 20px; text-align: center;">
                        🧠 訂閱學習洞察
                    </h3>
                    
                    <p style="color: #666; margin-bottom: 25px; line-height: 1.6; text-align: center;">
                        獲得我們從教學經驗中提煉的深度思考，包含 AI 開發心得、團隊協作經驗與技術學習方法論。
                    </p>
                    
                    <form id="subscription-form" onsubmit="handleSubscription(event)">
                        <div style="margin-bottom: 20px;">
                            <label style="display: block; margin-bottom: 8px; color: #333; font-weight: 500;">
                                電子郵件 *
                            </label>
                            <input type="email" id="subscriber-email" required style="
                                width: 100%; padding: 12px; border: 2px solid #e1e5e9; border-radius: 10px;
                                font-size: 16px; box-sizing: border-box;
                            " placeholder="your@email.com">
                        </div>
                        
                        <div style="margin-bottom: 25px;">
                            <label style="display: block; margin-bottom: 8px; color: #333; font-weight: 500;">
                                姓名 (選填)
                            </label>
                            <input type="text" id="subscriber-name" style="
                                width: 100%; padding: 12px; border: 2px solid #e1e5e9; border-radius: 10px;
                                font-size: 16px; box-sizing: border-box;
                            " placeholder="您的姓名">
                        </div>
                        
                        <div style="margin-bottom: 25px;">
                            <label style="display: block; margin-bottom: 12px; color: #333; font-weight: 500;">
                                感興趣的主題 (可多選)
                            </label>
                            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                                <label style="display: flex; align-items: center; font-size: 14px;">
                                    <input type="checkbox" value="AI開發" style="margin-right: 8px;"> AI 開發心得
                                </label>
                                <label style="display: flex; align-items: center; font-size: 14px;">
                                    <input type="checkbox" value="團隊協作" style="margin-right: 8px;"> 團隊協作
                                </label>
                                <label style="display: flex; align-items: center; font-size: 14px;">
                                    <input type="checkbox" value="學習方法" style="margin-right: 8px;"> 學習方法論
                                </label>
                                <label style="display: flex; align-items: center; font-size: 14px;">
                                    <input type="checkbox" value="工具應用" style="margin-right: 8px;"> 工具應用
                                </label>
                            </div>
                        </div>
                        
                        <button type="submit" style="
                            width: 100%; padding: 15px; 
                            background: linear-gradient(45deg, #667eea, #764ba2);
                            color: white; border: none; border-radius: 10px;
                            font-size: 16px; font-weight: 600; cursor: pointer;
                            box-shadow: 0 4px 15px rgba(102, 126, 234, 0.3);
                        ">
                            📧 立即訂閱洞察更新
                        </button>
                    </form>
                    
                    <p style="color: #999; font-size: 12px; text-align: center; margin-top: 20px;">
                        📊 我們尊重您的隱私，可隨時取消訂閱
                    </p>
                </div>
            </div>
        `;
        
        document.body.insertAdjacentHTML('beforeend', formHtml);
    }
}

// 全域函數
const subscriptionHandler = new EmailSubscriptionHandler();

function showSubscriptionForm() {
    subscriptionHandler.showSubscriptionForm();
}

function closeSubscriptionForm() {
    const modal = document.getElementById('subscription-modal');
    if (modal) {
        modal.remove();
    }
}

async function handleSubscription(event) {
    event.preventDefault();
    
    const email = document.getElementById('subscriber-email').value;
    const name = document.getElementById('subscriber-name').value;
    
    // 收集選中的興趣主題
    const interests = Array.from(document.querySelectorAll('#subscription-form input[type="checkbox"]:checked'))
        .map(checkbox => checkbox.value);
    
    const submitButton = event.target.querySelector('button[type="submit"]');
    const originalText = submitButton.textContent;
    
    // 顯示載入狀態
    submitButton.textContent = '📤 訂閱中...';
    submitButton.disabled = true;
    
    try {
        const result = await subscriptionHandler.subscribeEmail(email, name, interests);
        
        if (result.success) {
            // 顯示成功訊息
            alert(result.message);
            closeSubscriptionForm();
        } else {
            alert(result.message);
            submitButton.textContent = originalText;
            submitButton.disabled = false;
        }
    } catch (error) {
        alert('訂閱過程發生錯誤，請稍後再試');
        submitButton.textContent = originalText;
        submitButton.disabled = false;
    }
}