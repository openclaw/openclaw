---
title: "Deck_04_低龄国际学校.html"
source_path: "05_Marketing_Media/Decks/Deck_04_低龄国际学校.html"
tags: ["Maple", "html"]
ocr: false
---

# Deck_04_低龄国际学校.html

简介：内容概述：<!DOCTYPE html>

## 内容

```text
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Maple Education - 低龄国际学校路线</title>
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

        /* 品牌色彩 */
        .brand-blue { color: #2C5AA0; }
        .brand-red { color: #C1272D; }
        .bg-blue { background: #2C5AA0; }
        .bg-red { background: #C1272D; }

        /* 页眉 */
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding-bottom: 10px;
            border-bottom: 2px solid #2C5AA0;
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
            background: linear-gradient(135deg, #C1272D, #2C5AA0);
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
            color: #2C5AA0;
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
            background: linear-gradient(135deg, #1a5c3a 0%, #2d8f5e 50%, #34a065 100%);
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
            background: #FFD700;
            color: #333;
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
            color: #FFD700;
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
            background: #f8f9fa;
            border-radius: 10px;
        }

        .feature-icon {
            font-size: 32px;
            margin-bottom: 8px;
        }

        .feature-title {
            font-size: 14px;
            font-weight: 600;
            color: #1a5c3a;
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
            color: #1a5c3a;
            margin-bottom: 20px;
            padding-bottom: 10px;
            border-bottom: 3px solid #FFD700;
            display: inline-block;
        }

        .section-subtitle {
            font-size: 14px;
            color: #666;
            margin-bottom: 20px;
        }

        /* 学校卡片 */
        .school-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 15px;
            margin-bottom: 20px;
        }

        .school-card {
            background: white;
            border: 1px solid #e0e0e0;
            border-radius: 12px;
            padding: 18px;
            position: relative;
            transition: all 0.3s;
        }

        .school-card:hover {
            box-shadow: 0 4px 15px rgba(0,0,0,0.1);
        }

        .school-tier {
            position: absolute;
            top: -8px;
            right: 15px;
            padding: 3px 12px;
            border-radius: 15px;
            font-size: 10px;
            font-weight: bold;
            color: white;
        }

        .tier-1 { background: linear-gradient(135deg, #FFD700, #FFA500); color: #333; }
        .tier-2 { background: linear-gradient(135deg, #2C5AA0, #1a3d6e); }
        .tier-3 { background: linear-gradient(135deg, #666, #999); }

        .school-name {
            font-size: 15px;
            font-weight: bold;
            color: #333;
            margin-bottom: 5px;
        }

        .school-name-en {
            font-size: 11px;
            color: #999;
            margin-bottom: 10px;
        }

        .school-info {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8px;
            font-size: 11px;
        }

        .school-info-item {
            display: flex;
            align-items: center;
            gap: 5px;
            color: #666;
        }

        .school-info-item span {
            color: #333;
            font-weight: 500;
        }

        /* 对比表格 */
        .compare-table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 20px;
            font-size: 11px;
        }

        .compare-table th {
            background: #1a5c3a;
            color: white;
            padding: 12px 8px;
            text-align: center;
            font-weight: 600;
        }

        .compare-table td {
            padding: 10px 8px;
            border: 1px solid #e0e0e0;
            text-align: center;
        }

        .compare-table tr:nth-child(even) {
            background: #f8f9fa;
        }

        .compare-table .highlight-col {
            background: #FFF8E1;
        }

        /* 课程体系 */
        .curriculum-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 15px;
            margin-bottom: 20px;
        }

        .curriculum-card {
            background: white;
            border-radius: 12px;
            padding: 18px;
            text-align: center;
            border: 2px solid transparent;
            transition: all 0.3s;
        }

        .curriculum-card.ib { border-color: #2196F3; }
        .curriculum-card.igcse { border-color: #9C27B0; }
        .curriculum-card.ap { border-color: #FF5722; }

        .curriculum-icon {
            width: 50px;
            height: 50px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 12px;
            font-size: 20px;
            font-weight: bold;
            color: white;
        }

        .curriculum-card.ib .curriculum-icon { background: #2196F3; }
        .curriculum-card.igcse .curriculum-icon { background: #9C27B0; }
        .curriculum-card.ap .curriculum-icon { background: #FF5722; }

        .curriculum-name {
            font-size: 14px;
            font-weight: bold;
            color: #333;
            margin-bottom: 5px;
        }

        .curriculum-full {
            font-size: 10px;
            color: #999;
            margin-bottom: 10px;
        }

        .curriculum-desc {
            font-size: 11px;
            color: #666;
            text-align: left;
        }

        /* 价格区间 */
        .price-range {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 15px;
            margin-bottom: 20px;
        }

        .price-tier {
            background: white;
            border-radius: 12px;
            padding: 20px;
            text-align: center;
            position: relative;
            border: 2px solid #e0e0e0;
        }

        .price-tier.premium {
            border-color: #FFD700;
            background: linear-gradient(135deg, #FFFDE7, #FFF8E1);
        }

        .price-tier-badge {
            position: absolute;
            top: -10px;
            left: 50%;
            transform: translateX(-50%);
            background: #FFD700;
            color: #333;
            padding: 3px 15px;
            border-radius: 15px;
            font-size: 10px;
            font-weight: bold;
        }

        .price-tier-title {
            font-size: 14px;
            font-weight: bold;
            color: #333;
            margin-bottom: 5px;
            margin-top: 5px;
        }

        .price-tier-range {
            font-size: 22px;
            font-weight: bold;
            color: #C1272D;
            margin: 10px 0;
        }

        .price-tier-unit {
            font-size: 11px;
            color: #999;
            margin-bottom: 10px;
        }

        .price-tier-schools {
            font-size: 11px;
            color: #666;
            text-align: left;
        }

        /* 服务流程 */
        .process-flow {
            display: flex;
            justify-content: space-between;
            margin: 20px 0;
            position: relative;
        }

        .process-flow::before {
            content: '';
            position: absolute;
            top: 25px;
            left: 10%;
            right: 10%;
            height: 3px;
            background: linear-gradient(to right, #1a5c3a, #FFD700);
        }

        .process-step {
            flex: 1;
            text-align: center;
            position: relative;
            z-index: 1;
        }

        .process-number {
            width: 50px;
            height: 50px;
            background: linear-gradient(135deg, #1a5c3a, #2d8f5e);
            color: white;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 18px;
            font-weight: bold;
            margin: 0 auto 10px;
            border: 3px solid white;
            box-shadow: 0 2px 8px rgba(0,0,0,0.15);
        }

        .process-title {
            font-size: 12px;
            font-weight: bold;
            color: #333;
        }

        .process-desc {
            font-size: 10px;
            color: #999;
        }

        /* 服务价格 */
        .service-price-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 15px;
            margin-bottom: 20px;
        }

        .service-price-card {
            background: #f8f9fa;
            border-radius: 10px;
            padding: 18px;
            border-left: 4px solid #1a5c3a;
        }

        .service-price-card.featured {
            background: linear-gradient(135deg, #1a5c3a, #2d8f5e);
            color: white;
            border-left-color: #FFD700;
        }

        .service-price-name {
            font-size: 14px;
            font-weight: bold;
            margin-bottom: 5px;
        }

        .service-price-amount {
            font-size: 22px;
            font-weight: bold;
            color: #C1272D;
            margin: 8px 0;
        }

        .service-price-card.featured .service-price-amount {
            color: #FFD700;
        }

        .service-price-desc {
            font-size: 11px;
            color: #666;
        }

        .service-price-card.featured .service-price-desc {
            color: rgba(255,255,255,0.9);
        }

        /* 联系区域 */
        .contact-section {
            background: linear-gradient(135deg, #1a5c3a 0%, #2d8f5e 100%);
            border-radius: 15px;
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
            background: rgba(255,255,255,0.1);
            border-radius: 10px;
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

        /* 提示框 */
        .tip-box {
            background: #E8F5E9;
            border-left: 4px solid #4CAF50;
            padding: 15px;
            border-radius: 0 8px 8px 0;
            margin: 15px 0;
        }

        .tip-box.warning {
            background: #FFF8E1;
            border-color: #FFC107;
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

        /* 优势对比 */
        .vs-section {
            display: grid;
            grid-template-columns: 1fr auto 1fr;
            gap: 15px;
            margin: 20px 0;
            align-items: center;
        }

        .vs-card {
            background: #f8f9fa;
            border-radius: 12px;
            padding: 18px;
        }

        .vs-card.gov {
            border: 2px solid #2C5AA0;
        }

        .vs-card.intl {
            border: 2px solid #1a5c3a;
        }

        .vs-badge {
            display: inline-block;
            padding: 3px 12px;
            border-radius: 15px;
            font-size: 11px;
            font-weight: bold;
            margin-bottom: 10px;
        }

        .vs-card.gov .vs-badge {
            background: #2C5AA0;
            color: white;
        }

        .vs-card.intl .vs-badge {
            background: #1a5c3a;
            color: white;
        }

        .vs-title {
            font-size: 14px;
            font-weight: bold;
            margin-bottom: 10px;
        }

        .vs-list {
            font-size: 11px;
            color: #666;
        }

        .vs-list li {
            margin-bottom: 5px;
            list-style: none;
            padding-left: 15px;
            position: relative;
        }

        .vs-list li::before {
            content: '•';
            position: absolute;
            left: 0;
        }

        .vs-divider {
            font-size: 24px;
            color: #999;
            font-weight: bold;
        }

        /* 年龄段 */
        .age-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 12px;
            margin: 15px 0;
        }

        .age-card {
            background: white;
            border: 1px solid #e0e0e0;
            border-radius: 8px;
            padding: 12px;
            text-align: center;
        }

        .age-range {
            font-size: 18px;
            font-weight: bold;
            color: #1a5c3a;
        }

        .age-label {
            font-size: 11px;
            color: #666;
        }

        .age-note {
            font-size: 10px;
            color: #999;
            margin-top: 5px;
        }
    </style>
</head>
<body>
    <!-- 第1页：封面 -->
    <div class="page cover-page">
        <div class="cover-top">
            <div class="cover-badge">全球认可 · 无需考试</div>
            <h1 class="cover-title">新加坡国际学校<br>精英教育直通车</h1>
            <p class="cover-subtitle">IB/IGCSE/AP 三大国际课程体系 · 直升全球顶尖名校</p>

            <div class="cover-highlight">
                <div class="highlight-item">
                    <div class="highlight-number">40+</div>
                    <div class="highlight-label">国际学校</div>
                </div>
                <div class="highlight-item">
                    <div class="highlight-number">IB</div>
                    <div class="highlight-label">满分45分</div>
                </div>
                <div class="highlight-item">
                    <div class="highlight-number">100%</div>
                    <div class="highlight-label">英语环境</div>
                </div>
            </div>
        </div>

        <div class="cover-bottom">
            <div class="cover-features">
                <div class="feature-box">
                    <div class="feature-icon">🌍</div>
                    <div class="feature-title">全球化教育</div>
                    <div class="feature-desc">多元文化环境<br>国际视野培养</div>
                </div>
                <div class="feature-box">
                    <div class="feature-icon">📋</div>
                    <div class="feature-title">免试入学</div>
                    <div class="feature-desc">无需AEIS考试<br>随时插班入读</div>
                </div>
                <div class="feature-box">
                    <div class="feature-icon">🎓</div>
                    <div class="feature-title">名校跳板</div>
                    <div class="feature-desc">剑桥/牛津/藤校<br>录取率领先</div>
                </div>
            </div>

            <div class="cover-footer">
                <p><strong>Maple Education</strong> · 新加坡枫叶留学</p>
                <p>WhatsApp: +65 8686 3695 | WeChat: +86 1350 693 8797</p>
            </div>
        </div>
    </div>

    <!-- 第2页：国际学校概览 -->
    <div class="page">
        <div class="header">
            <div class="logo-area">
                <div class="logo-placeholder">M</div>
                <span class="company-name">Maple Education</span>
            </div>
            <span class="page-number">02 / 06</span>
        </div>

        <h2 class="section-title">新加坡国际学校概览</h2>
        <p class="section-subtitle">新加坡拥有40多所国际学校，提供世界一流的国际化教育</p>

        <h3 style="font-size: 15px; color: #1a5c3a; margin-bottom: 15px;">顶级国际学校推荐</h3>

        <div class="school-grid">
            <div class="school-card">
                <span class="school-tier tier-1">第一梯队</span>
                <div class="school-name">东南亚联合世界书院</div>
                <div class="school-name-en">UWC South East Asia</div>
                <div class="school-info">
                    <div class="school-info-item">课程：<span>IB</span></div>
                    <div class="school-info-item">年龄：<span>4-18岁</span></div>
                    <div class="school-info-item">学费：<span>S$45,000/年</span></div>
                    <div class="school-info-item">特色：<span>全球UWC联盟</span></div>
                </div>
            </div>
            <div class="school-card">
                <span class="school-tier tier-1">第一梯队</span>
                <div class="school-name">新加坡美国学校</div>
                <div class="school-name-en">Singapore American School</div>
                <div class="school-info">
                    <div class="school-info-item">课程：<span>AP</span></div>
                    <div class="school-info-item">年龄：<span>3-18岁</span></div>
                    <div class="school-info-item">学费：<span>S$48,000/年</span></div>
                    <div class="school-info-item">特色：<span>藤校录取率高</span></div>
                </div>
            </div>
            <div class="school-card">
                <span class="school-tier tier-1">第一梯队</span>
                <div class="school-name">德威国际学校</div>
                <div class="school-name-en">Dulwich College Singapore</div>
                <div class="school-info">
                    <div class="school-info-item">课程：<span>IB/IGCSE</span></div>
                    <div class="school-info-item">年龄：<span>2-18岁</span></div>
                    <div class="school-info-item">学费：<span>S$42,000/年</span></div>
                    <div class="school-info-item">特色：<span>英式精英教育</span></div>
                </div>
            </div>
            <div class="school-card">
                <span class="school-tier tier-1">第一梯队</span>
                <div class="school-name">东陵信托学校</div>
                <div class="school-name-en">Tanglin Trust School</div>
                <div class="school-info">
                    <div class="school-info-item">课程：<span>IB/IGCSE</span></div>
                    <div class="school-info-item">年龄：<span>3-18岁</span></div>
                    <div class="school-info-item">学费：<span>S$40,000/年</span></div>
                    <div class="school-info-item">特色：<span>老牌英式学校</span></div>
                </div>
            </div>
            <div class="school-card">
                <span class="school-tier tier-2">第二梯队</span>
                <div class="school-name">加拿大国际学校</div>
                <div class="school-name-en">Canadian International School</div>
                <div class="school-info">
                    <div class="school-info-item">课程：<span>IB</span></div>
                    <div class="school-info-item">年龄：<span>2-18岁</span></div>
                    <div class="school-info-item">学费：<span>S$35,000/年</span></div>
                    <div class="school-info-item">特色：<span>双语IB项目</span></div>
                </div>
            </div>
            <div class="school-card">
                <span class="school-tier tier-2">第二梯队</span>
                <div class="school-name">澳洲国际学校</div>
                <div class="school-name-en">Australian International School</div>
                <div class="school-info">
                    <div class="school-info-item">课程：<span>IB/HSC</span></div>
                    <div class="school-info-item">年龄：<span>2-18岁</span></div>
                    <div class="school-info-item">学费：<span>S$32,000/年</span></div>
                    <div class="school-info-item">特色：<span>澳洲高考通道</span></div>
                </div>
            </div>
        </div>

        <div class="tip-box">
            <div class="tip-title">💡 选校建议</div>
            <div class="tip-content">
                第一梯队学校竞争激烈，建议提前1-2年申请等位；第二梯队学校性价比高，中国学生比例较低，语言环境好；部分学校对中国护照有名额限制，请提前咨询。
            </div>
        </div>
    </div>

    <!-- 第3页：课程体系对比 -->
    <div class="page">
        <div class="header">
            <div class="logo-area">
                <div class="logo-placeholder">M</div>
                <span class="company-name">Maple Education</span>
            </div>
            <span class="page-number">03 / 06</span>
        </div>

        <h2 class="section-title">三大国际课程体系</h2>
        <p class="section-subtitle">IB、IGCSE、AP 三大体系各有特色，选择适合孩子的课程至关重要</p>

        <div class="curriculum-grid">
            <div class="curriculum-card ib">
                <div class="curriculum-icon">IB</div>
                <div class="curriculum-name">IB国际文凭</div>
                <div class="curriculum-full">International Baccalaureate</div>
                <div class="curriculum-desc">
                    <strong>适合年龄：</strong>3-19岁<br>
                    <strong>课程阶段：</strong><br>
                    • PYP（小学）<br>
                    • MYP（中学）<br>
                    • DP（高中）<br>
                    <strong>特点：</strong>全面发展、批判思维、全球认可度最高
                </div>
            </div>
            <div class="curriculum-card igcse">
                <div class="curriculum-icon">IG</div>
                <div class="curriculum-name">IGCSE/A-Level</div>
                <div class="curriculum-full">Cambridge Assessment</div>
                <div class="curriculum-desc">
                    <strong>适合年龄：</strong>14-18岁<br>
                    <strong>课程阶段：</strong><br>
                    • IGCSE（初中）<br>
                    • A-Level（高中）<br>
                    <strong>特点：</strong>英式体系、学术严谨、牛剑申请首选
                </div>
            </div>
            <div class="curriculum-card ap">
                <div class="curriculum-icon">AP</div>
                <div class="curriculum-name">AP美国大学先修</div>
                <div class="curriculum-full">Advanced Placement</div>
                <div class="curriculum-desc">
                    <strong>适合年龄：</strong>15-18岁<br>
                    <strong>课程阶段：</strong><br>
                    • 高中选修<br>
                    • 大学学分<br>
                    <strong>特点：</strong>美式体系、可换大学学分、藤校申请加分
                </div>
            </div>
        </div>

        <h3 style="font-size: 15px; color: #1a5c3a; margin: 20px 0 15px;">课程体系对比</h3>

        <table class="compare-table">
            <thead>
                <tr>
                    <th>对比项</th>
                    <th>IB</th>
                    <th>IGCSE/A-Level</th>
                    <th>AP</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td><strong>难度</strong></td>
                    <td>高（6门必修+论文）</td>
                    <td>中高（3-4门选修）</td>
                    <td>中（自选科目数量）</td>
                </tr>
                <tr>
                    <td><strong>灵活性</strong></td>
                    <td>低（固定框架）</td>
                    <td>高（自由选科）</td>
                    <td>最高（完全自选）</td>
                </tr>
                <tr>
                    <td><strong>全球认可</strong></td>
                    <td class="highlight-col">最广（150+国家）</td>
                    <td>广（英联邦优先）</td>
                    <td>广（美国为主）</td>
                </tr>
                <tr>
                    <td><strong>适合学生</strong></td>
                    <td>全面发展型</td>
                    <td>学术专精型</td>
                    <td>单科突出型</td>
                </tr>
                <tr>
                    <td><strong>目标院校</strong></td>
                    <td>全球顶尖大学</td>
                    <td>牛津/剑桥/英国G5</td>
                    <td>常春藤/美国TOP30</td>
                </tr>
            </tbody>
        </table>

        <h3 style="font-size: 15px; color: #1a5c3a; margin: 20px 0 15px;">国际学校 vs 政府学校</h3>

        <div class="vs-section">
            <div class="vs-card gov">
                <span class="vs-badge">政府学校</span>
                <div class="vs-title">通过AEIS考试入读</div>
                <ul class="vs-list">
                    <li>学费低廉（S$750-1,600/月）</li>
                    <li>需参加AEIS考试</li>
                    <li>按新加坡教育部课纲</li>
                    <li>华文为第二语言</li>
                    <li>本地学生为主</li>
                    <li>可申请PR</li>
                </ul>
            </div>
            <div class="vs-divider">VS</div>
            <div class="vs-card intl">
                <span class="vs-badge">国际学校</span>
                <div class="vs-title">面试入学，随时插班</div>
                <ul class="vs-list">
                    <li>学费较高（S$25,000-50,000/年）</li>
                    <li>无需AEIS，面试入学</li>
                    <li>IB/IGCSE/AP国际课程</li>
                    <li>全英文环境</li>
                    <li>国际学生为主</li>
                    <li>直升全球名校</li>
                </ul>
            </div>
        </div>
    </div>

    <!-- 第4页：费用与申请 -->
    <div class="page">
        <div class="header">
            <div class="logo-area">
                <div class="logo-placeholder">M</div>
                <span class="company-name">Maple Education</span>
            </div>
            <span class="page-number">04 / 06</span>
        </div>

        <h2 class="section-title">学费与入学要求</h2>
        <p class="section-subtitle">不同梯队学校费用差异明显，选择适合预算的学校</p>

        <div class="price-range">
            <div class="price-tier premium">
                <span class="price-tier-badge">顶级名校</span>
                <div class="price-tier-title">第一梯队</div>
                <div class="price-tier-range">S$40,000-50,000</div>
                <div class="price-tier-unit">每年学费</div>
                <div class="price-tier-schools">
                    • UWC 东南亚<br>
                    • 新加坡美国学校<br>
                    • 德威国际学校<br>
                    • 东陵信托学校
                </div>
            </div>
            <div class="price-tier">
                <div class="price-tier-title">第二梯队</div>
                <div class="price-tier-range">S$28,000-38,000</div>
                <div class="price-tier-unit">每年学费</div>
                <div class="price-tier-schools">
                    • 加拿大国际学校<br>
                    • 澳洲国际学校<br>
                    • 史丹福美国学校<br>
                    • 海外家庭学校
                </div>
            </div>
            <div class="price-tier">
                <div class="price-tier-title">第三梯队</div>
                <div class="price-tier-range">S$18,000-28,000</div>
                <div class="price-tier-unit">每年学费</div>
                <div class="price-tier-schools">
                    • 华中国际学校<br>
                    • 英华国际学校<br>
                    • 圣约瑟国际学校<br>
                    • 壹世界国际学校
                </div>
            </div>
        </div>

        <h3 style="font-size: 15px; color: #1a5c3a; margin: 20px 0 15px;">入学要求</h3>

        <div class="age-grid">
            <div class="age-card">
                <div class="age-range">3-5岁</div>
                <div class="age-label">幼儿园</div>
                <div class="age-note">无需考试<br>面试即可</div>
            </div>
            <div class="age-card">
                <div class="age-range">6-10岁</div>
                <div class="age-label">小学</div>
                <div class="age-note">简单测试<br>+家长面谈</div>
            </div>
            <div class="age-card">
                <div class="age-range">11-14岁</div>
                <div class="age-label">初中</div>
                <div class="age-note">英语+数学<br>笔试+面试</div>
            </div>
            <div class="age-card">
                <div class="age-range">15-18岁</div>
                <div class="age-label">高中</div>
                <div class="age-note">学术测试<br>+作品集</div>
            </div>
        </div>

        <div class="tip-box warning">
            <div class="tip-title">⚠️ 申请时间提醒</div>
            <div class="tip-content">
                顶级国际学校（UWC、SAS、德威等）通常提前1-2年开放申请，热门年级需要排队等位。建议尽早规划，预留充足准备时间。部分学校8月开学，申请截止日期为前一年10-12月。
            </div>
        </div>

        <h3 style="font-size: 15px; color: #1a5c3a; margin: 20px 0 15px;">其他费用预估</h3>

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
                    <td>申请费</td>
                    <td>500-2,500</td>
                    <td>不可退还，每所学校单独收取</td>
                </tr>
                <tr>
                    <td>注册费</td>
                    <td>2,000-5,000</td>
                    <td>录取后缴纳，一次性</td>
                </tr>
                <tr>
                    <td>建校费/债券</td>
                    <td>5,000-25,000</td>
                    <td>部分学校要求，离校时可退还</td>
                </tr>
                <tr>
                    <td>校服/书本</td>
                    <td>1,000-2,000/年</td>
                    <td>因校而异</td>
                </tr>
                <tr>
                    <td>校车</td>
                    <td>3,000-5,000/年</td>
                    <td>按距离计算</td>
                </tr>
            </tbody>
        </table>
    </div>

    <!-- 第5页：服务与流程 -->
    <div class="page">
        <div class="header">
            <div class="logo-area">
                <div class="logo-placeholder">M</div>
                <span class="company-name">Maple Education</span>
            </div>
            <span class="page-number">05 / 06</span>
        </div>

        <h2 class="section-title">我们的服务</h2>
        <p class="section-subtitle">从选校到入学，全程专业陪伴</p>

        <div class="process-flow">
            <div class="process-step">
                <div class="process-number">1</div>
                <div class="process-title">免费咨询</div>
                <div class="process-desc">了解需求</div>
            </div>
            <div class="process-step">
                <div class="process-number">2</div>
                <div class="process-title">选校规划</div>
                <div class="process-desc">匹配学校</div>
            </div>
            <div class="process-step">
                <div class="process-number">3</div>
                <div class="process-title">入学准备</div>
                <div class="process-desc">面试培训</div>
            </div>
            <div class="process-step">
                <div class="process-number">4</div>
                <div class="process-title">申请提交</div>
                <div class="process-desc">材料跟进</div>
            </div>
            <div class="process-step">
                <div class="process-number">5</div>
                <div class="process-title">签证入学</div>
                <div class="process-desc">顺利入读</div>
            </div>
        </div>

        <h3 style="font-size: 15px; color: #1a5c3a; margin: 25px 0 15px;">服务套餐</h3>

        <div class="service-price-grid">
            <div class="service-price-card">
                <div class="service-price-name">基础咨询服务</div>
                <div class="service-price-amount">¥1,500</div>
                <div class="service-price-desc">
                    • 1对1深度咨询（1小时）<br>
                    • 国际学校选校建议<br>
                    • 申请时间线规划<br>
                    • 费用预算分析
                </div>
            </div>
            <div class="service-price-card featured">
                <div class="service-price-name">全程申请服务</div>
                <div class="service-price-amount">S$2,000起</div>
                <div class="service-price-desc">
                    • 3所学校申请<br>
                    • 材料准备与审核<br>
                    • 入学面试辅导<br>
                    • 签证办理协助<br>
                    • 录取后入学指导
                </div>
            </div>
            <div class="service-price-card">
                <div class="service-price-name">面试强化培训</div>
                <div class="service-price-amount">S$800</div>
                <div class="service-price-desc">
                    • 4课时1对1培训<br>
                    • 模拟面试演练<br>
                    • 常见问题准备<br>
                    • 英语口语提升
                </div>
            </div>
            <div class="service-price-card">
                <div class="service-price-name">学生签证办理</div>
                <div class="service-price-amount">S$500</div>
                <div class="service-price-desc">
                    • Student Pass申请<br>
                    • 材料准备指导<br>
                    • ICA预约安排<br>
                    • 全程进度跟踪
                </div>
            </div>
        </div>

        <h3 style="font-size: 15px; color: #1a5c3a; margin: 20px 0 15px;">增值服务</h3>

        <table class="compare-table" style="font-size: 11px;">
            <thead>
                <tr>
                    <th>服务项目</th>
                    <th>价格</th>
                    <th>说明</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td>陪读签证申请</td>
                    <td>S$800</td>
                    <td>16岁以下学生家长陪读签证</td>
                </tr>
                <tr>
                    <td>探校预约服务</td>
                    <td>S$300/所</td>
                    <td>预约探校、陪同参观、翻译</td>
                </tr>
                <tr>
                    <td>住宿安排服务</td>
                    <td>S$500</td>
                    <td>学校附近公寓/寄宿家庭推荐</td>
                </tr>
                <tr>
                    <td>接机安置服务</td>
                    <td>S$200</td>
                    <td>机场接机、入住协助</td>
                </tr>
                <tr>
                    <td>VIP全包服务</td>
                    <td>S$5,000</td>
                    <td>选校+申请+签证+住宿+入学全程</td>
                </tr>
            </tbody>
        </table>
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

        <h2 class="section-title">为孩子开启国际教育之门</h2>
        <p class="section-subtitle">选择国际学校，让孩子站在更高的起点</p>

        <div style="background: #f8f9fa; border-radius: 12px; padding: 25px; margin-bottom: 25px;">
            <h3 style="font-size: 16px; color: #1a5c3a; margin-bottom: 15px;">🎁 限时福利</h3>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                <div style="background: white; padding: 15px; border-radius: 8px; border-left: 3px solid #FFD700;">
                    <div style="font-size: 14px; font-weight: bold; color: #333;">免费选校评估</div>
                    <div style="font-size: 12px; color: #666;">根据孩子情况推荐最适合的学校</div>
                </div>
                <div style="background: white; padding: 15px; border-radius: 8px; border-left: 3px solid #FFD700;">
                    <div style="font-size: 14px; font-weight: bold; color: #333;">国际学校信息手册</div>
                    <div style="font-size: 12px; color: #666;">40+学校详细信息与对比</div>
                </div>
                <div style="background: white; padding: 15px; border-radius: 8px; border-left: 3px solid #FFD700;">
                    <div style="font-size: 14px; font-weight: bold; color: #333;">面试真题分享</div>
                    <div style="font-size: 12px; color: #666;">历年面试问题与参考答案</div>
                </div>
                <div style="background: white; padding: 15px; border-radius: 8px; border-left: 3px solid #FFD700;">
                    <div style="font-size: 14px; font-weight: bold; color: #333;">1v1规划咨询</div>
                    <div style="font-size: 12px; color: #666;">资深顾问30分钟深度咨询</div>
                </div>
            </div>
        </div>

        <div style="background: linear-gradient(135deg, #E8F5E9, #C8E6C9); border-radius: 12px; padding: 20px; margin-bottom: 25px;">
            <h3 style="font-size: 15px; color: #333; margin-bottom: 12px;">📅 2025年申请时间线</h3>
            <div style="display: flex; gap: 10px; flex-wrap: wrap;">
                <div style="flex: 1; min-width: 140px; background: white; padding: 12px; border-radius: 8px; text-align: center;">
                    <div style="font-size: 11px; color: #666;">第一梯队学校</div>
                    <div style="font-size: 14px; font-weight: bold; color: #1a5c3a;">2024年10月</div>
                    <div style="font-size: 10px; color: #999;">申请截止</div>
                </div>
                <div style="flex: 1; min-width: 140px; background: white; padding: 12px; border-radius: 8px; text-align: center;">
                    <div style="font-size: 11px; color: #666;">第二梯队学校</div>
                    <div style="font-size: 14px; font-weight: bold; color: #1a5c3a;">滚动招生</div>
                    <div style="font-size: 10px; color: #999;">名额有限</div>
                </div>
                <div style="flex: 1; min-width: 140px; background: white; padding: 12px; border-radius: 8px; text-align: center;">
                    <div style="font-size: 11px; color: #666;">开学时间</div>
                    <div style="font-size: 14px; font-weight: bold; color: #C1272D;">2025年8月</div>
                    <div style="font-size: 10px; color: #999;">或1月插班</div>
                </div>
            </div>
        </div>

        <div class="contact-section">
            <h3 class="contact-title">立即预约免费咨询</h3>
            <p class="contact-subtitle">专业顾问一对一，为您的孩子匹配最适合的国际学校</p>

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
            <p style="font-size: 11px; color: #999;">📍 新加坡 · 专注国际教育与精英学校申请</p>
        </div>
    </div>
</body>
</html>
```
