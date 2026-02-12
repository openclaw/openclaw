---
title: "Deck_08_代理合作.html"
source_path: "05_Marketing_Media/Decks/Deck_08_代理合作.html"
tags: ["Maple", "html"]
ocr: false
---

# Deck_08_代理合作.html

简介：内容概述：<!DOCTYPE html>

## 内容

```text
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Maple Education - 代理合作招募</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        @page { size: A4; margin: 0; }
        body { font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif; background: #f5f5f5; color: #333; line-height: 1.6; }
        .page { width: 210mm; height: 297mm; background: white; margin: 0 auto 20px; padding: 15mm 18mm; position: relative; overflow: hidden; page-break-after: always; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        @media print { body { background: white; } .page { margin: 0; box-shadow: none; page-break-after: always; } }
        .header { display: flex; justify-content: space-between; align-items: center; padding-bottom: 10px; border-bottom: 2px solid #2C5AA0; margin-bottom: 15px; }
        .logo-area { display: flex; align-items: center; gap: 10px; }
        .logo-placeholder { width: 40px; height: 40px; background: linear-gradient(135deg, #C1272D, #2C5AA0); border-radius: 8px; display: flex; align-items: center; justify-content: center; color: white; font-weight: bold; font-size: 18px; }
        .company-name { font-size: 14px; color: #2C5AA0; font-weight: 600; }
        .page-number { font-size: 12px; color: #999; }
        .cover-page { padding: 0; display: flex; flex-direction: column; }
        .cover-top { background: linear-gradient(135deg, #2C5AA0 0%, #1a3d6e 50%, #0d2340 100%); height: 55%; padding: 25mm 20mm; color: white; position: relative; }
        .cover-top::after { content: ''; position: absolute; bottom: -30px; left: 0; right: 0; height: 60px; background: white; clip-path: polygon(0 50%, 100% 0, 100% 100%, 0 100%); }
        .cover-badge { display: inline-block; background: #C1272D; color: white; padding: 6px 18px; border-radius: 20px; font-size: 13px; font-weight: bold; margin-bottom: 20px; }
        .cover-title { font-size: 36px; font-weight: bold; margin-bottom: 15px; line-height: 1.3; }
        .cover-subtitle { font-size: 18px; opacity: 0.9; margin-bottom: 25px; }
        .cover-highlight { display: flex; gap: 35px; margin-top: 20px; }
        .highlight-item { text-align: center; }
        .highlight-number { font-size: 32px; font-weight: bold; color: #FFD700; }
        .highlight-label { font-size: 13px; opacity: 0.9; }
        .cover-bottom { height: 45%; padding: 40px 20mm 20mm; display: flex; flex-direction: column; justify-content: space-between; }
        .cover-features { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
        .feature-box { text-align: center; padding: 18px; background: linear-gradient(135deg, #f0f4f8, #fff); border-radius: 12px; border: 1px solid #e0e8f0; }
        .feature-icon { font-size: 32px; margin-bottom: 8px; }
        .feature-title { font-size: 14px; font-weight: 600; color: #2C5AA0; margin-bottom: 4px; }
        .feature-desc { font-size: 11px; color: #666; }
        .cover-footer { text-align: center; padding-top: 15px; border-top: 1px solid #e0e8f0; }
        .cover-footer p { font-size: 12px; color: #666; }
        .section-title { font-size: 24px; color: #2C5AA0; margin-bottom: 20px; padding-bottom: 10px; border-bottom: 3px solid #C1272D; display: inline-block; }
        .section-subtitle { font-size: 14px; color: #666; margin-bottom: 20px; }
        .partner-types { display: grid; grid-template-columns: repeat(2, 1fr); gap: 15px; margin-bottom: 20px; }
        .partner-card { background: white; border-radius: 12px; padding: 20px; box-shadow: 0 3px 12px rgba(0,0,0,0.08); border-left: 5px solid #2C5AA0; }
        .partner-card.highlight { border-left-color: #C1272D; background: linear-gradient(135deg, #fff5f5, #fff); }
        .partner-icon { font-size: 28px; margin-bottom: 10px; }
        .partner-name { font-size: 16px; font-weight: bold; color: #2C5AA0; margin-bottom: 5px; }
        .partner-desc { font-size: 12px; color: #666; margin-bottom: 10px; }
        .partner-benefits { font-size: 11px; color: #555; }
        .partner-benefits li { margin-bottom: 4px; list-style: none; padding-left: 15px; position: relative; }
        .partner-benefits li::before { content: '✓'; position: absolute; left: 0; color: #4CAF50; font-weight: bold; }
        .commission-table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 11px; }
        .commission-table th { background: linear-gradient(135deg, #2C5AA0, #1a3d6e); color: white; padding: 12px 10px; text-align: center; font-weight: 600; }
        .commission-table td { padding: 10px; border: 1px solid #e0e8f0; text-align: center; }
        .commission-table tr:nth-child(even) { background: #f8fafc; }
        .commission-table .highlight-cell { background: #FFF8E1; font-weight: bold; }
        .commission-amount { color: #C1272D; font-weight: bold; font-size: 13px; }
        .process-flow { display: flex; justify-content: space-between; margin: 25px 0; position: relative; }
        .process-flow::before { content: ''; position: absolute; top: 30px; left: 8%; right: 8%; height: 3px; background: linear-gradient(to right, #2C5AA0, #C1272D); }
        .process-step { flex: 1; text-align: center; position: relative; z-index: 1; }
        .step-circle { width: 60px; height: 60px; background: linear-gradient(135deg, #2C5AA0, #1a3d6e); color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 12px; font-size: 20px; border: 3px solid white; box-shadow: 0 3px 10px rgba(0,0,0,0.2); }
        .step-title { font-size: 12px; font-weight: bold; color: #2C5AA0; }
        .step-desc { font-size: 10px; color: #999; }
        .support-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 15px; margin-bottom: 20px; }
        .support-card { background: #f8fafc; border-radius: 10px; padding: 18px; border-left: 4px solid #2C5AA0; }
        .support-title { font-size: 14px; font-weight: bold; color: #2C5AA0; margin-bottom: 8px; display: flex; align-items: center; gap: 8px; }
        .support-content { font-size: 11px; color: #666; }
        .tip-box { background: linear-gradient(135deg, #FFF8E1, #FFF3CD); border-left: 4px solid #FFC107; padding: 15px; border-radius: 0 10px 10px 0; margin: 15px 0; }
        .tip-box.success { background: linear-gradient(135deg, #E8F5E9, #C8E6C9); border-color: #4CAF50; }
        .tip-title { font-size: 13px; font-weight: bold; color: #333; margin-bottom: 5px; }
        .tip-content { font-size: 12px; color: #666; }
        .contact-section { background: linear-gradient(135deg, #2C5AA0 0%, #1a3d6e 100%); border-radius: 15px; padding: 30px; color: white; text-align: center; margin-top: 20px; }
        .contact-title { font-size: 22px; margin-bottom: 10px; }
        .contact-subtitle { font-size: 13px; opacity: 0.9; margin-bottom: 25px; }
        .contact-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; text-align: left; }
        .contact-item { background: rgba(255,255,255,0.1); border-radius: 10px; padding: 15px; }
        .contact-label { font-size: 11px; opacity: 0.8; margin-bottom: 5px; }
        .contact-value { font-size: 14px; font-weight: 600; }
        .advantage-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 15px 0; }
        .advantage-item { background: white; border: 1px solid #e0e8f0; border-radius: 10px; padding: 15px; text-align: center; }
        .advantage-icon { font-size: 28px; margin-bottom: 8px; }
        .advantage-title { font-size: 12px; font-weight: bold; color: #2C5AA0; margin-bottom: 3px; }
        .advantage-desc { font-size: 10px; color: #999; }
        .case-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 15px 0; }
        .case-card { background: white; border-radius: 10px; padding: 15px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); text-align: center; }
        .case-avatar { width: 45px; height: 45px; background: linear-gradient(135deg, #2C5AA0, #C1272D); border-radius: 50%; margin: 0 auto 10px; display: flex; align-items: center; justify-content: center; color: white; font-weight: bold; font-size: 16px; }
        .case-name { font-size: 13px; font-weight: bold; color: #333; }
        .case-type { font-size: 10px; color: #999; margin-bottom: 8px; }
        .case-earning { font-size: 16px; font-weight: bold; color: #C1272D; }
        .case-period { font-size: 10px; color: #666; }
        .checklist { background: #f8fafc; border-radius: 12px; padding: 18px; }
        .checklist-title { font-size: 14px; font-weight: bold; color: #2C5AA0; margin-bottom: 12px; }
        .checklist-item { font-size: 11px; color: #555; margin-bottom: 6px; display: flex; align-items: flex-start; gap: 8px; }
        .checklist-item::before { content: '☐'; color: #2C5AA0; font-weight: bold; }
    </style>
</head>
<body>
    <div class="page cover-page">
        <div class="cover-top">
            <div class="cover-badge">诚招合作伙伴</div>
            <h1 class="cover-title">新加坡留学代理<br>合作招募计划</h1>
            <p class="cover-subtitle">携手共赢，开拓新加坡教育市场新蓝海</p>
            <div class="cover-highlight">
                <div class="highlight-item"><div class="highlight-number">30%</div><div class="highlight-label">起返佣比例</div></div>
                <div class="highlight-item"><div class="highlight-number">15+</div><div class="highlight-label">合作院校</div></div>
                <div class="highlight-item"><div class="highlight-number">0</div><div class="highlight-label">加盟费用</div></div>
            </div>
        </div>
        <div class="cover-bottom">
            <div class="cover-features">
                <div class="feature-box"><div class="feature-icon">💰</div><div class="feature-title">高额返佣</div><div class="feature-desc">私立院校30%起<br>公立申请最高50%</div></div>
                <div class="feature-box"><div class="feature-icon">🤝</div><div class="feature-title">全程支持</div><div class="feature-desc">培训+素材+客服<br>一站式赋能</div></div>
                <div class="feature-box"><div class="feature-icon">📈</div><div class="feature-title">长期收益</div><div class="feature-desc">学生续费持续分成<br>建立被动收入</div></div>
            </div>
            <div class="cover-footer"><p><strong>Maple Education</strong> · 新加坡枫叶留学</p><p>WhatsApp: +65 8686 3695 | WeChat: +86 1350 693 8797</p></div>
        </div>
    </div>

    <div class="page">
        <div class="header"><div class="logo-area"><div class="logo-placeholder">M</div><span class="company-name">Maple Education</span></div><span class="page-number">02 / 06</span></div>
        <h2 class="section-title">合作伙伴类型</h2>
        <p class="section-subtitle">无论您是机构还是个人，我们都有适合您的合作模式</p>
        <div class="partner-types">
            <div class="partner-card highlight"><div class="partner-icon">🏢</div><div class="partner-name">留学机构/中介</div><div class="partner-desc">已有留学业务基础，希望拓展新加坡市场</div><ul class="partner-benefits"><li>签署正式代理协议</li><li>独家区域保护（可选）</li><li>更高返佣比例</li><li>联合品牌宣传</li><li>定期业务培训</li></ul></div>
            <div class="partner-card"><div class="partner-icon">👩‍🏫</div><div class="partner-name">教育培训机构</div><div class="partner-desc">语言学校、K12培训、艺术机构等</div><ul class="partner-benefits"><li>学生资源互补</li><li>课程产品合作</li><li>联合招生活动</li><li>返佣+引流双收益</li></ul></div>
            <div class="partner-card"><div class="partner-icon">👨‍💻</div><div class="partner-name">个人代理/KOL</div><div class="partner-desc">留学顾问、自媒体博主、海外华人</div><ul class="partner-benefits"><li>零门槛加入</li><li>灵活推广方式</li><li>专属推荐码追踪</li><li>快速结算返佣</li></ul></div>
            <div class="partner-card"><div class="partner-icon">🌏</div><div class="partner-name">海外服务商</div><div class="partner-desc">移民公司、地产中介、旅行社等</div><ul class="partner-benefits"><li>客户资源共享</li><li>服务打包合作</li><li>互相引流</li><li>长期战略合作</li></ul></div>
        </div>
        <h3 style="font-size: 15px; color: #2C5AA0; margin: 15px 0 12px;">为什么选择 Maple Education？</h3>
        <div class="advantage-grid">
            <div class="advantage-item"><div class="advantage-icon">🎓</div><div class="advantage-title">正规资质</div><div class="advantage-desc">新加坡注册公司<br>UEN: 202044651W</div></div>
            <div class="advantage-item"><div class="advantage-icon">📚</div><div class="advantage-title">院校资源</div><div class="advantage-desc">15+合作院校<br>官方授权代理</div></div>
            <div class="advantage-item"><div class="advantage-icon">⚡</div><div class="advantage-title">高效服务</div><div class="advantage-desc">本地团队支持<br>快速响应处理</div></div>
            <div class="advantage-item"><div class="advantage-icon">💎</div><div class="advantage-title">口碑保障</div><div class="advantage-desc">学生好评如潮<br>转介绍率高</div></div>
        </div>
    </div>

    <div class="page">
        <div class="header"><div class="logo-area"><div class="logo-placeholder">M</div><span class="company-name">Maple Education</span></div><span class="page-number">03 / 06</span></div>
        <h2 class="section-title">返佣标准</h2>
        <p class="section-subtitle">透明清晰的返佣机制，让每一分付出都有回报</p>
        <table class="commission-table">
            <thead><tr><th>服务类型</th><th>服务费（收取）</th><th>代理返佣</th><th>返佣比例</th></tr></thead>
            <tbody>
                <tr><td colspan="4" style="background: #e8f0f8; font-weight: bold; color: #2C5AA0;">私立大学申请</td></tr>
                <tr><td>本科/硕士申请（咨询服务）</td><td>¥1,500</td><td class="commission-amount">¥450</td><td>30%</td></tr>
                <tr><td>VIP全程服务</td><td>S$599</td><td class="commission-amount">S$180</td><td>30%</td></tr>
                <tr><td colspan="4" style="background: #e8f0f8; font-weight: bold; color: #2C5AA0;">公立大学申请</td></tr>
                <tr><td>本科/授课型硕士</td><td>¥15,000</td><td class="commission-amount">¥4,500-7,500</td><td class="highlight-cell">30-50%</td></tr>
                <tr><td>研究型硕士/博士</td><td>¥30,000</td><td class="commission-amount">¥9,000-15,000</td><td class="highlight-cell">30-50%</td></tr>
                <tr><td colspan="4" style="background: #e8f0f8; font-weight: bold; color: #2C5AA0;">低龄留学</td></tr>
                <tr><td>AEIS培训+申请</td><td>按课程</td><td class="commission-amount">课程费20%</td><td>20%</td></tr>
                <tr><td>国际学校申请</td><td>S$2,000起</td><td class="commission-amount">S$600起</td><td>30%</td></tr>
                <tr><td>幼儿园申请+陪读</td><td>S$1,500</td><td class="commission-amount">S$450</td><td>30%</td></tr>
                <tr><td colspan="4" style="background: #e8f0f8; font-weight: bold; color: #2C5AA0;">移民服务</td></tr>
                <tr><td>自雇EP全套</td><td>S$12,380</td><td class="commission-amount">S$3,714</td><td>30%</td></tr>
                <tr><td colspan="4" style="background: #e8f0f8; font-weight: bold; color: #2C5AA0;">管家服务</td></tr>
                <tr><td>安家全程包</td><td>S$1,800</td><td class="commission-amount">S$360</td><td>20%</td></tr>
                <tr><td>其他单项服务</td><td>按项目</td><td class="commission-amount">服务费20%</td><td>20%</td></tr>
            </tbody>
        </table>
        <div class="tip-box"><div class="tip-title">💡 返佣说明</div><div class="tip-content">• 返佣比例根据合作深度可协商，长期优质合作伙伴可享更高比例<br>• 返佣在学生完成缴费后30天内结算，支持银行转账、PayNow、支付宝<br>• 学生后续续费、升学服务继续享受返佣</div></div>
    </div>

    <div class="page">
        <div class="header"><div class="logo-area"><div class="logo-placeholder">M</div><span class="company-name">Maple Education</span></div><span class="page-number">04 / 06</span></div>
        <h2 class="section-title">合作流程</h2>
        <p class="section-subtitle">简单四步，快速开启合作</p>
        <div class="process-flow">
            <div class="process-step"><div class="step-circle">📝</div><div class="step-title">提交申请</div><div class="step-desc">填写合作意向</div></div>
            <div class="process-step"><div class="step-circle">💬</div><div class="step-title">沟通洽谈</div><div class="step-desc">确定合作模式</div></div>
            <div class="process-step"><div class="step-circle">📄</div><div class="step-title">签署协议</div><div class="step-desc">明确权责条款</div></div>
            <div class="process-step"><div class="step-circle">🚀</div><div class="step-title">正式合作</div><div class="step-desc">开始推广获客</div></div>
        </div>
        <h3 style="font-size: 15px; color: #2C5AA0; margin: 25px 0 12px;">我们提供的支持</h3>
        <div class="support-grid">
            <div class="support-card"><div class="support-title">📚 产品培训</div><div class="support-content">• 新加坡留学政策解读<br>• 院校及课程详细介绍<br>• 常见问题应答技巧<br>• 定期线上培训课程</div></div>
            <div class="support-card"><div class="support-title">🎨 营销素材</div><div class="support-content">• 品牌授权使用<br>• 宣传海报/文案模板<br>• 院校介绍PPT<br>• 短视频脚本素材</div></div>
            <div class="support-card"><div class="support-title">🤝 销售支持</div><div class="support-content">• 客户咨询转接<br>• 专业顾问协助签单<br>• CRM系统追踪<br>• 疑难案例支持</div></div>
            <div class="support-card"><div class="support-title">💰 财务结算</div><div class="support-content">• 月度返佣报表<br>• 快速结算（30天内）<br>• 多种付款方式<br>• 正规发票/收据</div></div>
        </div>
        <h3 style="font-size: 15px; color: #2C5AA0; margin: 20px 0 12px;">代理收益案例</h3>
        <div class="case-grid">
            <div class="case-card"><div class="case-avatar">王</div><div class="case-name">王老师</div><div class="case-type">语言培训机构</div><div class="case-earning">¥85,000+</div><div class="case-period">2024年收益</div></div>
            <div class="case-card"><div class="case-avatar">李</div><div class="case-name">李女士</div><div class="case-type">留学顾问/个人代理</div><div class="case-earning">¥42,000+</div><div class="case-period">2024年收益</div></div>
            <div class="case-card"><div class="case-avatar">张</div><div class="case-name">张先生</div><div class="case-type">移民公司</div><div class="case-earning">S$15,000+</div><div class="case-period">2024年收益</div></div>
        </div>
    </div>

    <div class="page">
        <div class="header"><div class="logo-area"><div class="logo-placeholder">M</div><span class="company-name">Maple Education</span></div><span class="page-number">05 / 06</span></div>
        <h2 class="section-title">合作须知</h2>
        <p class="section-subtitle">为保障双方权益，请仔细阅读以下条款</p>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px;">
            <div class="checklist"><div class="checklist-title">✅ 代理权利</div><div class="checklist-item">使用 Maple Education 品牌进行推广</div><div class="checklist-item">获取最新产品资料和营销素材</div><div class="checklist-item">参加定期培训和业务交流</div><div class="checklist-item">享受约定的返佣比例</div><div class="checklist-item">获得销售支持和客服协助</div><div class="checklist-item">查看客户跟进状态和返佣明细</div></div>
            <div class="checklist"><div class="checklist-title">⚠️ 代理义务</div><div class="checklist-item">如实介绍服务内容，不夸大宣传</div><div class="checklist-item">保护客户隐私信息</div><div class="checklist-item">不私自承诺超出服务范围的内容</div><div class="checklist-item">维护品牌形象和声誉</div><div class="checklist-item">及时反馈客户需求和市场信息</div><div class="checklist-item">遵守合作协议约定的条款</div></div>
        </div>
        <div class="tip-box success"><div class="tip-title">🤝 合作原则</div><div class="tip-content">我们秉持「诚信、专业、共赢」的合作理念。代理伙伴是我们最宝贵的资源，我们承诺提供最大力度的支持，共同服务好每一位学生和家长。</div></div>
        <h3 style="font-size: 15px; color: #2C5AA0; margin: 20px 0 12px;">常见问题</h3>
        <div style="background: #f8fafc; border-radius: 12px; padding: 18px;">
            <div style="margin-bottom: 12px;"><div style="font-size: 12px; font-weight: bold; color: #2C5AA0; margin-bottom: 5px;">Q: 成为代理需要交费吗？</div><div style="font-size: 11px; color: #666; padding-left: 15px;">A: 不需要！我们不收取任何加盟费、保证金。合作完全基于业绩分成。</div></div>
            <div style="margin-bottom: 12px;"><div style="font-size: 12px; font-weight: bold; color: #2C5AA0; margin-bottom: 5px;">Q: 如何追踪我推荐的客户？</div><div style="font-size: 11px; color: #666; padding-left: 15px;">A: 我们提供专属推荐码和CRM系统，您可以实时查看客户状态和返佣明细。</div></div>
            <div style="margin-bottom: 12px;"><div style="font-size: 12px; font-weight: bold; color: #2C5AA0; margin-bottom: 5px;">Q: 返佣多久结算一次？</div><div style="font-size: 11px; color: #666; padding-left: 15px;">A: 学生完成付款后30天内结算。支持月结或按单结算，灵活选择。</div></div>
            <div><div style="font-size: 12px; font-weight: bold; color: #2C5AA0; margin-bottom: 5px;">Q: 可以申请独家区域代理吗？</div><div style="font-size: 11px; color: #666; padding-left: 15px;">A: 可以。达到一定业绩要求后，可申请城市或区域独家代理权。</div></div>
        </div>
    </div>

    <div class="page">
        <div class="header"><div class="logo-area"><div class="logo-placeholder">M</div><span class="company-name">Maple Education</span></div><span class="page-number">06 / 06</span></div>
        <h2 class="section-title">立即加入我们</h2>
        <p class="section-subtitle">开启新加坡教育市场的财富之门</p>
        <div style="background: linear-gradient(135deg, #f0f4f8, #e8f0f8); border-radius: 15px; padding: 25px; margin-bottom: 25px;">
            <h3 style="font-size: 16px; color: #2C5AA0; margin-bottom: 15px;">🎁 新代理专属福利</h3>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                <div style="background: white; padding: 15px; border-radius: 10px; border-left: 3px solid #C1272D;"><div style="font-size: 14px; font-weight: bold; color: #2C5AA0;">首单额外奖励</div><div style="font-size: 12px; color: #666;">首位成功签约客户额外奖励¥500</div></div>
                <div style="background: white; padding: 15px; border-radius: 10px; border-left: 3px solid #C1272D;"><div style="font-size: 14px; font-weight: bold; color: #2C5AA0;">专属培训</div><div style="font-size: 12px; color: #666;">1对1产品培训+销售技巧指导</div></div>
                <div style="background: white; padding: 15px; border-radius: 10px; border-left: 3px solid #C1272D;"><div style="font-size: 14px; font-weight: bold; color: #2C5AA0;">营销素材包</div><div style="font-size: 12px; color: #666;">价值¥2000的全套宣传素材</div></div>
                <div style="background: white; padding: 15px; border-radius: 10px; border-left: 3px solid #C1272D;"><div style="font-size: 14px; font-weight: bold; color: #2C5AA0;">优先支持</div><div style="font-size: 12px; color: #666;">新代理专属客服，快速响应</div></div>
            </div>
        </div>
        <div style="background: linear-gradient(135deg, #E8F5E9, #C8E6C9); border-radius: 15px; padding: 20px; margin-bottom: 25px;">
            <h3 style="font-size: 15px; color: #333; margin-bottom: 12px;">📋 申请流程</h3>
            <div style="display: flex; gap: 15px; text-align: center;">
                <div style="flex: 1; background: white; padding: 15px; border-radius: 10px;"><div style="font-size: 24px; margin-bottom: 5px;">1️⃣</div><div style="font-size: 12px; font-weight: bold; color: #333;">扫码添加微信</div><div style="font-size: 10px; color: #999;">或WhatsApp联系</div></div>
                <div style="flex: 1; background: white; padding: 15px; border-radius: 10px;"><div style="font-size: 24px; margin-bottom: 5px;">2️⃣</div><div style="font-size: 12px; font-weight: bold; color: #333;">说明合作意向</div><div style="font-size: 10px; color: #999;">介绍您的背景</div></div>
                <div style="flex: 1; background: white; padding: 15px; border-radius: 10px;"><div style="font-size: 24px; margin-bottom: 5px;">3️⃣</div><div style="font-size: 12px; font-weight: bold; color: #333;">签署协议</div><div style="font-size: 10px; color: #999;">电子签约</div></div>
                <div style="flex: 1; background: white; padding: 15px; border-radius: 10px;"><div style="font-size: 24px; margin-bottom: 5px;">4️⃣</div><div style="font-size: 12px; font-weight: bold; color: #333;">开始赚钱</div><div style="font-size: 10px; color: #999;">推广即有收益</div></div>
            </div>
        </div>
        <div class="contact-section">
            <h3 class="contact-title">立即申请成为代理</h3>
            <p class="contact-subtitle">期待与您携手共创辉煌</p>
            <div class="contact-grid">
                <div class="contact-item"><div class="contact-label">代理合作专线 / WhatsApp</div><div class="contact-value">+65 8686 3695</div></div>
                <div class="contact-item"><div class="contact-label">中国区合作 / 微信</div><div class="contact-value">+86 1350 693 8797</div></div>
                <div class="contact-item"><div class="contact-label">商务邮箱</div><div class="contact-value">Maple@maplesgedu.com</div></div>
                <div class="contact-item"><div class="contact-label">官方网站</div><div class="contact-value">www.maplesgedu.com</div></div>
            </div>
        </div>
        <div style="text-align: center; margin-top: 25px; padding-top: 15px; border-top: 1px solid #e0e8f0;"><p style="font-size: 11px; color: #999;">Maple Education Pte. Ltd. | UEN: 202044651W</p><p style="font-size: 11px; color: #999;">📍 新加坡 · 诚邀全球代理伙伴</p></div>
    </div>
</body>
</html>
```
