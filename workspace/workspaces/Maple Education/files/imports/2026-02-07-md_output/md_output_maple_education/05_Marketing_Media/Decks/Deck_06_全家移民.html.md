---
title: "Deck_06_全家移民.html"
source_path: "05_Marketing_Media/Decks/Deck_06_全家移民.html"
tags: ["新加坡", "Maple", "html"]
ocr: false
---

# Deck_06_全家移民.html

简介：内容概述：<!DOCTYPE html>

## 内容

```text
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Maple Education - 新加坡全家移民方案</title>
    <style>
        @page { size: A4; margin: 0; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Microsoft YaHei', 'Segoe UI', sans-serif; background: #f5f5f5; color: #333; line-height: 1.6; }
        .page { width: 210mm; min-height: 297mm; margin: 20px auto; background: white; box-shadow: 0 0 20px rgba(0,0,0,0.1); overflow: hidden; page-break-after: always; }
        @media print { body { background: white; } .page { margin: 0; box-shadow: none; } }
        .cover { height: 297mm; background: linear-gradient(135deg, #1565C0 0%, #0D47A1 100%); color: white; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; padding: 40mm; }
        .cover h1 { font-size: 38px; font-weight: 700; margin-bottom: 20px; }
        .cover .subtitle { font-size: 20px; color: #FFD54F; margin-bottom: 30px; }
        .maple-icon { font-size: 80px; margin-bottom: 30px; }
        .logo { font-size: 24px; font-weight: 700; margin-bottom: 20px; }
        .badge { display: inline-block; background: #C1272D; color: white; padding: 10px 25px; border-radius: 30px; font-weight: 700; font-size: 16px; margin-top: 20px; }
        .tagline { font-size: 14px; opacity: 0.9; border-top: 1px solid rgba(255,255,255,0.3); padding-top: 30px; margin-top: 30px; }
        .content-page { padding: 15mm 20mm; min-height: 297mm; }
        .page-header { display: flex; justify-content: space-between; border-bottom: 3px solid #2C5AA0; padding-bottom: 10px; margin-bottom: 20px; }
        .page-header .brand { font-size: 14px; color: #2C5AA0; font-weight: 600; }
        h2 { color: #2C5AA0; font-size: 22px; margin-bottom: 15px; border-bottom: 2px solid #eee; padding-bottom: 10px; }
        h3 { color: #C1272D; font-size: 16px; margin: 15px 0 10px; }
        .pathway { display: flex; align-items: center; justify-content: space-around; margin: 20px 0; padding: 20px; background: linear-gradient(to right, #e3f2fd, #bbdefb); border-radius: 10px; }
        .pathway-step { text-align: center; padding: 15px; }
        .pathway-step .icon { font-size: 36px; margin-bottom: 10px; }
        .pathway-step .title { font-weight: 700; color: #1565C0; }
        .pathway-arrow { font-size: 24px; color: #1565C0; }
        .service-box { margin: 15px 0; padding: 15px; border-radius: 10px; }
        .service-box.company { background: #e8f5e9; border-left: 4px solid #4caf50; }
        .service-box.ep { background: #e3f2fd; border-left: 4px solid #2196f3; }
        .service-box.family { background: #fff3e0; border-left: 4px solid #ff9800; }
        .price-table { width: 100%; border-collapse: collapse; margin: 15px 0; font-size: 13px; }
        .price-table th, .price-table td { padding: 12px; border: 1px solid #dee2e6; }
        .price-table th { background: #2C5AA0; color: white; }
        .price-table .price { color: #C1272D; font-weight: 700; font-size: 15px; }
        .highlight-box { background: #fff8e1; border-left: 4px solid #FFD54F; padding: 15px; margin: 15px 0; border-radius: 0 8px 8px 0; font-size: 14px; }
        .requirements { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin: 15px 0; }
        .req-box { padding: 15px; background: #f5f5f5; border-radius: 8px; }
        .req-box h4 { color: #1565C0; margin-bottom: 10px; font-size: 14px; }
        .req-box ul { margin-left: 20px; font-size: 13px; }
        .feature-list { list-style: none; padding: 0; }
        .feature-list li { padding: 8px 0 8px 30px; position: relative; border-bottom: 1px dashed #eee; font-size: 14px; }
        .feature-list li::before { content: '✓'; position: absolute; left: 0; top: 8px; width: 20px; height: 20px; background: #4caf50; color: white; border-radius: 50%; font-size: 12px; display: flex; align-items: center; justify-content: center; }
        .contact-section { background: linear-gradient(135deg, #1565C0, #0D47A1); color: white; padding: 25px; border-radius: 10px; margin-top: 20px; text-align: center; }
        .contact-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 15px; margin-top: 15px; font-size: 14px; }
        .footer { text-align: center; padding: 15px; font-size: 11px; color: #666; border-top: 1px solid #eee; }
    </style>
</head>
<body>
    <div class="page cover">
        <div class="maple-icon">👨‍👩‍👧‍👦</div>
        <div class="logo">MAPLE EDUCATION</div>
        <h1>新加坡全家移民<br>一站式方案</h1>
        <p class="subtitle">自雇EP + 子女教育 + 家属签证</p>
        <div class="badge">创业移民 · 全家团聚</div>
        <p class="tagline">公司注册 | EP申请 | 子女入学 | 家属签证<br><br>📧 Maple@maplesgedu.com | 🌐 maplesgedu.com</p>
    </div>

    <div class="page content-page">
        <div class="page-header"><span class="brand">MAPLE EDUCATION</span><span>02</span></div>
        <h2>全家移民路径</h2>

        <div class="pathway">
            <div class="pathway-step"><div class="icon">🏢</div><div class="title">注册公司</div><div style="font-size:12px;">新加坡Pte. Ltd.</div></div>
            <div class="pathway-arrow">→</div>
            <div class="pathway-step"><div class="icon">📋</div><div class="title">申请EP</div><div style="font-size:12px;">就业准证</div></div>
            <div class="pathway-arrow">→</div>
            <div class="pathway-step"><div class="icon">👨‍👩‍👧</div><div class="title">家属签证</div><div style="font-size:12px;">DP/LTVP</div></div>
            <div class="pathway-arrow">→</div>
            <div class="pathway-step"><div class="icon">🏠</div><div class="title">全家定居</div><div style="font-size:12px;">申请PR</div></div>
        </div>

        <h3>📊 EP薪资与家属签证对照</h3>
        <table class="price-table">
            <tr><th>EP持有人月薪</th><th>可申请的家属签证</th></tr>
            <tr><td>S$5,600+</td><td>EP持有人本人</td></tr>
            <tr><td>S$6,000+</td><td>配偶DP + 21岁以下子女DP</td></tr>
            <tr><td>S$12,000+</td><td>以上 + 父母LTVP</td></tr>
        </table>

        <div class="highlight-box">
            <strong>💡 自雇EP优势：</strong><br>
            • 自己当老板，无需雇主担保<br>
            • 家属可申请DP签证，子女可在新加坡入学<br>
            • 2年后可申请新加坡永久居民(PR)
        </div>

        <div class="footer">Maple Education Pte. Ltd. | 🌐 maplesgedu.com</div>
    </div>

    <div class="page content-page">
        <div class="page-header"><span class="brand">MAPLE EDUCATION</span><span>03</span></div>
        <h2>服务内容与费用</h2>

        <div class="service-box company">
            <h3>🏢 成立新加坡公司（全套首年）- S$3,880</h3>
            <ul style="margin-left:20px;font-size:13px;">
                <li>ACRA公司注册 + 公司章程</li>
                <li>首年注册地址服务</li>
                <li>首年公司秘书服务（含AGM）</li>
                <li>首年挂名董事服务</li>
            </ul>
        </div>

        <div class="service-box ep">
            <h3>📋 EP申请配套 - S$6,000</h3>
            <ul style="margin-left:20px;font-size:13px;">
                <li>申请资格初步评估</li>
                <li>Corppass/EPOL账户注册</li>
                <li>EP申请提交至MOM</li>
                <li>上诉函（如需）</li>
                <li>6个月工位 + MOM费用已含</li>
            </ul>
        </div>

        <div class="service-box family">
            <h3>👨‍👩‍👧 家属签证 - S$300/人</h3>
            <ul style="margin-left:20px;font-size:13px;">
                <li>配偶DP申请</li>
                <li>子女DP申请</li>
                <li>父母LTVP申请（月薪≥S$12,000）</li>
            </ul>
        </div>

        <h3>📦 全家移民套餐</h3>
        <table class="price-table">
            <tr><th>套餐内容</th><th>费用</th></tr>
            <tr><td>公司注册 + EP申请 + 银行开户</td><td class="price">~S$12,380</td></tr>
            <tr><td>+ 配偶DP + 1个子女DP</td><td class="price">+S$600</td></tr>
            <tr><td>+ 子女入学服务（私立/国际）</td><td class="price">另议</td></tr>
        </table>

        <div class="footer">Maple Education Pte. Ltd. | 🌐 maplesgedu.com</div>
    </div>

    <div class="page content-page">
        <div class="page-header"><span class="brand">MAPLE EDUCATION</span><span>04</span></div>
        <h2>申请条件与流程</h2>

        <div class="requirements">
            <div class="req-box">
                <h4>📝 EP申请基本条件</h4>
                <ul>
                    <li>本科及以上学历</li>
                    <li>月薪≥S$5,600（随年龄递增）</li>
                    <li>COMPASS打分≥40分</li>
                    <li>有相关行业经验</li>
                </ul>
            </div>
            <div class="req-box">
                <h4>🏢 公司注册要求</h4>
                <ul>
                    <li>至少1名股东</li>
                    <li>至少1名本地董事</li>
                    <li>注册资本最低S$1</li>
                    <li>建议S$200,000+</li>
                </ul>
            </div>
        </div>

        <h3>⏱️ 办理时间线</h3>
        <table class="price-table">
            <tr><th>阶段</th><th>时间</th></tr>
            <tr><td>公司注册</td><td>1-3个工作日</td></tr>
            <tr><td>EP申请提交</td><td>准备1-2周</td></tr>
            <tr><td>EP审批</td><td>3-8周</td></tr>
            <tr><td>家属DP申请</td><td>2-4周</td></tr>
            <tr><td>全程总计</td><td class="price">约2-3个月</td></tr>
        </table>

        <div class="contact-section">
            <h3 style="color:#FFD54F;">📞 免费评估</h3>
            <p>专业顾问为您评估EP申请资格，定制全家移民方案</p>
            <div class="contact-grid">
                <div>📧 Maple@maplesgedu.com</div>
                <div>🌐 maplesgedu.com</div>
                <div>📱 +65 8686 3695</div>
                <div>💬 +86 1350 693 8797</div>
            </div>
        </div>

        <div class="footer"><strong>Maple Education Pte. Ltd.</strong> | UEN: 202427459R</div>
    </div>
</body>
</html>
```
