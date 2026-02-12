---
title: "Template_02_学生信息收集表.html"
source_path: "01_Legal_and_Contracts/Templates/Template_02_学生信息收集表.html"
tags: ["合同", "表格", "html"]
ocr: false
---

# Template_02_学生信息收集表.html

简介：表格/清单类文件，结构化列出关键信息。

## 内容

```text
<!DOCTYPE html>
<html lang="en">

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Student Information Collection Form - 学生信息收集表</title>
    <style>
        @page {
            size: A4;
            margin: 0;
        }

        body {
            margin: 0;
            padding: 0;
            width: 210mm;
            height: 297mm;
            background: white;
            font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif;
            position: relative;
            box-sizing: border-box;
            border: 1px solid #eee;
        }

        /* Watermark */
        .watermark {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            opacity: 0.05;
            max-width: 600px;
            z-index: 1;
        }

        /* Header */
        .header {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            display: flex;
            align-items: flex-start;
            padding: 2mm 10mm 5mm 10mm;
            z-index: 10;
        }

        .logo {
            width: 90px;
            height: 90px;
            margin-right: 8mm;
            margin-top: 0;
        }

        .header-content {
            flex-grow: 1;
            display: flex;
            flex-direction: column;
            justify-content: flex-start;
            padding-top: 0;
            position: relative;
        }

        .company-name {
            font-size: 14pt;
            font-weight: 600;
            color: #333;
            line-height: 1.2;
        }

        .divider {
            height: 1px;
            background-color: #333;
            width: 75%;
            margin-top: 3mm;
        }

        /* Document Title - Top Right */
        .document-title {
            position: absolute;
            top: 0;
            right: 0;
            font-size: 18pt;
            font-weight: 700;
            color: #2c5aa0;
            text-transform: uppercase;
            letter-spacing: 1px;
        }

        /* Footer */
        .footer {
            position: absolute;
            bottom: 0;
            left: 0;
            right: 0;
            text-align: center;
            font-size: 8pt;
            color: #888;
            padding: 5mm 0;
            z-index: 10;
        }

        .footer span {
            margin: 0 5px;
        }

        /* Content Area */
        .content {
            position: absolute;
            top: 45mm;
            bottom: 20mm;
            left: 20mm;
            right: 20mm;
            z-index: 5;
            font-size: 9pt;
            line-height: 1.4;
        }

        .form-title {
            text-align: center;
            font-size: 16pt;
            font-weight: 700;
            color: #2c5aa0;
            margin-bottom: 15px;
        }

        .form-subtitle {
            text-align: center;
            font-size: 14pt;
            font-weight: 600;
            color: #666;
            margin-bottom: 20px;
        }

        .form-section {
            margin-bottom: 15px;
        }

        .section-title {
            font-weight: 700;
            color: #2c5aa0;
            font-size: 11pt;
            margin-bottom: 8px;
            border-bottom: 2px solid #2c5aa0;
            padding-bottom: 3px;
        }

        .form-row {
            display: flex;
            margin-bottom: 8px;
            align-items: center;
        }

        .form-label {
            width: 40%;
            font-weight: 600;
            font-size: 9pt;
        }

        .form-value {
            width: 60%;
            border-bottom: 1px solid #999;
            min-height: 20px;
            padding: 2px 5px;
        }

        .form-row-full {
            margin-bottom: 8px;
        }

        .form-label-full {
            font-weight: 600;
            margin-bottom: 5px;
            font-size: 9pt;
        }

        .form-value-full {
            border: 1px solid #999;
            min-height: 60px;
            padding: 5px;
        }

        table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 10px;
        }

        table th,
        table td {
            border: 1px solid #999;
            padding: 5px;
            font-size: 9pt;
        }

        table th {
            background-color: #f0f0f0;
            font-weight: 700;
        }

        .checkbox {
            display: inline-block;
            width: 12px;
            height: 12px;
            border: 1px solid #333;
            margin-right: 5px;
        }

        .signature-section {
            margin-top: 20px;
            display: flex;
            justify-content: space-between;
        }

        .signature-block {
            width: 45%;
        }

        .signature-line {
            border-bottom: 1px solid #333;
            margin-top: 15px;
            margin-bottom: 5px;
        }

        /* Print optimization */
        @media print {
            body {
                border: none;
            }
        }
    </style>
</head>

<body>

    <!-- Watermark -->
    <img src="../../04_Brand_Assets/01_Logo/Logo_MapleEducation_Main.jpg" class="watermark" alt="Watermark">

    <!-- Header -->
    <div class="header">
        <img src="../../04_Brand_Assets/01_Logo/Logo_MapleEducation_Main.jpg" class="logo" alt="Logo">
        <div class="header-content">
            <div class="document-title">DATA FORM</div>
            <div class="company-name">Maple Education Pte. Ltd. &nbsp;|&nbsp; 新加坡枫叶留学</div>
            <div class="divider"></div>
        </div>
    </div>

    <!-- Content -->
    <div class="content">
        <div class="form-title">Student Information Collection Form</div>
        <div class="form-subtitle">学生信息收集表</div>

        <div class="form-section">
            <div class="section-title">I. Personal Information 个人信息</div>
            <div class="form-row">
                <div class="form-label">Full Name (as on Passport) 姓名（护照姓名）:</div>
                <div class="form-value"></div>
            </div>
            <div class="form-row">
                <div class="form-label">Gender 性别:</div>
                <div class="form-value">
                    <span class="checkbox"></span>Male 男 &nbsp;&nbsp;
                    <span class="checkbox"></span>Female 女
                </div>
            </div>
            <div class="form-row">
                <div class="form-label">Date of Birth 出生日期:</div>
                <div class="form-value"></div>
            </div>
            <div class="form-row">
                <div class="form-label">Nationality 国籍:</div>
                <div class="form-value"></div>
            </div>
            <div class="form-row">
                <div class="form-label">Passport No. 护照号码:</div>
                <div class="form-value"></div>
            </div>
            <div class="form-row">
                <div class="form-label">ID Card No. 身份证号码:</div>
                <div class="form-value"></div>
            </div>
            <div class="form-row">
                <div class="form-label">Contact Number 联系电话:</div>
                <div class="form-value"></div>
            </div>
            <div class="form-row">
                <div class="form-label">Email Address 电子邮箱:</div>
                <div class="form-value"></div>
            </div>
            <div class="form-row">
                <div class="form-label">WeChat ID 微信号:</div>
                <div class="form-value"></div>
            </div>
        </div>

        <div class="form-section">
            <div class="section-title">II. Current Address 现居地址</div>
            <div class="form-row-full">
                <div class="form-label-full">Residential Address 居住地址:</div>
                <div class="form-value-full" style="min-height: 40px;"></div>
            </div>
        </div>

        <div class="form-section">
            <div class="section-title">III. Education Background 教育背景</div>
            <div class="form-row">
                <div class="form-label">Highest Education Level 最高学历:</div>
                <div class="form-value"></div>
            </div>
            <div class="form-row">
                <div class="form-label">School/University Name 学校名称:</div>
                <div class="form-value"></div>
            </div>
            <div class="form-row">
                <div class="form-label">Major/Field of Study 专业:</div>
                <div class="form-value"></div>
            </div>
            <div class="form-row">
                <div class="form-label">GPA/Grade 成绩/绩点:</div>
                <div class="form-value"></div>
            </div>
            <div class="form-row">
                <div class="form-label">Graduation Date 毕业日期:</div>
                <div class="form-value"></div>
            </div>
        </div>

        <div class="form-section">
            <div class="section-title">IV. Study Abroad Plan 留学计划</div>
            <div class="form-row">
                <div class="form-label">Intended Country 意向国家:</div>
                <div class="form-value">
                    <span class="checkbox"></span>Singapore 新加坡 &nbsp;
                    <span class="checkbox"></span>Malaysia 马来西亚 &nbsp;
                    <span class="checkbox"></span>Thailand 泰国
                </div>
            </div>
            <div class="form-row">
                <div class="form-label">Intended Program Level 意向课程层次:</div>
                <div class="form-value">
                    <span class="checkbox"></span>Diploma 大专 &nbsp;
                    <span class="checkbox"></span>Bachelor 本科 &nbsp;
                    <span class="checkbox"></span>Master 硕士 &nbsp;
                    <span class="checkbox"></span>PhD 博士
                </div>
            </div>
            <div class="form-row">
                <div class="form-label">Intended Institution(s) 意向院校:</div>
                <div class="form-value"></div>
            </div>
            <div class="form-row">
                <div class="form-label">Intended Major 意向专业:</div>
                <div class="form-value"></div>
            </div>
            <div class="form-row">
                <div class="form-label">Intended Start Date 预计入学时间:</div>
                <div class="form-value"></div>
            </div>
        </div>

        <div class="form-section">
            <div class="section-title">V. English Proficiency 英语水平</div>
            <div class="form-row">
                <div class="form-label">IELTS Score 雅思成绩:</div>
                <div class="form-value"></div>
            </div>
            <div class="form-row">
                <div class="form-label">TOEFL Score 托福成绩:</div>
                <div class="form-value"></div>
            </div>
            <div class="form-row">
                <div class="form-label">Other English Test 其他英语考试:</div>
                <div class="form-value"></div>
            </div>
        </div>

        <div class="form-section">
            <div class="section-title">VI. Guardian Information (if applicable) 监护人信息（如适用）</div>
            <div class="form-row">
                <div class="form-label">Guardian Name 监护人姓名:</div>
                <div class="form-value"></div>
            </div>
            <div class="form-row">
                <div class="form-label">Relationship 关系:</div>
                <div class="form-value"></div>
            </div>
            <div class="form-row">
                <div class="form-label">Contact Number 联系电话:</div>
                <div class="form-value"></div>
            </div>
            <div class="form-row">
                <div class="form-label">Email Address 电子邮箱:</div>
                <div class="form-value"></div>
            </div>
        </div>

        <div class="form-section">
            <div class="section-title">VII. Agent Information 代理信息</div>
            <div class="form-row">
                <div class="form-label">Referring Agent 推荐代理:</div>
                <div class="form-value"></div>
            </div>
            <div class="form-row">
                <div class="form-label">Agent Contact 代理联系方式:</div>
                <div class="form-value"></div>
            </div>
        </div>

        <div style="margin-top: 20px; font-size: 8pt; color: #666; text-align: center;">
            This form is for use by Maple Education Pte. Ltd. and its authorized partners only.<br>
            本表格仅供Maple Education Pte. Ltd.及其授权合作伙伴使用。
        </div>
    </div>

    <!-- Footer -->
    <div class="footer">
        <span>Email: Maple@maplesgedu.com</span>|
        <span>Website: Mapleedusg.com</span>|
        <span>SG: +65 86863695</span>|
        <span>CN: +86 13506938797</span>
    </div>

</body>

</html>
```
