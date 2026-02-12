---
title: "Deck_07_管家服务.html"
source_path: "05_Marketing_Media/Decks/Deck_07_管家服务.html"
tags: ["服务", "管家服务", "新加坡", "Maple", "html"]
ocr: false
---

# Deck_07_管家服务.html

简介：内容概述：<!DOCTYPE html>

## 内容

```text
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Maple Education - 新加坡管家服务</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        @page { size: A4; margin: 0; }
        body { font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif; background: #f5f5f5; color: #333; line-height: 1.6; }
        .page { width: 210mm; height: 297mm; background: white; margin: 0 auto 20px; padding: 15mm 18mm; position: relative; overflow: hidden; page-break-after: always; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        @media print { body { background: white; } .page { margin: 0; box-shadow: none; page-break-after: always; } }
        .header { display: flex; justify-content: space-between; align-items: center; padding-bottom: 10px; border-bottom: 2px solid #B8860B; margin-bottom: 15px; }
        .logo-area { display: flex; align-items: center; gap: 10px; }
        .logo-placeholder { width: 40px; height: 40px; background: linear-gradient(135deg, #B8860B, #D4AF37); border-radius: 8px; display: flex; align-items: center; justify-content: center; color: white; font-weight: bold; font-size: 18px; }
        .company-name { font-size: 14px; color: #1a2744; font-weight: 600; }
        .page-number { font-size: 12px; color: #999; }
        .cover-page { padding: 0; display: flex; flex-direction: column; }
        .cover-top { background: linear-gradient(135deg, #1a2744 0%, #2d3a4f 50%, #3d4a5f 100%); height: 55%; padding: 25mm 20mm; color: white; position: relative; }
        .cover-top::after { content: ''; position: absolute; bottom: -30px; left: 0; right: 0; height: 60px; background: white; clip-path: polygon(0 50%, 100% 0, 100% 100%, 0 100%); }
        .cover-badge { display: inline-block; background: linear-gradient(135deg, #B8860B, #D4AF37); color: white; padding: 6px 18px; border-radius: 20px; font-size: 13px; font-weight: bold; margin-bottom: 20px; }
        .cover-title { font-size: 36px; font-weight: bold; margin-bottom: 15px; line-height: 1.3; }
        .cover-subtitle { font-size: 18px; opacity: 0.9; margin-bottom: 25px; }
        .cover-highlight { display: flex; gap: 35px; margin-top: 20px; }
        .highlight-item { text-align: center; }
        .highlight-number { font-size: 32px; font-weight: bold; color: #D4AF37; }
        .highlight-label { font-size: 13px; opacity: 0.9; }
        .cover-bottom { height: 45%; padding: 40px 20mm 20mm; display: flex; flex-direction: column; justify-content: space-between; }
        .cover-features { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
        .feature-box { text-align: center; padding: 18px; background: linear-gradient(135deg, #f8f6f0, #fff); border-radius: 12px; border: 1px solid #e8dfc9; }
        .feature-icon { font-size: 32px; margin-bottom: 8px; }
        .feature-title { font-size: 14px; font-weight: 600; color: #1a2744; margin-bottom: 4px; }
        .feature-desc { font-size: 11px; color: #666; }
        .cover-footer { text-align: center; padding-top: 15px; border-top: 1px solid #e8dfc9; }
        .cover-footer p { font-size: 12px; color: #666; }
        .section-title { font-size: 24px; color: #1a2744; margin-bottom: 20px; padding-bottom: 10px; border-bottom: 3px solid #B8860B; display: inline-block; }
        .section-subtitle { font-size: 14px; color: #666; margin-bottom: 20px; }
        .service-category { display: grid; grid-template-columns: repeat(2, 1fr); gap: 15px; margin-bottom: 20px; }
        .category-card { background: white; border-radius: 12px; padding: 20px; box-shadow: 0 3px 12px rgba(0,0,0,0.08); border-top: 4px solid #B8860B; }
        .category-icon { width: 50px; height: 50px; background: linear-gradient(135deg, #1a2744, #2d3a4f); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 22px; margin-bottom: 12px; }
        .category-name { font-size: 16px; font-weight: bold; color: #1a2744; margin-bottom: 5px; }
        .category-desc { font-size: 12px; color: #666; margin-bottom: 10px; }
        .category-items { font-size: 11px; color: #555; }
        .category-items li { margin-bottom: 4px; list-style: none; padding-left: 15px; position: relative; }
        .category-items li::before { content: '✓'; position: absolute; left: 0; color: #B8860B; font-weight: bold; }
        .service-table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 11px; }
        .service-table th { background: linear-gradient(135deg, #1a2744, #2d3a4f); color: white; padding: 12px 10px; text-align: left; font-weight: 600; }
        .service-table td { padding: 10px; border-bottom: 1px solid #eee; }
        .service-table tr:nth-child(even) { background: #faf9f6; }
        .service-table .price { color: #B8860B; font-weight: bold; text-align: right; }
        .service-table .category-header { background: #f0ebe0; font-weight: bold; color: #1a2744; }
        .package-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; margin-bottom: 20px; }
        .package-card { background: white; border: 2px solid #e8dfc9; border-radius: 15px; padding: 20px; text-align: center; position: relative; }
        .package-card.featured { border-color: #B8860B; background: linear-gradient(135deg, #faf9f6, #fff); transform: scale(1.02); box-shadow: 0 4px 20px rgba(184,134,11,0.2); }
        .package-badge { position: absolute; top: -10px; left: 50%; transform: translateX(-50%); background: linear-gradient(135deg, #B8860B, #D4AF37); color: white; padding: 4px 15px; border-radius: 15px; font-size: 10px; font-weight: bold; }
        .package-name { font-size: 16px; font-weight: bold; color: #1a2744; margin: 10px 0 5px; }
        .package-desc { font-size: 11px; color: #999; margin-bottom: 15px; }
        .package-price { font-size: 28px; font-weight: bold; color: #B8860B; }
        .package-unit { font-size: 11px; color: #999; margin-bottom: 15px; }
        .package-features { text-align: left; font-size: 11px; color: #666; }
        .package-features li { margin-bottom: 5px; list-style: none; padding-left: 18px; position: relative; }
        .package-features li::before { content: '✓'; position: absolute; left: 0; color: #4CAF50; }
        .process-timeline { display: flex; justify-content: space-between; margin: 25px 0; position: relative; }
        .process-timeline::before { content: ''; position: absolute; top: 30px; left: 8%; right: 8%; height: 3px; background: linear-gradient(to right, #B8860B, #D4AF37, #B8860B); }
        .process-step { flex: 1; text-align: center; position: relative; z-index: 1; }
        .step-circle { width: 60px; height: 60px; background: linear-gradient(135deg, #1a2744, #2d3a4f); color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 12px; font-size: 20px; border: 3px solid white; box-shadow: 0 3px 10px rgba(0,0,0,0.2); }
        .step-title { font-size: 12px; font-weight: bold; color: #1a2744; }
        .step-desc { font-size: 10px; color: #999; }
        .testimonial-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 15px; margin-bottom: 20px; }
        .testimonial-card { background: #faf9f6; border-radius: 12px; padding: 18px; border-left: 4px solid #B8860B; }
        .testimonial-content { font-size: 12px; color: #555; font-style: italic; margin-bottom: 12px; line-height: 1.7; }
        .testimonial-author { display: flex; align-items: center; gap: 10px; }
        .author-avatar { width: 35px; height: 35px; background: linear-gradient(135deg, #B8860B, #D4AF37); border-radius: 50%; display: flex; align-items: center; justify-content: center; color: white; font-size: 14px; font-weight: bold; }
        .author-info { font-size: 11px; }
        .author-name { font-weight: bold; color: #1a2744; }
        .author-desc { color: #999; }
        .tip-box { background: linear-gradient(135deg, #faf9f6, #f0ebe0); border-left: 4px solid #B8860B; padding: 15px; border-radius: 0 10px 10px 0; margin: 15px 0; }
        .tip-title { font-size: 13px; font-weight: bold; color: #1a2744; margin-bottom: 5px; }
        .tip-content { font-size: 12px; color: #666; }
        .contact-section { background: linear-gradient(135deg, #1a2744 0%, #2d3a4f 100%); border-radius: 15px; padding: 30px; color: white; text-align: center; margin-top: 20px; }
        .contact-title { font-size: 22px; margin-bottom: 10px; }
        .contact-subtitle { font-size: 13px; opacity: 0.9; margin-bottom: 25px; }
        .contact-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; text-align: left; }
        .contact-item { background: rgba(255,255,255,0.1); border-radius: 10px; padding: 15px; }
        .contact-label { font-size: 11px; opacity: 0.8; margin-bottom: 5px; }
        .contact-value { font-size: 14px; font-weight: 600; }
        .advantage-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 15px 0; }
        .advantage-item { background: white; border: 1px solid #e8dfc9; border-radius: 10px; padding: 15px; text-align: center; }
        .advantage-icon { font-size: 28px; margin-bottom: 8px; }
        .advantage-title { font-size: 12px; font-weight: bold; color: #1a2744; margin-bottom: 3px; }
        .advantage-desc { font-size: 10px; color: #999; }
    </style>
</head>
<body>
    <div class="page cover-page">
        <div class="cover-top">
            <div class="cover-badge">私人定制 · 尊享体验</div>
            <h1 class="cover-title">新加坡管家服务<br>您的专属生活助手</h1>
            <p class="cover-subtitle">从落地到安家，让您的新加坡之旅无忧无虑</p>
            <div class="cover-highlight">
                <div class="highlight-item"><div class="highlight-number">24h</div><div class="highlight-label">全天候响应</div></div>
                <div class="highlight-item"><div class="highlight-number">1v1</div><div class="highlight-label">专属管家</div></div>
                <div class="highlight-item"><div class="highlight-number">100+</div><div class="highlight-label">服务项目</div></div>
            </div>
        </div>
        <div class="cover-bottom">
            <div class="cover-features">
                <div class="feature-box"><div class="feature-icon">🏠</div><div class="feature-title">安家服务</div><div class="feature-desc">租房、购房<br>装修、搬家全包</div></div>
                <div class="feature-box"><div class="feature-icon">📋</div><div class="feature-title">证件办理</div><div class="feature-desc">签证、银行、手机<br>一站式搞定</div></div>
                <div class="feature-box"><div class="feature-icon">🚗</div><div class="feature-title">出行陪同</div><div class="feature-desc">接机、用车、翻译<br>全程贴心陪伴</div></div>
            </div>
            <div class="cover-footer"><p><strong>Maple Education</strong> · 新加坡枫叶留学</p><p>WhatsApp: +65 8686 3695 | WeChat: +86 1350 693 8797</p></div>
        </div>
    </div>

    <div class="page">
        <div class="header"><div class="logo-area"><div class="logo-placeholder">M</div><span class="company-name">Maple Education</span></div><span class="page-number">02 / 06</span></div>
        <h2 class="section-title">管家服务类别</h2>
        <p class="section-subtitle">覆盖在新生活的方方面面，让您省心省力</p>
        <div class="service-category">
            <div class="category-card"><div class="category-icon">✈️</div><div class="category-name">落地安置服务</div><div class="category-desc">从机场到入住，一步到位</div><ul class="category-items"><li>机场VIP接机服务</li><li>临时住宿安排</li><li>电话卡办理</li><li>银行开户陪同</li><li>新加坡生活指导</li></ul></div>
            <div class="category-card"><div class="category-icon">🏠</div><div class="category-name">租房/购房服务</div><div class="category-desc">找到理想的家</div><ul class="category-items"><li>房源筛选与推荐</li><li>看房陪同与翻译</li><li>租约/购房合同审核</li><li>入住手续办理</li><li>家具家电采购指导</li></ul></div>
            <div class="category-card"><div class="category-icon">📄</div><div class="category-name">证件代办服务</div><div class="category-desc">繁琐手续我们来</div><ul class="category-items"><li>签证延期/更新</li><li>驾照转换</li><li>公证/认证文件</li><li>保险购买</li><li>政府部门预约</li></ul></div>
            <div class="category-card"><div class="category-icon">🚗</div><div class="category-name">出行陪同服务</div><div class="category-desc">全程贴心陪伴</div><ul class="category-items"><li>商务用车安排</li><li>购物陪同</li><li>医院就诊陪同</li><li>学校参观陪同</li><li>翻译服务</li></ul></div>
        </div>
        <h3 style="font-size: 15px; color: #1a2744; margin: 15px 0 12px;">我们的优势</h3>
        <div class="advantage-grid">
            <div class="advantage-item"><div class="advantage-icon">🌟</div><div class="advantage-title">本地团队</div><div class="advantage-desc">新加坡全职团队<br>响应快速</div></div>
            <div class="advantage-item"><div class="advantage-icon">🔒</div><div class="advantage-title">信息保密</div><div class="advantage-desc">严格隐私保护<br>安全可靠</div></div>
            <div class="advantage-item"><div class="advantage-icon">💎</div><div class="advantage-title">专业服务</div><div class="advantage-desc">5年+从业经验<br>熟悉本地</div></div>
            <div class="advantage-item"><div class="advantage-icon">💬</div><div class="advantage-title">中文沟通</div><div class="advantage-desc">无语言障碍<br>轻松对接</div></div>
        </div>
        <div class="tip-box"><div class="tip-title">🎯 适合人群</div><div class="tip-content">新移民家庭、留学生家长、商务人士、投资移民客户。无论您是初来乍到还是已经定居，我们都能为您提供量身定制的管家服务。</div></div>
    </div>

    <div class="page">
        <div class="header"><div class="logo-area"><div class="logo-placeholder">M</div><span class="company-name">Maple Education</span></div><span class="page-number">03 / 06</span></div>
        <h2 class="section-title">服务明细与价格</h2>
        <p class="section-subtitle">透明定价，按需选择，丰俭由人</p>
        <table class="service-table">
            <thead><tr><th style="width: 35%;">服务项目</th><th style="width: 40%;">服务内容</th><th style="width: 25%;">价格（S$）</th></tr></thead>
            <tbody>
                <tr class="category-header"><td colspan="3">✈️ 落地安置类</td></tr>
                <tr><td>机场接机</td><td>专车接机，协助行李，送至住所</td><td class="price">80-150</td></tr>
                <tr><td>落地安置包</td><td>接机+电话卡+银行开户+生活指导</td><td class="price">500</td></tr>
                <tr><td>临时住宿安排</td><td>代订酒店/服务公寓，陪同入住</td><td class="price">100</td></tr>
                <tr class="category-header"><td colspan="3">🏠 租房/购房类</td></tr>
                <tr><td>租房全程服务</td><td>需求分析+房源筛选+看房陪同+签约协助</td><td class="price">800-1,500</td></tr>
                <tr><td>单次看房陪同</td><td>半天看房（最多3套），含翻译</td><td class="price">200</td></tr>
                <tr><td>购房顾问服务</td><td>需求分析+楼盘推荐+看房陪同+交易协助</td><td class="price">按成交价0.5%</td></tr>
                <tr class="category-header"><td colspan="3">📄 证件代办类</td></tr>
                <tr><td>银行开户陪同</td><td>预约+陪同+翻译+材料准备</td><td class="price">150</td></tr>
                <tr><td>驾照转换</td><td>材料准备+预约+陪同办理</td><td class="price">300</td></tr>
                <tr><td>签证延期/续签</td><td>材料准备+在线提交+进度跟踪</td><td class="price">200-500</td></tr>
                <tr class="category-header"><td colspan="3">🚗 出行陪同类</td></tr>
                <tr><td>半日陪同</td><td>4小时内，含翻译/购物/办事</td><td class="price">200</td></tr>
                <tr><td>全日陪同</td><td>8小时，含翻译/购物/办事</td><td class="price">350</td></tr>
                <tr><td>医院陪诊</td><td>预约+陪同+翻译+取药</td><td class="price">250</td></tr>
            </tbody>
        </table>
        <div class="tip-box"><div class="tip-title">💡 价格说明</div><div class="tip-content">以上为基础价格，实际费用可能因具体需求调整。套餐服务更优惠，详见下页。所有服务均开具正规收据。</div></div>
    </div>

    <div class="page">
        <div class="header"><div class="logo-area"><div class="logo-placeholder">M</div><span class="company-name">Maple Education</span></div><span class="page-number">04 / 06</span></div>
        <h2 class="section-title">管家服务套餐</h2>
        <p class="section-subtitle">根据您的需求选择合适的套餐，享受更多优惠</p>
        <div class="package-grid">
            <div class="package-card"><div class="package-name">落地无忧包</div><div class="package-desc">初来新加坡必备</div><div class="package-price">S$500</div><div class="package-unit">一次性</div><ul class="package-features"><li>机场接机服务</li><li>电话卡办理</li><li>银行开户陪同</li><li>公交卡办理</li><li>生活指南讲解</li><li>常用APP安装指导</li></ul></div>
            <div class="package-card featured"><span class="package-badge">推荐</span><div class="package-name">安家全程包</div><div class="package-desc">租房+安置一站式</div><div class="package-price">S$1,800</div><div class="package-unit">一次性</div><ul class="package-features"><li>落地无忧包全部内容</li><li>租房全程服务</li><li>家具家电采购指导</li><li>网络/水电开通协助</li><li>周边生活设施介绍</li><li>1个月生活顾问</li></ul></div>
            <div class="package-card"><div class="package-name">VIP年度管家</div><div class="package-desc">全年无忧尊享服务</div><div class="package-price">S$5,000</div><div class="package-unit">每年</div><ul class="package-features"><li>专属管家一对一</li><li>24小时微信响应</li><li>每月4小时陪同服务</li><li>证件代办优先处理</li><li>紧急事务协助</li><li>商家折扣资源</li></ul></div>
        </div>
        <h3 style="font-size: 15px; color: #1a2744; margin: 20px 0 12px;">服务流程</h3>
        <div class="process-timeline">
            <div class="process-step"><div class="step-circle">📞</div><div class="step-title">咨询沟通</div><div class="step-desc">了解需求</div></div>
            <div class="process-step"><div class="step-circle">📋</div><div class="step-title">定制方案</div><div class="step-desc">制定计划</div></div>
            <div class="process-step"><div class="step-circle">💳</div><div class="step-title">确认付款</div><div class="step-desc">签约预付</div></div>
            <div class="process-step"><div class="step-circle">🎯</div><div class="step-title">执行服务</div><div class="step-desc">专业高效</div></div>
            <div class="process-step"><div class="step-circle">✅</div><div class="step-title">完成反馈</div><div class="step-desc">满意确认</div></div>
        </div>
        <div class="tip-box"><div class="tip-title">🎁 组合优惠</div><div class="tip-content">同时购买留学服务+管家服务，可享9折优惠。推荐新客户成功签约，双方各获S$100服务抵扣券。</div></div>
    </div>

    <div class="page">
        <div class="header"><div class="logo-area"><div class="logo-placeholder">M</div><span class="company-name">Maple Education</span></div><span class="page-number">05 / 06</span></div>
        <h2 class="section-title">客户评价</h2>
        <p class="section-subtitle">真实反馈，见证我们的专业与用心</p>
        <div class="testimonial-grid">
            <div class="testimonial-card"><div class="testimonial-content">"刚到新加坡人生地不熟，Maple的管家服务帮了大忙。从接机到开户、租房，全程陪同，特别专业。现在孩子顺利入学，我也找到了满意的公寓。"</div><div class="testimonial-author"><div class="author-avatar">王</div><div class="author-info"><div class="author-name">王女士</div><div class="author-desc">陪读妈妈 · 来自上海</div></div></div></div>
            <div class="testimonial-card"><div class="testimonial-content">"作为新移民，对新加坡很多政策和流程都不了解。管家帮我办理了驾照转换、保险购买，还陪我去银行开了公司账户，省了不少麻烦。"</div><div class="testimonial-author"><div class="author-avatar">李</div><div class="author-info"><div class="author-name">李先生</div><div class="author-desc">创业者 · EP持有人</div></div></div></div>
            <div class="testimonial-card"><div class="testimonial-content">"孩子生病去医院，语言不通很着急。预约了陪诊服务，管家全程翻译，还帮忙取药、联系保险理赔，太贴心了！"</div><div class="testimonial-author"><div class="author-avatar">张</div><div class="author-info"><div class="author-name">张女士</div><div class="author-desc">陪读家长 · 来自北京</div></div></div></div>
            <div class="testimonial-card"><div class="testimonial-content">"购买了VIP年度管家服务，真的物超所值。每次有事微信联系，响应特别快，感觉在新加坡也有了自己的'家人'。"</div><div class="testimonial-author"><div class="author-avatar">陈</div><div class="author-info"><div class="author-name">陈先生</div><div class="author-desc">投资移民 · 来自深圳</div></div></div></div>
        </div>
        <h3 style="font-size: 15px; color: #1a2744; margin: 25px 0 12px;">常见问题</h3>
        <div style="background: #faf9f6; border-radius: 12px; padding: 18px;">
            <div style="margin-bottom: 12px;"><div style="font-size: 12px; font-weight: bold; color: #B8860B; margin-bottom: 5px;">Q: 可以只购买单项服务吗？</div><div style="font-size: 11px; color: #666; padding-left: 15px;">A: 当然可以。我们提供灵活的单项服务和套餐服务，您可以根据需要自由选择。</div></div>
            <div style="margin-bottom: 12px;"><div style="font-size: 12px; font-weight: bold; color: #B8860B; margin-bottom: 5px;">Q: 如何付款？支持什么方式？</div><div style="font-size: 11px; color: #666; padding-left: 15px;">A: 支持银行转账、PayNow、支付宝、微信支付。大额服务可分期付款。</div></div>
            <div style="margin-bottom: 12px;"><div style="font-size: 12px; font-weight: bold; color: #B8860B; margin-bottom: 5px;">Q: 服务范围覆盖新加坡哪些区域？</div><div style="font-size: 11px; color: #666; padding-left: 15px;">A: 全岛覆盖。偏远地区可能收取少量交通补贴，具体提前沟通。</div></div>
            <div><div style="font-size: 12px; font-weight: bold; color: #B8860B; margin-bottom: 5px;">Q: 紧急情况如何联系？</div><div style="font-size: 11px; color: #666; padding-left: 15px;">A: VIP客户享有24小时紧急响应。普通客户工作时间内2小时内回复。</div></div>
        </div>
    </div>

    <div class="page">
        <div class="header"><div class="logo-area"><div class="logo-placeholder">M</div><span class="company-name">Maple Education</span></div><span class="page-number">06 / 06</span></div>
        <h2 class="section-title">开启您的尊享服务</h2>
        <p class="section-subtitle">让专业的人做专业的事，您只需享受新加坡生活</p>
        <div style="background: linear-gradient(135deg, #faf9f6, #f0ebe0); border-radius: 15px; padding: 25px; margin-bottom: 25px;">
            <h3 style="font-size: 16px; color: #1a2744; margin-bottom: 15px;">🎁 新客专享</h3>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                <div style="background: white; padding: 15px; border-radius: 10px; border-left: 3px solid #B8860B;"><div style="font-size: 14px; font-weight: bold; color: #1a2744;">免费咨询</div><div style="font-size: 12px; color: #666;">30分钟深度沟通，了解您的需求</div></div>
                <div style="background: white; padding: 15px; border-radius: 10px; border-left: 3px solid #B8860B;"><div style="font-size: 14px; font-weight: bold; color: #1a2744;">首单优惠</div><div style="font-size: 12px; color: #666;">新客首次服务享9折优惠</div></div>
                <div style="background: white; padding: 15px; border-radius: 10px; border-left: 3px solid #B8860B;"><div style="font-size: 14px; font-weight: bold; color: #1a2744;">新加坡生活指南</div><div style="font-size: 12px; color: #666;">电子版生活攻略免费领取</div></div>
                <div style="background: white; padding: 15px; border-radius: 10px; border-left: 3px solid #B8860B;"><div style="font-size: 14px; font-weight: bold; color: #1a2744;">推荐奖励</div><div style="font-size: 12px; color: #666;">成功推荐新客户，双方各获S$100券</div></div>
            </div>
        </div>
        <div style="background: linear-gradient(135deg, #E8F5E9, #C8E6C9); border-radius: 15px; padding: 20px; margin-bottom: 25px;">
            <h3 style="font-size: 15px; color: #333; margin-bottom: 12px;">📋 预约流程</h3>
            <div style="display: flex; gap: 15px; text-align: center;">
                <div style="flex: 1; background: white; padding: 15px; border-radius: 10px;"><div style="font-size: 24px; margin-bottom: 5px;">1️⃣</div><div style="font-size: 12px; font-weight: bold; color: #333;">微信/WhatsApp联系</div><div style="font-size: 10px; color: #999;">说明您的需求</div></div>
                <div style="flex: 1; background: white; padding: 15px; border-radius: 10px;"><div style="font-size: 24px; margin-bottom: 5px;">2️⃣</div><div style="font-size: 12px; font-weight: bold; color: #333;">获取报价方案</div><div style="font-size: 10px; color: #999;">定制服务计划</div></div>
                <div style="flex: 1; background: white; padding: 15px; border-radius: 10px;"><div style="font-size: 24px; margin-bottom: 5px;">3️⃣</div><div style="font-size: 12px; font-weight: bold; color: #333;">确认预约付款</div><div style="font-size: 10px; color: #999;">安排服务时间</div></div>
                <div style="flex: 1; background: white; padding: 15px; border-radius: 10px;"><div style="font-size: 24px; margin-bottom: 5px;">4️⃣</div><div style="font-size: 12px; font-weight: bold; color: #333;">享受专属服务</div><div style="font-size: 10px; color: #999;">管家贴心陪伴</div></div>
            </div>
        </div>
        <div class="contact-section">
            <h3 class="contact-title">立即预约管家服务</h3>
            <p class="contact-subtitle">您的满意是我们最大的追求</p>
            <div class="contact-grid">
                <div class="contact-item"><div class="contact-label">新加坡 / WhatsApp</div><div class="contact-value">+65 8686 3695</div></div>
                <div class="contact-item"><div class="contact-label">中国 / 微信</div><div class="contact-value">+86 1350 693 8797</div></div>
                <div class="contact-item"><div class="contact-label">电子邮箱</div><div class="contact-value">Maple@maplesgedu.com</div></div>
                <div class="contact-item"><div class="contact-label">官方网站</div><div class="contact-value">www.maplesgedu.com</div></div>
            </div>
        </div>
        <div style="text-align: center; margin-top: 25px; padding-top: 15px; border-top: 1px solid #e8dfc9;"><p style="font-size: 11px; color: #999;">Maple Education Pte. Ltd. | UEN: 202044651W</p><p style="font-size: 11px; color: #999;">📍 新加坡 · 您的专属生活管家</p></div>
    </div>
</body>
</html>
```
