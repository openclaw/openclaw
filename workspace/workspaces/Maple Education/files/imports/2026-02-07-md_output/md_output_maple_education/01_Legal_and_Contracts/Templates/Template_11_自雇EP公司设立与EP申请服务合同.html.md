---
title: "Template_11_自雇EP公司设立与EP申请服务合同.html"
source_path: "01_Legal_and_Contracts/Templates/Template_11_自雇EP公司设立与EP申请服务合同.html"
tags: ["合同", "服务", "html"]
ocr: false
---

# Template_11_自雇EP公司设立与EP申请服务合同.html

简介：合同/协议类文件，包含条款、费用、责任与流程说明。

## 内容

```text
<!DOCTYPE html>
<html lang="en">

<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Self-Employed EP & Company Setup Service Agreement - 自雇EP与公司设立服务合同</title>
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
    }

    .watermark {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      opacity: 0.05;
      max-width: 600px;
      z-index: 1;
      pointer-events: none;
    }

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
      border-bottom: 1px solid #333;
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
      border-top: 1px solid #ccc;
    }

    .footer span {
      margin: 0 5px;
    }

    .content {
      margin-top: 45mm;
      margin-bottom: 20mm;
      padding: 0 20mm;
      z-index: 5;
      font-size: 9pt;
      line-height: 1.6;
      color: #111;
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
      font-size: 15pt;
      font-weight: 600;
      color: #666;
      margin-bottom: 18px;
    }

    .meta-line {
      display: flex;
      justify-content: center;
      gap: 18px;
      font-size: 9pt;
      color: #444;
      margin-bottom: 12px;
      flex-wrap: wrap;
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
      gap: 10px;
    }

    .info-label {
      width: 40%;
      font-weight: 600;
      color: #333;
    }

    .info-value {
      width: 60%;
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
      padding: 6px 6px;
      vertical-align: top;
    }

    table th {
      background-color: #f0f0f0;
      font-weight: 700;
    }

    .signature-section {
      margin-top: 22px;
      page-break-inside: avoid;
    }

    .signature-block {
      margin-bottom: 18px;
      border: 1px solid #ccc;
      padding: 12px;
      page-break-inside: avoid;
    }

    .signature-row {
      display: flex;
      margin-bottom: 10px;
      gap: 10px;
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

    .page-break {
      page-break-after: always;
    }
  </style>
</head>

<body>

  <!-- Watermark -->
  <img src="../../04_Brand_Assets/01_Logo/Logo_MapleEducation_Main.png" class="watermark" alt="Watermark">

  <!-- Header -->
  <div class="header">
    <img src="../../04_Brand_Assets/01_Logo/Logo_MapleEducation_Main.png" class="logo" alt="Logo">
    <div class="header-content">
      <div class="document-title">SERVICE</div>
      <div class="company-name">Maple Education Pte. Ltd. &nbsp;|&nbsp; 新加坡枫叶留学</div>
      <div class="divider"></div>
    </div>
  </div>

  <!-- Footer -->
  <div class="footer">
    <span>Email: Maple@maplesgedu.com</span> |
    <span>Website: maplesgedu.com</span> |
    <span>SG: +65 8686 3695</span>
  </div>

  <!-- Content -->
  <div class="content">
    <div class="contract-title">Self‑Employed EP & Company Setup Service Agreement</div>
    <div class="contract-subtitle">自雇 EP 与公司设立服务合同</div>

    <div class="meta-line">
      <div><strong>Contract No.</strong> 合同编号：____________________</div>
      <div><strong>Date</strong> 日期：______/______/______</div>
    </div>

    <!-- Party A (Client) -->
    <div class="party-section">
      <div class="party-title">Party A (Client) 甲方（客户/委托人）</div>
      <div class="info-row">
        <div class="info-label">Full Name 姓名:</div>
        <div class="info-value"></div>
      </div>
      <div class="info-row">
        <div class="info-label">Nationality 国籍:</div>
        <div class="info-value"></div>
      </div>
      <div class="info-row">
        <div class="info-label">Passport/ID No. 证件号:</div>
        <div class="info-value"></div>
      </div>
      <div class="info-row">
        <div class="info-label">Address 地址:</div>
        <div class="info-value"></div>
      </div>
      <div class="info-row">
        <div class="info-label">Phone 电话:</div>
        <div class="info-value"></div>
      </div>
      <div class="info-row">
        <div class="info-label">Email 邮箱:</div>
        <div class="info-value"></div>
      </div>
      <div class="info-row">
        <div class="info-label">WeChat/WhatsApp 微信/WhatsApp:</div>
        <div class="info-value"></div>
      </div>
    </div>

    <!-- Party B (Service Provider) -->
    <div class="party-section">
      <div class="party-title">Party B (Service Provider) 乙方（服务提供方）</div>
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
        <div class="info-label">Email 电子邮箱:</div>
        <div class="info-value">Maple@maplesgedu.com</div>
      </div>
      <div class="info-row">
        <div class="info-label">Phone 电话:</div>
        <div class="info-value">+65 8686 3695</div>
      </div>
    </div>

    <p style="margin: 12px 0; line-height: 1.8;">
      WHEREAS Party A wishes to obtain structured assistance for Singapore company incorporation and a self‑employed
      Employment Pass ("EP") application; and Party B provides consulting, document coordination and project management
      support on a best‑efforts basis. The parties hereby agree as follows.
    </p>
    <p style="margin: 12px 0; line-height: 1.8;" class="bilingual">
      鉴于甲方希望获得新加坡公司设立及自雇 Employment Pass（“EP”）申请的整体协助；乙方提供咨询、材料统筹与项目管理支持（尽最大努力但不作结果承诺）。双方达成如下协议。
    </p>

    <!-- Article 1 -->
    <div class="article">
      <div class="article-title">Article 1: Definitions 第一条：定义</div>
      <div class="article-content">
        <div class="subsection">
          <div class="subsection-title">1.1 Authorities & Decisions <span class="bilingual">主管部门与决定</span></div>
          <div class="clause">
            "Authorities" refers to relevant Singapore government bodies (including ACRA, MOM, ICA, IRAS and banks, as
            applicable). Any approvals, registrations, pass issuance, renewals or refusals are solely determined by the
            Authorities.
          </div>
          <div class="clause bilingual">
            “主管部门”系指新加坡相关政府机构（包括 ACRA、MOM、ICA、IRAS 及银行等）。任何注册、审批、签发、续签或拒绝均由主管部门独立决定。
          </div>
        </div>
        <div class="subsection">
          <div class="subsection-title">1.2 Third‑Party Services <span class="bilingual">第三方服务</span></div>
          <div class="clause">
            Certain deliverables may require licensed professionals (e.g., corporate secretary, registered filing agent,
            accounting, tax, legal) and/or banking partners. Such services are not provided as legal/tax advice by Party
            B unless expressly agreed in writing.
          </div>
          <div class="clause bilingual">
            部分交付物可能需要持牌专业人士（例如公司秘书、注册申报代理、会计、税务、法律）及/或银行合作方参与。除非双方书面明确约定，乙方不提供法律/税务意见。
          </div>
        </div>
      </div>
    </div>

    <!-- Article 2 -->
    <div class="article">
      <div class="article-title">Article 2: Scope of Services 第二条：服务范围</div>
      <div class="article-content">
        <div class="subsection">
          <div class="subsection-title">2.1 Included Services <span class="bilingual">包含服务</span></div>
          <div class="clause">
            Party B will provide the following (as applicable to Party A's situation):
            <br>(a) Needs assessment and feasibility discussion (business profile, role design, shareholding and
            timeline).
            <br>(b) Incorporation coordination: document checklist, name ideas screening, coordination with corporate
            service provider for filings and standard resolutions.
            <br>(c) EP application preparation support: document checklist, forms review, narrative/positioning
            suggestions, and submission coordination through the employer or appointed agent.
            <br>(d) Family planning coordination (if requested): Dependant Pass / LTVP route explanation and document
            checklist.
            <br>(e) Project tracking and status updates until an outcome is received.
          </div>
          <div class="clause bilingual">
            乙方将向甲方提供以下服务（视甲方情况适用）：
            <br>(a) 需求评估与可行性讨论（行业背景、岗位设计、股权结构、时间线）。
            <br>(b) 公司设立统筹：材料清单、公司名称预筛、对接公司服务商完成注册申报与标准决议文件。
            <br>(c) EP 申请材料协助：材料清单、表格与材料检查、文案与定位建议，并通过雇主账号或指定代理协调递交。
            <br>(d) 家属规划统筹（如需要）：DP/LTVP 路线说明与材料清单。
            <br>(e) 项目进度跟踪与节点提醒，直至获得阶段性结果。
          </div>
        </div>

        <div class="subsection">
          <div class="subsection-title">2.2 Exclusions & No Guarantee <span class="bilingual">不包含事项与不保证</span></div>
          <div class="clause">
            Party A understands and agrees:
            <br>(a) Party B does not and cannot guarantee EP approval, bank account opening, incorporation approval,
            visa/pass issuance, renewal, PR/citizenship outcome, or any timeline.
            <br>(b) Party B is not responsible for decisions by the Authorities or any third parties.
            <br>(c) Government fees, statutory filings, accounting/tax, nominee/secretarial, due diligence and other
            third‑party charges are separate from Party B's service fee unless expressly stated.
          </div>
          <div class="clause bilingual">
            甲方理解并同意：
            <br>(a) 乙方不保证 EP 获批、银行开户成功、公司注册通过、签证/准证签发或续签、PR/公民结果及任何办理时间。
            <br>(b) 乙方不对主管部门或任何第三方的决定承担责任。
            <br>(c) 政府规费、法定申报、会计税务、名义董事/秘书服务、尽调等第三方费用与乙方服务费相互独立，除非另有明确书面约定。
          </div>
        </div>
      </div>
    </div>

    <!-- Article 3 -->
    <div class="article">
      <div class="article-title">Article 3: Client Obligations 第三条：甲方义务</div>
      <div class="article-content">
        <div class="subsection">
          <div class="subsection-title">3.1 Accuracy & Cooperation <span class="bilingual">真实完整与配合</span></div>
          <div class="clause">
            Party A shall provide accurate, complete and truthful information and documents, respond promptly to
            requests, and sign/authorize filings and declarations when required. Party A is solely responsible for any
            consequences caused by inaccurate information, delays or non‑cooperation.
          </div>
          <div class="clause bilingual">
            甲方应提供真实、完整、准确的信息与材料，按要求及时反馈，并在需要时签署/授权相关申报与声明。因信息不实、延误或不配合造成的后果由甲方自行承担。
          </div>
        </div>
      </div>
    </div>

    <!-- Article 4 -->
    <div class="article">
      <div class="article-title">Article 4: Fees & Payment 第四条：费用与支付</div>
      <div class="article-content">
        <div class="subsection">
          <div class="subsection-title">4.1 Service Fee <span class="bilingual">乙方服务费</span></div>
          <div class="clause">
            Party A shall pay Party B a service fee as below (in SGD):
            <table>
              <tr>
                <th style="width: 30%;">Item 项目</th>
                <th>Description 说明</th>
                <th style="width: 22%;">Amount 金额 (SGD)</th>
              </tr>
              <tr>
                <td>Project Fee 项目服务费</td>
                <td>
                  Company incorporation coordination + EP application coordination (best‑efforts).<br>
                  Excludes any third‑party / government fees unless stated.
                  <div class="bilingual">公司设立统筹 + EP 申请统筹（尽力而为）。不含第三方/政府规费（如未特别注明）。</div>
                </td>
                <td>SGD $__________</td>
              </tr>
            </table>
          </div>
        </div>

        <div class="subsection">
          <div class="subsection-title">4.2 Payment Schedule <span class="bilingual">付款方式与节点</span></div>
          <div class="clause">
            Unless otherwise agreed, Party A shall pay:
            <br>(a) Deposit: SGD $__________ upon signing (non‑refundable once Phase 1 starts).
            <br>(b) Milestone payment: SGD $__________ before submission/filing.
            <br>(c) Balance: SGD $__________ within ____ days after receiving outcome.
          </div>
          <div class="clause bilingual">
            除非另有约定，甲方支付方式如下：
            <br>(a) 定金：签署后支付 SGD $__________（第一阶段启动后不退）。
            <br>(b) 里程碑款：递交/申报前支付 SGD $__________。
            <br>(c) 尾款：获得阶段性结果后 ____ 日内支付 SGD $__________。
          </div>
        </div>

        <div class="subsection">
          <div class="subsection-title">4.3 Third‑Party Fees <span class="bilingual">第三方费用</span></div>
          <div class="clause">
            Party A acknowledges that incorporation, secretary/registered address, nominee director, accounting/tax,
            banking, due diligence, translations, medical checks and government fees may be required and are payable to
            third parties. Party B may assist with coordination but does not control third‑party pricing or outcomes.
          </div>
          <div class="clause bilingual">
            甲方确认：公司注册、秘书/注册地址、名义董事、会计税务、银行开户、尽调、翻译、公证、体检以及政府规费等可能由第三方收取。乙方仅协助对接与统筹，不对第三方收费与结果承担责任。
          </div>
        </div>
      </div>
    </div>

    <!-- Article 5 -->
    <div class="article">
      <div class="article-title">Article 5: Termination & Refunds 第五条：终止与退费</div>
      <div class="article-content">
        <div class="subsection">
          <div class="subsection-title">5.1 Termination <span class="bilingual">终止</span></div>
          <div class="clause">
            Either party may terminate this Agreement by written notice if the other party materially breaches and fails
            to remedy within ____ days. Party A may terminate for convenience, but fees already incurred for completed
            work are non‑refundable.
          </div>
          <div class="clause bilingual">
            如一方严重违约且在收到书面通知后 ____ 日内未改正，另一方可书面通知终止。本合同亦可由甲方无理由终止，但已发生/已完成的工作对应费用不予退还。
          </div>
        </div>

        <div class="subsection">
          <div class="subsection-title">5.2 Refund Principles <span class="bilingual">退费原则</span></div>
          <div class="clause">
            Unless otherwise agreed in writing:
            <br>(a) Deposit/initial planning fee is non‑refundable once Phase 1 work has started.
            <br>(b) If termination occurs before submission/filing due to Party B's material breach, unused portion of
            the fee may be refunded after deducting reasonable work done.
            <br>(c) No refund is available solely because an application is refused or delayed by Authorities/third
            parties.
          </div>
          <div class="clause bilingual">
            除非另有书面约定：
            <br>(a) 第一阶段启动后，定金/规划费不退。
            <br>(b) 如因乙方重大违约导致在递交/申报前终止，乙方应在扣除合理已完成工作后退还未使用部分。
            <br>(c) 因主管部门/第三方拒绝、延误等原因导致结果不理想，不构成乙方退费义务。
          </div>
        </div>
      </div>
    </div>

    <!-- Article 6 -->
    <div class="article">
      <div class="article-title">Article 6: Confidentiality & PDPA 第六条：保密与个人资料保护</div>
      <div class="article-content">
        <div class="subsection">
          <div class="subsection-title">6.1 Confidentiality <span class="bilingual">保密</span></div>
          <div class="clause">
            Each party shall keep confidential the other party's non‑public information obtained through this
            Agreement, except as required for performing services or required by law.
          </div>
          <div class="clause bilingual">
            双方应对因履行本合同获得的对方非公开信息保密，但为履行服务之必要披露或法律要求披露的除外。
          </div>
        </div>
        <div class="subsection">
          <div class="subsection-title">6.2 PDPA Notice & Consent <span class="bilingual">PDPA 告知与同意</span></div>
          <div class="clause">
            Party A consents to Party B collecting, using and disclosing Party A's personal data for purposes of service
            delivery, coordination with third‑party service providers and Authorities, record keeping, and compliance
            obligations, in accordance with Singapore's Personal Data Protection Act 2012 (PDPA).
          </div>
          <div class="clause bilingual">
            甲方同意乙方根据新加坡《2012年个人数据保护法》（PDPA）为履行服务、对接第三方服务商及主管部门、留存记录与合规需要而收集、使用与披露甲方个人资料。
          </div>
        </div>
      </div>
    </div>

    <!-- Article 7 -->
    <div class="article">
      <div class="article-title">Article 7: Liability & Disclaimer 第七条：责任限制与免责声明</div>
      <div class="article-content">
        <div class="subsection">
          <div class="subsection-title">7.1 Best‑Efforts Basis <span class="bilingual">尽力而为</span></div>
          <div class="clause">
            Party B provides support on a best‑efforts basis and does not warrant any outcome. Party B shall not be
            liable for indirect, incidental or consequential losses, or for acts/omissions of Authorities and third
            parties.
          </div>
          <div class="clause bilingual">
            乙方按“尽力而为”提供支持，不对任何结果作保证。乙方不对间接、附带或后果性损失负责，也不对主管部门或第三方的作为/不作为承担责任。
          </div>
        </div>
      </div>
    </div>

    <!-- Article 8 -->
    <div class="article">
      <div class="article-title">Article 8: Governing Law & Disputes 第八条：适用法律与争议解决</div>
      <div class="article-content">
        <div class="subsection">
          <div class="subsection-title">8.1 Governing Law <span class="bilingual">适用法律</span></div>
          <div class="clause">
            This Agreement shall be governed by the laws of Singapore.
          </div>
          <div class="clause bilingual">
            本合同适用新加坡法律。
          </div>
        </div>
        <div class="subsection">
          <div class="subsection-title">8.2 Dispute Resolution <span class="bilingual">争议解决</span></div>
          <div class="clause">
            The parties shall first attempt to resolve disputes through good‑faith negotiation. If unresolved, either
            party may submit the dispute to the courts of Singapore.
          </div>
          <div class="clause bilingual">
            双方应先友好协商解决争议；协商不成的，任何一方可向新加坡法院提起诉讼。
          </div>
        </div>
      </div>
    </div>

    <!-- Schedule A -->
    <div class="article page-break">
      <div class="article-title">Schedule A: Typical Milestones 附录A：典型服务节点</div>
      <div class="article-content">
        <div class="clause">
          The following is a non‑binding reference timeline (subject to Authority/third‑party processing):
          <br>(1) Phase 1 – Assessment & plan: ____ to ____ business days after receiving complete materials.
          <br>(2) Phase 2 – Incorporation filings: typically ____ to ____ business days.
          <br>(3) Phase 3 – EP preparation & submission coordination: ____ to ____ business days.
          <br>(4) Phase 4 – Outcome tracking: subject to MOM processing timelines.
        </div>
        <div class="clause bilingual">
          以下为非约束性的参考时间线（以主管部门/第三方处理为准）：
          <br>(1) 第一阶段—评估与方案：收到完整材料后 ____ 至 ____ 个工作日。
          <br>(2) 第二阶段—公司注册申报：通常 ____ 至 ____ 个工作日。
          <br>(3) 第三阶段—EP 材料准备与递交统筹：____ 至 ____ 个工作日。
          <br>(4) 第四阶段—结果跟踪：以 MOM 实际处理时间为准。
        </div>
      </div>
    </div>

    <!-- Signature -->
    <div class="signature-section">
      <div class="signature-block">
        <div class="party-title">Party A (Client) 甲方（客户/委托人）</div>
        <div class="signature-row">
          <div class="signature-label">Name 姓名:</div>
          <div class="signature-value"></div>
        </div>
        <div class="signature-row">
          <div class="signature-label">Signature 签字:</div>
          <div class="signature-value"></div>
        </div>
        <div class="signature-row">
          <div class="signature-label">Date 日期:</div>
          <div class="signature-value"></div>
        </div>
      </div>

      <div class="signature-block">
        <div class="party-title">Party B (Service Provider) 乙方（服务提供方）</div>
        <div class="signature-row">
          <div class="signature-label">For and on behalf of 代表:</div>
          <div class="signature-value">Maple Education Pte. Ltd.</div>
        </div>
        <div class="signature-row">
          <div class="signature-label">Authorized Signatory 授权签署人:</div>
          <div class="signature-value"></div>
        </div>
        <div class="signature-row">
          <div class="signature-label">Signature 签字:</div>
          <div class="signature-value"></div>
        </div>
        <div class="signature-row">
          <div class="signature-label">Date 日期:</div>
          <div class="signature-value"></div>
        </div>
      </div>
    </div>

  </div>
</body>

</html>
```
