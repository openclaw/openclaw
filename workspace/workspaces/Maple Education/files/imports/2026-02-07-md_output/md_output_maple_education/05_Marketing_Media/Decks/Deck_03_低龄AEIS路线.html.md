---
title: "Deck_03_低龄AEIS路线.html"
source_path: "05_Marketing_Media/Decks/Deck_03_低龄AEIS路线.html"
tags: ["Maple", "html"]
ocr: false
---

# Deck_03_低龄AEIS路线.html

简介：内容概述：<!DOCTYPE html>

## 内容

```text
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Maple Education - 低龄AEIS政府学校路线</title>
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
        .bg-light-blue { background: #EEF4FB; }
        .bg-gradient { background: linear-gradient(135deg, #2C5AA0 0%, #1a3d6e 100%); }

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

        /* 封面页特殊样式 */
        .cover-page {
            padding: 0;
            display: flex;
            flex-direction: column;
        }

        .cover-top {
            background: linear-gradient(135deg, #2C5AA0 0%, #1a3d6e 100%);
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
            background: #C1272D;
            color: white;
            padding: 6px 16px;
            border-radius: 20px;
            font-size: 13px;
            margin-bottom: 20px;
        }

        .cover-title {
            font-size: 38px;
            font-weight: bold;
            margin-bottom: 15px;
            line-height: 1.3;
        }

        .cover-subtitle {
            font-size: 20px;
            opacity: 0.95;
            margin-bottom: 25px;
        }

        .cover-highlight {
            display: flex;
            gap: 25px;
            margin-top: 20px;
        }

        .highlight-item {
            text-align: center;
        }

        .highlight-number {
            font-size: 36px;
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
            color: #2C5AA0;
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

        /* 内容页标题 */
        .section-title {
            font-size: 24px;
            color: #2C5AA0;
            margin-bottom: 20px;
            padding-bottom: 10px;
            border-bottom: 3px solid #C1272D;
            display: inline-block;
        }

        .section-subtitle {
            font-size: 14px;
            color: #666;
            margin-bottom: 20px;
        }

        /* AEIS介绍 */
        .aeis-intro {
            background: linear-gradient(135deg, #EEF4FB, #fff);
            border-radius: 12px;
            padding: 20px;
            margin-bottom: 20px;
        }

        .aeis-title {
            font-size: 18px;
            color: #2C5AA0;
            font-weight: bold;
            margin-bottom: 10px;
        }

        .aeis-desc {
            font-size: 13px;
            color: #555;
            line-height: 1.8;
        }

        /* 考试时间表 */
        .exam-timeline {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 20px;
            margin-bottom: 20px;
        }

        .exam-card {
            background: white;
            border: 2px solid #2C5AA0;
            border-radius: 12px;
            padding: 20px;
            position: relative;
        }

        .exam-card.s-aeis {
            border-color: #C1272D;
        }

        .exam-badge {
            position: absolute;
            top: -12px;
            left: 20px;
            background: #2C5AA0;
            color: white;
            padding: 4px 15px;
            border-radius: 15px;
            font-size: 13px;
            font-weight: bold;
        }

        .exam-card.s-aeis .exam-badge {
            background: #C1272D;
        }

        .exam-month {
            font-size: 28px;
            font-weight: bold;
            color: #2C5AA0;
            margin: 10px 0;
        }

        .exam-card.s-aeis .exam-month {
            color: #C1272D;
        }

        .exam-details {
            font-size: 12px;
            color: #666;
        }

        .exam-details li {
            margin-bottom: 5px;
            list-style: none;
            padding-left: 15px;
            position: relative;
        }

        .exam-details li::before {
            content: '•';
            position: absolute;
            left: 0;
            color: #2C5AA0;
        }

        /* 年龄对照表 */
        .age-table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 20px;
            font-size: 12px;
        }

        .age-table th {
            background: #2C5AA0;
            color: white;
            padding: 12px 10px;
            text-align: center;
        }

        .age-table td {
            padding: 10px;
            border: 1px solid #ddd;
            text-align: center;
        }

        .age-table tr:nth-child(even) {
            background: #f8f9fa;
        }

        .age-table .highlight-row {
            background: #FFF3CD;
        }

        /* 考试内容 */
        .exam-content {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 20px;
            margin-bottom: 20px;
        }

        .subject-card {
            background: white;
            border-radius: 12px;
            padding: 20px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.08);
        }

        .subject-icon {
            width: 50px;
            height: 50px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 24px;
            margin-bottom: 12px;
        }

        .subject-icon.english { background: #E3F2FD; }
        .subject-icon.math { background: #FFF3E0; }

        .subject-name {
            font-size: 16px;
            font-weight: bold;
            color: #333;
            margin-bottom: 8px;
        }

        .subject-details {
            font-size: 12px;
            color: #666;
        }

        .subject-details li {
            margin-bottom: 4px;
            list-style: none;
            padding-left: 15px;
            position: relative;
        }

        .subject-details li::before {
            content: '✓';
            position: absolute;
            left: 0;
            color: #4CAF50;
            font-size: 11px;
        }

        /* 备考服务 */
        .service-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 15px;
            margin-bottom: 20px;
        }

        .service-item {
            background: #f8f9fa;
            border-radius: 10px;
            padding: 18px;
            border-left: 4px solid #2C5AA0;
        }

        .service-item.highlight {
            background: linear-gradient(135deg, #2C5AA0, #1a3d6e);
            color: white;
            border-left: 4px solid #C1272D;
        }

        .service-name {
            font-size: 14px;
            font-weight: bold;
            margin-bottom: 8px;
        }

        .service-item.highlight .service-name {
            color: white;
        }

        .service-desc {
            font-size: 11px;
            color: #666;
            line-height: 1.6;
        }

        .service-item.highlight .service-desc {
            color: rgba(255,255,255,0.9);
        }

        /* 价格卡片 */
        .price-section {
            margin-bottom: 20px;
        }

        .price-cards {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 15px;
        }

        .price-card {
            background: white;
            border: 2px solid #eee;
            border-radius: 12px;
            padding: 20px;
            text-align: center;
            transition: all 0.3s;
        }

        .price-card.featured {
            border-color: #C1272D;
            transform: scale(1.02);
            box-shadow: 0 4px 15px rgba(193,39,45,0.2);
        }

        .price-card-badge {
            display: inline-block;
            background: #C1272D;
            color: white;
            padding: 3px 12px;
            border-radius: 15px;
            font-size: 10px;
            margin-bottom: 10px;
        }

        .price-card-title {
            font-size: 15px;
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
            font-size: 28px;
            font-weight: bold;
            color: #C1272D;
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

        /* 成功案例 */
        .case-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 15px;
            margin-bottom: 20px;
        }

        .case-card {
            background: white;
            border-radius: 10px;
            padding: 15px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.08);
            text-align: center;
        }

        .case-avatar {
            width: 50px;
            height: 50px;
            background: linear-gradient(135deg, #2C5AA0, #C1272D);
            border-radius: 50%;
            margin: 0 auto 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-weight: bold;
        }

        .case-name {
            font-size: 13px;
            font-weight: bold;
            color: #333;
        }

        .case-detail {
            font-size: 11px;
            color: #666;
            margin: 5px 0;
        }

        .case-result {
            display: inline-block;
            background: #E8F5E9;
            color: #2E7D32;
            padding: 3px 10px;
            border-radius: 10px;
            font-size: 10px;
            font-weight: bold;
        }

        /* 时间轴 */
        .timeline {
            position: relative;
            padding-left: 30px;
        }

        .timeline::before {
            content: '';
            position: absolute;
            left: 8px;
            top: 0;
            bottom: 0;
            width: 3px;
            background: linear-gradient(to bottom, #2C5AA0, #C1272D);
            border-radius: 2px;
        }

        .timeline-item {
            position: relative;
            padding-bottom: 20px;
        }

        .timeline-dot {
            position: absolute;
            left: -26px;
            top: 0;
            width: 20px;
            height: 20px;
            background: #2C5AA0;
            border-radius: 50%;
            border: 3px solid white;
            box-shadow: 0 0 0 2px #2C5AA0;
        }

        .timeline-content {
            background: #f8f9fa;
            border-radius: 8px;
            padding: 12px 15px;
        }

        .timeline-title {
            font-size: 13px;
            font-weight: bold;
            color: #2C5AA0;
            margin-bottom: 5px;
        }

        .timeline-desc {
            font-size: 11px;
            color: #666;
        }

        /* 联系页 */
        .contact-section {
            background: linear-gradient(135deg, #2C5AA0 0%, #1a3d6e 100%);
            border-radius: 15px;
            padding: 30px;
            color: white;
            text-align: center;
            margin-top: 30px;
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
            background: #FFF8E1;
            border-left: 4px solid #FFC107;
            padding: 15px;
            border-radius: 0 8px 8px 0;
            margin: 15px 0;
        }

        .tip-box.success {
            background: #E8F5E9;
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

        /* 优势列表 */
        .advantage-list {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 12px;
        }

        .advantage-item {
            display: flex;
            align-items: flex-start;
            gap: 10px;
            padding: 12px;
            background: #f8f9fa;
            border-radius: 8px;
        }

        .advantage-icon {
            width: 32px;
            height: 32px;
            background: #2C5AA0;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-size: 14px;
            flex-shrink: 0;
        }

        .advantage-text {
            font-size: 12px;
            color: #333;
        }

        .advantage-text strong {
            display: block;
            margin-bottom: 3px;
        }

        /* 步骤流程 */
        .step-flow {
            display: flex;
            justify-content: space-between;
            margin: 20px 0;
        }

        .step-item {
            flex: 1;
            text-align: center;
            position: relative;
        }

        .step-item:not(:last-child)::after {
            content: '→';
            position: absolute;
            right: -5px;
            top: 15px;
            font-size: 20px;
            color: #2C5AA0;
        }

        .step-number {
            width: 40px;
            height: 40px;
            background: linear-gradient(135deg, #2C5AA0, #1a3d6e);
            color: white;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 16px;
            font-weight: bold;
            margin: 0 auto 8px;
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
    </style>
</head>
<body>
    <!-- 第1页：封面 -->
    <div class="page cover-page">
        <div class="cover-top">
            <div class="cover-badge">7-16岁专属通道</div>
            <h1 class="cover-title">低龄留学 · AEIS<br>政府学校直通车</h1>
            <p class="cover-subtitle">让孩子进入新加坡顶尖公立学校的最佳路径</p>

            <div class="cover-highlight">
                <div class="highlight-item">
                    <div class="highlight-number">90%+</div>
                    <div class="highlight-label">学员通过率</div>
                </div>
                <div class="highlight-item">
                    <div class="highlight-number">500+</div>
                    <div class="highlight-label">成功案例</div>
                </div>
                <div class="highlight-item">
                    <div class="highlight-number">¥500</div>
                    <div class="highlight-label">起/月学费</div>
                </div>
            </div>
        </div>

        <div class="cover-bottom">
            <div class="cover-features">
                <div class="feature-box">
                    <div class="feature-icon">🎓</div>
                    <div class="feature-title">政府学校</div>
                    <div class="feature-desc">进入新加坡公立中小学<br>享受优质教育资源</div>
                </div>
                <div class="feature-box">
                    <div class="feature-icon">📚</div>
                    <div class="feature-title">双语环境</div>
                    <div class="feature-desc">英语为主、华文为辅<br>完美过渡无语言障碍</div>
                </div>
                <div class="feature-box">
                    <div class="feature-icon">💰</div>
                    <div class="feature-title">费用亲民</div>
                    <div class="feature-desc">年学费仅约6-8万人民币<br>性价比远超国际学校</div>
                </div>
            </div>

            <div class="cover-footer">
                <p><strong>Maple Education</strong> · 新加坡枫叶留学</p>
                <p>WhatsApp: +65 8686 3695 | WeChat: +86 1350 693 8797</p>
            </div>
        </div>
    </div>

    <!-- 第2页：AEIS考试介绍 -->
    <div class="page">
        <div class="header">
            <div class="logo-area">
                <div class="logo-placeholder">M</div>
                <span class="company-name">Maple Education</span>
            </div>
            <span class="page-number">02 / 06</span>
        </div>

        <h2 class="section-title">什么是 AEIS 考试？</h2>

        <div class="aeis-intro">
            <div class="aeis-title">AEIS = Admissions Exercise for International Students</div>
            <div class="aeis-desc">
                AEIS 是新加坡教育部专门为国际学生设计的入学考试，通过考试的学生将被分配进入新加坡政府中小学就读。这是目前国际学生进入新加坡公立学校的<strong>唯一官方通道</strong>。
            </div>
        </div>

        <h3 style="font-size: 16px; color: #2C5AA0; margin-bottom: 15px;">两次考试机会</h3>

        <div class="exam-timeline">
            <div class="exam-card">
                <span class="exam-badge">AEIS</span>
                <div class="exam-month">9月</div>
                <ul class="exam-details">
                    <li>考试时间：每年9月</li>
                    <li>报名时间：7月-8月</li>
                    <li>入学时间：次年1月</li>
                    <li>适合人群：准备充分的学生</li>
                </ul>
            </div>
            <div class="exam-card s-aeis">
                <span class="exam-badge">S-AEIS</span>
                <div class="exam-month">2月</div>
                <ul class="exam-details">
                    <li>考试时间：每年2月</li>
                    <li>报名时间：1月</li>
                    <li>入学时间：当年4月</li>
                    <li>适合人群：AEIS未通过的学生</li>
                </ul>
            </div>
        </div>

        <div class="tip-box">
            <div class="tip-title">💡 重要提示</div>
            <div class="tip-content">
                S-AEIS 不接受小学五年级（P5）和中学三年级（Sec 3）的报考，因为这些年级下学期即将毕业。建议这两个年级的学生参加9月的AEIS考试。
            </div>
        </div>

        <h3 style="font-size: 16px; color: #2C5AA0; margin: 20px 0 15px;">年龄与年级对照表</h3>

        <table class="age-table">
            <thead>
                <tr>
                    <th>考试年份出生年</th>
                    <th>年龄</th>
                    <th>报考年级</th>
                    <th>入学年级</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td>2018年1月2日 - 2019年1月1日</td>
                    <td>7岁</td>
                    <td>P2/P3</td>
                    <td>小学二/三年级</td>
                </tr>
                <tr>
                    <td>2017年1月2日 - 2018年1月1日</td>
                    <td>8岁</td>
                    <td>P2/P3</td>
                    <td>小学二/三年级</td>
                </tr>
                <tr>
                    <td>2016年1月2日 - 2017年1月1日</td>
                    <td>9岁</td>
                    <td>P4/P5</td>
                    <td>小学四/五年级</td>
                </tr>
                <tr class="highlight-row">
                    <td>2015年1月2日 - 2016年1月1日</td>
                    <td>10岁</td>
                    <td>P4/P5</td>
                    <td>小学四/五年级</td>
                </tr>
                <tr>
                    <td>2012年1月2日 - 2015年1月1日</td>
                    <td>11-14岁</td>
                    <td>Sec 1/2/3</td>
                    <td>中学一/二/三年级</td>
                </tr>
                <tr>
                    <td>2010年1月2日 - 2012年1月1日</td>
                    <td>14-16岁</td>
                    <td>Sec 1/2/3</td>
                    <td>中学一/二/三年级</td>
                </tr>
            </tbody>
        </table>
    </div>

    <!-- 第3页：考试内容与备考 -->
    <div class="page">
        <div class="header">
            <div class="logo-area">
                <div class="logo-placeholder">M</div>
                <span class="company-name">Maple Education</span>
            </div>
            <span class="page-number">03 / 06</span>
        </div>

        <h2 class="section-title">考试内容详解</h2>
        <p class="section-subtitle">AEIS考试只考两门科目：英语和数学</p>

        <div class="exam-content">
            <div class="subject-card">
                <div class="subject-icon english">📖</div>
                <div class="subject-name">英语 English</div>
                <ul class="subject-details">
                    <li>阅读理解（Reading Comprehension）</li>
                    <li>完形填空（Cloze Passage）</li>
                    <li>词汇与语法（Vocabulary & Grammar）</li>
                    <li>写作（小学选做/中学必做）</li>
                    <li>考试时长：2小时（小学）/ 2小时10分钟（中学）</li>
                </ul>
            </div>
            <div class="subject-card">
                <div class="subject-icon math">🔢</div>
                <div class="subject-name">数学 Mathematics</div>
                <ul class="subject-details">
                    <li>选择题（Multiple Choice）</li>
                    <li>简答题（Short Answer）</li>
                    <li>全英文出题，考察数学思维</li>
                    <li>难度略低于中国同年级水平</li>
                    <li>考试时长：1小时（小学）/ 1.5小时（中学）</li>
                </ul>
            </div>
        </div>

        <div class="tip-box success">
            <div class="tip-title">✅ 中国学生优势</div>
            <div class="tip-content">
                数学对于中国学生来说通常不是问题，主要挑战在于<strong>英语能力</strong>。建议重点突破英语阅读和写作，同时熟悉数学英文术语。
            </div>
        </div>

        <h3 style="font-size: 16px; color: #2C5AA0; margin: 25px 0 15px;">我们的备考服务</h3>

        <div class="service-grid">
            <div class="service-item">
                <div class="service-name">📊 入学评估测试</div>
                <div class="service-desc">免费评估学生英语和数学水平，制定个性化备考方案，明确薄弱环节和提升方向。</div>
            </div>
            <div class="service-item">
                <div class="service-name">📚 线上精品课程</div>
                <div class="service-desc">新加坡持牌教师授课，小班教学（4-6人），针对AEIS考纲设计，每周2-3次课。</div>
            </div>
            <div class="service-item highlight">
                <div class="service-name">🏫 新加坡集训营</div>
                <div class="service-desc">2-6个月沉浸式备考，全日制强化训练，快速提升英语能力，模拟真实考试环境。</div>
            </div>
            <div class="service-item">
                <div class="service-name">📝 模拟考试冲刺</div>
                <div class="service-desc">历年真题演练，考前一对一辅导，心理疏导和考试技巧指导，确保最佳状态。</div>
            </div>
        </div>

        <h3 style="font-size: 16px; color: #2C5AA0; margin: 20px 0 15px;">备考时间规划建议</h3>

        <div class="step-flow">
            <div class="step-item">
                <div class="step-number">1</div>
                <div class="step-title">评估定位</div>
                <div class="step-desc">1-2周</div>
            </div>
            <div class="step-item">
                <div class="step-number">2</div>
                <div class="step-title">基础强化</div>
                <div class="step-desc">2-3个月</div>
            </div>
            <div class="step-item">
                <div class="step-number">3</div>
                <div class="step-desc">1-2个月</div>
                <div class="step-title">真题演练</div>
            </div>
            <div class="step-item">
                <div class="step-number">4</div>
                <div class="step-title">冲刺模考</div>
                <div class="step-desc">2-4周</div>
            </div>
            <div class="step-item">
                <div class="step-number">5</div>
                <div class="step-title">正式考试</div>
                <div class="step-desc">9月/2月</div>
            </div>
        </div>
    </div>

    <!-- 第4页：服务与价格 -->
    <div class="page">
        <div class="header">
            <div class="logo-area">
                <div class="logo-placeholder">M</div>
                <span class="company-name">Maple Education</span>
            </div>
            <span class="page-number">04 / 06</span>
        </div>

        <h2 class="section-title">服务套餐与价格</h2>
        <p class="section-subtitle">灵活选择，满足不同备考需求</p>

        <div class="price-section">
            <div class="price-cards">
                <div class="price-card">
                    <div class="price-card-title">基础咨询包</div>
                    <div class="price-card-subtitle">适合自主备考家庭</div>
                    <div class="price-amount">¥1,500</div>
                    <div class="price-unit">一次性</div>
                    <ul class="price-features">
                        <li>AEIS政策详细解读</li>
                        <li>学生水平初步评估</li>
                        <li>备考方案规划建议</li>
                        <li>报名流程全程指导</li>
                        <li>备考资料包赠送</li>
                    </ul>
                </div>
                <div class="price-card featured">
                    <span class="price-card-badge">推荐</span>
                    <div class="price-card-title">线上备考班</div>
                    <div class="price-card-subtitle">国内远程高效备考</div>
                    <div class="price-amount">¥3,500</div>
                    <div class="price-unit">每月 / 最低报3个月</div>
                    <ul class="price-features">
                        <li>每周6课时直播课</li>
                        <li>新加坡持牌教师</li>
                        <li>4-6人精品小班</li>
                        <li>课后作业批改</li>
                        <li>月度测评报告</li>
                        <li>家长沟通群组</li>
                    </ul>
                </div>
                <div class="price-card">
                    <div class="price-card-title">新加坡集训</div>
                    <div class="price-card-subtitle">沉浸式强化备考</div>
                    <div class="price-amount">S$2,500</div>
                    <div class="price-unit">每月 / 含住宿</div>
                    <ul class="price-features">
                        <li>全日制强化课程</li>
                        <li>学生公寓住宿</li>
                        <li>一日三餐</li>
                        <li>周末文化活动</li>
                        <li>陪读签证协助</li>
                        <li>24小时生活管理</li>
                    </ul>
                </div>
            </div>
        </div>

        <h3 style="font-size: 16px; color: #2C5AA0; margin: 20px 0 15px;">增值服务</h3>

        <table class="age-table" style="font-size: 11px;">
            <thead>
                <tr>
                    <th>服务项目</th>
                    <th>价格</th>
                    <th>说明</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td>AEIS报名代办</td>
                    <td>S$200</td>
                    <td>含官方报名费、材料准备、预约考位</td>
                </tr>
                <tr>
                    <td>陪读签证申请</td>
                    <td>S$800</td>
                    <td>妈妈/奶奶/外婆陪读签证全程办理</td>
                </tr>
                <tr>
                    <td>学生签证申请</td>
                    <td>S$500</td>
                    <td>录取后Student Pass申请</td>
                </tr>
                <tr>
                    <td>考试接送服务</td>
                    <td>S$150</td>
                    <td>考试当天酒店-考场往返接送</td>
                </tr>
                <tr>
                    <td>一对一VIP辅导</td>
                    <td>S$80/小时</td>
                    <td>针对薄弱环节定制化提升</td>
                </tr>
            </tbody>
        </table>

        <div class="tip-box">
            <div class="tip-title">💰 费用说明</div>
            <div class="tip-content">
                以上价格不含新加坡教育部AEIS考试报名费（约S$672）。政府学校录取后，国际学生学费约为每月S$750-850（小学）或S$1,250-1,600（中学），远低于国际学校。
            </div>
        </div>
    </div>

    <!-- 第5页：成功案例与优势 -->
    <div class="page">
        <div class="header">
            <div class="logo-area">
                <div class="logo-placeholder">M</div>
                <span class="company-name">Maple Education</span>
            </div>
            <span class="page-number">05 / 06</span>
        </div>

        <h2 class="section-title">成功案例</h2>
        <p class="section-subtitle">每一个成功入学的孩子，都是我们的骄傲</p>

        <div class="case-grid">
            <div class="case-card">
                <div class="case-avatar">小</div>
                <div class="case-name">小明同学</div>
                <div class="case-detail">上海 | 10岁 | 备考4个月</div>
                <div class="case-result">录取 P5</div>
                <p style="font-size: 10px; color: #666; margin-top: 8px;">通过线上课程+暑假集训，首次参加AEIS即成功录取南洋小学</p>
            </div>
            <div class="case-card">
                <div class="case-avatar">小</div>
                <div class="case-name">小雨同学</div>
                <div class="case-detail">北京 | 13岁 | 备考6个月</div>
                <div class="case-result">录取 Sec 2</div>
                <p style="font-size: 10px; color: #666; margin-top: 8px;">英语基础较弱，经过半年系统培训，成功入读华侨中学</p>
            </div>
            <div class="case-card">
                <div class="case-avatar">小</div>
                <div class="case-name">小杰同学</div>
                <div class="case-detail">深圳 | 8岁 | 备考3个月</div>
                <div class="case-result">录取 P3</div>
                <p style="font-size: 10px; color: #666; margin-top: 8px;">国际学校转政府学校，适应快，数学考满分</p>
            </div>
        </div>

        <h3 style="font-size: 16px; color: #2C5AA0; margin: 25px 0 15px;">为什么选择政府学校？</h3>

        <div class="advantage-list">
            <div class="advantage-item">
                <div class="advantage-icon">💰</div>
                <div class="advantage-text">
                    <strong>学费低廉</strong>
                    年学费约6-10万人民币，是国际学校的1/3
                </div>
            </div>
            <div class="advantage-item">
                <div class="advantage-icon">🏆</div>
                <div class="advantage-text">
                    <strong>教育质量高</strong>
                    新加坡基础教育全球第一，PISA成绩领先
                </div>
            </div>
            <div class="advantage-item">
                <div class="advantage-icon">🌏</div>
                <div class="advantage-text">
                    <strong>双语优势</strong>
                    英语为主、华文为辅，中国孩子适应快
                </div>
            </div>
            <div class="advantage-item">
                <div class="advantage-icon">📈</div>
                <div class="advantage-text">
                    <strong>升学通道顺</strong>
                    可直升本地理工学院或申请世界名校
                </div>
            </div>
            <div class="advantage-item">
                <div class="advantage-icon">👨‍👩‍👧</div>
                <div class="advantage-text">
                    <strong>陪读政策</strong>
                    16岁以下可申请妈妈/奶奶陪读
                </div>
            </div>
            <div class="advantage-item">
                <div class="advantage-icon">🎯</div>
                <div class="advantage-text">
                    <strong>身份规划</strong>
                    读满2年可申请PR，为移民铺路
                </div>
            </div>
        </div>

        <h3 style="font-size: 16px; color: #2C5AA0; margin: 25px 0 15px;">完整服务流程</h3>

        <div class="timeline">
            <div class="timeline-item">
                <div class="timeline-dot"></div>
                <div class="timeline-content">
                    <div class="timeline-title">Step 1: 免费咨询评估</div>
                    <div class="timeline-desc">了解孩子情况，评估英语和数学水平，制定备考计划</div>
                </div>
            </div>
            <div class="timeline-item">
                <div class="timeline-dot"></div>
                <div class="timeline-content">
                    <div class="timeline-title">Step 2: 选择备考方案</div>
                    <div class="timeline-desc">线上课程或新加坡集训，根据时间和预算灵活选择</div>
                </div>
            </div>
            <div class="timeline-item">
                <div class="timeline-dot"></div>
                <div class="timeline-content">
                    <div class="timeline-title">Step 3: 系统备考培训</div>
                    <div class="timeline-desc">专业教师授课，定期测评，持续跟进学习进度</div>
                </div>
            </div>
            <div class="timeline-item">
                <div class="timeline-dot"></div>
                <div class="timeline-content">
                    <div class="timeline-title">Step 4: 报名与考试</div>
                    <div class="timeline-desc">协助AEIS报名，安排新加坡考试行程，全程陪同</div>
                </div>
            </div>
            <div class="timeline-item">
                <div class="timeline-dot"></div>
                <div class="timeline-content">
                    <div class="timeline-title">Step 5: 录取与入学</div>
                    <div class="timeline-desc">协助办理学生签证、陪读签证，安排住宿，顺利入学</div>
                </div>
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

        <h2 class="section-title">开启孩子的新加坡求学之旅</h2>
        <p class="section-subtitle">专业团队，全程陪伴，让每一个孩子都能进入理想的学校</p>

        <div style="background: #f8f9fa; border-radius: 12px; padding: 25px; margin-bottom: 25px;">
            <h3 style="font-size: 16px; color: #2C5AA0; margin-bottom: 15px;">🎁 限时福利</h3>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                <div style="background: white; padding: 15px; border-radius: 8px; border-left: 3px solid #C1272D;">
                    <div style="font-size: 14px; font-weight: bold; color: #333;">免费评估测试</div>
                    <div style="font-size: 12px; color: #666;">价值¥500的英语+数学水平测试</div>
                </div>
                <div style="background: white; padding: 15px; border-radius: 8px; border-left: 3px solid #C1272D;">
                    <div style="font-size: 14px; font-weight: bold; color: #333;">AEIS备考资料包</div>
                    <div style="font-size: 12px; color: #666;">历年真题+词汇表+备考指南</div>
                </div>
                <div style="background: white; padding: 15px; border-radius: 8px; border-left: 3px solid #C1272D;">
                    <div style="font-size: 14px; font-weight: bold; color: #333;">1v1规划咨询</div>
                    <div style="font-size: 12px; color: #666;">资深顾问30分钟深度咨询</div>
                </div>
                <div style="background: white; padding: 15px; border-radius: 8px; border-left: 3px solid #C1272D;">
                    <div style="font-size: 14px; font-weight: bold; color: #333;">组团优惠</div>
                    <div style="font-size: 12px; color: #666;">3人成团享9折优惠</div>
                </div>
            </div>
        </div>

        <div style="background: linear-gradient(135deg, #FFF8E1, #FFF3CD); border-radius: 12px; padding: 20px; margin-bottom: 25px;">
            <h3 style="font-size: 15px; color: #333; margin-bottom: 12px;">📅 2025年AEIS考试时间表</h3>
            <div style="display: flex; gap: 20px;">
                <div style="flex: 1; background: white; padding: 15px; border-radius: 8px; text-align: center;">
                    <div style="font-size: 12px; color: #666;">S-AEIS 补充考试</div>
                    <div style="font-size: 20px; font-weight: bold; color: #C1272D;">2025年2月</div>
                    <div style="font-size: 11px; color: #999;">报名截止：1月中旬</div>
                </div>
                <div style="flex: 1; background: white; padding: 15px; border-radius: 8px; text-align: center;">
                    <div style="font-size: 12px; color: #666;">AEIS 主要考试</div>
                    <div style="font-size: 20px; font-weight: bold; color: #2C5AA0;">2025年9月</div>
                    <div style="font-size: 11px; color: #999;">报名开始：7月</div>
                </div>
            </div>
        </div>

        <div class="contact-section">
            <h3 class="contact-title">立即预约免费咨询</h3>
            <p class="contact-subtitle">专业顾问一对一解答，为您的孩子量身定制留学方案</p>

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
