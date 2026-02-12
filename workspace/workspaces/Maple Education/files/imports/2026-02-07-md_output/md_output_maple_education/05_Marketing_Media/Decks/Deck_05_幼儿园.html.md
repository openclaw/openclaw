---
title: "Deck_05_幼儿园.html"
source_path: "05_Marketing_Media/Decks/Deck_05_幼儿园.html"
tags: ["指南", "新加坡", "Maple", "html"]
ocr: false
---

# Deck_05_幼儿园.html

简介：内容概述：<!DOCTYPE html>

## 内容

```text
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Maple Education - 新加坡幼儿园入学指南</title>
    <style>
        @page { size: A4; margin: 0; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Microsoft YaHei', 'Segoe UI', sans-serif; background: #f5f5f5; color: #333; line-height: 1.6; }
        .page { width: 210mm; min-height: 297mm; margin: 20px auto; background: white; box-shadow: 0 0 20px rgba(0,0,0,0.1); overflow: hidden; page-break-after: always; }
        @media print { body { background: white; } .page { margin: 0; box-shadow: none; } }
        .cover { height: 297mm; background: linear-gradient(135deg, #E91E63 0%, #C2185B 100%); color: white; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; padding: 40mm; }
        .cover h1 { font-size: 38px; font-weight: 700; margin-bottom: 20px; }
        .cover .subtitle { font-size: 20px; color: #FFE082; margin-bottom: 30px; }
        .maple-icon { font-size: 80px; margin-bottom: 30px; }
        .logo { font-size: 24px; font-weight: 700; margin-bottom: 20px; }
        .badge { display: inline-block; background: #2C5AA0; color: white; padding: 10px 25px; border-radius: 30px; font-weight: 700; font-size: 16px; margin-top: 20px; }
        .tagline { font-size: 14px; opacity: 0.9; border-top: 1px solid rgba(255,255,255,0.3); padding-top: 30px; margin-top: 30px; }
        .content-page { padding: 15mm 20mm; min-height: 297mm; }
        .page-header { display: flex; justify-content: space-between; border-bottom: 3px solid #2C5AA0; padding-bottom: 10px; margin-bottom: 20px; }
        .page-header .brand { font-size: 14px; color: #2C5AA0; font-weight: 600; }
        h2 { color: #2C5AA0; font-size: 22px; margin-bottom: 15px; border-bottom: 2px solid #eee; padding-bottom: 10px; }
        h3 { color: #C1272D; font-size: 16px; margin: 15px 0 10px; }
        .kg-type { margin: 15px 0; padding: 15px; border-radius: 10px; }
        .kg-public { background: #e8f5e9; border-left: 4px solid #4caf50; }
        .kg-private { background: #fff3e0; border-left: 4px solid #ff9800; }
        .kg-intl { background: #e3f2fd; border-left: 4px solid #2196f3; }
        .comparison-table { width: 100%; border-collapse: collapse; margin: 15px 0; font-size: 12px; }
        .comparison-table th, .comparison-table td { padding: 10px; border: 1px solid #dee2e6; text-align: center; }
        .comparison-table th { background: #2C5AA0; color: white; }
        .comparison-table tr:nth-child(even) { background: #f8f9fa; }
        .price-table { width: 100%; border-collapse: collapse; margin: 15px 0; font-size: 13px; }
        .price-table th, .price-table td { padding: 10px; border: 1px solid #dee2e6; }
        .price-table th { background: #2C5AA0; color: white; }
        .price-table .price { color: #C1272D; font-weight: 700; }
        .highlight-box { background: #fce4ec; border-left: 4px solid #E91E63; padding: 15px; margin: 15px 0; border-radius: 0 8px 8px 0; font-size: 14px; }
        .feature-list { list-style: none; padding: 0; }
        .feature-list li { padding: 8px 0 8px 30px; position: relative; border-bottom: 1px dashed #eee; font-size: 14px; }
        .feature-list li::before { content: '✓'; position: absolute; left: 0; top: 8px; width: 20px; height: 20px; background: #4caf50; color: white; border-radius: 50%; font-size: 12px; display: flex; align-items: center; justify-content: center; }
        .contact-section { background: linear-gradient(135deg, #2C5AA0, #1a4080); color: white; padding: 25px; border-radius: 10px; margin-top: 20px; text-align: center; }
        .contact-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 15px; margin-top: 15px; font-size: 14px; }
        .footer { text-align: center; padding: 15px; font-size: 11px; color: #666; border-top: 1px solid #eee; }
        .age-chart { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 15px 0; }
        .age-box { text-align: center; padding: 15px 10px; background: #f8f9fa; border-radius: 8px; border: 2px solid #E91E63; }
        .age-box .age { font-size: 24px; font-weight: 700; color: #E91E63; }
        .age-box .level { font-size: 12px; color: #666; }
    </style>
</head>
<body>
    <div class="page cover">
        <div class="maple-icon">👶</div>
        <div class="logo">MAPLE EDUCATION</div>
        <h1>新加坡幼儿园<br>入学指南</h1>
        <p class="subtitle">给孩子最好的起点</p>
        <div class="badge">3-6岁 · 公立/私立/国际</div>
        <p class="tagline">双语启蒙 | 妈妈陪读 | 升学无忧<br><br>📧 Maple@maplesgedu.com | 🌐 maplesgedu.com</p>
    </div>

    <div class="page content-page">
        <div class="page-header"><span class="brand">MAPLE EDUCATION</span><span>02</span></div>
        <h2>新加坡幼儿园类型</h2>

        <div class="kg-type kg-public">
            <h3>🏫 政府幼儿园 (PCF/MOE)</h3>
            <p><strong>学费：</strong>S$160-650/月 | <strong>优势：</strong>费用低，双语教学，可衔接政府小学</p>
            <p style="font-size:13px;color:#666;margin-top:5px;">代表：PAP Community Foundation (PCF)、MOE Kindergarten</p>
        </div>

        <div class="kg-type kg-private">
            <h3>🎨 私立幼儿园</h3>
            <p><strong>学费：</strong>S$800-1,500/月 | <strong>优势：</strong>课程多样，设施好，位置便利</p>
            <p style="font-size:13px;color:#666;margin-top:5px;">代表：Mindchamps、EtonHouse、Pat's Schoolhouse</p>
        </div>

        <div class="kg-type kg-intl">
            <h3>🌍 国际幼儿园</h3>
            <p><strong>学费：</strong>S$1,500-3,000/月 | <strong>优势：</strong>国际化环境，多元文化，直升国际学校</p>
            <p style="font-size:13px;color:#666;margin-top:5px;">代表：Canadian International School、Australian International School</p>
        </div>

        <h3>📊 年龄对照表</h3>
        <div class="age-chart">
            <div class="age-box"><div class="age">3岁</div><div class="level">Nursery 1 (N1)</div></div>
            <div class="age-box"><div class="age">4岁</div><div class="level">Nursery 2 (N2)</div></div>
            <div class="age-box"><div class="age">5岁</div><div class="level">Kindergarten 1 (K1)</div></div>
            <div class="age-box"><div class="age">6岁</div><div class="level">Kindergarten 2 (K2)</div></div>
        </div>

        <div class="footer">Maple Education Pte. Ltd. | 🌐 maplesgedu.com</div>
    </div>

    <div class="page content-page">
        <div class="page-header"><span class="brand">MAPLE EDUCATION</span><span>03</span></div>
        <h2>三种幼儿园对比</h2>

        <table class="comparison-table">
            <tr><th>对比项</th><th>政府幼儿园</th><th>私立幼儿园</th><th>国际幼儿园</th></tr>
            <tr><td>月学费</td><td>S$160-650</td><td>S$800-1,500</td><td>S$1,500-3,000</td></tr>
            <tr><td>教学语言</td><td>英语+母语</td><td>英语为主</td><td>全英语</td></tr>
            <tr><td>班级规模</td><td>20-25人</td><td>15-20人</td><td>10-15人</td></tr>
            <tr><td>升学衔接</td><td>政府小学优先</td><td>灵活选择</td><td>国际学校直升</td></tr>
            <tr><td>适合人群</td><td>长期居留家庭</td><td>注重性价比</td><td>计划国际教育</td></tr>
        </table>

        <h3>💰 服务费用</h3>
        <table class="price-table">
            <tr><th>服务项目</th><th>费用</th><th>说明</th></tr>
            <tr><td>公立幼儿园申请</td><td class="price">¥12,000</td><td>不成功退 ¥10,000</td></tr>
            <tr><td>陪读签证申请</td><td class="price">¥13,000</td><td>妈妈/奶奶可申请</td></tr>
            <tr><td>私立/国际幼儿园申请</td><td class="price">协商</td><td>根据学校难度定价</td></tr>
        </table>

        <div class="highlight-box">
            <strong>👩‍👧 陪读妈妈须知：</strong><br>
            • 孩子入读幼儿园后，妈妈/奶奶可申请陪读签证(LTVP)<br>
            • 陪读第一年不可工作，第二年起可申请工作许可<br>
            • 陪读签证每年需续签
        </div>

        <div class="footer">Maple Education Pte. Ltd. | 🌐 maplesgedu.com</div>
    </div>

    <div class="page content-page">
        <div class="page-header"><span class="brand">MAPLE EDUCATION</span><span>04</span></div>
        <h2>我们的服务</h2>

        <ul class="feature-list">
            <li><strong>幼儿园匹配</strong> - 根据住址、预算、教育理念推荐合适幼儿园</li>
            <li><strong>入学申请</strong> - 准备申请材料，代为提交申请</li>
            <li><strong>陪读签证</strong> - 协助妈妈/奶奶办理陪读签证</li>
            <li><strong>住房协助</strong> - 推荐幼儿园附近住房</li>
            <li><strong>落地服务</strong> - 接机、入学陪同、生活安置</li>
            <li><strong>升学规划</strong> - 小学升学路径咨询</li>
        </ul>

        <div class="contact-section">
            <h3 style="color:#FFE082;">📞 免费咨询</h3>
            <p>为宝宝规划最佳的新加坡教育起点</p>
            <div class="contact-grid">
                <div>📧 Maple@maplesgedu.com</div>
                <div>🌐 maplesgedu.com</div>
                <div>📱 +65 8686 3695</div>
                <div>💬 +86 1350 693 8797</div>
            </div>
        </div>

        <div style="text-align:center;margin-top:20px;">
            <div style="width:80px;height:80px;background:#f0f0f0;margin:10px auto;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#999;font-size:12px;">[二维码]</div>
        </div>

        <div class="footer"><strong>Maple Education Pte. Ltd.</strong> | UEN: 202427459R</div>
    </div>
</body>
</html>
```
