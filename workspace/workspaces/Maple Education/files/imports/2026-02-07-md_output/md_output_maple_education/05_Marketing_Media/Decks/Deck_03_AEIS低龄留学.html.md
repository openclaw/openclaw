---
title: "Deck_03_AEIS低龄留学.html"
source_path: "05_Marketing_Media/Decks/Deck_03_AEIS低龄留学.html"
tags: ["指南", "Maple", "html"]
ocr: false
---

# Deck_03_AEIS低龄留学.html

简介：内容概述：<!DOCTYPE html>

## 内容

```text
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Maple Education - AEIS低龄留学指南</title>
    <style>
        @page { size: A4; margin: 0; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Microsoft YaHei', 'Segoe UI', sans-serif; background: #f5f5f5; color: #333; line-height: 1.6; }
        .page { width: 210mm; min-height: 297mm; margin: 20px auto; background: white; box-shadow: 0 0 20px rgba(0,0,0,0.1); overflow: hidden; page-break-after: always; }
        @media print { body { background: white; } .page { margin: 0; box-shadow: none; } }

        /* 品牌色：蓝#2C5AA0 红#C1272D */
        .cover { height: 297mm; background: linear-gradient(135deg, #2C5AA0 0%, #1a4080 100%); color: white; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; padding: 40mm; }
        .cover-content { position: relative; z-index: 1; }
        .logo { font-size: 24px; font-weight: 700; margin-bottom: 20px; letter-spacing: 2px; }
        .cover h1 { font-size: 40px; font-weight: 700; margin-bottom: 20px; }
        .cover .subtitle { font-size: 20px; color: #FFD700; margin-bottom: 30px; }
        .cover .tagline { font-size: 16px; opacity: 0.9; border-top: 1px solid rgba(255,255,255,0.3); padding-top: 30px; margin-top: 30px; }
        .maple-icon { font-size: 80px; margin-bottom: 30px; }
        .age-badge { display: inline-block; background: #C1272D; color: white; padding: 10px 30px; border-radius: 30px; font-weight: 700; font-size: 18px; margin-top: 20px; }

        .content-page { padding: 15mm 20mm; min-height: 297mm; }
        .page-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 3px solid #2C5AA0; padding-bottom: 10px; margin-bottom: 20px; }
        .page-header .brand { font-size: 14px; color: #2C5AA0; font-weight: 600; }
        .page-header .page-num { font-size: 12px; color: #666; }

        h2 { color: #2C5AA0; font-size: 24px; margin-bottom: 20px; padding-bottom: 10px; border-bottom: 2px solid #eee; }
        h3 { color: #C1272D; font-size: 18px; margin: 20px 0 10px; }

        .highlight-box { background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px 20px; margin: 20px 0; border-radius: 0 8px 8px 0; }
        .highlight-box.blue { background: #e3f2fd; border-left-color: #2C5AA0; }
        .highlight-box.green { background: #d4edda; border-left-color: #28a745; }
        .highlight-box.red { background: #fce4ec; border-left-color: #C1272D; }

        .grade-table { width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 13px; }
        .grade-table th, .grade-table td { padding: 12px; text-align: center; border: 1px solid #dee2e6; }
        .grade-table th { background: #2C5AA0; color: white; }
        .grade-table tr:nth-child(even) { background: #f8f9fa; }

        .timeline { position: relative; padding-left: 30px; margin: 20px 0; }
        .timeline::before { content: ''; position: absolute; left: 10px; top: 0; bottom: 0; width: 3px; background: linear-gradient(to bottom, #2C5AA0, #C1272D); }
        .timeline-item { position: relative; margin-bottom: 20px; padding-left: 20px; }
        .timeline-item::before { content: ''; position: absolute; left: -26px; top: 5px; width: 16px; height: 16px; background: #2C5AA0; border: 3px solid white; border-radius: 50%; box-shadow: 0 0 0 2px #2C5AA0; }
        .timeline-item .time { font-weight: 600; color: #C1272D; font-size: 14px; }

        .feature-list { list-style: none; padding: 0; }
        .feature-list li { padding: 10px 0 10px 35px; position: relative; border-bottom: 1px dashed #eee; }
        .feature-list li::before { content: '✓'; position: absolute; left: 0; top: 10px; width: 24px; height: 24px; background: #28a745; color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 14px; }

        .price-table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        .price-table th, .price-table td { padding: 12px 15px; text-align: left; border-bottom: 1px solid #dee2e6; }
        .price-table th { background: #2C5AA0; color: white; }
        .price-table .price { color: #C1272D; font-weight: 700; font-size: 16px; }

        .two-column { display: grid; grid-template-columns: 1fr 1fr; gap: 25px; }
        .info-card { background: #f8f9fa; border-radius: 10px; padding: 20px; border-top: 4px solid #2C5AA0; }
        .info-card h4 { color: #2C5AA0; margin-bottom: 10px; }

        .exam-info { display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; margin: 20px 0; }
        .exam-box { text-align: center; padding: 20px; background: linear-gradient(135deg, #2C5AA0, #1a4080); color: white; border-radius: 10px; }
        .exam-box .label { font-size: 12px; opacity: 0.9; }
        .exam-box .value { font-size: 24px; font-weight: 700; margin-top: 5px; }

        .contact-section { background: linear-gradient(135deg, #2C5AA0, #1a4080); color: white; padding: 30px; border-radius: 12px; margin-top: 30px; text-align: center; }
        .contact-section h3 { color: white; margin-bottom: 20px; }
        .contact-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; margin-top: 20px; }
        .contact-item { display: flex; align-items: center; justify-content: center; gap: 10px; }

        .footer { text-align: center; padding: 20px; font-size: 12px; color: #666; border-top: 1px solid #eee; }

        .pathway-box { background: #f0f7ff; border: 2px solid #2C5AA0; border-radius: 10px; padding: 20px; margin: 15px 0; }
        .pathway-box h4 { color: #2C5AA0; margin-bottom: 10px; display: flex; align-items: center; gap: 10px; }
        .pathway-arrow { text-align: center; font-size: 24px; color: #2C5AA0; margin: 10px 0; }
    </style>
</head>
<body>
    <div class="page cover">
        <div class="cover-content">
            <div class="maple-icon">📚</div>
            <div class="logo">MAPLE EDUCATION</div>
            <h1>新加坡 AEIS<br>低龄留学指南</h1>
            <p class="subtitle">政府中小学入学考试全攻略</p>
            <div class="age-badge">适合 7-16 岁学生</div>
            <p class="tagline">专业备考辅导 | 考试报名协助 | 全程入学服务<br><br>📧 Maple@maplesgedu.com | 🌐 maplesgedu.com</p>
        </div>
    </div>

    <div class="page content-page">
        <div class="page-header"><span class="brand">MAPLE EDUCATION</span><span class="page-num">02</span></div>
        <h2>什么是 AEIS 考试？</h2>

        <div class="highlight-box blue">
            <strong>AEIS</strong> (Admissions Exercise for International Students) 是新加坡教育部为国际学生设立的<strong>政府中小学入学统一考试</strong>，通过考试的学生可以进入新加坡政府学校就读。
        </div>

        <div class="exam-info">
            <div class="exam-box"><div class="label">考试时间</div><div class="value">9月</div></div>
            <div class="exam-box"><div class="label">补充考试</div><div class="value">2月(S-AEIS)</div></div>
            <div class="exam-box"><div class="label">适用年龄</div><div class="value">7-16岁</div></div>
        </div>

        <h3>📋 考试科目</h3>
        <table class="grade-table">
            <tr><th>申请年级</th><th>英语</th><th>数学</th><th>考试时长</th></tr>
            <tr><td>小学 P2-P3</td><td>✓</td><td>✓</td><td>约2小时</td></tr>
            <tr><td>小学 P4-P5</td><td>✓</td><td>✓</td><td>约2.5小时</td></tr>
            <tr><td>中学 S1-S2</td><td>✓</td><td>✓</td><td>约3小时</td></tr>
            <tr><td>中学 S3</td><td>✓</td><td>✓</td><td>约3小时</td></tr>
        </table>

        <div class="highlight-box red">
            <strong>⚠️ 重要提醒：</strong><br>
            • AEIS 每年仅举办一次（9月），S-AEIS 为补充考试（2月）<br>
            • 小六和中四不开放申请<br>
            • 通过考试后由教育部统一分配学校
        </div>

        <div class="footer">Maple Education Pte. Ltd. | 🌐 maplesgedu.com</div>
    </div>

    <div class="page content-page">
        <div class="page-header"><span class="brand">MAPLE EDUCATION</span><span class="page-num">03</span></div>
        <h2>年龄与年级对照</h2>

        <table class="grade-table">
            <tr><th>出生年份</th><th>2025年9月年龄</th><th>可申请年级</th><th>考试类型</th></tr>
            <tr><td>2018年1月-12月</td><td>7岁</td><td>小二 P2</td><td>AEIS</td></tr>
            <tr><td>2017年1月-12月</td><td>8岁</td><td>小二/小三 P2-P3</td><td>AEIS</td></tr>
            <tr><td>2016年1月-12月</td><td>9岁</td><td>小三/小四 P3-P4</td><td>AEIS</td></tr>
            <tr><td>2015年1月-12月</td><td>10岁</td><td>小四/小五 P4-P5</td><td>AEIS</td></tr>
            <tr><td>2014年1月-12月</td><td>11岁</td><td>小五 P5</td><td>AEIS</td></tr>
            <tr><td>2013年1月-12月</td><td>12岁</td><td>中一 S1</td><td>AEIS</td></tr>
            <tr><td>2012年1月-12月</td><td>13岁</td><td>中一/中二 S1-S2</td><td>AEIS</td></tr>
            <tr><td>2011年1月-12月</td><td>14岁</td><td>中二/中三 S2-S3</td><td>AEIS</td></tr>
            <tr><td>2010年1月-12月</td><td>15岁</td><td>中三 S3</td><td>AEIS</td></tr>
        </table>

        <div class="highlight-box">
            <strong>💡 选择建议：</strong><br>
            • 英语基础较弱的学生建议申请较低年级<br>
            • 可同时申请两个年级，增加录取机会<br>
            • 考虑孩子适应能力，不建议跳级过多
        </div>

        <div class="footer">Maple Education Pte. Ltd. | 🌐 maplesgedu.com</div>
    </div>

    <div class="page content-page">
        <div class="page-header"><span class="brand">MAPLE EDUCATION</span><span class="page-num">04</span></div>
        <h2>备考与入学时间线</h2>

        <div class="two-column">
            <div>
                <h3>📅 AEIS（9月考试）</h3>
                <div class="timeline">
                    <div class="timeline-item"><div class="time">3-6月</div><div class="content">开始备考，参加培训课程</div></div>
                    <div class="timeline-item"><div class="time">7月</div><div class="content">网上报名开放（约2周）</div></div>
                    <div class="timeline-item"><div class="time">9月中旬</div><div class="content">参加 AEIS 考试</div></div>
                    <div class="timeline-item"><div class="time">12月</div><div class="content">公布录取结果</div></div>
                    <div class="timeline-item"><div class="time">次年1月</div><div class="content">正式入学</div></div>
                </div>
            </div>
            <div>
                <h3>📅 S-AEIS（2月考试）</h3>
                <div class="timeline">
                    <div class="timeline-item"><div class="time">10-12月</div><div class="content">继续备考冲刺</div></div>
                    <div class="timeline-item"><div class="time">1月</div><div class="content">网上报名（约2周）</div></div>
                    <div class="timeline-item"><div class="time">2月下旬</div><div class="content">参加 S-AEIS 考试</div></div>
                    <div class="timeline-item"><div class="time">4月</div><div class="content">公布录取结果</div></div>
                    <div class="timeline-item"><div class="time">4-5月</div><div class="content">正式入学</div></div>
                </div>
            </div>
        </div>

        <div class="highlight-box green">
            <strong>✅ 备考建议：</strong><br>
            • 建议至少提前 6 个月开始系统备考<br>
            • 重点攻克英语，这是大多数中国学生的短板<br>
            • 数学难度不高，但需适应英文出题方式
        </div>

        <div class="footer">Maple Education Pte. Ltd. | 🌐 maplesgedu.com</div>
    </div>

    <div class="page content-page">
        <div class="page-header"><span class="brand">MAPLE EDUCATION</span><span class="page-num">05</span></div>
        <h2>服务内容与费用</h2>

        <h3>📋 我们提供的服务</h3>
        <ul class="feature-list">
            <li><strong>考试评估</strong> - 评估孩子英语/数学水平，推荐合适年级</li>
            <li><strong>备考辅导对接</strong> - 推荐新加坡本地AEIS培训机构</li>
            <li><strong>报名协助</strong> - 指导网上报名流程，准备所需材料</li>
            <li><strong>签证办理</strong> - 学生准证申请，陪读签证办理</li>
            <li><strong>入学手续</strong> - 录取后学校报到、入学手续协助</li>
            <li><strong>生活安置</strong> - 住宿推荐、生活指导</li>
        </ul>

        <h3>💰 收费标准</h3>
        <table class="price-table">
            <tr><th>服务项目</th><th>费用</th><th>说明</th></tr>
            <tr><td>公立小一直入申请</td><td class="price">¥12,000</td><td>不成功退 ¥10,000</td></tr>
            <tr><td>公立幼稚园申请</td><td class="price">¥12,000</td><td>不成功退 ¥10,000</td></tr>
            <tr><td>陪读签证申请</td><td class="price">¥13,000</td><td>申请不成功不退费</td></tr>
            <tr><td>境外管家服务（3个月）</td><td class="price">S$699</td><td>落地安置+生活协助</td></tr>
        </table>

        <div class="highlight-box">
            <strong>👨‍👩‍👧 陪读签证说明：</strong><br>
            16岁以下学生的母亲/祖母可申请陪读签证(LTVP)。陪读第一年不可工作，第二年起可申请工作许可。
        </div>

        <div class="footer">Maple Education Pte. Ltd. | 🌐 maplesgedu.com</div>
    </div>

    <div class="page content-page">
        <div class="page-header"><span class="brand">MAPLE EDUCATION</span><span class="page-num">06</span></div>
        <h2>立即咨询，为孩子规划未来</h2>

        <div class="two-column">
            <div class="info-card">
                <h4>🎯 政府学校优势</h4>
                <ul style="margin-left: 20px; margin-top: 10px;">
                    <li>学费低廉（约S$750/月）</li>
                    <li>教育质量全球领先</li>
                    <li>双语教育环境</li>
                    <li>升学路径清晰</li>
                    <li>毕业可申请PR</li>
                </ul>
            </div>
            <div class="info-card">
                <h4>📊 我们的优势</h4>
                <ul style="margin-left: 20px; margin-top: 10px;">
                    <li>熟悉 AEIS 考试流程</li>
                    <li>本地培训资源对接</li>
                    <li>签证办理经验丰富</li>
                    <li>陪读妈妈全程支持</li>
                    <li>落地服务一站式</li>
                </ul>
            </div>
        </div>

        <div class="contact-section">
            <h3>📞 免费咨询热线</h3>
            <p>专业顾问为您解答 AEIS 考试、备考、签证等问题</p>
            <div class="contact-grid">
                <div class="contact-item"><span>📧</span><span>Maple@maplesgedu.com</span></div>
                <div class="contact-item"><span>🌐</span><span>maplesgedu.com</span></div>
                <div class="contact-item"><span>📱</span><span>+65 8686 3695 (WhatsApp)</span></div>
                <div class="contact-item"><span>💬</span><span>+86 1350 693 8797 (WeChat)</span></div>
            </div>
        </div>

        <div style="text-align: center; margin-top: 30px;">
            <p style="color: #666;">扫码添加顾问微信，获取 AEIS 备考资料</p>
            <div style="width: 100px; height: 100px; background: #f0f0f0; margin: 10px auto; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: #999;">[二维码]</div>
        </div>

        <div class="footer"><strong>Maple Education Pte. Ltd.</strong> | UEN: 202427459R<br>© 2024 Maple Education. All Rights Reserved.</div>
    </div>
</body>
</html>
```
