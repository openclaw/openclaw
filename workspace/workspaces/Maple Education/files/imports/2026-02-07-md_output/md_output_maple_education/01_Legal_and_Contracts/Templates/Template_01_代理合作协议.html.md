---
title: "Template_01_代理合作协议.html"
source_path: "01_Legal_and_Contracts/Templates/Template_01_代理合作协议.html"
tags: ["合同", "html"]
ocr: false
---

# Template_01_代理合作协议.html

简介：返佣/佣金清单，列出项目、比例与奖励规则。

## 内容

```text
<!DOCTYPE html>
<html lang="en">

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Referral Commission Cooperation Agreement - 代理合作协议</title>
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
            font-size: 18pt;
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
            padding: 0 20mm;
            z-index: 5;
            font-size: 9pt;
            line-height: 1.6;
        }

        .contract-title {
            text-align: center;
            font-size: 18pt;
            font-weight: 700;
            color: #2c5aa0;
            margin-bottom: 5px;
        }

        .contract-subtitle {
            text-align: center;
            font-size: 16pt;
            font-weight: 600;
            color: #666;
            margin-bottom: 20px;
        }

        .party-section {
            margin-bottom: 15px;
            border: 1px solid #ccc;
            padding: 10px;
            background-color: #f9f9f9;
            page-break-inside: avoid;
        }

        .party-title {
            font-weight: 700;
            font-size: 11pt;
            color: #2c5aa0;
            margin-bottom: 8px;
        }

        .info-row {
            display: flex;
            margin-bottom: 5px;
        }

        .info-label {
            width: 35%;
            font-weight: 600;
        }

        .info-value {
            width: 65%;
            border-bottom: 1px solid #999;
            min-height: 16px;
        }

        .article {
            margin-bottom: 15px;
            page-break-inside: avoid;
        }

        .article-title {
            font-weight: 700;
            font-size: 10pt;
            color: #2c5aa0;
            margin-bottom: 8px;
            border-bottom: 2px solid #2c5aa0;
            padding-bottom: 3px;
        }

        .article-content {
            margin-left: 10px;
        }

        .subsection {
            margin-bottom: 10px;
        }

        .subsection-title {
            font-weight: 600;
            margin-bottom: 5px;
        }

        .clause {
            margin-left: 15px;
            margin-bottom: 5px;
        }

        .signature-section {
            margin-top: 30px;
            page-break-inside: avoid;
        }

        .signature-block {
            margin-bottom: 25px;
            border: 1px solid #ccc;
            padding: 15px;
            page-break-inside: avoid;
        }

        .signature-row {
            display: flex;
            margin-bottom: 10px;
        }

        .signature-label {
            width: 40%;
            font-weight: 600;
        }

        .signature-value {
            width: 60%;
            border-bottom: 1px solid #333;
            min-height: 20px;
        }

        .bilingual {
            color: #666;
            font-size: 8.5pt;
        }

        table {
            width: 100%;
            border-collapse: collapse;
            margin: 10px 0;
            font-size: 9pt;
        }

        table th,
        table td {
            border: 1px solid #999;
            padding: 5px;
        }

        table th {
            background-color: #f0f0f0;
            font-weight: 700;
        }

        /* Print optimization */
        @media print {
            body {
                border: none;
            }

            .page-break {
                page-break-after: always;
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
            <div class="document-title">CONTRACT</div>
            <div class="company-name">Maple Education Pte. Ltd. &nbsp;|&nbsp; 新加坡枫叶留学</div>
            <div class="divider"></div>
        </div>
    </div>

    <!-- Content -->
    <div class="content">
        <div class="contract-title">Referral Commission Cooperation Agreement</div>
        <div class="contract-subtitle">代理合作协议</div>

        <!-- Party A Information -->
        <div class="party-section">
            <div class="party-title">Party A (Service Provider) 甲方（服务提供方）</div>
            <div class="info-row">
                <div class="info-label">Company Name 公司名称:</div>
                <div class="info-value">Maple Education Pte. Ltd.</div>
            </div>
            <div class="info-row">
                <div class="info-label">UEN 公司注册号:</div>
                <div class="info-value">202349302E</div>
            </div>
            <div class="info-row">
                <div class="info-label">Registered Address 注册地址:</div>
                <div class="info-value">111 North Bridge Road, #25-01, Peninsula Plaza, Singapore 179098</div>
            </div>
            <div class="info-row">
                <div class="info-label">Legal Representative 法定代表人:</div>
                <div class="info-value">Leonard Chow Yi Ding</div>
            </div>
            <div class="info-row">
                <div class="info-label">Contact Person 联系人:</div>
                <div class="info-value">Leonard Chow Yi Ding</div>
            </div>
            <div class="info-row">
                <div class="info-label">Phone 电话:</div>
                <div class="info-value">+65 86863695</div>
            </div>
            <div class="info-row">
                <div class="info-label">Email 电子邮箱:</div>
                <div class="info-value">Maple@maplesgedu.com</div>
            </div>
        </div>

        <!-- Party B Information -->
        <div class="party-section">
            <div class="party-title">Party B (Referral Agent) 乙方（推荐代理）</div>
            <div class="info-row">
                <div class="info-label">Full Name/Company Name 姓名/公司名称:</div>
                <div class="info-value"></div>
            </div>
            <div class="info-row">
                <div class="info-label">ID/UEN Number 身份证号/公司注册号:</div>
                <div class="info-value"></div>
            </div>
            <div class="info-row">
                <div class="info-label">Address 地址:</div>
                <div class="info-value"></div>
            </div>
            <div class="info-row">
                <div class="info-label">Contact Person 联系人:</div>
                <div class="info-value"></div>
            </div>
            <div class="info-row">
                <div class="info-label">Phone 电话:</div>
                <div class="info-value"></div>
            </div>
            <div class="info-row">
                <div class="info-label">Email 电子邮箱:</div>
                <div class="info-value"></div>
            </div>
            <div class="info-row">
                <div class="info-label">WeChat ID 微信号:</div>
                <div class="info-value"></div>
            </div>
            <div class="info-row">
                <div class="info-label">Bank Account Name 银行账户名:</div>
                <div class="info-value"></div>
            </div>
            <div class="info-row">
                <div class="info-label">Bank Name 开户行:</div>
                <div class="info-value"></div>
            </div>
            <div class="info-row">
                <div class="info-label">Account Number 账号:</div>
                <div class="info-value"></div>
            </div>
            <div class="info-row">
                <div class="info-label">SWIFT Code (if applicable) SWIFT代码（如适用）:</div>
                <div class="info-value"></div>
            </div>
        </div>

        <p style="margin: 20px 0; line-height: 1.8;">
            WHEREAS Party A is engaged in international education consulting and student placement services; and Party
            B is willing to refer prospective students to Party A; NOW, THEREFORE, in consideration of the mutual
            covenants and agreements hereinafter set forth and for other good and valuable consideration, the receipt
            and sufficiency of which are hereby acknowledged, the parties agree as follows:
        </p>

        <p style="margin: 20px 0; line-height: 1.8;" class="bilingual">
            鉴于甲方从事国际教育咨询及学生招生服务；乙方愿意向甲方推荐潜在学生；现在，基于以下相互约定的条款以及其他良好且有价值的对价（各方特此确认已收到且充分），双方达成如下协议：
        </p>

        <!-- Article 1 -->
        <div class="article">
            <div class="article-title">Article 1: Definitions 第一条：定义</div>
            <div class="article-content">
                <div class="subsection">
                    <div class="subsection-title">1.1 Partner Institutions and Programs <span
                            class="bilingual">合作院校及项目</span></div>
                    <div class="clause">
                        Party A maintains cooperation agreements with educational institutions in Singapore, Malaysia,
                        Thailand, and other regions (hereinafter referred to as "Partner Institutions"). The specific
                        list of institutions and programs shall be subject to the official list provided by Party A and
                        may be updated from time to time upon written notice to Party B.
                    </div>
                    <div class="clause bilingual">
                        甲方与新加坡、马来西亚、泰国及其他地区的教育机构（以下简称"合作院校"）建立合作关系。具体的院校及项目清单以甲方提供的正式清单为准，并可能根据书面通知不时更新。
                    </div>
                </div>

                <div class="subsection">
                    <div class="subsection-title">1.2 Base Commission <span class="bilingual">基准佣金</span></div>
                    <div class="clause">
                        "Base Commission" refers to the commission amount that Party A receives from Partner
                        Institutions for each successfully enrolled student. The Base Commission varies by institution,
                        program level, and program type, as specified in the Commission List (Appendix A) provided by
                        Party A.
                    </div>
                    <div class="clause bilingual">
                        "基准佣金"是指甲方从合作院校获得的每位成功录取学生的佣金金额。基准佣金因院校、项目层次和项目类型而异，具体见甲方提供的《佣金清单》（附录A）。
                    </div>
                </div>

                <div class="subsection">
                    <div class="subsection-title">1.3 Student <span class="bilingual">学生</span></div>
                    <div class="clause">
                        "Student" refers to any prospective student referred by Party B to Party A who subsequently
                        applies for admission to a Partner Institution through Party A's services. A student shall be
                        deemed to be referred by Party B only if Party B has provided the student's complete information
                        to Party A in writing and received written confirmation from Party A prior to the student's
                        application submission.
                    </div>
                    <div class="clause bilingual">
                        "学生"是指由乙方向甲方推荐的任何潜在学生，该学生随后通过甲方的服务申请入读合作院校。仅当乙方在学生提交申请前以书面形式向甲方提供学生完整信息并收到甲方书面确认时，该学生才被视为由乙方推荐。
                    </div>
                </div>

                <div class="subsection">
                    <div class="subsection-title">1.4 Successful Enrollment <span class="bilingual">成功录取</span>
                    </div>
                    <div class="clause">
                        "Successful Enrollment" occurs when a referred student: (a) receives an official offer of
                        admission from a Partner Institution; (b) accepts the offer and pays all required fees; (c)
                        completes visa application procedures (if applicable); and (d) physically commences studies at
                        the Partner Institution, whereupon Party A receives the Base Commission from the Partner
                        Institution.
                    </div>
                    <div class="clause bilingual">
                        "成功录取"是指推荐学生：(a) 收到合作院校的正式录取通知；(b)
                        接受录取并支付所有必需费用；(c) 完成签证申请程序（如适用）；(d)
                        实际开始在合作院校学习，届时甲方从合作院校收到基准佣金。
                    </div>
                </div>
            </div>
        </div>

        <!-- Article 2 -->
        <div class="article">
            <div class="article-title">Article 2: Scope of Cooperation 第二条：合作范围</div>
            <div class="article-content">
                <div class="subsection">
                    <div class="subsection-title">2.1 Party B's Responsibilities <span
                            class="bilingual">乙方责任</span></div>
                    <div class="clause">
                        (a) Party B shall actively identify and refer qualified prospective students to Party A for
                        admission to Partner Institutions;
                    </div>
                    <div class="clause">
                        (b) Party B shall provide accurate and complete information about each referred student,
                        including but not limited to: full name, contact details, educational background, language
                        proficiency, intended program, and any other information reasonably requested by Party A;
                    </div>
                    <div class="clause">
                        (c) Party B shall ensure that all referred students are genuinely interested in pursuing
                        education abroad and meet the basic eligibility requirements of the intended programs;
                    </div>
                    <div class="clause">
                        (d) Party B shall not misrepresent Party A's services or make unauthorized commitments on behalf
                        of Party A to students or Partner Institutions;
                    </div>
                    <div class="clause">
                        (e) Party B shall comply with all applicable laws and regulations in its jurisdiction,
                        including but not limited to data protection, consumer protection, and education agency
                        regulations.
                    </div>
                    <div class="clause bilingual">
                        (a) 乙方应积极识别并向甲方推荐符合条件的潜在学生以入读合作院校；<br>
                        (b) 乙方应提供每位推荐学生的准确完整信息，包括但不限于：全名、联系方式、教育背景、语言能力、意向项目及甲方合理要求的任何其他信息；<br>
                        (c) 乙方应确保所有推荐学生真正有意出国留学并符合意向项目的基本资格要求；<br>
                        (d) 乙方不得歪曲甲方的服务或代表甲方向学生或合作院校作出未经授权的承诺；<br>
                        (e) 乙方应遵守其所在司法管辖区的所有适用法律法规，包括但不限于数据保护、消费者保护和教育代理法规。
                    </div>
                </div>

                <div class="subsection">
                    <div class="subsection-title">2.2 Party A's Responsibilities <span
                            class="bilingual">甲方责任</span></div>
                    <div class="clause">
                        (a) Party A shall provide professional education consulting services to all students referred by
                        Party B, including but not limited to: program selection guidance, application assistance,
                        document preparation, visa application support, and pre-departure briefings;
                    </div>
                    <div class="clause">
                        (b) Party A shall keep Party B reasonably informed of the application status of referred
                        students;
                    </div>
                    <div class="clause">
                        (c) Party A shall maintain up-to-date information on Partner Institutions, programs, admission
                        requirements, and commission structures, and provide such information to Party B upon request;
                    </div>
                    <div class="clause">
                        (d) Party A shall process commission payments to Party B in accordance with Article 5 of this
                        Agreement;
                    </div>
                    <div class="clause">
                        (e) Party A shall handle all student data in accordance with applicable data protection laws,
                        including Singapore's Personal Data Protection Act 2012 (PDPA).
                    </div>
                    <div class="clause bilingual">
                        (a) 甲方应向乙方推荐的所有学生提供专业教育咨询服务，包括但不限于：项目选择指导、申请协助、文件准备、签证申请支持和行前说明；<br>
                        (b) 甲方应合理告知乙方推荐学生的申请状态；<br>
                        (c) 甲方应保持合作院校、项目、录取要求和佣金结构的最新信息，并应乙方要求提供此类信息；<br>
                        (d) 甲方应根据本协议第五条向乙方支付佣金；<br>
                        (e) 甲方应根据适用的数据保护法律（包括新加坡《2012年个人数据保护法》（PDPA））处理所有学生数据。
                    </div>
                </div>
            </div>
        </div>

        <!-- Article 3 -->
        <div class="article">
            <div class="article-title">Article 3: Student Confirmation and Attribution 第三条：学生确认与归属</div>
            <div class="article-content">
                <div class="subsection">
                    <div class="subsection-title">3.1 Student Registration <span class="bilingual">学生登记</span></div>
                    <div class="clause">
                        Party B must register each prospective student with Party A by submitting the Student
                        Information Collection Form (Appendix B) via email to Maple@maplesgedu.com. Party A shall
                        acknowledge receipt and confirm the student's attribution to Party B within two (2) business
                        days.
                    </div>
                    <div class="clause bilingual">
                        乙方必须通过电子邮件向 Maple@maplesgedu.com 提交《学生信息收集表》（附录B）以向甲方登记每位潜在学生。甲方应在两（2）个工作日内确认收到并确认学生归属于乙方。
                    </div>
                </div>

                <div class="subsection">
                    <div class="subsection-title">3.2 First-Come-First-Served Principle <span
                            class="bilingual">先到先得原则</span></div>
                    <div class="clause">
                        In the event that the same student is referred by multiple agents, the student shall be
                        attributed to the agent who first submitted a complete and valid Student Information Collection
                        Form to Party A and received written confirmation. Party A's determination in this regard shall
                        be final and binding.
                    </div>
                    <div class="clause bilingual">
                        如同一学生由多个代理推荐，该学生应归属于首先向甲方提交完整有效的《学生信息收集表》并收到书面确认的代理。甲方对此的决定应是最终的和有约束力的。
                    </div>
                </div>

                <div class="subsection">
                    <div class="subsection-title">3.3 Validity Period <span class="bilingual">有效期</span></div>
                    <div class="clause">
                        Party B's attribution rights to a registered student shall be valid for twelve (12) months from
                        the date of Party A's written confirmation. If the student does not submit an application within
                        this period, the student attribution may be re-assigned at Party A's discretion.
                    </div>
                    <div class="clause bilingual">
                        乙方对已登记学生的归属权自甲方书面确认之日起十二（12）个月内有效。如学生在此期间未提交申请，学生归属可由甲方自行决定重新分配。
                    </div>
                </div>
            </div>
        </div>

        <!-- Article 4 -->
        <div class="article">
            <div class="article-title">Article 4: Commission Rebate and Sharing Method 第四条：佣金返还与分配方式</div>
            <div class="article-content">
                <div class="subsection">
                    <div class="subsection-title">4.1 Commission Sharing Ratio <span class="bilingual">佣金分配比例</span>
                    </div>
                    <div class="clause">
                        Upon Successful Enrollment of a student referred by Party B, Party A shall rebate to Party B
                        seventy percent (70%) of the Base Commission received from the Partner Institution, and Party A
                        shall retain thirty percent (30%) as its service fee. The sharing ratio is: <strong>Party B: 70%
                            | Party A: 30%</strong>.
                    </div>
                    <div class="clause bilingual">
                        乙方推荐的学生成功录取后，甲方应将从合作院校收到的基准佣金的百分之七十（70%）返还给乙方，甲方保留百分之三十（30%）作为服务费。分配比例为：<strong>乙方：70%
                            | 甲方：30%</strong>。
                    </div>
                </div>

                <div class="subsection">
                    <div class="subsection-title">4.2 Calculation Example <span class="bilingual">计算示例</span></div>
                    <div class="clause">
                        If Party A receives a Base Commission of SGD 5,000 from a Partner Institution for a successfully
                        enrolled student referred by Party B, then:<br>
                        - Party B's rebate: SGD 5,000 × 70% = SGD 3,500<br>
                        - Party A's retention: SGD 5,000 × 30% = SGD 1,500
                    </div>
                    <div class="clause bilingual">
                        如甲方从合作院校收到由乙方推荐的成功录取学生的基准佣金为 SGD 5,000，则：<br>
                        - 乙方返佣：SGD 5,000 × 70% = SGD 3,500<br>
                        - 甲方留存：SGD 5,000 × 30% = SGD 1,500
                    </div>
                </div>

                <div class="subsection">
                    <div class="subsection-title">4.3 Currency and Exchange Rate <span class="bilingual">货币与汇率</span>
                    </div>
                    <div class="clause">
                        All commissions shall be calculated and paid in Singapore Dollars (SGD). If the Base Commission
                        is received by Party A in a currency other than SGD, the exchange rate for commission
                        calculation shall be the prevailing mid-market exchange rate published by the Monetary Authority
                        of Singapore (MAS) on the date Party A receives the commission from the Partner Institution.
                    </div>
                    <div class="clause bilingual">
                        所有佣金应以新加坡元（SGD）计算和支付。如甲方收到的基准佣金为SGD以外的货币，佣金计算的汇率应为甲方从合作院校收到佣金当日新加坡金融管理局（MAS）公布的现行中间市场汇率。
                    </div>
                </div>
            </div>
        </div>

        <!-- Article 5 -->
        <div class="article">
            <div class="article-title">Article 5: Settlement and Payment 第五条：结算与支付</div>
            <div class="article-content">
                <div class="subsection">
                    <div class="subsection-title">5.1 Payment Timeline <span class="bilingual">支付时间</span></div>
                    <div class="clause">
                        Party A shall pay Party B's commission rebate within seven (7) business days after Party A
                        receives the Base Commission from the Partner Institution. Party A shall provide written notice
                        to Party B upon receipt of the Base Commission, including the amount received and the calculated
                        rebate amount.
                    </div>
                    <div class="clause bilingual">
                        甲方应在从合作院校收到基准佣金后七（7）个工作日内向乙方支付佣金返还。甲方应在收到基准佣金后向乙方提供书面通知，包括收到的金额和计算的返佣金额。
                    </div>
                </div>

                <div class="subsection">
                    <div class="subsection-title">5.2 Payment Method <span class="bilingual">支付方式</span></div>
                    <div class="clause">
                        Payment shall be made via bank transfer to the bank account designated by Party B in this
                        Agreement. All bank transfer fees and charges shall be borne by the respective paying party.
                        Party B shall ensure that the provided bank account information is accurate and current, and
                        shall promptly notify Party A in writing of any changes.
                    </div>
                    <div class="clause bilingual">
                        支付应通过银行转账至乙方在本协议中指定的银行账户。所有银行转账费用和手续费应由各自的支付方承担。乙方应确保提供的银行账户信息准确且最新，并应及时书面通知甲方任何变更。
                    </div>
                </div>

                <div class="subsection">
                    <div class="subsection-title">5.3 Payment Documentation <span class="bilingual">支付文件</span></div>
                    <div class="clause">
                        For each payment, Party A shall provide Party B with: (a) a commission statement detailing the
                        student name, institution, program, Base Commission amount, and rebate calculation; and (b) a
                        copy of the bank transfer confirmation. Party B shall issue a receipt or invoice (as applicable
                        under local tax laws) within seven (7) days of receiving payment.
                    </div>
                    <div class="clause bilingual">
                        对于每笔付款，甲方应向乙方提供：(a) 佣金对账单，详细说明学生姓名、院校、项目、基准佣金金额和返佣计算；(b)
                        银行转账确认副本。乙方应在收到付款后七（7）天内开具收据或发票（根据当地税法适用）。
                    </div>
                </div>

                <div class="subsection">
                    <div class="subsection-title">5.4 Tax Obligations <span class="bilingual">税务义务</span></div>
                    <div class="clause">
                        Each party shall be responsible for its own tax obligations arising from this Agreement. Party B
                        acknowledges that Party A shall not withhold any taxes from commission payments unless required
                        by applicable law. Party B shall indemnify and hold Party A harmless from any tax liabilities,
                        penalties, or interest arising from Party B's failure to comply with its tax obligations.
                    </div>
                    <div class="clause bilingual">
                        各方应对本协议产生的自身税务义务负责。乙方确认，除非适用法律要求，否则甲方不会从佣金支付中扣缴任何税款。乙方应赔偿并使甲方免受因乙方未履行税务义务而产生的任何税务责任、罚款或利息的损害。
                    </div>
                </div>

                <div class="subsection">
                    <div class="subsection-title">5.5 Quarterly Reconciliation <span class="bilingual">季度对账</span>
                    </div>
                    <div class="clause">
                        Party A shall provide Party B with a quarterly commission reconciliation statement within
                        fifteen (15) days after the end of each calendar quarter, summarizing all commission payments
                        made during that quarter. Party B shall review the statement and notify Party A in writing of
                        any discrepancies within thirty (30) days of receipt, failing which the statement shall be
                        deemed accepted.
                    </div>
                    <div class="clause bilingual">
                        甲方应在每个日历季度结束后十五（15）天内向乙方提供季度佣金对账单，汇总该季度内支付的所有佣金。乙方应审查对账单并在收到后三十（30）天内以书面形式通知甲方任何差异，否则该对账单应被视为已接受。
                    </div>
                </div>
            </div>
        </div>

        <!-- Article 6 -->
        <div class="article">
            <div class="article-title">Article 6: Risks, Force Majeure, and Non-Payment Scenarios 第六条：风险、不可抗力与不付款情形
            </div>
            <div class="article-content">
                <div class="subsection">
                    <div class="subsection-title">6.1 No Guarantee of Enrollment <span class="bilingual">不保证录取</span>
                    </div>
                    <div class="clause">
                        Party A does not guarantee that any student referred by Party B will be admitted to a Partner
                        Institution. Admission decisions are made solely by the Partner Institutions based on their own
                        criteria and policies. Party A shall use commercially reasonable efforts to assist students with
                        their applications but shall not be liable for any unsuccessful applications.
                    </div>
                    <div class="clause bilingual">
                        甲方不保证乙方推荐的任何学生将被合作院校录取。录取决定完全由合作院校根据其自身标准和政策作出。甲方应使用商业上合理的努力协助学生申请，但不对任何不成功的申请承担责任。
                    </div>
                </div>

                <div class="subsection">
                    <div class="subsection-title">6.2 Student Withdrawal and Refunds <span
                            class="bilingual">学生退学与退款</span></div>
                    <div class="clause">
                        If a student withdraws from a Partner Institution or is refunded tuition fees by the Partner
                        Institution for any reason, and the Partner Institution consequently claws back or demands
                        repayment of the Base Commission from Party A, then:<br>
                        (a) Party A shall promptly notify Party B of such clawback or demand;<br>
                        (b) Party B shall refund to Party A the full amount of the commission rebate previously paid to
                        Party B for that student within fourteen (14) days of Party A's written notice;<br>
                        (c) If Party B fails to refund within the specified period, Party A may offset the amount owed
                        against any future commission payments due to Party B under this Agreement or any other
                        agreement.
                    </div>
                    <div class="clause bilingual">
                        如学生因任何原因从合作院校退学或被合作院校退还学费，合作院校因此收回或要求甲方退还基准佣金，则：<br>
                        (a) 甲方应立即通知乙方此类收回或要求；<br>
                        (b) 乙方应在甲方书面通知后十四（14）天内向甲方退还之前为该学生支付给乙方的全部佣金返还金额；<br>
                        (c) 如乙方未能在规定期限内退款，甲方可将所欠金额从本协议或任何其他协议项下应付给乙方的任何未来佣金支付中抵消。
                    </div>
                </div>

                <div class="subsection">
                    <div class="subsection-title">6.3 Partner Institution Non-Payment <span
                            class="bilingual">合作院校不付款</span></div>
                    <div class="clause">
                        Party A's obligation to pay commission rebate to Party B is contingent upon Party A actually
                        receiving the Base Commission from the Partner Institution. In the event that a Partner
                        Institution fails to pay the Base Commission to Party A for any reason (including but not
                        limited to the Partner Institution's insolvency, breach of contract, or policy changes), Party A
                        shall not be obligated to pay any commission rebate to Party B for that student. Party A shall
                        use reasonable efforts to collect the Base Commission from the Partner Institution and shall
                        keep Party B informed of such collection efforts.
                    </div>
                    <div class="clause bilingual">
                        甲方向乙方支付佣金返还的义务取决于甲方实际从合作院校收到基准佣金。如合作院校因任何原因（包括但不限于合作院校破产、违约或政策变更）未能向甲方支付基准佣金，甲方对该学生无义务向乙方支付任何佣金返还。甲方应使用合理努力向合作院校收取基准佣金，并应使乙方了解此类收款努力。
                    </div>
                </div>

                <div class="subsection">
                    <div class="subsection-title">6.4 Force Majeure <span class="bilingual">不可抗力</span></div>
                    <div class="clause">
                        Neither party shall be liable for any failure or delay in performing its obligations under this
                        Agreement to the extent that such failure or delay is caused by circumstances beyond its
                        reasonable control, including but not limited to: acts of God, war, terrorism, civil unrest,
                        pandemics, government actions, strikes, natural disasters, or interruption of communication or
                        power supplies ("Force Majeure Event"). The affected party shall promptly notify the other party
                        of the Force Majeure Event and use reasonable efforts to mitigate its effects. If a Force
                        Majeure Event continues for more than sixty (60) days, either party may terminate this Agreement
                        upon written notice without liability, except for obligations that have already accrued.
                    </div>
                    <div class="clause bilingual">
                        任何一方均不对因其合理控制范围以外的情况导致其履行本协议义务的任何失败或延迟承担责任，包括但不限于：天灾、战争、恐怖主义、内乱、流行病、政府行为、罢工、自然灾害或通讯或电力供应中断（"不可抗力事件"）。受影响方应立即通知另一方不可抗力事件，并使用合理努力减轻其影响。如不可抗力事件持续超过六十（60）天，任何一方可通过书面通知终止本协议而不承担责任，但已产生的义务除外。
                    </div>
                </div>

                <div class="subsection">
                    <div class="subsection-title">6.5 Change in Commission Structure <span
                            class="bilingual">佣金结构变更</span></div>
                    <div class="clause">
                        If a Partner Institution changes its commission structure or reduces the Base Commission after a
                        student has been referred but before Successful Enrollment, Party A shall notify Party B of such
                        change. The commission rebate to Party B shall be calculated based on the actual Base Commission
                        received by Party A. Party A shall not be liable for any reduction in commission rebate due to
                        changes in the Partner Institution's commission policies.
                    </div>
                    <div class="clause bilingual">
                        如合作院校在学生被推荐后但在成功录取前更改其佣金结构或降低基准佣金，甲方应通知乙方此类变更。对乙方的佣金返还应根据甲方实际收到的基准佣金计算。甲方不对因合作院校佣金政策变更导致的任何佣金返还减少承担责任。
                    </div>
                </div>
            </div>
        </div>

        <!-- Article 7 -->
        <div class="article">
            <div class="article-title">Article 7: Confidentiality and Data Protection 第七条：保密与数据保护</div>
            <div class="article-content">
                <div class="subsection">
                    <div class="subsection-title">7.1 Confidential Information <span class="bilingual">保密信息</span>
                    </div>
                    <div class="clause">
                        "Confidential Information" means all non-public information disclosed by one party to the other
                        party, whether orally or in writing, that is designated as confidential or that reasonably
                        should be understood to be confidential given the nature of the information and the
                        circumstances of disclosure, including but not limited to: business plans, commission structures,
                        student information, financial information, and trade secrets.
                    </div>
                    <div class="clause bilingual">
                        "保密信息"是指一方向另一方披露的所有非公开信息，无论是口头还是书面，被指定为机密或根据信息的性质和披露情况合理应理解为机密的信息，包括但不限于：商业计划、佣金结构、学生信息、财务信息和商业秘密。
                    </div>
                </div>

                <div class="subsection">
                    <div class="subsection-title">7.2 Confidentiality Obligations <span class="bilingual">保密义务</span>
                    </div>
                    <div class="clause">
                        Each party agrees to:<br>
                        (a) Hold all Confidential Information of the other party in strict confidence;<br>
                        (b) Not disclose such Confidential Information to any third party without the prior written
                        consent of the other party, except as required by law or to professional advisors bound by
                        confidentiality obligations;<br>
                        (c) Use such Confidential Information solely for the purpose of performing its obligations and
                        exercising its rights under this Agreement;<br>
                        (d) Protect such Confidential Information using the same degree of care it uses to protect its
                        own confidential information, but in no event less than reasonable care.
                    </div>
                    <div class="clause bilingual">
                        各方同意：<br>
                        (a) 严格保密另一方的所有保密信息；<br>
                        (b) 未经另一方事先书面同意，不向任何第三方披露此类保密信息，但法律要求或向受保密义务约束的专业顾问披露的除外；<br>
                        (c) 仅为履行本协议项下义务和行使权利的目的使用此类保密信息；<br>
                        (d) 使用与保护其自身保密信息相同程度的注意保护此类保密信息，但无论如何不得低于合理注意。
                    </div>
                </div>

                <div class="subsection">
                    <div class="subsection-title">7.3 Personal Data Protection (PDPA Compliance) <span
                            class="bilingual">个人数据保护（PDPA合规）</span></div>
                    <div class="clause">
                        Both parties acknowledge that in the course of this cooperation, they may collect, use, and
                        disclose personal data of students and other individuals. Each party agrees to comply with all
                        applicable data protection laws and regulations, including Singapore's Personal Data Protection
                        Act 2012 (PDPA) and its amendments. In particular:<br>
                        (a) Personal data shall be collected only for purposes that a reasonable person would consider
                        appropriate in the circumstances and with the consent of the individual concerned;<br>
                        (b) Personal data shall be accurate, complete, and not misleading;<br>
                        (c) Personal data shall be protected by reasonable security arrangements against unauthorized
                        access, collection, use, disclosure, copying, modification, disposal, or similar risks;<br>
                        (d) Personal data shall not be retained longer than necessary for the fulfillment of the purpose
                        for which it was collected;<br>
                        (e) Each party shall promptly notify the other party of any data breach or unauthorized access
                        to personal data.
                    </div>
                    <div class="clause bilingual">
                        双方确认，在本合作过程中，他们可能会收集、使用和披露学生及其他个人的个人数据。各方同意遵守所有适用的数据保护法律法规，包括新加坡《2012年个人数据保护法》（PDPA）及其修正案。特别是：<br>
                        (a) 个人数据的收集应仅用于合理的人在该情况下认为适当的目的，并经相关个人同意；<br>
                        (b) 个人数据应准确、完整且不具误导性；<br>
                        (c) 个人数据应通过合理的安全安排防止未经授权的访问、收集、使用、披露、复制、修改、处置或类似风险；<br>
                        (d) 个人数据的保留时间不得超过其收集目的所需的时间；<br>
                        (e) 各方应立即通知另一方任何数据泄露或对个人数据的未经授权访问。
                    </div>
                </div>

                <div class="subsection">
                    <div class="subsection-title">7.4 Survival <span class="bilingual">存续</span></div>
                    <div class="clause">
                        The obligations under this Article 7 shall survive the termination or expiration of this
                        Agreement for a period of five (5) years.
                    </div>
                    <div class="clause bilingual">
                        本第七条项下的义务应在本协议终止或到期后存续五（5）年。
                    </div>
                </div>
            </div>
        </div>

        <!-- Article 8 -->
        <div class="article">
            <div class="article-title">Article 8: Term and Termination 第八条：期限与终止</div>
            <div class="article-content">
                <div class="subsection">
                    <div class="subsection-title">8.1 Initial Term <span class="bilingual">初始期限</span></div>
                    <div class="clause">
                        This Agreement shall commence on the date of execution by both parties (the "Effective Date")
                        and shall continue for an initial period of one (1) year, unless earlier terminated in
                        accordance with this Article 8.
                    </div>
                    <div class="clause bilingual">
                        本协议应自双方签署之日（"生效日期"）开始，初始期限为一（1）年，除非根据本第八条提前终止。
                    </div>
                </div>

                <div class="subsection">
                    <div class="subsection-title">8.2 Renewal <span class="bilingual">续期</span></div>
                    <div class="clause">
                        Upon expiration of the initial term, this Agreement shall automatically renew for successive
                        one-year periods unless either party provides written notice of non-renewal to the other party
                        at least thirty (30) days prior to the end of the then-current term.
                    </div>
                    <div class="clause bilingual">
                        初始期限到期后，本协议应自动续期一年，除非任何一方在当前期限结束前至少三十（30）天向另一方提供不续期的书面通知。
                    </div>
                </div>

                <div class="subsection">
                    <div class="subsection-title">8.3 Termination for Convenience <span class="bilingual">便利终止</span>
                    </div>
                    <div class="clause">
                        Either party may terminate this Agreement for any reason or no reason upon sixty (60) days'
                        prior written notice to the other party.
                    </div>
                    <div class="clause bilingual">
                        任何一方可因任何原因或无理由，在向另一方提前六十（60）天书面通知后终止本协议。
                    </div>
                </div>

                <div class="subsection">
                    <div class="subsection-title">8.4 Termination for Cause <span class="bilingual">因故终止</span></div>
                    <div class="clause">
                        Either party may terminate this Agreement immediately upon written notice if:<br>
                        (a) The other party commits a material breach of this Agreement and fails to cure such breach
                        within thirty (30) days after receiving written notice specifying the breach;<br>
                        (b) The other party becomes insolvent, files for bankruptcy, or has a receiver or liquidator
                        appointed;<br>
                        (c) The other party engages in any fraudulent, illegal, or unethical conduct in connection with
                        this Agreement;<br>
                        (d) The other party's business license or operating permit is revoked or suspended.
                    </div>
                    <div class="clause bilingual">
                        任何一方可在以下情况下立即通过书面通知终止本协议：<br>
                        (a) 另一方严重违反本协议，并在收到说明违约的书面通知后三十（30）天内未能纠正此类违约；<br>
                        (b) 另一方破产、申请破产或被指定接管人或清算人；<br>
                        (c) 另一方在本协议相关事项中从事任何欺诈、非法或不道德行为；<br>
                        (d) 另一方的营业执照或经营许可被吊销或暂停。
                    </div>
                </div>

                <div class="subsection">
                    <div class="subsection-title">8.5 Effect of Termination <span class="bilingual">终止的效力</span>
                    </div>
                    <div class="clause">
                        Upon termination or expiration of this Agreement:<br>
                        (a) Party B shall immediately cease representing itself as an agent or partner of Party A;<br>
                        (b) All commission payment obligations for students who achieved Successful Enrollment prior to
                        the termination date shall survive and remain in full force and effect;<br>
                        (c) Students who were registered with Party A prior to the termination date but have not yet
                        achieved Successful Enrollment shall continue to be attributed to Party B, and commission
                        payments shall be made in accordance with this Agreement upon their Successful Enrollment,
                        provided such enrollment occurs within twelve (12) months of the termination date;<br>
                        (d) Each party shall return or destroy all Confidential Information of the other party in its
                        possession;<br>
                        (e) Articles 5 (Settlement and Payment), 6 (Risks and Non-Payment), 7 (Confidentiality), 9
                        (Applicable Law and Dispute Resolution), and 10 (Miscellaneous) shall survive termination.
                    </div>
                    <div class="clause bilingual">
                        本协议终止或到期后：<br>
                        (a) 乙方应立即停止将自己代表为甲方的代理或合作伙伴；<br>
                        (b) 终止日期前实现成功录取的学生的所有佣金支付义务应存续并保持完全效力；<br>
                        (c) 终止日期前向甲方登记但尚未实现成功录取的学生应继续归属于乙方，并在其成功录取后根据本协议支付佣金，前提是此类录取发生在终止日期后十二（12）个月内；<br>
                        (d) 各方应返还或销毁其拥有的另一方的所有保密信息；<br>
                        (e) 第五条（结算与支付）、第六条（风险与不付款）、第七条（保密）、第九条（适用法律与争议解决）和第十条（杂项）应在终止后存续。
                    </div>
                </div>
            </div>
        </div>

        <!-- Article 9 -->
        <div class="article">
            <div class="article-title">Article 9: Nature of Relationship and Applicable Law 第九条：关系性质与适用法律</div>
            <div class="article-content">
                <div class="subsection">
                    <div class="subsection-title">9.1 Independent Contractors <span class="bilingual">独立承包商</span>
                    </div>
                    <div class="clause">
                        The parties are independent contractors. Nothing in this Agreement shall be construed to create
                        a partnership, joint venture, agency, employment, or fiduciary relationship between the parties.
                        Neither party has any authority to bind the other party or to incur any obligation on behalf of
                        the other party without the prior written consent of the other party.
                    </div>
                    <div class="clause bilingual">
                        双方为独立承包商。本协议中的任何内容均不得被解释为在双方之间建立合伙、合资、代理、雇佣或信托关系。任何一方均无权约束另一方或未经另一方事先书面同意代表另一方承担任何义务。
                    </div>
                </div>

                <div class="subsection">
                    <div class="subsection-title">9.2 No Exclusivity <span class="bilingual">非排他性</span></div>
                    <div class="clause">
                        This Agreement is non-exclusive. Both parties are free to enter into similar agreements with
                        other parties and to conduct business with other parties without restriction, provided that such
                        activities do not breach the terms of this Agreement.
                    </div>
                    <div class="clause bilingual">
                        本协议为非排他性。双方可自由与其他方签订类似协议并与其他方开展业务而不受限制，前提是此类活动不违反本协议的条款。
                    </div>
                </div>

                <div class="subsection">
                    <div class="subsection-title">9.3 Governing Law <span class="bilingual">适用法律</span></div>
                    <div class="clause">
                        This Agreement shall be governed by and construed in accordance with the laws of the Republic of
                        Singapore, without regard to its conflict of law provisions.
                    </div>
                    <div class="clause bilingual">
                        本协议应受新加坡共和国法律管辖并根据其解释，不考虑其法律冲突条款。
                    </div>
                </div>

                <div class="subsection">
                    <div class="subsection-title">9.4 Dispute Resolution <span class="bilingual">争议解决</span></div>
                    <div class="clause">
                        (a) <strong>Negotiation:</strong> In the event of any dispute, controversy, or claim arising out
                        of or relating to this Agreement or the breach, termination, or invalidity thereof, the parties
                        shall first attempt to resolve the matter through good faith negotiations for a period of thirty
                        (30) days.<br>
                        (b) <strong>Mediation:</strong> If the dispute cannot be resolved through negotiation, the
                        parties shall attempt to resolve it through mediation administered by the Singapore Mediation
                        Centre in accordance with its mediation rules then in effect.<br>
                        (c) <strong>Arbitration:</strong> If the dispute cannot be resolved through mediation within
                        sixty (60) days of the commencement of mediation, it shall be referred to and finally resolved
                        by arbitration administered by the Singapore International Arbitration Centre (SIAC) in
                        accordance with the Arbitration Rules of SIAC for the time being in force. The seat of
                        arbitration shall be Singapore. The language of arbitration shall be English. The arbitral
                        tribunal shall consist of one (1) arbitrator to be appointed by mutual agreement of the parties,
                        or failing such agreement within thirty (30) days, to be appointed by the President of SIAC.
                    </div>
                    <div class="clause bilingual">
                        (a) <strong>协商：</strong>
                        如因本协议或其违反、终止或无效而产生任何争议、争论或索赔，双方应首先尝试通过善意协商在三十（30）天内解决问题。<br>
                        (b) <strong>调解：</strong> 如争议无法通过协商解决，双方应尝试通过新加坡调解中心根据其当时有效的调解规则进行调解来解决。<br>
                        (c) <strong>仲裁：</strong>
                        如争议在调解开始后六十（60）天内无法通过调解解决，应提交新加坡国际仲裁中心（SIAC）并根据SIAC当时有效的仲裁规则最终通过仲裁解决。仲裁地为新加坡。仲裁语言为英语。仲裁庭应由双方相互同意任命一（1）名仲裁员组成，如在三十（30）天内未能达成此类协议，则由SIAC主席任命。
                    </div>
                </div>

                <div class="subsection">
                    <div class="subsection-title">9.5 Costs of Dispute Resolution <span class="bilingual">争议解决费用</span>
                    </div>
                    <div class="clause">
                        Each party shall bear its own costs of negotiation and mediation. The costs of arbitration
                        (including arbitrator's fees and administrative fees) shall be borne equally by the parties,
                        unless the arbitral tribunal determines otherwise. Each party shall bear its own legal fees and
                        expenses unless the arbitral tribunal awards costs to the prevailing party.
                    </div>
                    <div class="clause bilingual">
                        各方应承担自己的协商和调解费用。仲裁费用（包括仲裁员费用和管理费用）应由双方平均承担，除非仲裁庭另有决定。各方应承担自己的法律费用和支出，除非仲裁庭将费用判给胜诉方。
                    </div>
                </div>
            </div>
        </div>

        <!-- Article 10 -->
        <div class="article">
            <div class="article-title">Article 10: Miscellaneous 第十条：杂项</div>
            <div class="article-content">
                <div class="subsection">
                    <div class="subsection-title">10.1 Entire Agreement <span class="bilingual">完整协议</span></div>
                    <div class="clause">
                        This Agreement, including all appendices and attachments, constitutes the entire agreement
                        between the parties with respect to the subject matter hereof and supersedes all prior and
                        contemporaneous agreements, understandings, negotiations, and discussions, whether oral or
                        written, between the parties.
                    </div>
                    <div class="clause bilingual">
                        本协议（包括所有附录和附件）构成双方就其主题事项的完整协议，并取代双方之间所有先前和同时期的协议、理解、谈判和讨论，无论是口头还是书面。
                    </div>
                </div>

                <div class="subsection">
                    <div class="subsection-title">10.2 Amendments <span class="bilingual">修订</span></div>
                    <div class="clause">
                        No amendment, modification, or waiver of any provision of this Agreement shall be effective
                        unless in writing and signed by both parties. No waiver of any breach of this Agreement shall
                        constitute a waiver of any other or subsequent breach.
                    </div>
                    <div class="clause bilingual">
                        本协议任何条款的修订、修改或放弃均应以书面形式并由双方签署方为有效。对本协议任何违约的放弃不构成对任何其他或后续违约的放弃。
                    </div>
                </div>

                <div class="subsection">
                    <div class="subsection-title">10.3 Assignment <span class="bilingual">转让</span></div>
                    <div class="clause">
                        Neither party may assign or transfer this Agreement or any rights or obligations hereunder
                        without the prior written consent of the other party, except that Party A may assign this
                        Agreement to any successor entity in connection with a merger, acquisition, or sale of
                        substantially all of its assets. Any attempted assignment in violation of this provision shall
                        be null and void.
                    </div>
                    <div class="clause bilingual">
                        未经另一方事先书面同意，任何一方不得转让或转移本协议或其项下的任何权利或义务，但甲方可在并购或出售其几乎全部资产时将本协议转让给任何继承实体。违反本条款的任何试图转让均应无效。
                    </div>
                </div>

                <div class="subsection">
                    <div class="subsection-title">10.4 Notices <span class="bilingual">通知</span></div>
                    <div class="clause">
                        All notices, requests, consents, claims, demands, waivers, and other communications under this
                        Agreement shall be in writing and shall be deemed to have been given: (a) when delivered by hand
                        (with written confirmation of receipt); (b) when received by the addressee if sent by a
                        nationally recognized overnight courier (receipt requested); (c) on the date sent by email (with
                        confirmation of transmission) if sent during normal business hours of the recipient, and on the
                        next business day if sent after normal business hours of the recipient; or (d) on the third day
                        after the date mailed, by certified or registered mail, return receipt requested, postage
                        prepaid. Notices shall be sent to the addresses and email addresses specified in this Agreement
                        or to such other address as either party may designate in writing.
                    </div>
                    <div class="clause bilingual">
                        本协议项下的所有通知、请求、同意、索赔、要求、放弃和其他通信均应以书面形式，并应被视为已送达：(a) 手递时（附书面收据确认）；(b)
                        如通过全国认可的隔夜快递发送，收件人收到时（要求收据）；(c)
                        如在收件人正常营业时间内通过电子邮件发送（附传输确认），则在发送当日；如在收件人正常营业时间外发送，则在下一个工作日；或 (d)
                        通过挂号或注册邮件（要求回执、邮资预付）邮寄后的第三天。通知应发送至本协议中指定的地址和电子邮件地址，或任何一方以书面形式指定的其他地址。
                    </div>
                </div>

                <div class="subsection">
                    <div class="subsection-title">10.5 Severability <span class="bilingual">可分割性</span></div>
                    <div class="clause">
                        If any provision of this Agreement is held to be invalid, illegal, or unenforceable by a court
                        of competent jurisdiction, the remaining provisions shall continue in full force and effect. The
                        parties shall endeavor to replace any invalid, illegal, or unenforceable provision with a valid
                        provision that achieves the original intent and economic effect to the greatest extent possible.
                    </div>
                    <div class="clause bilingual">
                        如本协议的任何条款被有管辖权的法院认定为无效、非法或不可执行，其余条款应继续完全有效。双方应努力用能在最大程度上实现原始意图和经济效果的有效条款替换任何无效、非法或不可执行的条款。
                    </div>
                </div>

                <div class="subsection">
                    <div class="subsection-title">10.6 Counterparts <span class="bilingual">副本</span></div>
                    <div class="clause">
                        This Agreement may be executed in counterparts, each of which shall be deemed an original, but
                        all of which together shall constitute one and the same instrument. Execution and delivery of
                        this Agreement by exchange of scanned copies via email or other electronic means shall be deemed
                        as valid as physical exchange of original executed copies.
                    </div>
                    <div class="clause bilingual">
                        本协议可以一式多份签署，每份均应被视为正本，但所有份数合在一起应构成同一文书。通过电子邮件或其他电子方式交换扫描副本签署和交付本协议应被视为与实际交换原始签署副本同样有效。
                    </div>
                </div>

                <div class="subsection">
                    <div class="subsection-title">10.7 Language <span class="bilingual">语言</span></div>
                    <div class="clause">
                        This Agreement is executed in both English and Chinese. In the event of any inconsistency
                        between the English and Chinese versions, the English version shall prevail.
                    </div>
                    <div class="clause bilingual">
                        本协议以英文和中文签署。如英文版本和中文版本之间存在任何不一致，应以英文版本为准。
                    </div>
                </div>
            </div>
        </div>

        <!-- Signature Section -->
        <div class="signature-section">
            <p style="font-weight: 600; margin-bottom: 15px;">
                IN WITNESS WHEREOF, the parties have executed this Agreement as of the date first written above.<br>
                <span class="bilingual">特此为证，双方已于上述日期签署本协议。</span>
            </p>

            <div class="signature-block">
                <div class="party-title">Party A (甲方): Maple Education Pte. Ltd.</div>
                <div class="signature-row">
                    <div class="signature-label">Authorized Signatory 授权签署人:</div>
                    <div class="signature-value"></div>
                </div>
                <div class="signature-row">
                    <div class="signature-label">Name 姓名:</div>
                    <div class="signature-value">Leonard Chow Yi Ding</div>
                </div>
                <div class="signature-row">
                    <div class="signature-label">Title 职务:</div>
                    <div class="signature-value">Director</div>
                </div>
                <div class="signature-row">
                    <div class="signature-label">Date 日期:</div>
                    <div class="signature-value"></div>
                </div>
                <div class="signature-row">
                    <div class="signature-label">Company Stamp 公司印章:</div>
                    <div class="signature-value" style="min-height: 60px;"></div>
                </div>
            </div>

            <div class="signature-block">
                <div class="party-title">Party B (乙方):</div>
                <div class="signature-row">
                    <div class="signature-label">Authorized Signatory 授权签署人:</div>
                    <div class="signature-value"></div>
                </div>
                <div class="signature-row">
                    <div class="signature-label">Name 姓名:</div>
                    <div class="signature-value"></div>
                </div>
                <div class="signature-row">
                    <div class="signature-label">Title/Capacity 职务/身份:</div>
                    <div class="signature-value"></div>
                </div>
                <div class="signature-row">
                    <div class="signature-label">Date 日期:</div>
                    <div class="signature-value"></div>
                </div>
                <div class="signature-row">
                    <div class="signature-label">Company Stamp (if applicable) 公司印章（如适用）:</div>
                    <div class="signature-value" style="min-height: 60px;"></div>
                </div>
            </div>
        </div>

        <div style="margin-top: 30px; font-size: 8pt; color: #666; text-align: center;">
            This agreement is for use by Maple Education Pte. Ltd. and its authorized partners only.<br>
            本协议仅供Maple Education Pte. Ltd.及其授权合作伙伴使用。
        </div>

        <div style="margin-top: 20px; page-break-before: always;">
            <div class="party-title" style="text-align: center; font-size: 12pt;">Appendices 附录</div>
            <p style="margin-top: 15px;">
                <strong>Appendix A:</strong> Commission List 佣金清单<br>
                <strong>Appendix B:</strong> Student Information Collection Form 学生信息收集表
            </p>
            <p style="font-size: 8pt; color: #666; margin-top: 10px;">
                Note: Appendices shall be provided separately and form an integral part of this Agreement.<br>
                注：附录应单独提供，并构成本协议的组成部分。
            </p>
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
