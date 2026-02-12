---
title: "Deck_05_新加坡幼儿园.html"
source_path: "05_Marketing_Media/Decks/Deck_05_新加坡幼儿园.html"
tags: ["新加坡", "Maple", "html"]
ocr: false
---

# Deck_05_新加坡幼儿园.html

简介：内容概述：<!DOCTYPE html>

## 内容

```text
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Maple Education - 新加坡幼儿园</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        @page {
            size: A4;
            margin: 0;
        }

        body {
            font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif;
            background: #f5f5f5;
            color: #333;
            line-height: 1.6;
        }

        .page {
            width: 210mm;
            height: 297mm;
            background: white;
            margin: 0 auto 20px;
            padding: 15mm 18mm;
            position: relative;
            overflow: hidden;
            page-break-after: always;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }

        @media print {
            body { background: white; }
            .page {
                margin: 0;
                box-shadow: none;
                page-break-after: always;
            }
        }

        /* 品牌色彩 - 幼儿园主题用温暖的橙色 */
        .brand-orange { color: #FF6B35; }
        .brand-pink { color: #FF85A2; }
        .bg-orange { background: #FF6B35; }
        .bg-pink { background: #FF85A2; }

        /* 页眉 */
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding-bottom: 10px;
            border-bottom: 2px solid #FF6B35;
            margin-bottom: 15px;
        }

        .logo-area {
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .logo-placeholder {
            width: 40px;
            height: 40px;
            background: linear-gradient(135deg, #FF6B35, #FF85A2);
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-weight: bold;
            font-size: 18px;
        }

        .company-name {
            font-size: 14px;
            color: #FF6B35;
            font-weight: 600;
        }

        .page-number {
            font-size: 12px;
            color: #999;
        }

        /* 封面页 */
        .cover-page {
            padding: 0;
            display: flex;
            flex-direction: column;
        }

        .cover-top {
            background: linear-gradient(135deg, #FF6B35 0%, #FF85A2 50%, #FFB347 100%);
            height: 55%;
            padding: 25mm 20mm;
            color: white;
            position: relative;
        }

        .cover-top::after {
            content: '';
            position: absolute;
            bottom: -30px;
            left: 0;
            right: 0;
            height: 60px;
            background: white;
            clip-path: polygon(0 50%, 100% 0, 100% 100%, 0 100%);
        }

        .cover-badge {
            display: inline-block;
            background: white;
            color: #FF6B35;
            padding: 6px 16px;
            border-radius: 20px;
            font-size: 13px;
            font-weight: bold;
            margin-bottom: 20px;
        }

        .cover-title {
            font-size: 36px;
            font-weight: bold;
            margin-bottom: 15px;
            line-height: 1.3;
        }

        .cover-subtitle {
            font-size: 18px;
            opacity: 0.95;
            margin-bottom: 25px;
        }

        .cover-highlight {
            display: flex;
            gap: 30px;
            margin-top: 20px;
        }

        .highlight-item {
            text-align: center;
        }

        .highlight-number {
            font-size: 34px;
            font-weight: bold;
            color: #FFE066;
        }

        .highlight-label {
            font-size: 13px;
            opacity: 0.9;
        }

        .cover-bottom {
            height: 45%;
            padding: 40px 20mm 20mm;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
        }

        .cover-features {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 20px;
        }

        .feature-box {
            text-align: center;
            padding: 15px;
            background: linear-gradient(135deg, #FFF5F0, #FFF0F5);
            border-radius: 15px;
        }

        .feature-icon {
            font-size: 36px;
            margin-bottom: 8px;
        }

        .feature-title {
            font-size: 14px;
            font-weight: 600;
            color: #FF6B35;
            margin-bottom: 4px;
        }

        .feature-desc {
            font-size: 11px;
            color: #666;
        }

        .cover-footer {
            text-align: center;
            padding-top: 15px;
            border-top: 1px solid #eee;
        }

        .cover-footer p {
            font-size: 12px;
            color: #666;
        }

        /* 内容标题 */
        .section-title {
            font-size: 24px;
            color: #FF6B35;
            margin-bottom: 20px;
            padding-bottom: 10px;
            border-bottom: 3px solid #FFB347;
            display: inline-block;
        }

        .section-subtitle {
            font-size: 14px;
            color: #666;
            margin-bottom: 20px;
        }

        /* 幼儿园类型卡片 */
        .kindergarten-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 15px;
            margin-bottom: 20px;
        }

        .kg-card {
            background: white;
            border-radius: 15px;
            padding: 20px;
            box-shadow: 0 3px 10px rgba(0,0,0,0.08);
            border-left: 5px solid #FF6B35;
        }

        .kg-card.moe { border-left-color: #2196F3; }
        .kg-card.private { border-left-color: #4CAF50; }
        .kg-card.international { border-left-color: #9C27B0; }

        .kg-badge {
            display: inline-block;
            padding: 3px 12px;
            border-radius: 15px;
            font-size: 10px;
            font-weight: bold;
            color: white;
            margin-bottom: 10px;
        }

        .kg-card.moe .kg-badge { background: #2196F3; }
        .kg-card.private .kg-badge { background: #4CAF50; }
        .kg-card.international .kg-badge { background: #9C27B0; }

        .kg-name {
            font-size: 16px;
            font-weight: bold;
            color: #333;
            margin-bottom: 5px;
        }

        .kg-name-en {
            font-size: 11px;
            color: #999;
            margin-bottom: 12px;
        }

        .kg-info {
            font-size: 12px;
            color: #666;
        }

        .kg-info li {
            margin-bottom: 5px;
            list-style: none;
            padding-left: 18px;
            position: relative;
        }

        .kg-info li::before {
            content: '•';
            position: absolute;
            left: 0;
            color: #FF6B35;
            font-weight: bold;
        }

        /* 对比表格 */
        .compare-table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 20px;
            font-size: 11px;
        }

        .compare-table th {
            background: linear-gradient(135deg, #FF6B35, #FF85A2);
            color: white;
            padding: 12px 8px;
            text-align: center;
            font-weight: 600;
        }

        .compare-table td {
            padding: 10px 8px;
            border: 1px solid #ffe0d0;
            text-align: center;
        }

        .compare-table tr:nth-child(even) {
            background: #FFF5F0;
        }

        .compare-table .highlight-cell {
            background: #FFE0B2;
            font-weight: bold;
        }

        /* 年龄阶段 */
        .age-timeline {
            display: flex;
            gap: 10px;
            margin: 20px 0;
        }

        .age-stage {
            flex: 1;
            background: white;
            border-radius: 12px;
            padding: 15px;
            text-align: center;
            box-shadow: 0 2px 8px rgba(0,0,0,0.08);
            position: relative;
        }

        .age-stage::after {
            content: '→';
            position: absolute;
            right: -15px;
            top: 50%;
            transform: translateY(-50%);
            font-size: 16px;
            color: #FF6B35;
        }

        .age-stage:last-child::after {
            display: none;
        }

        .age-icon {
            font-size: 28px;
            margin-bottom: 8px;
        }

        .age-range {
            font-size: 16px;
            font-weight: bold;
            color: #FF6B35;
        }

        .age-name {
            font-size: 12px;
            color: #666;
            margin-top: 3px;
        }

        .age-name-en {
            font-size: 10px;
            color: #999;
        }

        /* 热门幼儿园 */
        .popular-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 12px;
            margin-bottom: 20px;
        }

        .popular-card {
            background: linear-gradient(135deg, #FFF5F0, #fff);
            border-radius: 10px;
            padding: 15px;
            text-align: center;
            border: 1px solid #ffe0d0;
        }

        .popular-logo {
            width: 50px;
            height: 50px;
            background: white;
            border-radius: 50%;
            margin: 0 auto 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 12px;
            font-weight: bold;
            color: #FF6B35;
            border: 2px solid #FF6B35;
        }

        .popular-name {
            font-size: 12px;
            font-weight: bold;
            color: #333;
            margin-bottom: 3px;
        }

        .popular-type {
            font-size: 10px;
            color: #999;
            margin-bottom: 8px;
        }

        .popular-fee {
            font-size: 11px;
            color: #FF6B35;
            font-weight: bold;
        }

        /* 价格卡片 */
        .price-cards {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 15px;
            margin-bottom: 20px;
        }

        .price-card {
            background: white;
            border: 2px solid #ffe0d0;
            border-radius: 15px;
            padding: 20px;
            text-align: center;
        }

        .price-card.featured {
            border-color: #FF6B35;
            background: linear-gradient(135deg, #FFF5F0, #fff);
            transform: scale(1.02);
            box-shadow: 0 4px 15px rgba(255,107,53,0.2);
        }

        .price-card-badge {
            display: inline-block;
            background: #FF6B35;
            color: white;
            padding: 3px 12px;
            border-radius: 15px;
            font-size: 10px;
            margin-bottom: 10px;
        }

        .price-card-title {
            font-size: 14px;
            font-weight: bold;
            color: #333;
            margin-bottom: 5px;
        }

        .price-card-subtitle {
            font-size: 11px;
            color: #999;
            margin-bottom: 15px;
        }

        .price-amount {
            font-size: 26px;
            font-weight: bold;
            color: #FF6B35;
            margin-bottom: 5px;
        }

        .price-unit {
            font-size: 11px;
            color: #999;
            margin-bottom: 15px;
        }

        .price-features {
            text-align: left;
            font-size: 11px;
            color: #666;
        }

        .price-features li {
            margin-bottom: 5px;
            list-style: none;
            padding-left: 18px;
            position: relative;
        }

        .price-features li::before {
            content: '✓';
            position: absolute;
            left: 0;
            color: #4CAF50;
        }

        /* 提示框 */
        .tip-box {
            background: linear-gradient(135deg, #FFF8E1, #FFF3CD);
            border-left: 4px solid #FFB347;
            padding: 15px;
            border-radius: 0 12px 12px 0;
            margin: 15px 0;
        }

        .tip-box.success {
            background: linear-gradient(135deg, #E8F5E9, #C8E6C9);
            border-color: #4CAF50;
        }

        .tip-title {
            font-size: 13px;
            font-weight: bold;
            color: #333;
            margin-bottom: 5px;
        }

        .tip-content {
            font-size: 12px;
            color: #666;
        }

        /* 服务流程 */
        .service-flow {
            display: flex;
            justify-content: space-between;
            margin: 20px 0;
            position: relative;
        }

        .service-flow::before {
            content: '';
            position: absolute;
            top: 30px;
            left: 10%;
            right: 10%;
            height: 3px;
            background: linear-gradient(to right, #FF6B35, #FF85A2, #FFB347);
            border-radius: 2px;
        }

        .service-step {
            flex: 1;
            text-align: center;
            position: relative;
            z-index: 1;
        }

        .step-icon {
            width: 60px;
            height: 60px;
            background: linear-gradient(135deg, #FF6B35, #FF85A2);
            color: white;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 24px;
            margin: 0 auto 10px;
            border: 3px solid white;
            box-shadow: 0 3px 10px rgba(255,107,53,0.3);
        }

        .step-title {
            font-size: 12px;
            font-weight: bold;
            color: #333;
        }

        .step-desc {
            font-size: 10px;
            color: #999;
        }

        /* 签证信息 */
        .visa-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 15px;
            margin-bottom: 20px;
        }

        .visa-card {
            background: white;
            border-radius: 12px;
            padding: 18px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.08);
        }

        .visa-title {
            font-size: 14px;
            font-weight: bold;
            color: #FF6B35;
            margin-bottom: 10px;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .visa-content {
            font-size: 12px;
            color: #666;
        }

        .visa-content li {
            margin-bottom: 5px;
            list-style: none;
            padding-left: 15px;
            position: relative;
        }

        .visa-content li::before {
            content: '•';
            position: absolute;
            left: 0;
            color: #FF6B35;
        }

        /* 联系区域 */
        .contact-section {
            background: linear-gradient(135deg, #FF6B35 0%, #FF85A2 100%);
            border-radius: 20px;
            padding: 30px;
            color: white;
            text-align: center;
            margin-top: 20px;
        }

        .contact-title {
            font-size: 22px;
            margin-bottom: 10px;
        }

        .contact-subtitle {
            font-size: 13px;
            opacity: 0.9;
            margin-bottom: 25px;
        }

        .contact-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 20px;
            text-align: left;
        }

        .contact-item {
            background: rgba(255,255,255,0.15);
            border-radius: 12px;
            padding: 15px;
        }

        .contact-label {
            font-size: 11px;
            opacity: 0.8;
            margin-bottom: 5px;
        }

        .contact-value {
            font-size: 14px;
            font-weight: 600;
        }

        /* 课程特色 */
        .curriculum-features {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 12px;
            margin: 15px 0;
        }

        .curriculum-item {
            background: #FFF5F0;
            border-radius: 10px;
            padding: 12px;
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .curriculum-icon {
            width: 40px;
            height: 40px;
            background: linear-gradient(135deg, #FF6B35, #FF85A2);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 18px;
            flex-shrink: 0;
        }

        .curriculum-text {
            font-size: 12px;
            color: #333;
        }

        .curriculum-text strong {
            display: block;
            margin-bottom: 2px;
        }

        /* Q&A 样式 */
        .qa-section {
            background: #f8f9fa;
            border-radius: 12px;
            padding: 18px;
            margin-bottom: 15px;
        }

        .qa-item {
            margin-bottom: 12px;
        }

        .qa-item:last-child {
            margin-bottom: 0;
        }

        .qa-q {
            font-size: 12px;
            font-weight: bold;
            color: #FF6B35;
            margin-bottom: 5px;
        }

        .qa-a {
            font-size: 11px;
            color: #666;
            padding-left: 15px;
        }
    </style>
</head>
<body>
    <!-- 第1页：封面 -->
    <div class="page cover-page">
        <div class="cover-top">
            <div class="cover-badge">2-6岁 · 快乐启蒙</div>
            <h1 class="cover-title">新加坡幼儿园<br>双语启蒙黄金期</h1>
            <p class="cover-subtitle">给孩子一个快乐的国际化童年起点</p>

            <div class="cover-highlight">
                <div class="highlight-item">
                    <div class="highlight-number">300+</div>
                    <div class="highlight-label">幼儿园选择</div>
                </div>
                <div class="highlight-item">
                    <div class="highlight-number">双语</div>
                    <div class="highlight-label">教学环境</div>
                </div>
                <div class="highlight-item">
                    <div class="highlight-number">S$600</div>
                    <div class="highlight-label">起/月</div>
                </div>
            </div>
        </div>

        <div class="cover-bottom">
            <div class="cover-features">
                <div class="feature-box">
                    <div class="feature-icon">👶</div>
                    <div class="feature-title">无需考试</div>
                    <div class="feature-desc">2-6岁直接入学<br>无语言门槛</div>
                </div>
                <div class="feature-box">
                    <div class="feature-icon">🌈</div>
                    <div class="feature-title">双语教育</div>
                    <div class="feature-desc">英语+华语<br>自然习得</div>
                </div>
                <div class="feature-box">
                    <div class="feature-icon">👨‍👩‍👧</div>
                    <div class="feature-title">陪读签证</div>
                    <div class="feature-desc">妈妈/奶奶<br>可陪同照顾</div>
                </div>
            </div>

            <div class="cover-footer">
                <p><strong>Maple Education</strong> · 新加坡枫叶留学</p>
                <p>WhatsApp: +65 8686 3695 | WeChat: +86 1350 693 8797</p>
            </div>
        </div>
    </div>

    <!-- 第2页：幼儿园类型介绍 -->
    <div class="page">
        <div class="header">
            <div class="logo-area">
                <div class="logo-placeholder">M</div>
                <span class="company-name">Maple Education</span>
            </div>
            <span class="page-number">02 / 06</span>
        </div>

        <h2 class="section-title">新加坡幼儿园类型</h2>
        <p class="section-subtitle">新加坡幼儿园分为三大类，各有特色，满足不同家庭需求</p>

        <div class="kindergarten-grid">
            <div class="kg-card moe">
                <span class="kg-badge">政府背景</span>
                <div class="kg-name">政府/政府资助幼儿园</div>
                <div class="kg-name-en">MOE Kindergarten / Anchor Operators</div>
                <ul class="kg-info">
                    <li><strong>代表：</strong>MOE Kindergarten、PAP、NTUC</li>
                    <li><strong>费用：</strong>S$160-800/月（国际生较高）</li>
                    <li><strong>特点：</strong>教育部统一课程，质量有保证</li>
                    <li><strong>限制：</strong>部分优先录取本地学生</li>
                </ul>
            </div>
            <div class="kg-card private">
                <span class="kg-badge">推荐选择</span>
                <div class="kg-name">私立幼儿园</div>
                <div class="kg-name-en">Private Kindergartens</div>
                <ul class="kg-info">
                    <li><strong>代表：</strong>Mindchamps、Mulberry、EtonHouse</li>
                    <li><strong>费用：</strong>S$800-2,000/月</li>
                    <li><strong>特点：</strong>课程灵活，国际学生友好</li>
                    <li><strong>优势：</strong>双语环境好，申请流程简单</li>
                </ul>
            </div>
            <div class="kg-card international">
                <span class="kg-badge">高端路线</span>
                <div class="kg-name">国际学校幼儿园</div>
                <div class="kg-name-en">International School Preschool</div>
                <ul class="kg-info">
                    <li><strong>代表：</strong>CIS、AIS、Dulwich早期教育</li>
                    <li><strong>费用：</strong>S$2,000-3,500/月</li>
                    <li><strong>特点：</strong>直升该校小学，IB/英式课程</li>
                    <li><strong>适合：</strong>计划长期走国际学校路线</li>
                </ul>
            </div>
            <div class="kg-card">
                <span class="kg-badge">本地特色</span>
                <div class="kg-name">托儿所 Child Care</div>
                <div class="kg-name-en">Full-day Care + Education</div>
                <ul class="kg-info">
                    <li><strong>年龄：</strong>2个月-6岁</li>
                    <li><strong>时间：</strong>全日制（7am-7pm）</li>
                    <li><strong>特点：</strong>照顾+教育一体化</li>
                    <li><strong>适合：</strong>陪读妈妈需要工作的家庭</li>
                </ul>
            </div>
        </div>

        <h3 style="font-size: 15px; color: #FF6B35; margin: 15px 0 12px;">学制与年龄对应</h3>

        <div class="age-timeline">
            <div class="age-stage">
                <div class="age-icon">👶</div>
                <div class="age-range">2-3岁</div>
                <div class="age-name">托班</div>
                <div class="age-name-en">Playgroup</div>
            </div>
            <div class="age-stage">
                <div class="age-icon">🧒</div>
                <div class="age-range">3-4岁</div>
                <div class="age-name">小班</div>
                <div class="age-name-en">Nursery 1</div>
            </div>
            <div class="age-stage">
                <div class="age-icon">👧</div>
                <div class="age-range">4-5岁</div>
                <div class="age-name">中班</div>
                <div class="age-name-en">Nursery 2</div>
            </div>
            <div class="age-stage">
                <div class="age-icon">🧒</div>
                <div class="age-range">5-6岁</div>
                <div class="age-name">大班</div>
                <div class="age-name-en">Kindergarten 1</div>
            </div>
            <div class="age-stage">
                <div class="age-icon">🎓</div>
                <div class="age-range">6-7岁</div>
                <div class="age-name">学前班</div>
                <div class="age-name-en">Kindergarten 2</div>
            </div>
        </div>

        <div class="tip-box">
            <div class="tip-title">💡 入学年龄说明</div>
            <div class="tip-content">
                新加坡学年从1月开始。孩子在入学当年1月1日前满足年龄要求即可入读对应年级。例如：2020年6月出生的孩子，2024年1月可入读Nursery 1（小班）。
            </div>
        </div>
    </div>

    <!-- 第3页：热门幼儿园推荐 -->
    <div class="page">
        <div class="header">
            <div class="logo-area">
                <div class="logo-placeholder">M</div>
                <span class="company-name">Maple Education</span>
            </div>
            <span class="page-number">03 / 06</span>
        </div>

        <h2 class="section-title">热门幼儿园推荐</h2>
        <p class="section-subtitle">精选国际学生友好、口碑优秀的幼儿园</p>

        <div class="popular-grid">
            <div class="popular-card">
                <div class="popular-logo">MC</div>
                <div class="popular-name">MindChamps</div>
                <div class="popular-type">私立连锁 · 全岛30+</div>
                <div class="popular-fee">S$1,200-1,800/月</div>
            </div>
            <div class="popular-card">
                <div class="popular-logo">ML</div>
                <div class="popular-name">Mulberry Learning</div>
                <div class="popular-type">私立 · Reggio特色</div>
                <div class="popular-fee">S$1,400-1,900/月</div>
            </div>
            <div class="popular-card">
                <div class="popular-logo">EH</div>
                <div class="popular-name">EtonHouse</div>
                <div class="popular-type">国际 · IB PYP</div>
                <div class="popular-fee">S$1,800-2,500/月</div>
            </div>
            <div class="popular-card">
                <div class="popular-logo">PF</div>
                <div class="popular-name">Pat's Schoolhouse</div>
                <div class="popular-type">私立 · 双语特色</div>
                <div class="popular-fee">S$1,000-1,500/月</div>
            </div>
            <div class="popular-card">
                <div class="popular-logo">CL</div>
                <div class="popular-name">Creative Learning</div>
                <div class="popular-type">私立 · 艺术特色</div>
                <div class="popular-fee">S$900-1,300/月</div>
            </div>
            <div class="popular-card">
                <div class="popular-logo">白</div>
                <div class="popular-name">白沙幼儿园</div>
                <div class="popular-type">私立 · 华语强化</div>
                <div class="popular-fee">S$800-1,200/月</div>
            </div>
        </div>

        <h3 style="font-size: 15px; color: #FF6B35; margin: 20px 0 12px;">费用对比一览</h3>

        <table class="compare-table">
            <thead>
                <tr>
                    <th>类型</th>
                    <th>月费（S$）</th>
                    <th>注册费</th>
                    <th>国际生友好度</th>
                    <th>位置数量</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td>政府幼儿园</td>
                    <td>640-800</td>
                    <td>低</td>
                    <td>有限制</td>
                    <td>名额紧张</td>
                </tr>
                <tr class="highlight-cell">
                    <td><strong>私立幼儿园</strong></td>
                    <td><strong>800-2,000</strong></td>
                    <td>中</td>
                    <td class="highlight-cell">高</td>
                    <td>充足</td>
                </tr>
                <tr>
                    <td>国际学校</td>
                    <td>2,000-3,500</td>
                    <td>高</td>
                    <td>最高</td>
                    <td>需排队</td>
                </tr>
            </tbody>
        </table>

        <h3 style="font-size: 15px; color: #FF6B35; margin: 20px 0 12px;">课程特色</h3>

        <div class="curriculum-features">
            <div class="curriculum-item">
                <div class="curriculum-icon">📚</div>
                <div class="curriculum-text">
                    <strong>双语教育</strong>
                    英语为主、华语为辅，每日双语浸润
                </div>
            </div>
            <div class="curriculum-item">
                <div class="curriculum-icon">🎨</div>
                <div class="curriculum-text">
                    <strong>全人发展</strong>
                    注重创造力、社交能力和情商培养
                </div>
            </div>
            <div class="curriculum-item">
                <div class="curriculum-icon">🎮</div>
                <div class="curriculum-text">
                    <strong>游戏式学习</strong>
                    玩中学，激发孩子学习兴趣
                </div>
            </div>
            <div class="curriculum-item">
                <div class="curriculum-icon">🌱</div>
                <div class="curriculum-text">
                    <strong>户外探索</strong>
                    新加坡气候适宜户外活动
                </div>
            </div>
        </div>

        <div class="tip-box success">
            <div class="tip-title">✅ 选园建议</div>
            <div class="tip-content">
                建议实地探校，观察孩子与老师的互动。优先选择离住所近、有中文老师的幼儿园，帮助孩子更好适应。私立幼儿园对国际学生最友好，入学流程最简单。
            </div>
        </div>
    </div>

    <!-- 第4页：费用与签证 -->
    <div class="page">
        <div class="header">
            <div class="logo-area">
                <div class="logo-placeholder">M</div>
                <span class="company-name">Maple Education</span>
            </div>
            <span class="page-number">04 / 06</span>
        </div>

        <h2 class="section-title">费用与签证指南</h2>
        <p class="section-subtitle">全面了解入读新加坡幼儿园的费用和签证要求</p>

        <h3 style="font-size: 15px; color: #FF6B35; margin-bottom: 12px;">签证类型</h3>

        <div class="visa-grid">
            <div class="visa-card">
                <div class="visa-title">👶 学生准证 Student Pass</div>
                <ul class="visa-content">
                    <li>适用于6岁以上或入读私立/国际幼儿园</li>
                    <li>部分私立幼儿园可协助申请</li>
                    <li>有效期与学校课程一致</li>
                    <li>需要学校录取通知书</li>
                </ul>
            </div>
            <div class="visa-card">
                <div class="visa-title">👩 陪读签证 Dependant Pass</div>
                <ul class="visa-content">
                    <li>适用于16岁以下学生的女性家属</li>
                    <li>可由妈妈、奶奶或外婆申请</li>
                    <li>第二年起可申请工作许可</li>
                    <li>与孩子签证绑定</li>
                </ul>
            </div>
            <div class="visa-card">
                <div class="visa-title">✈️ 短期访问签证</div>
                <ul class="visa-content">
                    <li>中国护照可申请多次往返签证</li>
                    <li>每次停留最长30天</li>
                    <li>适合短期体验或等待长期签证</li>
                    <li>不需要学校担保</li>
                </ul>
            </div>
            <div class="visa-card">
                <div class="visa-title">💼 家长工作签证</div>
                <ul class="visa-content">
                    <li>如父母持EP/SP工作签证</li>
                    <li>孩子可申请Dependant Pass</li>
                    <li>直接入读任何幼儿园</li>
                    <li>无需额外学生签证</li>
                </ul>
            </div>
        </div>

        <h3 style="font-size: 15px; color: #FF6B35; margin: 20px 0 12px;">费用预算清单</h3>

        <table class="compare-table" style="font-size: 11px;">
            <thead>
                <tr>
                    <th>费用项目</th>
                    <th>金额（S$）</th>
                    <th>说明</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td>幼儿园月费</td>
                    <td>800-2,500</td>
                    <td>因学校类型而异，半日/全日不同</td>
                </tr>
                <tr>
                    <td>注册费</td>
                    <td>200-1,000</td>
                    <td>一次性，不可退还</td>
                </tr>
                <tr>
                    <td>押金</td>
                    <td>1-2个月学费</td>
                    <td>离校时退还</td>
                </tr>
                <tr>
                    <td>校服/书包</td>
                    <td>100-300</td>
                    <td>按学校要求</td>
                </tr>
                <tr>
                    <td>陪读签证申请</td>
                    <td>政府费用约30</td>
                    <td>不含服务费</td>
                </tr>
                <tr>
                    <td>住房租金</td>
                    <td>1,500-3,000/月</td>
                    <td>组屋/公寓，看地段</td>
                </tr>
                <tr>
                    <td>生活费</td>
                    <td>1,000-1,500/月</td>
                    <td>一大一小基本开销</td>
                </tr>
            </tbody>
        </table>

        <div class="tip-box">
            <div class="tip-title">💰 年度费用估算</div>
            <div class="tip-content">
                选择私立幼儿园 + 陪读妈妈，每年总费用约 S$45,000-60,000（约人民币24-32万）。包含学费、住房、生活费。相比北上广深国际幼儿园，费用相当但教育环境更国际化。
            </div>
        </div>
    </div>

    <!-- 第5页：我们的服务 -->
    <div class="page">
        <div class="header">
            <div class="logo-area">
                <div class="logo-placeholder">M</div>
                <span class="company-name">Maple Education</span>
            </div>
            <span class="page-number">05 / 06</span>
        </div>

        <h2 class="section-title">我们的服务</h2>
        <p class="section-subtitle">从选园到入学，陪伴您和宝贝的每一步</p>

        <div class="service-flow">
            <div class="service-step">
                <div class="step-icon">💬</div>
                <div class="step-title">咨询评估</div>
                <div class="step-desc">了解需求</div>
            </div>
            <div class="service-step">
                <div class="step-icon">🏫</div>
                <div class="step-title">选园推荐</div>
                <div class="step-desc">匹配学校</div>
            </div>
            <div class="service-step">
                <div class="step-icon">👀</div>
                <div class="step-title">探校预约</div>
                <div class="step-desc">实地参观</div>
            </div>
            <div class="service-step">
                <div class="step-icon">📝</div>
                <div class="step-title">申请入学</div>
                <div class="step-desc">材料办理</div>
            </div>
            <div class="service-step">
                <div class="step-icon">✈️</div>
                <div class="step-title">签证安置</div>
                <div class="step-desc">顺利入园</div>
            </div>
        </div>

        <h3 style="font-size: 15px; color: #FF6B35; margin: 20px 0 12px;">服务套餐</h3>

        <div class="price-cards">
            <div class="price-card">
                <div class="price-card-title">咨询服务</div>
                <div class="price-card-subtitle">适合自助办理的家庭</div>
                <div class="price-amount">¥1,500</div>
                <div class="price-unit">一次性</div>
                <ul class="price-features">
                    <li>1小时深度咨询</li>
                    <li>幼儿园选校建议</li>
                    <li>签证政策解读</li>
                    <li>申请流程指导</li>
                    <li>费用预算规划</li>
                </ul>
            </div>
            <div class="price-card featured">
                <span class="price-card-badge">推荐</span>
                <div class="price-card-title">全程申请服务</div>
                <div class="price-card-subtitle">省心省力一站式</div>
                <div class="price-amount">S$1,500</div>
                <div class="price-unit">含入学+陪读签证</div>
                <ul class="price-features">
                    <li>3所幼儿园申请</li>
                    <li>探校预约与陪同</li>
                    <li>入学材料准备</li>
                    <li>陪读签证办理</li>
                    <li>住房推荐</li>
                    <li>入园适应跟进</li>
                </ul>
            </div>
            <div class="price-card">
                <div class="price-card-title">VIP管家服务</div>
                <div class="price-card-subtitle">全程无忧托管</div>
                <div class="price-amount">S$3,000</div>
                <div class="price-unit">含安置服务</div>
                <ul class="price-features">
                    <li>全程申请服务</li>
                    <li>机场接机</li>
                    <li>租房陪同签约</li>
                    <li>银行开户协助</li>
                    <li>手机卡办理</li>
                    <li>1个月生活指导</li>
                </ul>
            </div>
        </div>

        <h3 style="font-size: 15px; color: #FF6B35; margin: 20px 0 12px;">常见问题</h3>

        <div class="qa-section">
            <div class="qa-item">
                <div class="qa-q">Q: 孩子不会英语可以入读吗？</div>
                <div class="qa-a">A: 完全可以！2-4岁正是语言习得黄金期，孩子在双语环境中自然习得，通常3-6个月就能流利交流。</div>
            </div>
            <div class="qa-item">
                <div class="qa-q">Q: 陪读妈妈可以工作吗？</div>
                <div class="qa-a">A: 第一年不可以。从第二年起可申请工作准证（LOC），从事全职或兼职工作。</div>
            </div>
            <div class="qa-item">
                <div class="qa-q">Q: 幼儿园毕业后怎么升学？</div>
                <div class="qa-a">A: 可选择：1）参加AEIS考试进入政府小学；2）继续私立/国际学校；3）直升所在国际学校小学部。</div>
            </div>
        </div>
    </div>

    <!-- 第6页：联系我们 -->
    <div class="page">
        <div class="header">
            <div class="logo-area">
                <div class="logo-placeholder">M</div>
                <span class="company-name">Maple Education</span>
            </div>
            <span class="page-number">06 / 06</span>
        </div>

        <h2 class="section-title">给宝贝最好的启蒙</h2>
        <p class="section-subtitle">在新加坡，开启快乐的双语童年</p>

        <div style="background: linear-gradient(135deg, #FFF5F0, #FFF0F5); border-radius: 15px; padding: 25px; margin-bottom: 25px;">
            <h3 style="font-size: 16px; color: #FF6B35; margin-bottom: 15px;">🎁 限时福利</h3>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                <div style="background: white; padding: 15px; border-radius: 10px; border-left: 3px solid #FF6B35;">
                    <div style="font-size: 14px; font-weight: bold; color: #333;">免费选园评估</div>
                    <div style="font-size: 12px; color: #666;">根据预算和需求推荐最适合的幼儿园</div>
                </div>
                <div style="background: white; padding: 15px; border-radius: 10px; border-left: 3px solid #FF6B35;">
                    <div style="font-size: 14px; font-weight: bold; color: #333;">幼儿园信息手册</div>
                    <div style="font-size: 12px; color: #666;">50+幼儿园详细信息与费用对比</div>
                </div>
                <div style="background: white; padding: 15px; border-radius: 10px; border-left: 3px solid #FF6B35;">
                    <div style="font-size: 14px; font-weight: bold; color: #333;">陪读签证攻略</div>
                    <div style="font-size: 12px; color: #666;">最新政策解读与申请指南</div>
                </div>
                <div style="background: white; padding: 15px; border-radius: 10px; border-left: 3px solid #FF6B35;">
                    <div style="font-size: 14px; font-weight: bold; color: #333;">新加坡生活指南</div>
                    <div style="font-size: 12px; color: #666;">租房、交通、医疗、购物全攻略</div>
                </div>
            </div>
        </div>

        <div style="background: linear-gradient(135deg, #E8F5E9, #C8E6C9); border-radius: 15px; padding: 20px; margin-bottom: 25px;">
            <h3 style="font-size: 15px; color: #333; margin-bottom: 12px;">📅 入学时间线</h3>
            <div style="display: flex; gap: 15px;">
                <div style="flex: 1; background: white; padding: 12px; border-radius: 10px; text-align: center;">
                    <div style="font-size: 11px; color: #666;">主要入学季</div>
                    <div style="font-size: 16px; font-weight: bold; color: #FF6B35;">每年1月</div>
                    <div style="font-size: 10px; color: #999;">新加坡学年开始</div>
                </div>
                <div style="flex: 1; background: white; padding: 12px; border-radius: 10px; text-align: center;">
                    <div style="font-size: 11px; color: #666;">灵活入学</div>
                    <div style="font-size: 16px; font-weight: bold; color: #4CAF50;">全年接受</div>
                    <div style="font-size: 10px; color: #999;">私立幼儿园随时插班</div>
                </div>
                <div style="flex: 1; background: white; padding: 12px; border-radius: 10px; text-align: center;">
                    <div style="font-size: 11px; color: #666;">建议准备时间</div>
                    <div style="font-size: 16px; font-weight: bold; color: #2196F3;">提前2-3个月</div>
                    <div style="font-size: 10px; color: #999;">签证+找房+适应</div>
                </div>
            </div>
        </div>

        <div class="contact-section">
            <h3 class="contact-title">立即预约免费咨询</h3>
            <p class="contact-subtitle">专业顾问一对一，为宝贝规划最适合的幼儿园</p>

            <div class="contact-grid">
                <div class="contact-item">
                    <div class="contact-label">新加坡 / WhatsApp</div>
                    <div class="contact-value">+65 8686 3695</div>
                </div>
                <div class="contact-item">
                    <div class="contact-label">中国 / 微信</div>
                    <div class="contact-value">+86 1350 693 8797</div>
                </div>
                <div class="contact-item">
                    <div class="contact-label">电子邮箱</div>
                    <div class="contact-value">Maple@maplesgedu.com</div>
                </div>
                <div class="contact-item">
                    <div class="contact-label">官方网站</div>
                    <div class="contact-value">www.maplesgedu.com</div>
                </div>
            </div>
        </div>

        <div style="text-align: center; margin-top: 25px; padding-top: 15px; border-top: 1px solid #eee;">
            <p style="font-size: 11px; color: #999;">Maple Education Pte. Ltd. | UEN: 202044651W</p>
            <p style="font-size: 11px; color: #999;">📍 新加坡 · 专注低龄留学与家庭教育规划</p>
        </div>
    </div>
</body>
</html>
```
