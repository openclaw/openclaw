---
title: "TODO.md"
source_path: "TODO.md"
tags: ["合同", "返佣", "财务", "流程", "模板", "表格", "清单", "说明", "服务", "新加坡"]
ocr: false
---

# TODO.md

简介：内容概述：# Maple Education Project TODO

## 内容

```text
# Maple Education Project TODO

## 1. Brand & Letterhead 品牌与信笺
- 在 `04_Brand_Assets/` 补齐透明版主 Logo（PNG），命名为 `Brand_Logo_Main.png`，并保留 JPG 作为参考或移入 `00_已弃用_Deprecated/04_Brand_Old_Assets/`。（✅ PNG 已补齐，后续考虑迁移旧 JPG）
- 确认 `Brand_Letterhead_A4.png` 是否为正式信笺背景；如有新版本，替换并在 `LETTERHEAD_README.md` 中更新说明。
- 统一说明：所有合同/发票/说明文档应使用透明 PNG Logo + A4 信笺背景。
 - 在主 `README.md` 中补充「Brand & Visual Guidelines」小节，简要列出字体、字号、主色/辅色/灰度色号、A4 内容区域与 Header/Footer 规范，并列出现有 Logo 资产。
 - 梳理并统一颜色体系：对齐 HTML 模板中的 `#2c5aa0`、`#333/#666/#888` 与营销文档中提到的枫叶红 `#C1272D`、深蓝 `#0F2B46`、浅灰 `#F4F6F8`，确定一套官方色板并写入 README。
 - 后续逐步更新各 HTML 模板与脚本（例如 `Template_01_代理合作协议.html` 仍引用 JPG Logo）统一使用 `Brand_Logo_Main.png` 与官方色板，并记录进度。 

## 2. Legal & Contracts 法务与合同
- 按 `01_Legal_and_Contracts/README.md` 的说明，优先使用 HTML 模板（`Templates/*.html`）+ 浏览器打印生成 PDF，不再新增 DOCX/TXT 版本。
- 为以下场景明确使用哪份模板：
  - 代理合作协议：`Template_01_代理合作协议.html`
  - 学生信息表：`Template_02_学生信息收集表.html`（配合微信在线表单）
  - 代理工作流程说明：`Template_03_代理工作流程.html`
  - 返佣项目清单：`Template_04_返佣项目清单.html`
- 如需一次性打包合作资料，使用 `99_System_and_Tools/Script_Generate_Partner_Package.py` 生成 `Maple_Education_Partner_Package_Bilingual.pdf`。
- 给 `01_Legal_and_Contracts/Executed/` 中的已签合同统一命名（`YYYY-MM-DD_AGT_...[Bilingual].pdf`），旧版本移动至 `00_已弃用_Deprecated/01_Legal_Executed_Old_Versions/`。
- 统一所有合同模板的主体信息与个人资料保护条款：
  - 删除现有模板中以 Maple Education 为“甲方”的写法，统一改为“乙方：Maple Education Pte. Ltd.”，对方当事人按实际情况填写为客户/代理/合作院校等法定名称。
  - 在合同页眉或封面按品牌规范加入公司标识与 ACRA 图标（`04_Brand_Assets/acra.png`），并列出标准联系方式：Email `Maple@maplesgedu.com`、Website `maplesgedu.com`、SG 电话 `+65 86863695`、CN 电话 `+86 13506938797`，以及 Director `Leonard Chow Yi Ding`。
  - 为涉及学生或合作方个人资料的条款增写 PDPA（新加坡个人资料保护法）相关内容，涵盖同意授权（Consent）、使用目的与范围（Purpose Limitation）、通知义务（Notification）、数据保留与销毁（Retention）、访问与更正权利（Access & Correction）以及必要时的跨境资料传输说明，整体措辞对齐新加坡常见商业合同风格。
  - 按合同类型拆解为具体待办，逐份更新：
    - `Templates/Template_01_代理合作协议.html`（代理合作协议）：
      - 调整主体设置：将合作代理/渠道方设为甲方，将 Maple Education Pte. Ltd. 明确设定为乙方（服务提供方）；同步修改首页 Party A/B 信息块及签署页中的 Party A/B 顺序与中文“甲方/乙方”标注。
      - 全文检索并梳理 Party A/Party B 相关表述（责任、权利、违约条款），在不改变商业结构的前提下，确保“乙方＝Maple Education Pte. Ltd.” 在中英文中保持一致，避免语义混乱。
      - 将页眉水印与 Logo 统一替换为透明版 `Brand_Logo_Main.png`，在公司名称下方或右侧小尺寸加入 ACRA 图标 `acra.png`，整体风格符合 `Brand & Visual Guidelines`。
      - 统一页脚联系方式：`Email: Maple@maplesgedu.com | Website: maplesgedu.com | SG: +65 86863695 | CN: +86 13506938797`，替换现有 `Mapleedusg.com` 等旧写法。
      - 复核并精炼第 2 章合作范围、第 5 章佣金与结算、第 7 章个人资料与保密条款的英文 & 中文表达，使其符合新加坡商业合同常见用语（例如 “on a best-efforts basis”, “subject to applicable laws”, “without prejudice to any other rights and remedies” 等）并与 PDPA 要求对齐。
      - 审阅第 7.3 条 PDPA 合规条款，在现有基础上补充个人资料主体的权利（访问、更正、撤回同意、投诉渠道）以及在需要跨境传输时的保护措施说明。
    - `Templates/Template_02_学生信息收集表.html`（学生信息收集表）：
      - 修正页脚域名为 `maplesgedu.com`，与公司信息 README 保持一致。
      - 在表格末尾增加一段简短 PDPA 同意与通知声明（中英双语），说明：信息用途（用于留学咨询与申请服务）、披露对象（合作院校与必要的服务提供方）、保存期限与删除规则，以及学生查询/撤回同意的联系方式（统一指向 Maple 官方邮箱与 WhatsApp/WeChat）。
      - 检查表头的公司名称、Logo 引用路径是否已全部指向透明版 `Brand_Logo_Main.png`，如仍使用 JPG 或旧版水印，统一替换。
    - `Templates/Template_03_代理工作流程.html`（代理合作标准流程）：
      - 在文首标题下增加一句说明：“本流程文件为《代理合作协议》的配套操作指引，不单独构成服务承诺或法律义务。”（中英对照），避免被误解为独立合同。
      - 全文检查 Party A/Party B 表述，明确：Maple Education Pte. Ltd. 为乙方（服务提供方），代理为甲方（推荐方）；如有与主协议角色不一致的地方，统一调整措辞。
      - 统一页脚联系方式及域名为最新版标准格式，并确保 Logo 与水印采用 `Brand_Logo_Main.png`。
      - 在“七、数据与保密”部分补充一小段 PDPA 说明，强调双方在处理学生及合作方个人资料时必须遵守新加坡 PDPA 及各自所在司法辖区的数据保护法，且数据使用仅限于代理合作所需的合理范围。
    - `Templates/Template_04_返佣项目清单.html`（返佣项目清单）：
      - 将页眉 Logo/水印替换为透明版 `Brand_Logo_Main.png`，必要时在标题区域加入小号 `acra.png`，以体现正式公司主体而非个人渠道价格表。
      - 在文首增加简短说明：“本返佣项目清单为 Maple Education Pte. Ltd. 与授权代理合作使用，具体返佣金额与比例以双方签署的《代理合作协议》及院校实际结算为准，不构成对任何第三方的要约。”（中英双语）。
      - 在文末增加风险与调整条款，明确如因院校政策调整、汇率波动或上游佣金变更导致费用变化，Maple 有权在合理范围内调整返佣比例，并提前以书面形式通知代理。
      - 统一页脚联系方式和域名为最新规范，并检查所有出现 “Mapleedusg.com” 的地方统一改为 `maplesgedu.com`。
    - `Drafts/Contract_01_Study_Abroad_Service_Agreement.html` 等留学服务合同草稿：
      - 对照最新 HTML 模板与品牌规范，确认正文中已不再使用“甲方/乙方”结构，而是以“申请人 / Maple Education Pte. Ltd.” 作为合同双方称谓；如发现残留“甲方/乙方”表述，全部删除或改为明确的当事人名称。
      - 逐条审阅收费条款、退费条款、违约责任条款的中英文翻译，确保逻辑、金额与责任划分一致，并符合新加坡常见留学服务合同的写法（例如明确无签证退款规则、学生自身原因导致违约的处理方式等）。
      - 检查并完善数据保护声明：在现有 PDPA 文本基础上，增加对资料保留期限、访问/更正流程、投诉渠道（例如 PDPC 或公司内部数据保护联络点）的说明。
      - 确认每页页脚中的公司名称、UEN、注册地址、联系方式与 `01_Legal_and_Contracts/README.md` 中的公司信息完全一致，必要时统一更新。

## 3. Operations & Data 运营与数据
- 在 `02_Operations_and_Data/` 下建立：
  - `Partner_Package/`：存放可直接发给代理的打包 PDF（由 Partner Package 脚本生成）。
  - `Student_Data/`：学生信息汇总表（Excel/CSV），字段参考 `02_Internal_SOPs/SOP_Student_Service_Lifecycle.md`。
- 在 README 中写清楚：所有学生必须先填写微信在线表单，再根据需要生成/打印 HTML 学生信息表。

## 4. Finance & Invoices 财务与发票
- 统一发票生成方式：
  - 如使用 AI 页面：`03_Finance_and_Invoices/2025-11-23_INV_Maple_Invoice_AI_Generator.html`（浏览器打开→填写→打印为 PDF）。
  - 或使用 `99_System_and_Tools/app.py` 中的发票 PDF 逻辑（需本机 Python 环境与字体）。
- 检查并在 README 中标明目前推荐的发票流程，以及发票文件命名规范：`YYYY-MM-DD_INV_[Client]_[Number].pdf`。

## 5. Internal SOP 内部流程
- 将以下 SOP 与 README 对应起来，让新人知道去哪看：
  - 留学主线服务流程：`02_Internal_SOPs/SOP_Student_Service_Lifecycle.md`
  - 自雇 EP / 公司设立流程：`02_Internal_SOPs/Guide_Self_Employed_EP_Application.md` + `中国客户办理新加坡自雇EP完整指南.txt`
  - 营销素材与文案生成：`02_Internal_SOPs/内容素材生成计划与Prompt.md`
- 在 README 中增加 “典型任务 → 查看哪个 SOP/模板” 的索引。

## 6. Marketing Media 市场素材
- 对 `05_Marketing_Media/` 归类：
  - 原始拍摄（Raw）
  - AI 放大/处理后（ai_upscaled）
  - 对外可公开成片（Selected）
- 可选：运行 `99_System_and_Tools/app.py` 提供的图片分类服务，将新素材自动归入子目录。

## 7. Website 官网
- 根据 `05_Company_Website/TODO.md`，收集：
  - 数据库备份（.sql）
  - `wp-content/uploads` 媒体
  - 实际使用的主题与插件
- 完成本地或测试环境搭建后，在 README 中补充 “如何更新官网内容/谁负责” 的说明。

## 8. Legacy & Cleanup 旧文件与清理
- `00_已弃用_Deprecated/` 内所有 DOCX/TXT/PDF 仅作历史参考，明确在 README 中标注 “不要基于此创建新文件”。
- `99_System_and_Tools/Legacy_Tools/` 仅在需要回溯 DOCX 流程时使用；在 README 中标记为 Legacy，不再推荐。
- 定期检查根目录散落文件（如单独的 PPT、PDF），按业务归入对应子目录或移动到 Deprecated。 

## 9. Brand Illustrations & Website UI 品牌插画与网站素材
- 基于 `99_System_and_Tools/brand_asset_prompts.json` 设计一整套素材类别：
  - 吉祥物贴纸与动作组（表情、姿势、道具）；
  - 合作院校景观卡通版（Kaplan、PSB、Amity、NUS、NTU 等）；
  - 吉祥物 + 校园组合场景（用于网站 Banner / 宣传海报）；
  - 网站 UI 元素（卡片边框、分割线、标签、按钮/CTA、icon 小图标）；
  - 标题艺术字 / Section Header 装饰。
- 检查并修正 `Script_Generate_Images_Local.py` 与 `brand_asset_prompts.json` 的 `category` 不一致问题（例如 `"School Landmark"` vs `"School Landmarks"`），确保生成脚本能正确跑通。
- 在 `04_Brand_Assets/Generated_Images/` 下约定命名规范与子目录（如 `Mascots/`, `Schools/`, `UI/`, `Banners/`），并在 README 或单独 `README_Brand_Assets.md` 中文档化。
- 为网站与合同选定一小套“官方素材组合”（例如每个合作院校 1–2 张卡通景观，吉祥物 8–10 个经典动作），避免素材过多导致体验混乱。 

## 10. Website Content & WordPress 实施
- [ ] 根据 `05_Company_Website/Maple_Group_Site_Structure.md` 和 `Maple_Group_Site_Content.md`，为 **Home `/`** 页面写出完整中文文案（Hero、三大服务卡片、流程、CTA），整理到一个专用内容文件（例如 `05_Company_Website/content_home.md`），方便粘贴进 WordPress。
- [ ] 为 **Study Abroad `/study-abroad`** 总页撰写完整文案（介绍 Maple Education、三条主线入口、管家服务提示、费用计算器引导），输出到 `content_study_abroad.md`。
- [ ] 分别为低龄子页：  
  - `/study/k12-international`（国际学校路线）  
  - `/study/k12-public-aeis`（公立 + AEIS 路线）  
  写出分段清晰的页面文案（路径说明、合作学校列表、服务模块、FAQ），各用一个内容文件（`content_k12_international.md` / `content_k12_public_aeis.md`）。
- [ ] 为 **新二/衔接 `/study/new2-path`** 和 **合作办本科 `/study/dual-degree-path`** 各写一份页面文案，包含典型路径示例（如“新二 + Kaplan + UCD → NUS 硕士”）和对 NUS/NTU 等目标院校的免责声明。
- [ ] 为 **Schools `/schools`** 列表页写一个结构化介绍（分类卡片），并至少完成三所重点私立合作院校的详情页文案草稿：Kaplan、PSB、Amity（`/schools/kaplan`, `/schools/psb`, `/schools/amity`），每页包含学校简介、合作大学、主要课程、适合人群、与 Maple 的合作方式、后续路径链接。
- [ ] 为 **Immigration & Work Passes `/immigration-workpasses`** 及其子页撰写完整内容：  
  - `student-pr`（学生证申请 PR）  
  - `self-employed-ep`（自雇 EP / 开公司）  
  - `workpasses-overview`（WP/S Pass/EP 对比）  
  - `dependants`（家属 DP/LTVP 与陪读签证）  
  - `investment`（投资与长期规划信息页）  
  明确每页的风险提示和与留学/管家页面的交叉链接。
- [ ] 为 **Butler & Concierge `/butler-concierge`** 写出完整页面文案，按“孩子管理 / 成年人支持 / 地接服务”三块结构组织，复用并扩展 `Deck_Maple_Group_Concierge.md` 中的要点。
- [ ] 设计并文档化 **费用计算器 `/calculators`** 的用户文案和字段说明（不写代码）：包含输入项（路径、学校、住宿类型、生活档位）、输出示例（按年份拆分的总费用）以及以 NUS 硕士为例的目标导向对比说明。
- [ ] 为 **Resources `/resources`**、**About `/about`**、**Contact `/contact`** 各写一份页面文案草稿，确保：  
  - Resources 中的文章分类与现有 SOP/指南对应；  
  - About 清楚说明 Maple Group / Maple Education 的关系与合规立场；  
  - Contact 页的表单字段与 PDPA 简版隐私声明一致。
- [ ] 在完成上述内容文件后，整理一份给 WordPress 实施方或 `cl`（Claude Code）的执行说明（例如 `05_Company_Website/IMPLEMENTATION_NOTES.md`），列出：  
  - 每个页面对应的 Markdown 源文件路径；  
  - 需要在 WP 中创建的页面 slug / URL；  
  - 需要上传或准备的图片列表（路径、建议分辨率、用途），便于前端或主题开发一次性对齐。
```
