---
title: "Deck_04_国际学校.html"
source_path: "05_Marketing_Media/Decks/Deck_04_国际学校.html"
tags: ["指南", "新加坡", "Maple", "html"]
ocr: false
---

# Deck_04_国际学校.html

简介：内容概述：<!DOCTYPE html>

## 内容

```text
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Maple Education - 新加坡国际学校指南</title>
    <style>
        @page { size: A4; margin: 0; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Microsoft YaHei', 'Segoe UI', sans-serif; background: #f5f5f5; color: #333; line-height: 1.6; }
        .page { width: 210mm; min-height: 297mm; margin: 20px auto; background: white; box-shadow: 0 0 20px rgba(0,0,0,0.1); overflow: hidden; page-break-after: always; }
        @media print { body { background: white; } .page { margin: 0; box-shadow: none; } }
        .cover { height: 297mm; background: linear-gradient(135deg, #2C5AA0 0%, #1a4080 100%); color: white; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; padding: 40mm; }
        .cover h1 { font-size: 38px; font-weight: 700; margin-bottom: 20px; }
        .cover .subtitle { font-size: 20px; color: #FFD700; margin-bottom: 30px; }
        .maple-icon { font-size: 80px; margin-bottom: 30px; }
        .logo { font-size: 24px; font-weight: 700; margin-bottom: 20px; letter-spacing: 2px; }
        .badge { display: inline-block; background: #C1272D; color: white; padding: 10px 30px; border-radius: 30px; font-weight: 700; font-size: 16px; margin-top: 20px; }
        .tagline { font-size: 14px; opacity: 0.9; border-top: 1px solid rgba(255,255,255,0.3); padding-top: 30px; margin-top: 30px; }
        .content-page { padding: 15mm 20mm; min-height: 297mm; }
        .page-header { display: flex; justify-content: space-between; border-bottom: 3px solid #2C5AA0; padding-bottom: 10px; margin-bottom: 20px; }
        .page-header .brand { font-size: 14px; color: #2C5AA0; font-weight: 600; }
        h2 { color: #2C5AA0; font-size: 22px; margin-bottom: 15px; border-bottom: 2px solid #eee; padding-bottom: 10px; }
        h3 { color: #C1272D; font-size: 16px; margin: 15px 0 10px; }
        .school-tier { margin: 15px 0; padding: 15px; border-radius: 8px; }
        .tier1 { background: linear-gradient(135deg, #fff8e1, #ffecb3); border-left: 4px solid #FFD700; }
        .tier2 { background: #e3f2fd; border-left: 4px solid #2C5AA0; }
        .tier3 { background: #f5f5f5; border-left: 4px solid #9e9e9e; }
        .school-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-top: 10px; }
        .school-item { background: white; padding: 10px; border-radius: 6px; font-size: 13px; }
        .school-item strong { color: #2C5AA0; }
        .price-table { width: 100%; border-collapse: collapse; margin: 15px 0; font-size: 13px; }
        .price-table th, .price-table td { padding: 10px; border: 1px solid #dee2e6; }
        .price-table th { background: #2C5AA0; color: white; }
        .price-table .price { color: #C1272D; font-weight: 700; }
        .highlight-box { background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 15px 0; border-radius: 0 8px 8px 0; font-size: 14px; }
        .feature-list { list-style: none; padding: 0; }
        .feature-list li { padding: 8px 0 8px 30px; position: relative; border-bottom: 1px dashed #eee; font-size: 14px; }
        .feature-list li::before { content: '✓'; position: absolute; left: 0; top: 8px; width: 20px; height: 20px; background: #28a745; color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; }
        .contact-section { background: linear-gradient(135deg, #2C5AA0, #1a4080); color: white; padding: 25px; border-radius: 10px; margin-top: 20px; text-align: center; }
        .contact-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 15px; margin-top: 15px; font-size: 14px; }
        .footer { text-align: center; padding: 15px; font-size: 11px; color: #666; border-top: 1px solid #eee; }
        .comparison { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 15px 0; }
        .compare-box { padding: 15px; border-radius: 8px; }
        .compare-box.ib { background: #e8f5e9; border: 2px solid #4caf50; }
        .compare-box.ap { background: #e3f2fd; border: 2px solid #2196f3; }
        .compare-box h4 { margin-bottom: 10px; }
    </style>
</head>
<body>
    <div class="page cover">
        <div class="maple-icon">🌍</div>
        <div class="logo">MAPLE EDUCATION</div>
        <h1>新加坡国际学校<br>入学指南</h1>
        <p class="subtitle">IB · AP · 英式 · 美式课程体系</p>
        <div class="badge">免AEIS考试 直接入学</div>
        <p class="tagline">顶级国际教育 | 多元课程选择 | 全球名校直通<br><br>📧 Maple@maplesgedu.com | 🌐 maplesgedu.com</p>
    </div>

    <div class="page content-page">
        <div class="page-header"><span class="brand">MAPLE EDUCATION</span><span>02</span></div>
        <h2>新加坡国际学校分梯队一览</h2>

        <div class="school-tier tier1">
            <h3>🏆 第一梯队（顶级）- 学费 S$40,000+/年</h3>
            <div class="school-grid">
                <div class="school-item"><strong>UWC 世界联合书院</strong><br>全球最顶尖IB学校</div>
                <div class="school-item"><strong>SAS 新加坡美国学校</strong><br>美式教育标杆</div>
                <div class="school-item"><strong>TTS 东陵信托学校</strong><br>英式精英教育</div>
                <div class="school-item"><strong>UWCSEA</strong><br>IB课程全球前列</div>
            </div>
            <p style="margin-top:10px;font-size:13px;color:#666;">入学难度极高，需提前1-2年排队，建议背景提升</p>
        </div>

        <div class="school-tier tier2">
            <h3>⭐ 第二梯队（优质）- 学费 S$25,000-40,000/年</h3>
            <div class="school-grid">
                <div class="school-item"><strong>CIS 加拿大国际学校</strong><br>IB课程，双语项目</div>
                <div class="school-item"><strong>AIS 澳洲国际学校</strong><br>澳洲课程+IB</div>
                <div class="school-item"><strong>Stamford American</strong><br>美式课程+IB</div>
                <div class="school-item"><strong>Dulwich 德威国际</strong><br>英式传统名校</div>
            </div>
        </div>

        <div class="school-tier tier3">
            <h3>📚 第三梯队（性价比）- 学费 S$15,000-25,000/年</h3>
            <div class="school-grid">
                <div class="school-item"><strong>GIIS 环印国际学校</strong><br>印度/IB/CBSE课程</div>
                <div class="school-item"><strong>Chatsworth 佳慧书院</strong><br>IB课程，小班教学</div>
                <div class="school-item"><strong>ISS 国际社区学校</strong><br>IB课程，多元文化</div>
                <div class="school-item"><strong>NEXUS 莱仕国际</strong><br>英式课程</div>
            </div>
        </div>

        <div class="footer">Maple Education Pte. Ltd. | 🌐 maplesgedu.com</div>
    </div>

    <div class="page content-page">
        <div class="page-header"><span class="brand">MAPLE EDUCATION</span><span>03</span></div>
        <h2>IB vs AP 课程体系对比</h2>

        <div class="comparison">
            <div class="compare-box ib">
                <h4>🌐 IB 国际文凭课程</h4>
                <ul style="margin-left:20px;font-size:13px;">
                    <li>全球认可度最高</li>
                    <li>6门学科+核心课程</li>
                    <li>注重批判性思维</li>
                    <li>大学申请优势明显</li>
                    <li>适合全面发展型学生</li>
                </ul>
            </div>
            <div class="compare-box ap">
                <h4>🇺🇸 AP 美国大学预修</h4>
                <ul style="margin-left:20px;font-size:13px;">
                    <li>美国大学首选</li>
                    <li>可自选科目数量</li>
                    <li>可转大学学分</li>
                    <li>适合某科目特别强的学生</li>
                    <li>灵活度较高</li>
                </ul>
            </div>
        </div>

        <h3>💰 服务费用</h3>
        <table class="price-table">
            <tr><th>学校梯队</th><th>服务费</th><th>说明</th></tr>
            <tr><td>第一梯队（顶级）</td><td class="price">Case by case</td><td>需背景提升+长期规划</td></tr>
            <tr><td>第二梯队（优质）</td><td class="price">~S$2,000</td><td>申请+入学协助</td></tr>
            <tr><td>第三梯队（性价比）</td><td class="price">少量文书费</td><td>基础申请服务</td></tr>
            <tr><td>陪读签证</td><td class="price">¥13,000</td><td>16岁以下可申请</td></tr>
        </table>

        <div class="highlight-box">
            <strong>💡 选校建议：</strong>根据家庭预算、孩子英语水平、升学目标综合考虑。第二梯队性价比最高，教学质量有保障。
        </div>

        <div class="footer">Maple Education Pte. Ltd. | 🌐 maplesgedu.com</div>
    </div>

    <div class="page content-page">
        <div class="page-header"><span class="brand">MAPLE EDUCATION</span><span>04</span></div>
        <h2>我们的服务</h2>

        <ul class="feature-list">
            <li><strong>学校匹配</strong> - 根据孩子情况推荐最适合的国际学校</li>
            <li><strong>入学申请</strong> - 准备申请材料，递交学校申请</li>
            <li><strong>入学测试辅导</strong> - 针对学校测试进行备考指导</li>
            <li><strong>面试培训</strong> - 模拟面试，提升录取概率</li>
            <li><strong>签证办理</strong> - 学生准证+陪读签证全程协助</li>
            <li><strong>校园参观</strong> - 安排学校开放日/实地考察</li>
            <li><strong>入学衔接</strong> - 入学后的适应期支持</li>
        </ul>

        <div class="contact-section">
            <h3 style="color:#FFD700;">📞 免费咨询</h3>
            <p>帮助您找到最适合孩子的国际学校</p>
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
