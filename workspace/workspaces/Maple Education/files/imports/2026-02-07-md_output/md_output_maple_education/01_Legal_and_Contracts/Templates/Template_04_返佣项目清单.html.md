---
title: "Template_04_返佣项目清单.html"
source_path: "01_Legal_and_Contracts/Templates/Template_04_返佣项目清单.html"
tags: ["合同", "返佣", "清单", "html"]
ocr: false
---

# Template_04_返佣项目清单.html

简介：返佣/佣金清单，列出项目、比例与奖励规则。

## 内容

```text
<!DOCTYPE html>
<html lang="en">

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Commission List - 返佣项目清单</title>
    <style>
        @page {
            size: A4;
            margin: 0;
        }

        body {
            margin: 0;
            padding: 0;
            width: 210mm;
            background: white;
            font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif;
            position: relative;
            box-sizing: border-box;
            border: 1px solid #eee;
        }

        /* Watermark */
        .watermark {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            opacity: 0.05;
            max-width: 600px;
            z-index: 1;
        }

        /* Header */
        .header {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            display: flex;
            align-items: flex-start;
            padding: 2mm 10mm 5mm 10mm;
            background: white;
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
            font-size: 16pt;
            font-weight: 700;
            color: #2c5aa0;
            text-transform: uppercase;
            letter-spacing: 1px;
        }

        /* Footer */
        .footer {
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            text-align: center;
            font-size: 8pt;
            color: #888;
            padding: 5mm 0;
            background: white;
            z-index: 10;
        }

        .footer span {
            margin: 0 5px;
        }

        /* Content Area */
        .content {
            margin-top: 45mm;
            margin-bottom: 20mm;
            padding: 0 15mm;
            z-index: 5;
            font-size: 9pt;
            line-height: 1.4;
        }

        .main-title {
            text-align: center;
            font-size: 16pt;
            font-weight: 700;
            color: #ff6600;
            margin-bottom: 20px;
        }

        .section-title {
            text-align: center;
            font-size: 14pt;
            font-weight: 700;
            color: #2c5aa0;
            margin-top: 20px;
            margin-bottom: 15px;
            padding: 8px;
            background-color: #f0f0f0;
            border-left: 5px solid #2c5aa0;
        }

        table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 15px;
            font-size: 8.5pt;
        }

        table th {
            background-color: #ffd966;
            font-weight: 700;
            padding: 8px 5px;
            border: 1px solid #999;
            text-align: center;
        }

        table td {
            padding: 6px 5px;
            border: 1px solid #999;
        }

        .school-name {
            background-color: #d9e2f3;
            font-weight: 600;
            text-align: left;
            vertical-align: middle;
        }

        .text-center {
            text-align: center;
        }

        .notes {
            margin-top: 20px;
            padding: 10px;
            background-color: #fff3cd;
            border-left: 5px solid #ff6600;
            font-size: 8.5pt;
            line-height: 1.8;
        }

        .notes p {
            margin: 5px 0;
        }

        .currency-note {
            text-align: center;
            font-size: 10pt;
            font-weight: 700;
            color: #dc3545;
            margin-top: 15px;
        }

        .page-break {
            page-break-after: always;
        }

        .logo-center {
            text-align: center;
            margin: 20px 0;
        }

        .logo-center img {
            width: 120px;
            height: 120px;
        }

        .end-section {
            text-align: center;
            margin: 25px 0;
        }

        .end-section img {
            width: 100px;
            height: 100px;
        }

        .end-section-text {
            font-size: 13pt;
            font-weight: 700;
            color: #2c5aa0;
            margin-top: 10px;
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
            <div class="document-title">COMMISSION LIST</div>
            <div class="company-name">Maple Education Pte. Ltd. &nbsp;|&nbsp; 新加坡枫叶留学</div>
            <div class="divider"></div>
        </div>
    </div>

    <!-- Content -->
    <div class="content">
        <div class="main-title">SG枫叶留学新加坡、马来西亚、泰国留学项目佣金清单</div>

        <!-- Singapore Programs -->
        <div class="section-title">新加坡留学项目 Singapore Study Programs</div>

        <!-- Kaplan Higher Education -->
        <table>
            <thead>
                <tr>
                    <th style="width: 30%;">学校名称</th>
                    <th style="width: 35%;">课程</th>
                    <th style="width: 20%;">佣金比例</th>
                    <th style="width: 15%;">额外奖励</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td rowspan="10" class="school-name">新加坡楷博高等教育学院<br>Kaplan Higher Education Ac</td>
                    <td>English (PBEP)</td>
                    <td class="text-center">10%</td>
                    <td rowspan="10" class="text-center">年度送满5个学生，每个学生奖励300人民币</td>
                </tr>
                <tr>
                    <td>Foundation (KFD)</td>
                    <td class="text-center">10%</td>
                </tr>
                <tr>
                    <td>Diploma</td>
                    <td class="text-center">10%</td>
                </tr>
                <tr>
                    <td>PBEP+KFD+Diploma+Bachelor+Master<br>语言+预科+大专+本科+硕士</td>
                    <td class="text-center">10%+10%+10%</td>
                </tr>
                <tr>
                    <td>PBEP+Diploma+Bachelor+Master<br>语言+大专+本科+硕士</td>
                    <td class="text-center">10%+10%+10%</td>
                </tr>
                <tr>
                    <td>PBEP+Bachelor 语言+本科</td>
                    <td class="text-center">10%+2%</td>
                </tr>
                <tr>
                    <td>Bachelor 本科直入</td>
                    <td class="text-center">6%</td>
                </tr>
                <tr>
                    <td>PBEP+Master 语言+硕士</td>
                    <td class="text-center">6%+2%</td>
                </tr>
                <tr>
                    <td>Master 硕士直入</td>
                    <td class="text-center">6%</td>
                </tr>
                <tr>
                    <td>Bachelor+Master 本科+硕士</td>
                    <td class="text-center">6%+2%</td>
                </tr>
            </tbody>
        </table>

        <!-- JCU Singapore -->
        <table>
            <thead>
                <tr>
                    <th style="width: 30%;">学校名称</th>
                    <th style="width: 35%;">课程</th>
                    <th style="width: 20%;">佣金比例</th>
                    <th style="width: 15%;">额外奖励</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td rowspan="5" class="school-name">澳洲詹姆斯库克大学新加坡校区<br>JCU Singapore</td>
                    <td>English</td>
                    <td class="text-center">8%</td>
                    <td rowspan="5" class="text-center">年度送满5个学生，每个学生奖励400人民币</td>
                </tr>
                <tr>
                    <td>Foundation</td>
                    <td class="text-center">8%</td>
                </tr>
                <tr>
                    <td>Diploma</td>
                    <td class="text-center">8%</td>
                </tr>
                <tr>
                    <td>Bachelor Degree</td>
                    <td class="text-center">8%</td>
                </tr>
                <tr>
                    <td>Master Degree</td>
                    <td class="text-center">8%</td>
                </tr>
            </tbody>
        </table>

        <!-- Curtin University -->
        <table>
            <thead>
                <tr>
                    <th style="width: 30%;">学校名称</th>
                    <th style="width: 35%;">课程</th>
                    <th style="width: 20%;">佣金比例</th>
                    <th style="width: 15%;">额外奖励</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td rowspan="5" class="school-name">澳洲科廷科技分校<br>Curtin University of Technology</td>
                    <td>English</td>
                    <td class="text-center">10%</td>
                    <td rowspan="5" class="text-center">年度送满5个学生，每个学生奖励400人民币</td>
                </tr>
                <tr>
                    <td>Foundation</td>
                    <td class="text-center">8%</td>
                </tr>
                <tr>
                    <td>Diploma</td>
                    <td class="text-center">8%</td>
                </tr>
                <tr>
                    <td>Bachelor Degree</td>
                    <td class="text-center">8%（第一年前八门科目）</td>
                </tr>
                <tr>
                    <td>Master Degree</td>
                    <td class="text-center">8%（第一年前八门科目）</td>
                </tr>
            </tbody>
        </table>

        <div class="page-break"></div>

        <!-- PSB Academy -->
        <table>
            <thead>
                <tr>
                    <th style="width: 30%;">学校名称</th>
                    <th style="width: 35%;">课程</th>
                    <th style="width: 20%;">佣金比例</th>
                    <th style="width: 15%;">额外奖励</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td rowspan="8" class="school-name">新加坡PSB学院<br>PSB Academy</td>
                    <td>English (CEP)</td>
                    <td class="text-center">10%</td>
                    <td rowspan="8" class="text-center"></td>
                </tr>
                <tr>
                    <td>Foundation</td>
                    <td class="text-center">10%</td>
                </tr>
                <tr>
                    <td>Diploma/PGDiploma</td>
                    <td class="text-center">10%</td>
                </tr>
                <tr>
                    <td>CEP+Foundation+Diploma+Bachelor</td>
                    <td class="text-center">10%+10%+10%</td>
                </tr>
                <tr>
                    <td>Bachelor Degree（直入）</td>
                    <td class="text-center">6%</td>
                </tr>
                <tr>
                    <td>CEP+Bachelor Degree</td>
                    <td class="text-center">10%+6%</td>
                </tr>
                <tr>
                    <td>Master Degree（直入）</td>
                    <td class="text-center">6%</td>
                </tr>
                <tr>
                    <td>CEP+Master Degree</td>
                    <td class="text-center">10%+6%</td>
                </tr>
            </tbody>
        </table>

        <!-- Amity Global Institute -->
        <table>
            <thead>
                <tr>
                    <th style="width: 30%;">学校名称</th>
                    <th style="width: 35%;">课程</th>
                    <th style="width: 20%;">佣金比例</th>
                    <th style="width: 15%;">额外奖励</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td rowspan="6" class="school-name">新加坡Amity全球学院<br>Amity Global Institute</td>
                    <td>English</td>
                    <td class="text-center">SGD 300（一科）</td>
                    <td rowspan="6" class="text-center"></td>
                </tr>
                <tr>
                    <td>Foundation</td>
                    <td class="text-center">15%</td>
                </tr>
                <tr>
                    <td>Diploma</td>
                    <td class="text-center">15%</td>
                </tr>
                <tr>
                    <td>Advanced</td>
                    <td class="text-center">15%</td>
                </tr>
                <tr>
                    <td>Degree</td>
                    <td class="text-center">15%</td>
                </tr>
                <tr>
                    <td>硕士Master</td>
                    <td class="text-center">SGD 2500</td>
                </tr>
            </tbody>
        </table>

        <!-- Dimensions International College -->
        <table>
            <thead>
                <tr>
                    <th style="width: 30%;">学校名称</th>
                    <th style="width: 35%;">课程</th>
                    <th style="width: 20%;">佣金比例</th>
                    <th style="width: 15%;">额外奖励</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td rowspan="8" class="school-name">新加坡博伟教育学院<br>Dimensions International College</td>
                    <td>O Level</td>
                    <td class="text-center">SGD1740</td>
                    <td rowspan="8" class="text-center"></td>
                </tr>
                <tr>
                    <td>A Level</td>
                    <td class="text-center">SGD2140</td>
                </tr>
                <tr>
                    <td>剑桥小中学（小一-中四）</td>
                    <td class="text-center">SGD1540（以后每年SGD1270）</td>
                </tr>
                <tr>
                    <td>English（6个月）</td>
                    <td class="text-center">SGD1140</td>
                </tr>
                <tr>
                    <td>Diploma</td>
                    <td class="text-center">SGD1000</td>
                </tr>
                <tr>
                    <td>Advance Diploma</td>
                    <td class="text-center">SGD2080（分两次支付）</td>
                </tr>
                <tr>
                    <td>Bachelor</td>
                    <td class="text-center">SGD1340</td>
                </tr>
                <tr>
                    <td>Master Degree（12个月）</td>
                    <td class="text-center">SGD1940</td>
                </tr>
            </tbody>
        </table>

        <div class="page-break"></div>

        <!-- SIM -->
        <table>
            <thead>
                <tr>
                    <th style="width: 30%;">学校名称</th>
                    <th style="width: 35%;">课程</th>
                    <th style="width: 20%;">佣金比例</th>
                    <th style="width: 15%;">额外奖励</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td rowspan="5" class="school-name">新加坡管理学院<br>Singapore Institute of Management</td>
                    <td>English</td>
                    <td class="text-center">SGD100</td>
                    <td rowspan="5" class="text-center">英文+预科/大专=SGD470<br>（升学本科不结算佣金）</td>
                </tr>
                <tr>
                    <td>ARAP/PEAP（硕士英文）</td>
                    <td class="text-center">SGD470</td>
                </tr>
                <tr>
                    <td>Foundation/Diploma</td>
                    <td class="text-center">SGD370</td>
                </tr>
                <tr>
                    <td>Bachelor Degree（直入）</td>
                    <td class="text-center">SGD800</td>
                </tr>
                <tr>
                    <td>Master Degree（直入）</td>
                    <td class="text-center">SGD940</td>
                </tr>
            </tbody>
        </table>

        <!-- MDIS -->
        <table>
            <thead>
                <tr>
                    <th style="width: 30%;">学校名称</th>
                    <th style="width: 35%;">课程</th>
                    <th style="width: 20%;">佣金比例</th>
                    <th style="width: 15%;">额外奖励</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td rowspan="12" class="school-name">新加坡管理发展学院<br>Management Development Institute of
                        Singapore</td>
                    <td>O/A Level（10-12month）</td>
                    <td class="text-center">SGD1000</td>
                    <td rowspan="12" class="text-center"></td>
                </tr>
                <tr>
                    <td>O/A Level（16month）</td>
                    <td class="text-center">SGD1200</td>
                </tr>
                <tr>
                    <td>IGCSE（12month）</td>
                    <td class="text-center">SGD840</td>
                </tr>
                <tr>
                    <td>IGCSE（24month）</td>
                    <td class="text-center">SGD2140（分两次支付）</td>
                </tr>
                <tr>
                    <td>EIS/CIS（per Level）</td>
                    <td class="text-center">SGD230</td>
                </tr>
                <tr>
                    <td>International Foundation</td>
                    <td class="text-center">SGD400</td>
                </tr>
                <tr>
                    <td>Diploma</td>
                    <td class="text-center">SGD530</td>
                </tr>
                <tr>
                    <td>Advance Diploma</td>
                    <td class="text-center">SGD700</td>
                </tr>
                <tr>
                    <td>Bachelor（8-12month）</td>
                    <td class="text-center">SGD1000</td>
                </tr>
                <tr>
                    <td>Bachelor（13-18month）</td>
                    <td class="text-center">SGD1200</td>
                </tr>
                <tr>
                    <td>Bachelor（24-29month）</td>
                    <td class="text-center">SGD1050</td>
                </tr>
                <tr>
                    <td>Master</td>
                    <td class="text-center">SGD1640</td>
                </tr>
            </tbody>
        </table>

        <!-- LSBF Academy -->
        <table>
            <thead>
                <tr>
                    <th style="width: 30%;">学校名称</th>
                    <th style="width: 35%;">课程</th>
                    <th style="width: 20%;">佣金比例</th>
                    <th style="width: 15%;">额外奖励</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td rowspan="5" class="school-name">新加坡伦敦商业金融学院<br>LSBF Academy</td>
                    <td>English</td>
                    <td class="text-center">12%</td>
                    <td rowspan="5" class="text-center">高级大专第一学期18%<br>第二学期4%</td>
                </tr>
                <tr>
                    <td>Bachelor Degree</td>
                    <td class="text-center">6%</td>
                </tr>
                <tr>
                    <td>top-up（UOG 本科直入）</td>
                    <td class="text-center">6%</td>
                </tr>
                <tr>
                    <td>Master Degree</td>
                    <td class="text-center">10%</td>
                </tr>
                <tr>
                    <td>ACCA</td>
                    <td class="text-center">8%(仅第一年报名科目)</td>
                </tr>
            </tbody>
        </table>

        <div class="page-break"></div>

        <!-- EAIM -->
        <table>
            <thead>
                <tr>
                    <th style="width: 30%;">学校名称</th>
                    <th style="width: 35%;">课程</th>
                    <th style="width: 20%;">佣金比例</th>
                    <th style="width: 15%;">额外奖励</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td rowspan="4" class="school-name">新加坡东亚管理学院<br>EAST ASIA Institute of Management</td>
                    <td>English/ Foundation</td>
                    <td class="text-center">8%</td>
                    <td rowspan="4" class="text-center"></td>
                </tr>
                <tr>
                    <td>Diploma</td>
                    <td class="text-center">8%</td>
                </tr>
                <tr>
                    <td>Bachelor Degree</td>
                    <td class="text-center">4%</td>
                </tr>
                <tr>
                    <td>Master Degree</td>
                    <td class="text-center">8%</td>
                </tr>
            </tbody>
        </table>

        <!-- SHRM College -->
        <table>
            <thead>
                <tr>
                    <th style="width: 30%;">学校名称</th>
                    <th style="width: 35%;">课程</th>
                    <th style="width: 20%;">佣金比例</th>
                    <th style="width: 15%;">额外奖励</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td rowspan="3" class="school-name">新加坡莎瑞管理学院<br>SHRM College</td>
                    <td>English/Foundation/Diploma</td>
                    <td class="text-center">6%</td>
                    <td rowspan="3" class="text-center"></td>
                </tr>
                <tr>
                    <td>Bachelor Degree</td>
                    <td class="text-center">6%</td>
                </tr>
                <tr>
                    <td>Master Degree</td>
                    <td class="text-center">6%</td>
                </tr>
            </tbody>
        </table>

        <!-- ST Francis -->
        <table>
            <thead>
                <tr>
                    <th style="width: 30%;">学校名称</th>
                    <th style="width: 35%;">课程</th>
                    <th style="width: 20%;">佣金比例</th>
                    <th style="width: 15%;">额外奖励</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td rowspan="3" class="school-name">新加坡圣法西斯学院<br>ST Francis Methodist School</td>
                    <td>English</td>
                    <td class="text-center">6%</td>
                    <td rowspan="3" class="text-center"></td>
                </tr>
                <tr>
                    <td>O Level/IGCSE/剑桥中小学</td>
                    <td class="text-center">6%</td>
                </tr>
                <tr>
                    <td>A Level/WACE</td>
                    <td class="text-center">6%</td>
                </tr>
            </tbody>
        </table>

        <!-- Raffles Music College -->
        <table>
            <thead>
                <tr>
                    <th style="width: 30%;">学校名称</th>
                    <th style="width: 35%;">课程</th>
                    <th style="width: 20%;">佣金比例</th>
                    <th style="width: 15%;">额外奖励</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td rowspan="4" class="school-name">新加坡莱佛士音乐学院<br>Singapore Raffles Music College</td>
                    <td>English</td>
                    <td class="text-center">SGD 470</td>
                    <td rowspan="4" class="text-center"></td>
                </tr>
                <tr>
                    <td>Diploma</td>
                    <td class="text-center">7%</td>
                </tr>
                <tr>
                    <td>Bachelor Degree</td>
                    <td class="text-center">7%</td>
                </tr>
                <tr>
                    <td>Master Degree</td>
                    <td class="text-center">7%</td>
                </tr>
            </tbody>
        </table>

        <!-- LASALLE -->
        <table>
            <thead>
                <tr>
                    <th style="width: 30%;">学校名称</th>
                    <th style="width: 35%;">课程</th>
                    <th style="width: 20%;">佣金比例</th>
                    <th style="width: 15%;">额外奖励</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td class="school-name">新加坡拉萨尔艺术学院<br>LASALLE College Of The Arts</td>
                    <td></td>
                    <td class="text-center">SGD670（一次性）</td>
                    <td class="text-center"></td>
                </tr>
            </tbody>
        </table>

        <!-- NAFA -->
        <table>
            <thead>
                <tr>
                    <th style="width: 30%;">学校名称</th>
                    <th style="width: 35%;">课程</th>
                    <th style="width: 20%;">佣金比例</th>
                    <th style="width: 15%;">额外奖励</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td class="school-name">新加坡南洋艺术学院<br>NANYANG Academy Of Fine Arts</td>
                    <td></td>
                    <td class="text-center">SGD670（一次性）</td>
                    <td class="text-center"></td>
                </tr>
            </tbody>
        </table>

        <div class="page-break"></div>

        <!-- International Schools -->
        <table>
            <thead>
                <tr>
                    <th style="width: 30%;">学校名称</th>
                    <th style="width: 35%;">课程</th>
                    <th style="width: 20%;">佣金比例</th>
                    <th style="width: 15%;">额外奖励</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td class="school-name">加拿大国际（新加坡）<br>Canadian International School Singapore</td>
                    <td></td>
                    <td class="text-center">SGD1000（根据学生入学的学期不同，返佣次数不一样，共计1000新币）</td>
                    <td class="text-center"></td>
                </tr>
                <tr>
                    <td class="school-name">澳洲国际（新加坡）<br>Australian International School Singapore</td>
                    <td></td>
                    <td class="text-center">SGD800（根据学生入学的学期不同，返佣次数不一样，共计800新币）</td>
                    <td class="text-center"></td>
                </tr>
            </tbody>
        </table>

        <!-- Global Indian -->
        <table>
            <thead>
                <tr>
                    <th style="width: 30%;">学校名称</th>
                    <th style="width: 35%;">课程</th>
                    <th style="width: 20%;">佣金比例</th>
                    <th style="width: 15%;">额外奖励</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td rowspan="2" class="school-name">环印国际学校（新加坡）<br>Global Indian International School</td>
                    <td>kindergarten</td>
                    <td class="text-center">SGD 530（一次性）</td>
                    <td rowspan="2" class="text-center"></td>
                </tr>
                <tr>
                    <td>Class 1 to 6</td>
                    <td class="text-center">SGD 800（一次性）</td>
                </tr>
            </tbody>
        </table>

        <!-- Other Schools -->
        <table>
            <thead>
                <tr>
                    <th style="width: 30%;">学校名称</th>
                    <th style="width: 35%;">课程</th>
                    <th style="width: 20%;">佣金比例</th>
                    <th style="width: 15%;">额外奖励</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td rowspan="2" class="school-name">佳慧世界书院</td>
                    <td>kindergarten-class 5</td>
                    <td class="text-center">SGD 1340（一次性）</td>
                    <td rowspan="2" class="text-center"></td>
                </tr>
                <tr>
                    <td>Class 6-Class 12</td>
                    <td class="text-center">SGD 1000（一次性）</td>
                </tr>
                <tr>
                    <td class="school-name">美国斯坦福国际<br>Stamford American (INTERNATIONAL SCHOOL)</td>
                    <td></td>
                    <td class="text-center">SGD800（根据学生入学的学期不同，返佣次数不一样，共计800新币）</td>
                    <td class="text-center"></td>
                </tr>
            </tbody>
        </table>

        <!-- Raffles Education Network -->
        <table>
            <thead>
                <tr>
                    <th style="width: 30%;">学校名称</th>
                    <th style="width: 35%;">课程</th>
                    <th style="width: 20%;">佣金比例</th>
                    <th style="width: 15%;">额外奖励</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td rowspan="5" class="school-name">新加坡莱佛士高等教育学院<br>RAFFLES Education Network</td>
                    <td>English</td>
                    <td class="text-center">SGD90（二个级别SGD320）</td>
                    <td rowspan="5" class="text-center"></td>
                </tr>
                <tr>
                    <td>Bachelor Degree（设计专业）</td>
                    <td class="text-center">SGD1340（分两次支付）</td>
                </tr>
                <tr>
                    <td>Bachelor Degree（商科专业）</td>
                    <td class="text-center">SGD1140（分两次支付）</td>
                </tr>
                <tr>
                    <td>Master Degree</td>
                    <td class="text-center">SGD670</td>
                </tr>
                <tr>
                    <td>上海/广州校区</td>
                    <td class="text-center">RMB4350（返佣人民币）</td>
                </tr>
            </tbody>
        </table>

        <div class="end-section">
            <img src="../../04_Brand_Assets/01_Logo/Logo_MapleEducation_Main.jpg" alt="Logo">
            <div class="end-section-text">以上为新加坡私立大学留学项目返佣表格</div>
        </div>

        <div class="page-break"></div>

        <!-- Singapore Public Universities -->
        <table>
            <thead>
                <tr>
                    <th style="width: 30%;">学校名称</th>
                    <th style="width: 25%;">课程</th>
                    <th style="width: 20%;">佣金比例</th>
                    <th style="width: 25%;">额外奖励</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td rowspan="3" class="school-name">1. 新加坡国立大学<br>(National University of Singapore)<br><br>2.
                        新加坡南洋理工大学<br>(Nanyang Technological University)<br><br>3. 新加坡管理大学<br>(Singapore Management
                        University)<br><br>4. 新加坡科技设计大学<br>(Singapore University of Technology And Design)</td>
                    <td rowspan="3">本科、硕士、博士</td>
                    <td rowspan="3" class="text-center">无返佣</td>
                    <td>1. 本科以及授课型硕士项目收费15000人民币包三所院校（申请不成功退费10000人民币）</td>
                </tr>
                <tr>
                    <td>2. 研究性硕士、博士收费30000人民币包三所院校（申请不成功退费15000人民币，未申请到奖学金退费10000人民币）</td>
                </tr>
                <tr>
                    <td></td>
                </tr>
                <tr>
                    <td class="school-name">新加坡公立幼稚园、小一</td>
                    <td></td>
                    <td class="text-center">无返佣</td>
                    <td>收费12000人民币，申请不成功退费10000人民币。</td>
                </tr>
                <tr>
                    <td class="school-name">单申请陪读签证</td>
                    <td></td>
                    <td class="text-center">无返佣</td>
                    <td>13000人民币，申请不成功不退费。</td>
                </tr>
            </tbody>
        </table>

        <div class="end-section">
            <img src="../../04_Brand_Assets/01_Logo/Logo_MapleEducation_Main.jpg" alt="Logo">
            <div class="end-section-text">以上为新加坡公立大学留学项目返佣表格</div>
        </div>

        <!-- Malaysia Programs -->
        <div class="section-title">马来西亚留学项目 Malaysia Study Programs</div>

        <table>
            <thead>
                <tr>
                    <th style="width: 30%;">学校名称</th>
                    <th style="width: 35%;">课程</th>
                    <th style="width: 20%;">佣金比例</th>
                    <th style="width: 15%;">额外奖励</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td rowspan="2" class="school-name">马来西亚英迪大学<br>INTI International University</td>
                    <td>本科-硕士</td>
                    <td class="text-center">USD 800（一次性）</td>
                    <td rowspan="2" class="text-center"></td>
                </tr>
                <tr>
                    <td>博士</td>
                    <td class="text-center">USD 1200（一次性）</td>
                </tr>
            </tbody>
        </table>

        <table>
            <thead>
                <tr>
                    <th style="width: 30%;">学校名称</th>
                    <th style="width: 35%;">课程</th>
                    <th style="width: 20%;">佣金比例</th>
                    <th style="width: 15%;">额外奖励</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td rowspan="2" class="school-name">马来西亚泰莱大学<br>Taylor's University</td>
                    <td>本科-硕士</td>
                    <td class="text-center">USD 800（一次性）</td>
                    <td rowspan="2" class="text-center"></td>
                </tr>
                <tr>
                    <td>博士</td>
                    <td class="text-center">USD 580（一次性）</td>
                </tr>
            </tbody>
        </table>

        <table>
            <thead>
                <tr>
                    <th style="width: 30%;">学校名称</th>
                    <th style="width: 35%;">课程</th>
                    <th style="width: 20%;">佣金比例</th>
                    <th style="width: 15%;">额外奖励</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td rowspan="2" class="school-name">马来西亚亚太科技大学<br>ASIA PACIFIC UNIVERSITY OF TECHNOLOGY</td>
                    <td>本科-硕士</td>
                    <td class="text-center">USD 940（一次性）</td>
                    <td rowspan="2" class="text-center"></td>
                </tr>
                <tr>
                    <td>博士</td>
                    <td class="text-center">USD 940（一次性）</td>
                </tr>
            </tbody>
        </table>

        <table>
            <thead>
                <tr>
                    <th style="width: 30%;">学校名称</th>
                    <th style="width: 35%;">课程</th>
                    <th style="width: 20%;">佣金比例</th>
                    <th style="width: 15%;">额外奖励</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td class="school-name">马来西亚世纪大学<br>SEGI University</td>
                    <td>本科-硕士-博士</td>
                    <td class="text-center">USD 530（一次性）</td>
                    <td class="text-center"></td>
                </tr>
            </tbody>
        </table>

        <table>
            <thead>
                <tr>
                    <th style="width: 30%;">学校名称</th>
                    <th style="width: 35%;">课程</th>
                    <th style="width: 20%;">佣金比例</th>
                    <th style="width: 15%;">额外奖励</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td class="school-name">马来西亚双威大学<br>Sunway University</td>
                    <td>本科-硕士-博士</td>
                    <td class="text-center">RMB1470（一次性）</td>
                    <td class="text-center"></td>
                </tr>
            </tbody>
        </table>

        <div class="end-section">
            <img src="../../04_Brand_Assets/01_Logo/Logo_MapleEducation_Main.jpg" alt="Logo">
            <div class="end-section-text">以上为马来西亚私立大学留学项目返佣表格</div>
        </div>

        <div class="page-break"></div>

        <!-- Malaysia Public Universities -->
        <table>
            <thead>
                <tr>
                    <th style="width: 30%;">学校名称</th>
                    <th style="width: 25%;">课程</th>
                    <th style="width: 20%;">佣金比例</th>
                    <th style="width: 25%;">额外奖励</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td rowspan="3" class="school-name">马来西亚公立大学</td>
                    <td>本科、授课型硕士</td>
                    <td class="text-center">无返佣</td>
                    <td>收费10000人民币包三所院校（申请不成功，退费60%）*不包括第三方费用</td>
                </tr>
                <tr>
                    <td>研究型硕士、博士</td>
                    <td class="text-center">无返佣</td>
                    <td>收费14000人民币包三所院校（申请不成功，退费60%）*不包括第三方费用</td>
                </tr>
                <tr>
                    <td>寒暑假博士</td>
                    <td class="text-center">无返佣</td>
                    <td>收费20000人民币（申请不成功，退费70%）</td>
                </tr>
            </tbody>
        </table>

        <div class="end-section">
            <img src="../../04_Brand_Assets/01_Logo/Logo_MapleEducation_Main.jpg" alt="Logo">
            <div class="end-section-text">以上为马来西亚公立大学留学项目返佣表格</div>
        </div>

        <!-- Thailand Programs -->
        <div class="section-title">泰国留学项目 Thailand Study Programs</div>

        <table>
            <thead>
                <tr>
                    <th style="width: 30%;">学校名称</th>
                    <th style="width: 35%;">课程</th>
                    <th style="width: 20%;">佣金比例</th>
                    <th style="width: 15%;">额外奖励</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td rowspan="2" class="school-name">泰国先皇理工大学项目班<br>King Mongkut's Institute Of Technology
                        Ladkrabang</td>
                    <td>本科-硕士</td>
                    <td class="text-center">RMB 13400（一次性（专业有限））</td>
                    <td rowspan="2" class="text-center"></td>
                </tr>
                <tr>
                    <td>博士</td>
                    <td class="text-center">RMB 16750（一次性（专业有限））</td>
                </tr>
            </tbody>
        </table>

        <table>
            <thead>
                <tr>
                    <th style="width: 30%;">学校名称</th>
                    <th style="width: 35%;">课程</th>
                    <th style="width: 20%;">佣金比例</th>
                    <th style="width: 15%;">额外奖励</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td rowspan="2" class="school-name">泰国玛哈沙拉堪大学项目班<br>Rajabhat Maha Sarakham University</td>
                    <td>本科-硕士</td>
                    <td class="text-center">RMB 13400（一次性（专业有限））</td>
                    <td rowspan="2" class="text-center"></td>
                </tr>
                <tr>
                    <td>博士</td>
                    <td class="text-center">RMB 16750（一次性（专业有限））</td>
                </tr>
            </tbody>
        </table>

        <table>
            <thead>
                <tr>
                    <th style="width: 30%;">学校名称</th>
                    <th style="width: 35%;">课程</th>
                    <th style="width: 20%;">佣金比例</th>
                    <th style="width: 15%;">额外奖励</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td rowspan="3" class="school-name">泰国格乐大学<br>Krirk University</td>
                    <td>本科</td>
                    <td class="text-center">RMB 3350（高中毕业学历申请）</td>
                    <td rowspan="3" class="text-center"></td>
                </tr>
                <tr>
                    <td>中文授课硕士</td>
                    <td class="text-center">RMB 3350（一次性）</td>
                </tr>
                <tr>
                    <td>博士</td>
                    <td class="text-center">RMB 8710（一次性）</td>
                </tr>
            </tbody>
        </table>

        <div class="end-section">
            <img src="../../04_Brand_Assets/01_Logo/Logo_MapleEducation_Main.jpg" alt="Logo">
            <div class="end-section-text">以上为泰国私立大学留学项目返佣表格</div>
        </div>

        <!-- Notes -->
        <div class="notes">
            <p><strong>1、</strong>上述为新加坡、马来西亚以及泰国主打优质私立大学返佣清单，未列入其中的学校返佣数额请咨询枫叶留学。</p>
            <p><strong>2、</strong>通常佣金会在学生进入该阶段课程后50个工作日内支付。如学生入学后不满一个月办理退学手续的，则不给予支付佣金。</p>
            <p><strong>3、</strong>部分学校每笔佣金支付需扣除30-60新币不等外方银行手续费。</p>
            <p><strong>4、</strong>佣金按照汇款当日中国银行现钞买入价折算人民币支付合作方国内账户，所产生汇款手续费由枫叶留学承担。</p>
            <p><strong>5、</strong>如需新币结算：佣金由新加坡账户以新币直接汇入合作方指定账户，外方银行手续费由对方自行承担(30-60新币不等,以银行实时扣除为准)。</p>
        </div>

        <div class="currency-note">
            ① SGD（新币）； ② USD（美金）； ③ RM（马币）； ④ RMB（人民币）； 百分比则纯学费的比例。
        </div>

        <div style="margin-top: 20px; font-size: 8pt; color: #666; text-align: center;">
            This commission list is for use by Maple Education Pte. Ltd. and its authorized partners only.<br>
            本佣金清单仅供Maple Education Pte. Ltd.及其授权合作伙伴使用。
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
