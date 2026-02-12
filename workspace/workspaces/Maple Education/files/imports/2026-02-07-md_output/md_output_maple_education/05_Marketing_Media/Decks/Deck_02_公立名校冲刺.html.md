---
title: "Deck_02_公立名校冲刺.html"
source_path: "05_Marketing_Media/Decks/Deck_02_公立名校冲刺.html"
tags: ["指南", "新加坡", "Maple", "html"]
ocr: false
---

# Deck_02_公立名校冲刺.html

简介：内容概述：<!DOCTYPE html>

## 内容

```text
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Maple Education - 新加坡公立名校冲刺指南</title>
    <style>
        @page { size: A4; margin: 0; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Microsoft YaHei', 'Segoe UI', sans-serif; background: #f5f5f5; color: #333; line-height: 1.6; }
        .page { width: 210mm; min-height: 297mm; margin: 20px auto; background: white; box-shadow: 0 0 20px rgba(0,0,0,0.1); overflow: hidden; page-break-after: always; }
        @media print { body { background: white; } .page { margin: 0; box-shadow: none; } }

        .cover { height: 297mm; background: linear-gradient(135deg, #1a3a6e 0%, #0d2240 100%); color: white; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; padding: 40mm; position: relative; }
        .cover-content { position: relative; z-index: 1; }
        .logo { font-size: 24px; font-weight: 700; margin-bottom: 20px; letter-spacing: 2px; }
        .cover h1 { font-size: 42px; font-weight: 700; margin-bottom: 20px; }
        .cover .subtitle { font-size: 22px; color: #FFD700; margin-bottom: 40px; }
        .cover .tagline { font-size: 16px; opacity: 0.8; border-top: 1px solid rgba(255,255,255,0.3); padding-top: 30px; margin-top: 30px; }
        .maple-icon { font-size: 80px; margin-bottom: 30px; }
        .gold-badge { display: inline-block; background: linear-gradient(135deg, #FFD700, #FFA500); color: #1a3a6e; padding: 10px 30px; border-radius: 30px; font-weight: 700; font-size: 18px; margin-top: 20px; }

        .content-page { padding: 15mm 20mm; min-height: 297mm; }
        .page-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 3px solid #1a3a6e; padding-bottom: 10px; margin-bottom: 20px; }
        .page-header .brand { font-size: 14px; color: #1a3a6e; font-weight: 600; }
        .page-header .page-num { font-size: 12px; color: #666; }

        h2 { color: #1a3a6e; font-size: 24px; margin-bottom: 20px; padding-bottom: 10px; border-bottom: 2px solid #eee; }
        h3 { color: #C1272D; font-size: 18px; margin: 20px 0 10px; }

        .highlight-box { background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px 20px; margin: 20px 0; border-radius: 0 8px 8px 0; }
        .highlight-box.blue { background: #e8f4fd; border-left-color: #1a3a6e; }
        .highlight-box.green { background: #d4edda; border-left-color: #28a745; }
        .highlight-box.gold { background: #fff8e1; border-left-color: #FFD700; }

        .university-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; margin: 20px 0; }
        .university-card { background: #f8f9fa; border: 2px solid #1a3a6e; border-radius: 12px; padding: 20px; text-align: center; }
        .university-card .rank { background: #FFD700; color: #1a3a6e; font-size: 12px; font-weight: 700; padding: 4px 12px; border-radius: 20px; display: inline-block; margin-bottom: 10px; }
        .university-card .name { font-size: 18px; font-weight: 700; color: #1a3a6e; margin-bottom: 5px; }
        .university-card .name-en { font-size: 12px; color: #666; margin-bottom: 10px; }
        .university-card .highlight { font-size: 13px; color: #C1272D; font-weight: 500; }

        .stat-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin: 20px 0; }
        .stat-box { text-align: center; padding: 15px; background: linear-gradient(135deg, #1a3a6e, #2C5AA0); color: white; border-radius: 8px; }
        .stat-box .number { font-size: 28px; font-weight: 700; color: #FFD700; }
        .stat-box .label { font-size: 12px; }

        .requirements-table { width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 13px; }
        .requirements-table th, .requirements-table td { padding: 12px; text-align: left; border: 1px solid #dee2e6; }
        .requirements-table th { background: #1a3a6e; color: white; }
        .requirements-table tr:nth-child(even) { background: #f8f9fa; }

        .price-table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        .price-table th, .price-table td { padding: 12px 15px; text-align: left; border-bottom: 1px solid #dee2e6; }
        .price-table th { background: #1a3a6e; color: white; }
        .price-table .price { color: #C1272D; font-weight: 700; font-size: 16px; }

        .feature-list { list-style: none; padding: 0; }
        .feature-list li { padding: 10px 0 10px 35px; position: relative; border-bottom: 1px dashed #eee; }
        .feature-list li::before { content: '✓'; position: absolute; left: 0; top: 10px; width: 24px; height: 24px; background: #28a745; color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 14px; }

        .timeline { position: relative; padding-left: 30px; margin: 20px 0; }
        .timeline::before { content: ''; position: absolute; left: 10px; top: 0; bottom: 0; width: 3px; background: linear-gradient(to bottom, #FFD700, #1a3a6e); }
        .timeline-item { position: relative; margin-bottom: 20px; padding-left: 20px; }
        .timeline-item::before { content: ''; position: absolute; left: -26px; top: 5px; width: 16px; height: 16px; background: #FFD700; border: 3px solid #1a3a6e; border-radius: 50%; }
        .timeline-item .time { font-weight: 600; color: #C1272D; font-size: 14px; }
        .timeline-item .content { font-size: 14px; }

        .two-column { display: grid; grid-template-columns: 1fr 1fr; gap: 30px; }
        .case-study { background: #f8f9fa; border-radius: 8px; padding: 15px; margin: 10px 0; border-left: 4px solid #FFD700; }
        .case-study .title { font-weight: 600; color: #1a3a6e; margin-bottom: 5px; }
        .case-study .result { color: #28a745; font-weight: 500; }

        .contact-section { background: linear-gradient(135deg, #1a3a6e, #0d2240); color: white; padding: 30px; border-radius: 12px; margin-top: 30px; text-align: center; }
        .contact-section h3 { color: #FFD700; margin-bottom: 20px; }
        .contact-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; margin-top: 20px; }
        .contact-item { display: flex; align-items: center; justify-content: center; gap: 10px; }

        .footer { text-align: center; padding: 20px; font-size: 12px; color: #666; border-top: 1px solid #eee; }
    </style>
</head>
<body>
    <div class="page cover">
        <div class="cover-content">
            <div class="maple-icon">🏆</div>
            <div class="logo">MAPLE EDUCATION</div>
            <h1>新加坡公立名校<br>冲刺指南</h1>
            <p class="subtitle">NUS · NTU · SMU · SUTD</p>
            <div class="gold-badge">QS 世界排名 Top 15</div>
            <p class="tagline">专业背景提升 | 精准选校定位 | 全程申请服务<br><br>📧 Maple@maplesgedu.com | 🌐 maplesgedu.com</p>
        </div>
    </div>

    <div class="page content-page">
        <div class="page-header"><span class="brand">MAPLE EDUCATION</span><span class="page-num">02</span></div>
        <h2>新加坡四大公立名校</h2>
        <div class="stat-row">
            <div class="stat-box"><div class="number">#8</div><div class="label">NUS QS排名</div></div>
            <div class="stat-box"><div class="number">#15</div><div class="label">NTU QS排名</div></div>
            <div class="stat-box"><div class="number">98%</div><div class="label">就业率</div></div>
            <div class="stat-box"><div class="number">S$5K+</div><div class="label">起薪中位数</div></div>
        </div>
        <div class="university-grid">
            <div class="university-card"><span class="rank">QS #8 亚洲第一</span><div class="name">新加坡国立大学</div><div class="name-en">NUS</div><div class="highlight">综合实力最强，商科/工程/计算机顶尖</div></div>
            <div class="university-card"><span class="rank">QS #15 工科强校</span><div class="name">南洋理工大学</div><div class="name-en">NTU</div><div class="highlight">工程/材料/传媒/教育全球领先</div></div>
            <div class="university-card"><span class="rank">亚洲顶级商学院</span><div class="name">新加坡管理大学</div><div class="name-en">SMU</div><div class="highlight">商科/金融/法律/会计精英教育</div></div>
            <div class="university-card"><span class="rank">MIT合作院校</span><div class="name">新加坡科技设计大学</div><div class="name-en">SUTD</div><div class="highlight">创新设计/AI/建筑设计前沿</div></div>
        </div>
        <div class="highlight-box gold"><strong>🎯 为什么选择新加坡公立大学？</strong><br>• 世界顶尖排名，学历全球认可<br>• 学费相对英美低廉（本科约S$17,000-20,000/年）<br>• 毕业后可申请工作签证，积累经验后申请PR</div>
        <div class="footer">Maple Education Pte. Ltd. | 🌐 maplesgedu.com</div>
    </div>

    <div class="page content-page">
        <div class="page-header"><span class="brand">MAPLE EDUCATION</span><span class="page-num">03</span></div>
        <h2>申请要求一览</h2>
        <h3>📚 本科申请</h3>
        <table class="requirements-table">
            <tr><th>申请条件</th><th>NUS/NTU</th><th>SMU</th><th>SUTD</th></tr>
            <tr><td>高考成绩</td><td>超一本线100分+</td><td>超一本线80分+</td><td>超一本线80分+</td></tr>
            <tr><td>雅思要求</td><td>6.5+</td><td>7.0+</td><td>6.5+</td></tr>
            <tr><td>面试</td><td>部分专业</td><td>必须</td><td>必须</td></tr>
        </table>
        <h3>🎓 硕士申请</h3>
        <table class="requirements-table">
            <tr><th>申请条件</th><th>授课型硕士</th><th>研究型硕士</th></tr>
            <tr><td>本科背景</td><td>985/211优先，GPA 3.5+</td><td>985/211优先，GPA 3.7+</td></tr>
            <tr><td>雅思要求</td><td>6.5-7.0+</td><td>6.5-7.0+</td></tr>
            <tr><td>GRE/GMAT</td><td>商科需GMAT 680+</td><td>部分专业需GRE 320+</td></tr>
        </table>
        <div class="highlight-box blue"><strong>💡 背景不够强？</strong> 我们提供背景提升服务：科研项目、实习推荐、竞赛辅导等。</div>
        <div class="footer">Maple Education Pte. Ltd. | 🌐 maplesgedu.com</div>
    </div>

    <div class="page content-page">
        <div class="page-header"><span class="brand">MAPLE EDUCATION</span><span class="page-num">04</span></div>
        <h2>服务内容与费用</h2>
        <ul class="feature-list">
            <li><strong>选校定位</strong> - 根据背景精准匹配目标院校和专业</li>
            <li><strong>背景评估</strong> - 全面分析优劣势，制定提升计划</li>
            <li><strong>文书撰写</strong> - 专业文案团队，打造亮眼申请文书</li>
            <li><strong>申请递交</strong> - 包三所院校，全程跟进申请进度</li>
            <li><strong>面试辅导</strong> - 模拟面试训练，提升录取概率</li>
            <li><strong>签证办理</strong> - 协助准备材料，确保签证顺利</li>
        </ul>
        <h3>💰 收费标准</h3>
        <table class="price-table">
            <tr><th>服务项目</th><th>费用</th><th>退费政策</th></tr>
            <tr><td>本科申请（包三所院校）</td><td class="price">¥15,000</td><td>申请不成功退 ¥10,000</td></tr>
            <tr><td>授课型硕士申请（包三所院校）</td><td class="price">¥15,000</td><td>申请不成功退 ¥10,000</td></tr>
            <tr><td>研究型硕士/博士申请</td><td class="price">¥30,000</td><td>不成功退 ¥15,000</td></tr>
        </table>
        <div class="highlight-box green"><strong>🛡️ 安心保障：</strong>「不成功，大额退款」，零风险冲刺名校！</div>
        <h3>📊 成功案例</h3>
        <div class="two-column">
            <div class="case-study"><div class="title">张同学 - 浙江大学</div><div>GPA 3.6 | 雅思 7.0</div><div class="result">✅ 录取 NUS 计算机硕士</div></div>
            <div class="case-study"><div class="title">李同学 - 上海财经</div><div>GPA 3.7 | GMAT 710</div><div class="result">✅ 录取 NTU 金融硕士</div></div>
        </div>
        <div class="footer">Maple Education Pte. Ltd. | 🌐 maplesgedu.com</div>
    </div>

    <div class="page content-page">
        <div class="page-header"><span class="brand">MAPLE EDUCATION</span><span class="page-num">05</span></div>
        <h2>开启您的名校之旅</h2>
        <div class="stat-row">
            <div class="stat-box"><div class="number">4</div><div class="label">合作公立大学</div></div>
            <div class="stat-box"><div class="number">200+</div><div class="label">可选专业</div></div>
            <div class="stat-box"><div class="number">85%+</div><div class="label">申请成功率</div></div>
            <div class="stat-box"><div class="number">1v1</div><div class="label">专属顾问</div></div>
        </div>
        <div class="highlight-box gold"><strong>🎁 限时福利：</strong><br>✅ 免费背景评估 ✅ 免费选校定位 ✅ 签约后赠送面试辅导</div>
        <div class="contact-section">
            <h3>📞 预约免费咨询</h3>
            <div class="contact-grid">
                <div class="contact-item"><span>📧</span><span>Maple@maplesgedu.com</span></div>
                <div class="contact-item"><span>🌐</span><span>maplesgedu.com</span></div>
                <div class="contact-item"><span>📱</span><span>+65 8686 3695 (WhatsApp)</span></div>
                <div class="contact-item"><span>💬</span><span>+86 1350 693 8797 (WeChat)</span></div>
            </div>
        </div>
        <div style="text-align: center; margin-top: 30px;"><p style="color: #666;">扫码添加顾问微信</p><div style="width: 100px; height: 100px; background: #f0f0f0; margin: 10px auto; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: #999;">[二维码]</div></div>
        <div class="footer"><strong>Maple Education Pte. Ltd.</strong> | UEN: 202427459R<br>© 2024 Maple Education. All Rights Reserved.</div>
    </div>
</body>
</html>
```
