---
title: "Maple_Study_Abroad_Service_Contract_Complete.html"
source_path: "01_Legal_and_Contracts/Templates/Maple_Study_Abroad_Service_Contract_Complete.html"
tags: ["合同", "服务", "Maple", "html"]
ocr: false
---

# Maple_Study_Abroad_Service_Contract_Complete.html

简介：合同/协议类文件，包含条款、费用、责任与流程说明。

## 内容

```text
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Maple Education Study Abroad Service Agreement - 枫叶留学出国留学服务合同</title>
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
            font-family: 'Segoe UI', 'Microsoft YaHei', SimSun, serif;
            position: relative;
            box-sizing: border-box;
        }

        .watermark {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            opacity: 0.04;
            width: 500px;
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
            width: 80px;
            height: 80px;
            margin-right: 8mm;
        }

        .header-content {
            flex-grow: 1;
            padding-top: 5px;
        }

        .company-name {
            font-size: 16pt;
            font-weight: 600;
            color: #333;
            line-height: 1.3;
        }

        .company-name-en {
            font-size: 11pt;
            font-weight: 500;
            color: #2c5aa0;
        }

        .company-info {
            font-size: 8pt;
            color: #666;
            line-height: 1.4;
            margin-top: 2px;
        }

        .footer {
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            text-align: center;
            font-size: 7.5pt;
            color: #888;
            padding: 4mm 0;
            background: white;
            border-top: 1px solid #ccc;
            z-index: 10;
        }

        .content {
            margin-top: 38mm;
            margin-bottom: 18mm;
            padding: 0 15mm;
            z-index: 5;
            font-size: 9.5pt;
            line-height: 1.7;
            color: #333;
        }

        .contract-title {
            text-align: center;
            font-size: 20pt;
            font-weight: 700;
            color: #2c5aa0;
            margin: 15px 0 5px 0;
            letter-spacing: 2px;
        }

        .contract-subtitle {
            text-align: center;
            font-size: 13pt;
            font-weight: 500;
            color: #666;
            margin-bottom: 18px;
            font-style: italic;
        }

        .info-box {
            background: #f9f9f9;
            border-left: 3px solid #2c5aa0;
            padding: 10px 12px;
            margin: 15px 0;
            font-size: 9pt;
            line-height: 1.6;
        }

        .warning-box {
            background: #fff5f5;
            border: 2px solid #d32f2f;
            border-radius: 4px;
            padding: 12px;
            margin: 15px 0;
            font-size: 9pt;
            line-height: 1.7;
        }

        .section-title {
            font-size: 13pt;
            font-weight: 700;
            color: #2c5aa0;
            margin: 20px 0 10px 0;
            padding-bottom: 5px;
            border-bottom: 2px solid #2c5aa0;
        }

        .cn {
            color: #333;
            line-height: 1.9;
            margin-bottom: 3px;
        }

        .en {
            color: #666;
            font-style: italic;
            font-size: 8.5pt;
            line-height: 1.6;
            margin-bottom: 12px;
        }

        table {
            width: 100%;
            border-collapse: collapse;
            margin: 12px 0;
            font-size: 9pt;
        }

        table th,
        table td {
            border: 1px solid #ccc;
            padding: 8px;
        }

        table th {
            background-color: #2c5aa0;
            color: white;
            font-weight: 600;
        }

        ol {
            margin: 10px 0 10px 20px;
            padding: 0;
        }

        li {
            margin-bottom: 10px;
            line-height: 1.8;
        }

        .signature-section {
            margin-top: 35px;
            display: flex;
            justify-content: space-between;
            page-break-inside: avoid;
        }

        .signature-block {
            width: 48%;
        }

        .signature-line {
            border-bottom: 1px solid #333;
            margin: 25px 0 5px 0;
            height: 40px;
        }

        .page-break {
            page-break-after: always;
        }

        @media print {
            body {
                border: none;
            }
        }
    </style>
</head>
<body>
    <img src="../../04_Brand_Assets/01_Logo/Logo_MapleEducation_Main.jpg" alt="Watermark" class="watermark">

    <div class="header">
        <img src="../../04_Brand_Assets/01_Logo/Logo_MapleEducation_Main.jpg" alt="Maple Education Logo" class="logo">
        <div class="header-content">
            <div class="company-name">SG枫叶留学</div>
            <div class="company-name-en">MAPLE EDUCATION PTE. LTD.</div>
            <div class="company-info">
                UEN: 202349302E | Singapore Business Registration<br>
                111 North Bridge Road, #25-01, Peninsula Plaza, Singapore 179098
            </div>
        </div>
    </div>

    <div class="footer">
        <strong style="color: #2c5aa0;">Maple Education Pte. Ltd.</strong> | UEN: 202349302E<br>
        📧 Maple@maplesgedu.com | 🌐 www.maplesgedu.com | 📱 SG +65 86863695 | CN +86 13506938797
    </div>

    <div class="content">
        <div class="contract-title">出国留学服务合同</div>
        <div class="contract-subtitle">Study Abroad Service Agreement</div>

        <div class="info-box">
            <strong>服务邮箱 Service Email:</strong> Maple@maplesgedu.com<br>
            <strong>合同编号 Contract No.:</strong> MAPLE-________ <br>
            <strong>留学顾问 Study Consultant:</strong> __________ <br>
            <strong>联系手机 Contact Phone:</strong> +65 86863695 (SG/WhatsApp) | +86 13506938797 (CN/WeChat)
        </div>

        <div class="warning-box">
            <div style="font-size: 12pt; font-weight: 700; color: #d32f2f; margin-bottom: 12px;">特别告知</div>
            <div style="font-size: 10.5pt; font-weight: 600; color: #d32f2f; margin-bottom: 12px; font-style: italic;">IMPORTANT NOTICE</div>

            <div class="cn">尊敬的申请人：</div>
            <div class="en">Dear Applicant,</div>

            <div class="cn">您好。感谢您选择Maple Education Pte. Ltd.（以下称"枫叶留学"）为您提供出国留学服务。为确保更好地为您提供服务，枫叶留学特别提示您注意以下内容：</div>
            <div class="en">Thank you for choosing Maple Education Pte. Ltd. (hereinafter referred to as "Maple Education") to provide you with study abroad services. To ensure better service delivery, Maple Education would like to draw your special attention to the following:</div>

            <ol>
                <li>
                    <div class="cn">申请人必须符合新加坡及目标国家/地区自费出国留学的必备条件。</div>
                    <div class="en">The applicant must meet the necessary requirements for self-funded study abroad in Singapore and the target country/region.</div>
                </li>
                <li>
                    <div class="cn">在留学申请办理过程中，申请人将前往的国家或地区的留学政策、签证政策或申请留学院校的入学要求可能会发生变化，如申请人届时不能满足新的要求则可能导致留学手续无法办理。</div>
                    <div class="en">During the study abroad application process, the study abroad policies, visa policies, or admission requirements of the institutions in the country or region to which the applicant intends to go may change. If the applicant cannot meet the new requirements at that time, it may result in the inability to complete the study abroad procedures.</div>
                </li>
                <li>
                    <div class="cn">发放签证是申请人申请留学的国家或地区政府独立行使的权利。虽然申请人具备了签证的条件，但是否能够获得签证存在不确定性；同时，申请人获得签证的时间亦具有不确定性。在未获得前往国家或地区签证或入境批准文件之前，申请人切勿轻易变更目前就学或就业状况，且不得随意动用所提供的经济担保资金或做出其他重大经济行为，还应避免使（领）馆调查时出现与原申请材料不符的情况，以免签证申请失败给申请人造成损失。</div>
                    <div class="en">The issuance of visas is an independent right exercised by the government of the country or region to which the applicant applies for study. Although the applicant meets the visa requirements, there is uncertainty as to whether a visa can be obtained; at the same time, the time for the applicant to obtain a visa is also uncertain. Before obtaining a visa or entry approval document for the destination country or region, the applicant should not easily change their current study or employment status, should not arbitrarily use the provided financial guarantee funds or make other major economic actions, and should also avoid situations where the embassy (consulate) investigation reveals inconsistencies with the original application materials, so as to avoid losses caused by visa application failure.</div>
                </li>
                <li>
                    <div class="cn">申请人获得签证或入境许可文件后，该国家或院校发生的任何变化是枫叶留学无法预测的，此变化可能会对申请人的留学产生一定的影响。</div>
                    <div class="en">After the applicant obtains a visa or entry permit document, any changes that occur in the country or institution are unpredictable by Maple Education, and such changes may have a certain impact on the applicant's study abroad.</div>
                </li>
                <li>
                    <div class="cn">申请人向枫叶留学缴付款项时，应汇入枫叶留学指定的银行账户或当面交至枫叶留学财务部并索取盖有枫叶留学财务专用章的正式收据。当申请人采用汇款方式时，收款人处应填写正确、完整的枫叶留学名称。申请人不得以任何方式将费用交给枫叶留学指定账户或财务部以外的任何单位或个人。</div>
                    <div class="en">When the applicant pays fees to Maple Education, they should remit to the bank account designated by Maple Education or pay in person to Maple Education's finance department and obtain an official receipt stamped with Maple Education's financial seal. When the applicant uses the remittance method, the payee should fill in the correct and complete name of Maple Education. The applicant must not pay fees to any unit or individual other than Maple Education's designated account or finance department in any way.</div>
                </li>
                <li>
                    <div class="cn">如果申请人不符合申请留学院校的直接入学要求，院校可能会给申请人签发有条件的课程录取通知书，要求申请人必须通过一个阶段的学习，达到校方录取通知书上的要求后，方可进入该校专业课程学习，在此期间申请人可能因无法达到院校要求而最终不能获得入学资格。</div>
                    <div class="en">If the applicant does not meet the direct admission requirements of the application institution, the institution may issue a conditional course admission letter to the applicant, requiring the applicant to complete a period of study and meet the requirements on the institution's admission letter before entering the institution's professional course study. During this period, the applicant may ultimately fail to obtain admission qualification due to inability to meet the institution's requirements.</div>
                </li>
                <li>
                    <div class="cn">申请人前往的国家或地区使（领）馆发出申请人申请的签证（预签）或入境批准文件后，申请人不得擅自更改入学院校或专业。</div>
                    <div class="en">After the embassy (consulate) of the country or region to which the applicant is going issues the visa (pre-visa) or entry approval document applied for by the applicant, the applicant shall not change the admission institution or major without authorization.</div>
                </li>
                <li>
                    <div class="cn">申请人不得提供任何虚假的书面、电子或口头材料和信息。</div>
                    <div class="en">The applicant must not provide any false written, electronic, or verbal materials and information.</div>
                </li>
                <li>
                    <div class="cn">申请人出境后应自觉遵守前往国家的法律、法规、留学院校和境外机构的规章制度，申请人应对入学以后的个人行为负责，避免与院校或境外机构产生任何纠纷。申请人入学后，因学习成绩不合格或其它原因，可能会导致申请人不能获得相应证书。</div>
                    <div class="en">After departure, the applicant should consciously comply with the laws and regulations of the destination country, the rules and regulations of the study abroad institutions and overseas institutions. The applicant shall be responsible for personal behavior after enrollment and avoid any disputes with institutions or overseas institutions. After enrollment, the applicant may not be able to obtain the corresponding certificate due to unqualified academic performance or other reasons.</div>
                </li>
                <li>
                    <div class="cn">枫叶留学禁止工作人员对申请人做出任何"百分百"、"绝对没问题"等口头或书面方式的过度承诺，该承诺属违规行为，若申请人发现枫叶留学工作人员任何的违规行为，请及时将此情况反馈给枫叶留学。</div>
                    <div class="en">Maple Education prohibits staff from making any excessive promises such as "one hundred percent" or "absolutely no problem" in oral or written form to applicants. Such promises are violations. If the applicant discovers any violations by Maple Education staff, please promptly report this situation to Maple Education.</div>
                </li>
            </ol>

            <div class="cn" style="margin-top: 15px;">因上述原因或申请人违反上述规定及本合同约定所引起的任何后果、纠纷和损失，枫叶留学不承担任何责任。</div>
            <div class="en">Maple Education shall not bear any responsibility for any consequences, disputes, and losses caused by the above reasons or the applicant's violation of the above provisions and this contract.</div>

            <div class="cn">如申请人发现任何商业贿赂行为，可向枫叶留学举报。枫叶留学举报电话：+65 86863695；举报邮箱：Maple@maplesgedu.com</div>
            <div class="en">If the applicant discovers any commercial bribery, they can report it to Maple Education. Maple Education reporting hotline: +65 86863695; Reporting email: Maple@maplesgedu.com</div>

            <div class="cn">申请人在签字前应仔细阅读合同，并应完全了解合同文本的全部条款，特别应对合同中的"退费规定"全面了解。</div>
            <div class="en">The applicant should carefully read the contract before signing and should fully understand all terms of the contract text, especially should have a comprehensive understanding of the "Refund Regulations" in the contract.</div>

            <div style="margin-top: 20px; padding: 10px; background: #fffbf0; border: 1px solid #ffa000;">
                <div class="cn"><strong>申请人（委托人/代理人）已阅读、并清楚了解上述条款的内容和含义。</strong></div>
                <div class="en"><strong>The Applicant (Principal/Agent) has read and clearly understands the content and meaning of the above terms.</strong></div>

                <div style="margin-top: 20px;">
                    <div class="cn">申请人（委托人/代理人）签名：______________________ 日期：____ 年 __ 月 __ 日</div>
                    <div class="en">Applicant (Principal/Agent) Signature: ______________________ Date: ___/___/______</div>
                </div>
            </div>
        </div>

        <div class="page-break"></div>

        <!-- 第一章 -->
        <div class="section-title">第一章 合同双方 | Chapter 1: Contracting Parties</div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>委托人（下称"申请人"）Applicant (Principal)：</strong></div>
            <table>
                <tr>
                    <td style="width: 30%"><strong>姓名 Name:</strong></td>
                    <td>______________________</td>
                </tr>
                <tr>
                    <td><strong>身份证号 ID Number:</strong></td>
                    <td>______________________</td>
                </tr>
                <tr>
                    <td><strong>护照号 Passport Number:</strong></td>
                    <td>______________________</td>
                </tr>
                <tr>
                    <td><strong>联系地址 Contact Address:</strong></td>
                    <td>______________________</td>
                </tr>
                <tr>
                    <td><strong>联系电话 Contact Phone:</strong></td>
                    <td>______________________</td>
                </tr>
                <tr>
                    <td><strong>电子邮箱 Email:</strong></td>
                    <td>______________________</td>
                </tr>
            </table>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>受托人 Service Provider：</strong></div>
            <div class="info-box">
                <strong>公司名称 Company Name:</strong> Maple Education Pte. Ltd.<br>
                <strong>注册编号 UEN:</strong> 202349302E<br>
                <strong>注册地址 Registered Address:</strong> 111 North Bridge Road, #25-01, Peninsula Plaza, Singapore 179098<br>
                <strong>联系电话 Phone:</strong> +65 86863695 (Singapore/WhatsApp)<br>
                <strong>中国联系 China Contact:</strong> +86 13506938797 (WeChat)<br>
                <strong>电子邮箱 Email:</strong> Maple@maplesgedu.com<br>
                <strong>官方网站 Website:</strong> www.maplesgedu.com
            </div>
        </div>

        <div class="cn">申请人、枫叶留学双方本着自愿、平等、诚信的原则，就申请人接受枫叶留学提供有关自费出国留学中介服务事宜，经协商，达成如下协议，以共同遵守。</div>
        <div class="en">Based on the principles of voluntariness, equality, and good faith, the applicant and Maple Education have reached the following agreement through negotiation regarding the applicant's acceptance of Maple Education's provision of intermediary services related to self-funded study abroad, to be jointly observed.</div>

        <!-- 第二章 -->
        <div class="section-title">第二章 服务内容 | Chapter 2: Service Scope</div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第一条</strong> 枫叶留学向申请人提供留学前往国家的教育概况、院校、院系、专业的信息，供申请人参考，提供相应的咨询建议，最终由申请人决定留学方案。</div>
            <div class="en"><strong>Article 1</strong> Maple Education shall provide the applicant with information about the education overview, institutions, faculties, and majors of the study abroad destination country for the applicant's reference, provide corresponding consultation and advice, with the final study abroad plan to be decided by the applicant.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第二条</strong> 根据自身条件，申请人决定申请赴 __________ (国家/地区) 留学，合同类型为 __________ (院校类型) 申请服务；目标院校为 __________，专业为 __________。并自愿接受枫叶留学提供涉及上述自费出国留学的中介服务。</div>
            <div class="en"><strong>Article 2</strong> Based on personal qualifications, the applicant decides to apply for study in __________ (Country/Region), the contract type is __________ (Institution Type) application service; the target institution is __________, the major is __________. And voluntarily accepts Maple Education's provision of intermediary services related to the aforementioned self-funded study abroad.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第三条</strong> 申请全过程包含的服务如下：</div>
            <div class="en"><strong>Article 3</strong> The complete application process includes the following services:</div>

            <ol>
                <li>
                    <div class="cn">为申请人提供前期留学相关的咨询服务，规划申请院校，确认专业。</div>
                    <div class="en">Provide the applicant with preliminary study abroad consultation services, plan application institutions, and confirm majors.</div>
                </li>
                <li>
                    <div class="cn">收集申请人的申请资料并协助申请人整理材料。（包含代写文书服务）</div>
                    <div class="en">Collect the applicant's application materials and assist the applicant in organizing materials. (Including document writing services)</div>
                </li>
                <li>
                    <div class="cn">评估申请人的申请材料并完成申请递交。</div>
                    <div class="en">Evaluate the applicant's application materials and complete the application submission.</div>
                </li>
                <li>
                    <div class="cn">为申请人监督申请过程并确认offer情况。</div>
                    <div class="en">Monitor the application process for the applicant and confirm the offer status.</div>
                </li>
                <li>
                    <div class="cn">协助申请人办理签证，递交签证材料，确认签证审批情况。</div>
                    <div class="en">Assist the applicant in visa processing, submit visa materials, and confirm visa approval status.</div>
                </li>
                <li>
                    <div class="cn">协助申请人做好入学前准备。</div>
                    <div class="en">Assist the applicant in pre-enrollment preparations.</div>
                </li>
                <li>
                    <div class="cn">协助申请人在目的地国家的学习生活相关咨询服务。</div>
                    <div class="en">Assist the applicant with consultation services related to study and living in the destination country.</div>
                </li>
            </ol>

            <div class="warning-box">
                <div class="cn"><strong>备注：</strong> 第三条"附加内容"手写无效。本合同服务不包含语言培训、院校申请费、签证费、学费、生活费、机票等第三方费用。</div>
                <div class="en"><strong>Note:</strong> Handwritten "additional content" in Article 3 is invalid. Services under this contract do not include language training, institution application fees, visa fees, tuition fees, living expenses, airfare, and other third-party costs.</div>
            </div>
        </div>

        <div class="page-break"></div>

        <!-- 第三章 -->
        <div class="section-title">第三章 申请人的权利和义务 | Chapter 3: Rights and Obligations of the Applicant</div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第四条</strong> 确认本合同委托事项，并按本合同约定按时向枫叶留学支付中介服务费。</div>
            <div class="en"><strong>Article 4</strong> Confirm the commissioned matters of this contract and pay the intermediary service fee to Maple Education on time as stipulated in this contract.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第五条</strong> 申请人应在本合同签订后，于 ____ 年 __ 月 __ 日前把入学申请所需材料交给枫叶留学（入学材料以各院校公布的当年最新招生标准为准），并遵守本合同《特别告知》中规定。如申请人不能如期提供入学申请所需材料或违反《特别告知》中规定，因此而造成的损失由申请人承担。</div>
            <div class="en"><strong>Article 5</strong> After signing this contract, the applicant shall submit the required materials for the admission application to Maple Education by __/__/____ (admission materials shall be based on the latest enrollment standards published by each institution for the current year), and comply with the provisions in the "Important Notice" of this contract. If the applicant cannot provide the required materials for the admission application on time or violates the provisions in the "Important Notice," the losses caused thereby shall be borne by the applicant.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第六条</strong> 在留学申请办理过程中，如前往国家或地区的留学政策、签证政策或申请留学院校的入学要求发生变化，申请人应根据新的要求，及时提供补充材料。</div>
            <div class="en"><strong>Article 6</strong> During the study abroad application process, if the study abroad policies, visa policies, or admission requirements of the institutions in the destination country or region change, the applicant shall promptly provide supplementary materials according to the new requirements.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第七条</strong> 在留学申请办理过程中，申请人应在枫叶留学的指导下，自行将申请留学院校报名费、学费、杂费等费用按时足额汇往学校指定的银行账号。</div>
            <div class="en"><strong>Article 7</strong> During the study abroad application process, under the guidance of Maple Education, the applicant shall remit the application institution's registration fee, tuition, miscellaneous fees, and other fees on time and in full to the bank account designated by the school.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第八条</strong> 在留学申请办理过程中，如申请人前往国家或地区使（领）馆要求申请人进行面试，申请人应按使（领）馆要求，按时到使（领）馆面试。</div>
            <div class="en"><strong>Article 8</strong> During the study abroad application process, if the embassy (consulate) of the destination country or region requires the applicant to attend an interview, the applicant shall attend the embassy (consulate) interview on time as required by the embassy (consulate).</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第九条</strong> 申请人如未能获得留学前往国家或地区签证或入境批准文件，或者已获签证或入境批准文件而放弃前往该国已申请留学学院学习，均由申请人自行负责向该院校提出退费申请，要求该院校按规定退还学费、杂费等费用。</div>
            <div class="en"><strong>Article 9</strong> If the applicant fails to obtain a visa or entry approval document for the study abroad destination country or region, or abandons going to the applied study abroad institution in that country after obtaining a visa or entry approval document, the applicant shall be solely responsible for submitting a refund application to the institution and requesting the institution to refund tuition, miscellaneous fees, and other fees according to regulations.</div>
        </div>

        <!-- 第四章 -->
        <div class="section-title">第四章 枫叶留学的权利和义务 | Chapter 4: Rights and Obligations of Maple Education</div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第十条</strong> 如实向申请人介绍前往国家或地区的留学政策、签证政策和申请留学院校的基本情况、入学要求等留学相关信息。</div>
            <div class="en"><strong>Article 10</strong> Truthfully introduce to the applicant the study abroad policies, visa policies, and basic information about the application institutions, admission requirements, and other study abroad related information of the destination country or region.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第十一条</strong> 根据各国使（领）馆的要求，枫叶留学收到申请人符合签证要求的全部签证申请材料后，在十个工作日内向相关使（领）馆递交签证申请材料。</div>
            <div class="en"><strong>Article 11</strong> According to the requirements of embassies (consulates) of various countries, after receiving all visa application materials from the applicant that meet visa requirements, Maple Education shall submit the visa application materials to the relevant embassy (consulate) within ten working days.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第十二条</strong> 申请人理解并同意，枫叶留学有权在不暴露申请人真实身份及隐私的前提下，根据枫叶留学需要公开及使用枫叶留学指导申请人撰写的文书及其它材料。</div>
            <div class="en"><strong>Article 12</strong> The applicant understands and agrees that Maple Education has the right to publicly use documents and other materials guided by Maple Education for the applicant's writing, provided that the applicant's true identity and privacy are not exposed, according to Maple Education's needs.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第十三条</strong> 枫叶留学有权要求申请人提供并及时从申请人处获得与申请有关的各项信息。</div>
            <div class="en"><strong>Article 13</strong> Maple Education has the right to request and promptly obtain from the applicant all information related to the application.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第十四条</strong> 枫叶留学同意并确认，枫叶留学有权拆阅并处理各申请和非申请学校寄给申请人的信函（包括但不限于邮件、电子邮件、传真）。</div>
            <div class="en"><strong>Article 14</strong> Maple Education agrees and confirms that Maple Education has the right to open and handle letters sent to the applicant by various application and non-application schools (including but not limited to mail, email, fax).</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第十五条</strong> 枫叶留学有权按本合同规定向申请人收取服务费；如果申请人拖欠费用，枫叶留学有权就申请人应付但未付的款项自应付之日起按日0.05%比例收取滞纳金。</div>
            <div class="en"><strong>Article 15</strong> Maple Education has the right to charge service fees to the applicant as stipulated in this contract; if the applicant is in arrears with fees, Maple Education has the right to charge a late fee at a rate of 0.05% per day from the date due on the amounts payable but not paid by the applicant.</div>
        </div>

        <div class="page-break"></div>

        <!-- 第五章 -->
        <div class="section-title">第五章 缴费及退费规定 | Chapter 5: Payment and Refund Regulations</div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第十六条</strong> 申请人在与枫叶留学签署本合同的同时，需向枫叶留学支付服务费，费用详情如下：</div>
            <div class="en"><strong>Article 16</strong> When signing this contract with Maple Education, the applicant shall pay service fees to Maple Education, with fee details as follows:</div>

            <table style="margin-top: 15px;">
                <tr>
                    <td style="width: 50%"><strong>服务费总额 Total Service Fee:</strong></td>
                    <td><strong>SGD $__________ / CNY ¥__________</strong></td>
                </tr>
                <tr>
                    <td><strong>支付方式 Payment Method:</strong></td>
                    <td>☐ 一次性付清 Full Payment ☐ 分期付款 Installment</td>
                </tr>
                <tr>
                    <td><strong>首次付款 Initial Payment:</strong></td>
                    <td>SGD $__________ / CNY ¥__________</td>
                </tr>
                <tr>
                    <td><strong>付款日期 Payment Date:</strong></td>
                    <td>____ 年 __ 月 __ 日 / ___/___/______</td>
                </tr>
            </table>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第十七条</strong> 交纳服务费的有效途径如下，由于枫叶留学充分发挥新加坡本土服务+互联网留学模式，建议学生可通过银行汇款或在线支付：</div>
            <div class="en"><strong>Article 17</strong> Valid payment methods for service fees are as follows. As Maple Education fully utilizes the Singapore local service + online study abroad model, students are advised to use bank transfer or online payment:</div>

            <div class="info-box" style="margin-top: 12px;">
                <div style="margin-bottom: 12px;">
                    <strong style="color: #2c5aa0;">1) 银行转账 Bank Transfer (推荐 Recommended)</strong><br>
                    <div style="margin-left: 15px; margin-top: 6px; font-size: 8.5pt;">
                        <strong>Account Name 账户名称:</strong> Maple Education Pte. Ltd.<br>
                        <strong>Bank 开户行:</strong> DBS Bank Ltd. / OCBC Bank<br>
                        <strong>Account Number 账号:</strong> __________<br>
                        <strong>Swift Code:</strong> __________<br>
                        <em style="color: #666;">汇款后请将凭证发送至 Maple@maplesgedu.com<br>Please send transfer receipt to Maple@maplesgedu.com after remittance</em>
                    </div>
                </div>

                <div style="margin-bottom: 12px;">
                    <strong style="color: #2c5aa0;">2) 支付宝/微信支付 Alipay/WeChat Pay</strong><br>
                    <div style="margin-left: 15px; margin-top: 6px; font-size: 8.5pt;">
                        联系客服老师领取官方收款码 Contact customer service for official payment QR code<br>
                        WeChat: +86 13506938797 | WhatsApp: +65 86863695<br>
                        <em style="color: #666;">提示：因国家政策预防诈骗风控，异地扫码支付可能会被提示风险支付，建议通过银行汇款。<br>
                        Note: Due to national anti-fraud policies, cross-regional QR code payments may trigger risk alerts; bank transfer is recommended.</em>
                    </div>
                </div>

                <div>
                    <strong style="color: #2c5aa0;">3) 上门现金交款或POS机刷卡 In-Person Cash or Card Payment</strong><br>
                    <div style="margin-left: 15px; margin-top: 6px; font-size: 8.5pt;">
                        需提前联系预约 Appointment required<br>
                        Address: 111 North Bridge Road, #25-01, Peninsula Plaza, Singapore 179098
                    </div>
                </div>
            </div>

            <div class="warning-box" style="margin-top: 12px;">
                <div class="cn"><strong>⚠️ 重要提示：</strong>请勿向个人账户或非指定账户支付费用，否则枫叶留学不承担任何责任。付款后请索取盖有枫叶留学财务专用章的正式收据。</div>
                <div class="en"><strong>⚠️ Important Notice:</strong> Do not pay fees to personal accounts or non-designated accounts, otherwise Maple Education will not assume any responsibility. Please request an official receipt stamped with Maple Education's financial seal after payment.</div>
            </div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第十八条</strong> 申请人必须自行承担在留学申请办理过程中发生的其他费用（如院校报名费、护照工本费、公证费、体检费、签证费、银行手续费及汇款费、机票款、保险费、院校学费、杂费、接机费、住宿费等）。上述费用由申请人自行向有关机构缴付，缴费标准和缴费方式以相关收费机构对申请人的要求为准。</div>
            <div class="en"><strong>Article 18</strong> The applicant must bear other costs incurred during the study abroad application process (such as institution registration fees, passport fees, notarization fees, medical examination fees, visa fees, bank handling fees and remittance fees, airfare, insurance premiums, institution tuition, miscellaneous fees, airport pickup fees, accommodation fees, etc.). The above fees shall be paid by the applicant directly to relevant institutions, with payment standards and payment methods subject to the requirements of the relevant fee-charging institutions for the applicant.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第十九条</strong> 为了保证申请材料迅速安全到达，申请人与学校所有往来邮件全部采用国际大型速递公司DHL的服务，邮递费缴费标准和缴费方式以相关收费机构对申请人的要求为准。</div>
            <div class="en"><strong>Article 19</strong> To ensure the rapid and safe arrival of application materials, all correspondence between the applicant and the school shall use the services of international major courier company DHL, with courier fee payment standards and payment methods subject to the requirements of the relevant fee-charging institution for the applicant.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第二十条</strong> 如申请人因自身原因，在本合同签署后单方面要求解除本合同，申请人已缴付的中介服务费按以下方法处理：</div>
            <div class="en"><strong>Article 20</strong> If the applicant unilaterally requests to terminate this contract for personal reasons after signing this contract, the intermediary service fees paid by the applicant shall be handled as follows:</div>

            <table style="margin-top: 12px;">
                <thead>
                    <tr>
                        <th style="width: 40%">时间节点 Timeline</th>
                        <th>退费标准 Refund Standard</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td>
                            <div class="cn">签约后7日内（含7日）</div>
                            <div class="en" style="font-size: 8pt; font-style: italic;">Within 7 days after signing (including day 7)</div>
                        </td>
                        <td>
                            <div class="cn">扣除50%服务费，余款退还，本合同终止。</div>
                            <div class="en" style="font-size: 8pt; font-style: italic;">Deduct 50% service fee, refund balance, contract terminated.</div>
                        </td>
                    </tr>
                    <tr>
                        <td>
                            <div class="cn">签约7日后至文书材料尚未完成之前</div>
                            <div class="en" style="font-size: 8pt; font-style: italic;">After 7 days of signing until before document materials are completed</div>
                        </td>
                        <td>
                            <div class="cn">扣除70%服务费，余款退还，本合同终止。</div>
                            <div class="en" style="font-size: 8pt; font-style: italic;">Deduct 70% service fee, refund balance, contract terminated.</div>
                        </td>
                    </tr>
                    <tr>
                        <td>
                            <div class="cn">文书材料已完成，申请尚未递交</div>
                            <div class="en" style="font-size: 8pt; font-style: italic;">Document materials completed, application not yet submitted</div>
                        </td>
                        <td>
                            <div class="cn">扣除90%服务费，余款退还，本合同终止。</div>
                            <div class="en" style="font-size: 8pt; font-style: italic;">Deduct 90% service fee, refund balance, contract terminated.</div>
                        </td>
                    </tr>
                    <tr>
                        <td>
                            <div class="cn">已完成网申或已将申请材料递交至申请院校</div>
                            <div class="en" style="font-size: 8pt; font-style: italic;">Online application completed or application materials submitted to application institutions</div>
                        </td>
                        <td>
                            <div class="cn">服务费不予退还，本合同终止。</div>
                            <div class="en" style="font-size: 8pt; font-style: italic;">Service fee non-refundable, contract terminated.</div>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第二十一条</strong> 如发生以下情形之一，则申请人已交付的中介服务费一律不予退还，本合同终止：</div>
            <div class="en"><strong>Article 21</strong> If any of the following circumstances occur, the intermediary service fees paid by the applicant will not be refunded, and this contract shall be terminated:</div>

            <ol>
                <li>
                    <div class="cn">申请人无正当理由拒付或不按时支付本合同约定的任何一笔款项或学校要求的文件材料；</div>
                    <div class="en">The applicant refuses to pay or fails to pay any amount stipulated in this contract or the document materials required by the school without valid reason;</div>
                </li>
                <li>
                    <div class="cn">申请人由于自身的违法行为，导致本合同无法履行；</div>
                    <div class="en">The applicant's illegal conduct leads to the inability to perform this contract;</div>
                </li>
                <li>
                    <div class="cn">申请人未按前往国家或地区使（领）馆签证要求办妥签证申请所需文件及手续，并书面（正本）要求坚持送签而被拒签；</div>
                    <div class="en">The applicant fails to complete the documents and procedures required for visa application as required by the embassy (consulate) of the destination country or region, and insists on submitting the visa in writing (original) and is refused;</div>
                </li>
                <li>
                    <div class="cn">申请人提供虚假材料或隐瞒相关实情；</div>
                    <div class="en">The applicant provides false materials or conceals relevant facts;</div>
                </li>
                <li>
                    <div class="cn">申请人被前往国家或地区使（领）馆查实有非法移民、犯罪前科等不良记录而被拒签；</div>
                    <div class="en">The applicant is refused a visa after being verified by the embassy (consulate) of the destination country or region to have adverse records such as illegal immigration or criminal record;</div>
                </li>
                <li>
                    <div class="cn">申请人前往国家或地区使（领）馆已发出申请人申请的签证（预签）或入境批准文件后，申请人拒绝领取签证或入境批准文件或提出要求转学或不向留学院校缴付学费、杂费等费用的。</div>
                    <div class="en">After the embassy (consulate) of the destination country or region has issued the visa (pre-visa) or entry approval document applied for by the applicant, the applicant refuses to collect the visa or entry approval document or requests a transfer or fails to pay tuition, miscellaneous fees, and other fees to the study abroad institution.</div>
                </li>
            </ol>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第二十二条</strong> 枫叶留学应按上述退费规定，在申请人办妥退费手续后将应退款无息退还申请人，申请人将合同及相关收费凭证退还枫叶留学，本合同终止；如申请人未能提供合同及收费凭证，需签署"遗失声明"，经枫叶留学核实后，办理相关退款手续，本合同终止。</div>
            <div class="en"><strong>Article 22</strong> Maple Education shall refund the refundable amount to the applicant without interest after the applicant completes the refund procedures according to the above refund regulations, the applicant shall return the contract and relevant fee receipts to Maple Education, and this contract shall be terminated; if the applicant fails to provide the contract and fee receipts, a "Loss Declaration" must be signed, and after verification by Maple Education, the relevant refund procedures shall be processed, and this contract shall be terminated.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第二十三条</strong> 申请人申请留学院校的报名费和学费、杂费以及在留学申请办理过程中发生的其他费用（除枫叶留学收取的中介服务费）的退费事宜，由申请人自行与申请留学院校和相关收费机构负责处理。</div>
            <div class="en"><strong>Article 23</strong> Refund matters for the application institution's registration fee and tuition, miscellaneous fees, and other costs incurred during the study abroad application process (excluding the intermediary service fees charged by Maple Education) shall be handled by the applicant directly with the application institution and relevant fee-charging institutions.</div>
        </div>

        <div class="page-break"></div>

        <!-- 第六章 -->
        <div class="section-title">第六章 终止条款 | Chapter 6: Termination Clauses</div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第二十四条</strong> 申请人前往国家或地区使（领）馆发出申请人申请的签证或入境批准文件后，即视为枫叶留学已完成为申请人提供自费出国留学中介服务事宜，本合同即告终止。</div>
            <div class="en"><strong>Article 24</strong> After the embassy (consulate) of the destination country or region issues the visa or entry approval document applied for by the applicant, it shall be deemed that Maple Education has completed the provision of self-funded study abroad intermediary services for the applicant, and this contract shall be terminated.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第二十五条</strong> 在本合同的履行过程中，经枫叶留学挂号信或特快专递催告后，在三十天之内，申请人仍无继续履行本合同或终止本合同的书面意思表示，本合同终止，枫叶留学所收取的服务费均不予退还。</div>
            <div class="en"><strong>Article 25</strong> During the performance of this contract, after being urged by Maple Education via registered mail or express delivery, if the applicant still has no written intention to continue performing this contract or terminate this contract within thirty days, this contract shall be terminated, and all service fees collected by Maple Education shall not be refunded.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第二十六条</strong> 出现本合同其他条款规定的合同终止条件，本合同即告终止。</div>
            <div class="en"><strong>Article 26</strong> When the contract termination conditions stipulated in other terms of this contract occur, this contract shall be terminated.</div>
        </div>

        <!-- 第七章 -->
        <div class="section-title">第七章 通知送达 | Chapter 7: Notice Delivery</div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第二十七条</strong> 申请人与枫叶留学发出的通知应以书面或电子数据形式进行，除面交本人外，以本合同以下所述的通讯地址并以对方为收件人一经发出后5日期满，均视为已经送达；或者向对方下列号码发送短信、微信或电子邮箱发送邮件，任一方式发送成功即视为送达。</div>
            <div class="en"><strong>Article 27</strong> Notices issued by the applicant and Maple Education shall be in written or electronic data form. Except for hand delivery to the person, notices sent to the communication address described below in this contract with the other party as the recipient shall be deemed delivered after 5 days from issuance; or sending SMS, WeChat, or email to the other party's numbers below, successful delivery by any method shall be deemed delivered.</div>

            <table style="margin-top: 12px;">
                <tr>
                    <td style="width: 35%"><strong>申请人联系方式<br>Applicant Contact:</strong></td>
                    <td>
                        收件人 Recipient: __________<br>
                        邮寄地址 Mailing Address: __________<br>
                        手机号码 Phone Number: __________<br>
                        微信号码 WeChat ID: __________<br>
                        电子邮箱 Email: __________
                    </td>
                </tr>
                <tr>
                    <td><strong>枫叶留学联系方式<br>Maple Education Contact:</strong></td>
                    <td>
                        收件人 Recipient: Maple Education Service Team<br>
                        通讯地址 Address: 111 North Bridge Road, #25-01, Peninsula Plaza, Singapore 179098<br>
                        手机号码 Phone: +65 86863695<br>
                        微信号码 WeChat: +86 13506938797<br>
                        电子邮箱 Email: Maple@maplesgedu.com
                    </td>
                </tr>
            </table>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第二十八条</strong> 任何一方若指定其他邮寄地址、手机号码、微信号或电子邮箱，必须及时以书面形式通知另一方，如未通知对方，另一方以本合同确认的联系信息送达视为有效送达。</div>
            <div class="en"><strong>Article 28</strong> If either party designates other mailing addresses, mobile phone numbers, WeChat IDs, or email addresses, they must promptly notify the other party in writing. If the other party is not notified, delivery to the contact information confirmed in this contract shall be deemed valid delivery.</div>
        </div>

        <!-- 第八章 -->
        <div class="section-title">第八章 适用的法律及争议解决方法 | Chapter 8: Applicable Law and Dispute Resolution</div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第二十九条</strong> 本合同的效力、履行、解释及争议解决均适用新加坡共和国法律。</div>
            <div class="en"><strong>Article 29</strong> The validity, performance, interpretation, and dispute resolution of this contract shall all be governed by the laws of the Republic of Singapore.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第三十条</strong> 申请人、枫叶留学在履行本合同中如发生争议，应由双方协商解决。如协商不成，双方可向枫叶留学注册地有管辖权的新加坡法院提起诉讼，或提交新加坡国际仲裁中心(SIAC)进行仲裁。</div>
            <div class="en"><strong>Article 30</strong> If disputes arise between the applicant and Maple Education during the performance of this contract, they shall be resolved through consultation between both parties. If consultation fails, both parties may file a lawsuit with a Singapore court having jurisdiction over Maple Education's place of registration, or submit to arbitration at the Singapore International Arbitration Centre (SIAC).</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第三十一条</strong> 诉讼或仲裁费用由败诉方承担。胜诉方为维权支出的合理费用（如律师费、差旅费等），由败诉方承担，具体金额以法院或仲裁庭判决为准。</div>
            <div class="en"><strong>Article 31</strong> Litigation or arbitration costs shall be borne by the losing party. Reasonable expenses incurred by the prevailing party for rights protection (such as attorney fees, travel expenses, etc.) shall be borne by the losing party, with specific amounts subject to court or arbitration tribunal judgment.</div>
        </div>

        <!-- 第九章 -->
        <div class="section-title">第九章 本合同的补充、变更、修改 | Chapter 9: Supplement, Change, and Modification of this Contract</div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第三十二条</strong> 对本合同的任何补充、变更、修改应采用书面补充合同形式。补充合同在双方签署后与本合同具有同等法律效力。</div>
            <div class="en"><strong>Article 32</strong> Any supplement, change, or modification to this contract shall be in the form of a written supplementary contract. The supplementary contract shall have equal legal effect with this contract after being signed by both parties.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第三十三条</strong> 除本合同上明确规定可以填写的内容之外，任何在本合同上的手写内容或修改均对双方没有约束力。</div>
            <div class="en"><strong>Article 33</strong> Except for content explicitly specified in this contract that can be filled in, any handwritten content or modifications on this contract shall not be binding on both parties.</div>
        </div>

        <!-- 第十章 -->
        <div class="section-title">第十章 特别条款 | Chapter 10: Special Clauses</div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第三十四条</strong> 申请人、枫叶留学作如下特别约定：申请人对《特别告知》的内容已仔细阅读，并同意将《特别告知》的全部内容作为本合同的条款，与枫叶留学共同遵守履行。</div>
            <div class="en"><strong>Article 34</strong> The applicant and Maple Education make the following special agreement: The applicant has carefully read the content of the "Important Notice" and agrees to treat all content of the "Important Notice" as terms of this contract, to be jointly observed and performed with Maple Education.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第三十五条</strong> 本合同是申请人、枫叶留学双方真实意思的表示，双方已仔细阅读并完全知晓其内容。</div>
            <div class="en"><strong>Article 35</strong> This contract represents the true intentions of both the applicant and Maple Education, and both parties have carefully read and fully understand its content.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第三十六条</strong> 枫叶留学的服务承诺以本合同及附件约定为准，任何工作人员的口头承诺若与本合同约定不一致，均视为无效。</div>
            <div class="en"><strong>Article 36</strong> Maple Education's service commitments are subject to this contract and appendices. Any verbal promises by staff members that are inconsistent with this contract shall be deemed invalid.</div>
        </div>

        <!-- 第十一章 -->
        <div class="section-title">第十一章 生效条款 | Chapter 11: Effective Clauses</div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第三十七条</strong> 本合同自枫叶留学盖章（合同专用章）及申请人（如申请人未满18周岁由申请人法定监护人）签字并支付服务费之日起生效。本合同有效期限为贰年。</div>
            <div class="en"><strong>Article 37</strong> This contract shall become effective from the date when Maple Education affixes its seal (contract special seal) and the applicant (or the applicant's legal guardian if the applicant is under 18 years old) signs and pays the service fee. The validity period of this contract is two years.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第三十八条</strong> 若申请人在贰年之后仍然要求继续履行合同，则申请人在取得枫叶留学许可后，与枫叶留学另行签订补充协议。</div>
            <div class="en"><strong>Article 38</strong> If the applicant still requires continued performance of the contract after two years, the applicant shall sign a supplementary agreement with Maple Education separately after obtaining Maple Education's permission.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第三十九条</strong> 本合同正本一式两份，申请人、枫叶留学双方各执一份，各份具有同等效力。</div>
            <div class="en"><strong>Article 39</strong> This contract is made in duplicate originals, with the applicant and Maple Education each holding one copy, each having equal effect.</div>
        </div>

        <!-- PDPA Statement -->
        <div style="margin: 25px 0; padding: 15px; background: #f0f8ff; border: 2px solid #2c5aa0; border-radius: 4px;">
            <div style="font-size: 11pt; font-weight: 700; color: #2c5aa0; margin-bottom: 10px;">数据保护声明 Personal Data Protection Statement</div>
            <div class="cn" style="margin-bottom: 8px;">根据新加坡《个人数据保护法》(Personal Data Protection Act, PDPA)，Maple Education Pte. Ltd. 承诺妥善保护申请人的个人信息，仅用于本合同约定的留学服务目的，不会向第三方泄露或出售申请人的个人信息（法律要求除外）。申请人有权查询、更正或删除其个人信息。如有数据保护相关问题，请联系：Maple@maplesgedu.com</div>
            <div class="en">In accordance with Singapore's Personal Data Protection Act (PDPA), Maple Education Pte. Ltd. commits to properly protecting the applicant's personal information, using it only for the study abroad service purposes stipulated in this contract, and will not disclose or sell the applicant's personal information to third parties (except as required by law). The applicant has the right to inquire about, correct, or delete their personal information. For data protection related inquiries, please contact: Maple@maplesgedu.com</div>
        </div>

        <!-- Signature Section -->
        <div class="signature-section" style="margin-top: 40px;">
            <div class="signature-block">
                <div class="cn" style="font-weight: 600;">委托人（申请人）签名：</div>
                <div class="en" style="font-size: 8.5pt; font-style: italic;">Applicant Signature:</div>
                <div class="signature-line"></div>

                <div class="cn" style="margin-top: 20px;">未满18周岁法定代理人/监护人签名：</div>
                <div class="en" style="font-size: 8.5pt; font-style: italic;">Legal Guardian Signature (if under 18):</div>
                <div class="signature-line"></div>

                <div class="cn" style="margin-top: 20px; font-weight: 600;">签署日期 Date：</div>
                <div>____ 年 __ 月 __ 日 / ___/___/______</div>
            </div>

            <div class="signature-block">
                <div class="cn" style="font-weight: 600;">受托人（盖章）：</div>
                <div class="en" style="font-size: 8.5pt; font-style: italic;">Service Provider (Seal):</div>
                <div class="signature-line">
                    <div style="text-align: center; padding-top: 8px; font-weight: 600; color: #2c5aa0; font-size: 10pt;">
                        Maple Education Pte. Ltd.<br>
                        [公司印章 Company Seal]<br>
                        UEN: 202349302E
                    </div>
                </div>

                <div class="cn" style="margin-top: 20px;">授权代表签字：</div>
                <div class="en" style="font-size: 8.5pt; font-style: italic;">Authorized Representative:</div>
                <div class="signature-line"></div>

                <div class="cn" style="margin-top: 20px; font-weight: 600;">签署日期 Date：</div>
                <div>____ 年 __ 月 __ 日 / ___/___/______</div>
            </div>
        </div>

        <div style="margin-top: 40px; text-align: center; font-size: 9pt; color: #666; padding-top: 20px; border-top: 1px solid #ccc;">
            <div class="cn">--- 合同正文完 ---</div>
            <div class="en" style="margin-top: 4px;">--- End of Contract ---</div>
            <div style="margin-top: 10px; font-size: 8pt;">
                本合同依据新加坡法律及最佳实践标准准备 | This contract has been prepared in accordance with Singapore law and best practices
            </div>
        </div>

    </div>
</body>
</html>
```
