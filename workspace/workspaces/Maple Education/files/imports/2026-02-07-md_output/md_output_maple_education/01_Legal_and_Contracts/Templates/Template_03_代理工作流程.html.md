---
title: "Template_03_代理工作流程.html"
source_path: "01_Legal_and_Contracts/Templates/Template_03_代理工作流程.html"
tags: ["合同", "流程", "html"]
ocr: false
---

# Template_03_代理工作流程.html

简介：SOP/流程文档，说明操作步骤与规范。

## 内容

```text
<!DOCTYPE html>
<html lang="en">

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Standard Procedure for Agent Cooperation - 代理合作标准流程</title>
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
            padding: 0 20mm;
            z-index: 5;
            font-size: 9.5pt;
            line-height: 1.6;
        }

        .main-title {
            text-align: center;
            font-size: 18pt;
            font-weight: 700;
            color: #2c5aa0;
            margin-bottom: 8px;
        }

        .main-subtitle {
            text-align: center;
            font-size: 16pt;
            font-weight: 600;
            color: #666;
            margin-bottom: 25px;
        }

        .section {
            margin-bottom: 20px;
            page-break-inside: avoid;
        }

        .section-title {
            font-weight: 700;
            font-size: 11pt;
            color: #2c5aa0;
            margin-bottom: 10px;
            border-bottom: 2px solid #2c5aa0;
            padding-bottom: 4px;
        }

        .section-title-cn {
            font-weight: 700;
            font-size: 10pt;
            color: #666;
            margin-bottom: 12px;
        }

        .procedure-item {
            margin-bottom: 12px;
        }

        .procedure-item-en {
            margin-bottom: 5px;
            line-height: 1.7;
        }

        .procedure-item-cn {
            color: #666;
            line-height: 1.7;
            margin-bottom: 8px;
        }

        .item-number {
            font-weight: 600;
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
    <img src="../../04_Brand_Assets/Brand_Logo_Main.jpg" class="watermark" alt="Watermark">

    <!-- Header -->
    <div class="header">
        <img src="../../04_Brand_Assets/Brand_Logo_Main.jpg" class="logo" alt="Logo">
        <div class="header-content">
            <div class="document-title">PROCEDURE</div>
            <div class="company-name">Maple Education Pte. Ltd. &nbsp;|&nbsp; 新加坡枫叶留学</div>
            <div class="divider"></div>
        </div>
    </div>

    <!-- Content -->
    <div class="content">
        <div class="main-title">Standard Procedure for Agent Cooperation</div>
        <div class="main-subtitle">代理合作标准流程</div>

        <!-- Section I -->
        <div class="section">
            <div class="section-title">I. Lead Registration</div>
            <div class="section-title-cn">一、线索登记</div>

            <div class="procedure-item">
                <div class="procedure-item-en">
                    <span class="item-number">1.</span> Upon receiving a prospective student, Party B shall register
                    the lead through Party A's designated channel (system/email) within 24 hours. The registration shall
                    include: name, contact information, intended country/major, highest academic qualification, academic
                    results, and passport/ID number (if available).
                </div>
                <div class="procedure-item-cn">
                    <span class="item-number">1.</span>
                    乙方收到意向学生后，24小时内通过甲方指定渠道登记（系统/邮件），包含：姓名、联系方式、意向国家/专业、最高学历、成绩、护照/身份证号（如有）。
                </div>
            </div>

            <div class="procedure-item">
                <div class="procedure-item-en">
                    <span class="item-number">2.</span> If the same student is submitted through multiple channels, the
                    one whose registration time is first confirmed by Party A shall prevail.
                </div>
                <div class="procedure-item-cn">
                    <span class="item-number">2.</span> 同一学生如多渠道递交，以甲方先确认登记时间为准。
                </div>
            </div>
        </div>

        <!-- Section II -->
        <div class="section">
            <div class="section-title">II. Document Preparation</div>
            <div class="section-title-cn">二、材料准备</div>

            <div class="procedure-item">
                <div class="procedure-item-en">
                    <span class="item-number">1.</span> Party B shall collect from the student and conduct a preliminary
                    review of documents including: passport, academic transcripts, graduation certificate/certificate of
                    enrollment, language proficiency scores, personal statement/recommendation letters, etc.
                </div>
                <div class="procedure-item-cn">
                    <span class="item-number">1.</span>
                    乙方向学生收集并初审：护照、成绩单、毕业证/在读证明、语言成绩、个人陈述/推荐信等。
                </div>
            </div>

            <div class="procedure-item">
                <div class="procedure-item-en">
                    <span class="item-number">2.</span> Party B shall send a checklist of required documents and a list
                    of missing items to Party A/the student; Party A shall provide templates (for PS/RL) and formatting
                    guidelines.
                </div>
                <div class="procedure-item-cn">
                    <span class="item-number">2.</span> 乙方将材料清单与缺失项发给甲方/学生；甲方提供模板（PS/RL）与格式指引。
                </div>
            </div>
        </div>

        <!-- Section III -->
        <div class="section">
            <div class="section-title">III. Submission and Follow-up</div>
            <div class="section-title-cn">三、递交与跟进</div>

            <div class="procedure-item">
                <div class="procedure-item-en">
                    <span class="item-number">1.</span> Party B shall submit the complete package of documents to Party
                    A's designated email/system; Party A shall complete the final review and submit the application to
                    the institution.
                </div>
                <div class="procedure-item-cn">
                    <span class="item-number">1.</span> 乙方将材料打包提交给甲方指定邮箱/系统；甲方完成最终审核与院校递交。
                </div>
            </div>

            <div class="procedure-item">
                <div class="procedure-item-en">
                    <span class="item-number">2.</span> Party A shall update the application status (submitted,
                    supplementary documents required, interview, offer) and synchronize it with Party B; Party B shall
                    be responsible for communicating with and coordinating the student.
                </div>
                <div class="procedure-item-cn">
                    <span class="item-number">2.</span>
                    甲方更新申请状态（递交、补件、面试、录取）并同步给乙方；乙方负责学生沟通与配合。
                </div>
            </div>
        </div>

        <!-- Section IV -->
        <div class="section">
            <div class="section-title">IV. Offer and Enrollment</div>
            <div class="section-title-cn">四、录取与注册</div>

            <div class="procedure-item">
                <div class="procedure-item-en">
                    <span class="item-number">1.</span> Party A shall obtain the Offer/Admission Notice and send it to
                    Party B/the student, while also providing instructions for enrollment and payment.
                </div>
                <div class="procedure-item-cn">
                    <span class="item-number">1.</span> 甲方获取Offer/录取通知，发送乙方/学生；同步注册缴费指引。
                </div>
            </div>

            <div class="procedure-item">
                <div class="procedure-item-en">
                    <span class="item-number">2.</span> Party B shall assist the student in completing enrollment,
                    payment, and visa/matriculation procedures on time; Party A shall be responsible for liaising with
                    and confirming with the institution.
                </div>
                <div class="procedure-item-cn">
                    <span class="item-number">2.</span> 乙方协助学生按时完成注册、缴费、签证/入学手续；甲方负责与院校对接确认。
                </div>
            </div>
        </div>

        <!-- Section V -->
        <div class="section">
            <div class="section-title">V. Commission and Settlement</div>
            <div class="section-title-cn">五、佣金与结算</div>

            <div class="procedure-item">
                <div class="procedure-item-en">
                    <span class="item-number">1.</span> After Party A receives the commission from the institution,
                    Party A shall settle the payment with Party B within 7 calendar days according to the percentage
                    stipulated in the agreement (Base Commission × 70%). The currency and exchange rate shall be as
                    agreed in the agreement.
                </div>
                <div class="procedure-item-cn">
                    <span class="item-number">1.</span>
                    院校支付佣金至甲方后，甲方在7个自然日内按协议比例向乙方结算（基准佣金×70%），币种/汇率按协议约定。
                </div>
            </div>

            <div class="procedure-item">
                <div class="procedure-item-en">
                    <span class="item-number">2.</span> Party B shall provide accurate payment information (account
                    holder's name, account number, bank name, SWIFT code, currency). Party A shall bear the bank charges
                    on the Singapore end, while any cross-border and/or receiving bank charges shall be borne by Party
                    B.
                </div>
                <div class="procedure-item-cn">
                    <span class="item-number">2.</span>
                    乙方提供准确收款信息（户名、账号、银行、SWIFT、币种）；甲方承担新加坡端手续费，跨境/收款行手续费由乙方承担。
                </div>
            </div>

            <div class="procedure-item">
                <div class="procedure-item-en">
                    <span class="item-number">3.</span> If the upstream commission is paid in installments, settlement
                    shall be made separately for each installment based on the base commission received.
                </div>
                <div class="procedure-item-cn">
                    <span class="item-number">3.</span> 如上游佣金分期，按各期到账基准佣金分别结算。
                </div>
            </div>
        </div>

        <!-- Section VI -->
        <div class="section">
            <div class="section-title">VI. Risks and Special Circumstances</div>
            <div class="section-title-cn">六、风险与特别情况</div>

            <div class="procedure-item">
                <div class="procedure-item-en">
                    <span class="item-number">1.</span> If a student withdraws or fails to enroll within one (1) month
                    after the course commencement date, resulting in the non-payment of commission from the upstream
                    (institution), Party A shall have no obligation to pay the commission for said student to Party B.
                </div>
                <div class="procedure-item-cn">
                    <span class="item-number">1.</span> 学生在入学后1个月内退学/未注册导致上游未付佣金，甲方无义务向乙方支付该学生返佣。
                </div>
            </div>

            <div class="procedure-item">
                <div class="procedure-item-en">
                    <span class="item-number">2.</span> If the institution fails to pay or underpays the commission due
                    to policy or operational reasons, Party A shall only settle the payment to the extent of the amount
                    actually received and shall assist Party B in pursuing the outstanding payment (without guaranteeing
                    the outcome).
                </div>
                <div class="procedure-item-cn">
                    <span class="item-number">2.</span>
                    若院校因政策/经营原因未付或少付佣金，甲方仅在实际到账范围内结算，并协助乙方追讨（不承诺结果）。
                </div>
            </div>
        </div>

        <!-- Section VII -->
        <div class="section">
            <div class="section-title">VII. Data and Confidentiality</div>
            <div class="section-title-cn">七、数据与保密</div>

            <div class="procedure-item">
                <div class="procedure-item-en">
                    <span class="item-number">1.</span> Both parties undertake confidentiality obligations regarding
                    student information, commission policies, and commercial terms.
                </div>
                <div class="procedure-item-cn">
                    <span class="item-number">1.</span> 双方对学生信息、佣金政策、商业条款承担保密义务。
                </div>
            </div>

            <div class="procedure-item">
                <div class="procedure-item-en">
                    <span class="item-number">2.</span> Data processing shall comply with applicable laws (including
                    Singapore's PDPA) and shall be limited to the reasonable necessities of the cooperation.
                </div>
                <div class="procedure-item-cn">
                    <span class="item-number">2.</span> 数据处理遵守适用法律（含新加坡PDPA）；仅限合作之合理需要。
                </div>
            </div>
        </div>

        <!-- Section VIII -->
        <div class="section">
            <div class="section-title">VIII. Ledger and Reconciliation</div>
            <div class="section-title-cn">八、台账与交付</div>

            <div class="procedure-item">
                <div class="procedure-item-en">
                    <span class="item-number">1.</span> Party B shall maintain a student ledger (including leads,
                    milestones, admission/enrollment status, and commission status); Party A shall synchronize records
                    of commission received and settlements made.
                </div>
                <div class="procedure-item-cn">
                    <span class="item-number">1.</span>
                    乙方维护学生台账（线索、节点、录取/就读状态、返佣状态）；甲方同步佣金到账和结算记录。
                </div>
            </div>

            <div class="procedure-item">
                <div class="procedure-item-en">
                    <span class="item-number">2.</span> It is recommended to reconcile accounts once a month. Any
                    discrepancies should be communicated and confirmed within 3 days.
                </div>
                <div class="procedure-item-cn">
                    <span class="item-number">2.</span> 建议每月对账一次，异常3日内沟通确认。
                </div>
            </div>
        </div>

        <div style="margin-top: 30px; font-size: 8pt; color: #666; text-align: center;">
            This procedure document is for use by Maple Education Pte. Ltd. and its authorized partners only.<br>
            本流程文件仅供Maple Education Pte. Ltd.及其授权合作伙伴使用。
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
