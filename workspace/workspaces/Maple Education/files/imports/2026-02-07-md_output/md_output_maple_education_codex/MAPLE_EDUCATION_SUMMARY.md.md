---
title: "MAPLE_EDUCATION_SUMMARY.md"
source_path: "MAPLE_EDUCATION_SUMMARY.md"
tags: ["总结", "说明", "指南", "SOP", "计划", "合同", "财务", "Maple", "md"]
ocr: false
---

# MAPLE_EDUCATION_SUMMARY.md

简介：该文档是枫叶留学资料库的总览，概述目录结构、关键文件、流程模板与后续重点。

## 内容

```text
# Maple Education Repository Summary / 枫叶留学资料库总览

**Generated 生成时间:** 2025-12-01  
**Scope 范围:** Windows Desktop 目录 `maple education/` – Maple Education Pte. Ltd. 的文件中枢、模板库、内部脚本与品牌资产集合。

---

## 1. High-Level Purpose / 项目定位

- 为 Maple Education 枫叶留学（一站式留学与延伸服务）集中管理：合同与法律文件、学生与代理流程 SOP、财务与发票、品牌与营销素材、公司网站代码、以及自动化工具。
- 面向对象：内部团队（法务 / 运营 / 市场 / 技术）、合作代理，以及未来接手文档系统的新同事。
- 文档风格：中英双语为主，所有正式对外 PDF 建议从 HTML 模板 + 浏览器打印 A4 的统一信笺系统生成。

---

## 2. Key Top-Level Files / 顶层重要文档

- `README.md`  
  - 公司简介、联系方式与品牌简版规范（字体、字号、色板、A4 布局、Header/Footer 规则）。  
  - 目录结构说明 + 典型任务导航（例如：给代理发资料包、让学生填表、生成发票、查看官网文件等）。  
  - 约定：新文档一律使用 HTML 模板 + 浏览器打印 PDF，不再新增 DOCX/TXT 流程。

- `project_overview.md`  
  - 总览整个仓库的定位（文件中枢 + 模板 + 工具库）与各子目录职责。  
  - 说明文档层级：顶层 README、TODO、信笺说明、各类模板 `.md` 作为「文字母版」、以及整理结果快照。

- `TODO.md`  
  - 按模块列出后续工作：品牌与信笺统一、合同模板与命名规范、运营/数据结构化整理、官网内容与技术改造、营销素材规划等。  
  - 可视作中长期工作清单和优先级参考。

- `LETTERHEAD_README.md`  
  - 详细说明信笺/合同/发票 HTML 模板的结构、引用的 A4 背景图 (`Brand_Letterhead_A4.png`) 与 Logo、以及浏览器打印为 PDF 的具体设置。  
  - 指向 `99_System_and_Tools/templates/letterhead_*.html` 和 `01_Legal_and_Contracts/Templates/如何生成PDF.md` 作为完整使用手册。

- `文件整理完成报告.md`  
  - 2025-11-24 时点的文件整理成果快照：已完成事项、生成的 PDF 文件列表、Partner Package 的最终状态、以及目录结构优化结果。  
  - 明确目前有哪些可直接使用的成品（例如最新代理协议 PDF、Partner Package、透明 PNG Logo 等）。

---

## 3. Directory Overview / 目录一览

### `00_已弃用_Deprecated` – Deprecated Files / 已弃用文件

- 作用：归档已被统一 HTML+信笺体系取代的旧格式（DOCX/TXT/PDF）以及旧版 Logo、旧发票等；仅供历史参考。  
- 子目录：  
  - `01_Legal_*` – 旧版法律模板、草稿、已执行合同与相关 TXT/PDF。  
  - `03_Finance_Old_Invoices/` – 旧发票示例与 JPG Logo。  
  - `04_Brand_Old_Assets/` – 老版 `Brand_Logo_Main.jpg`。  
  - `wordpress/` – 历史 WordPress 站点代码。  
- 提示：**不要使用此目录中的文件创建新文档**，最新模板在 `01_Legal_and_Contracts` 与 `99_System_and_Tools/templates` 中。

### `01_Legal_and_Contracts` – Legal Documents & Contracts / 法律文件与合同

- `Templates/` – 法务与合作伙伴使用的标准 HTML 模板（A4 + 信笺）：  
  - `Template_01_代理合作协议.{md,html}` – 代理合作协议（完整 8–9 页，中英双语）。  
  - `Template_02_学生信息收集表.{md,html}` – 学生信息收集表，配合微信在线表单或打印纸质版本。  
  - `Template_03_代理工作流程.{md,html}` – 标准代理工作流程说明。  
  - `Template_04_返佣项目清单.{md,html}` + `Template_04_返佣项目清单_sample.xlsx` – 各国家院校及返佣比例清单。  
  - `pdf_output*` / `pdf_output_letterhead/` – 各模板生成的 PDF 示例（含信笺背景版本与合并版）。  
  - `如何生成PDF.md` – 浏览器打印设置的详细步骤和注意事项。
- `Drafts/` – 留学服务合同草稿（HTML/PDF/MD），主要是历史从 DOCX 迁移过来的版本。  
- `Executed/` – 已签署或正式使用的合同与 Partner Package PDF（例如：`Maple_Education_Partner_Package_Bilingual.pdf`、具体学生合同等）。

### `02_Internal_SOPs` – Internal SOPs / 内部流程说明

- 核心 SOP 文档：  
  - `SOP_Student_Service_Lifecycle.md` – 学生服务全流程，从咨询到落地与后续服务。  
  - `SOP_Document_Flow_ClientFacing.md` – 不同阶段给学生与代理发送哪些文件、使用哪些模板。  
  - `Guide_Self_Employed_EP_Application.md` + `中国客户办理新加坡自雇EP完整指南.txt` – 面向中国客户的自雇 EP 详解。  
  - `内容素材生成计划与Prompt.md` – 内容与营销素材的生成计划与提示词设计。
- `Extracted_MD/` – 从历史 DOCX/PDF 中抽取的参考文本，仅用于查阅旧内容；不作为最新操作依据。

### `02_Operations_and_Data` – Operations & Data / 运营与数据

- 目前主要包含：  
  - `Partner_Package/` – 已整理好的合作代理资料包（多份 PDF + Logo），可直接压缩后发送给新代理。  
- 后续建议：逐步加入结构化学生/代理数据（Excel/CSV）与运营报表，并与 SOP 保持一致。

### `03_Finance_and_Invoices` – Finance & Invoices / 财务与发票

- `2025-11-23_INV_Maple_Invoice_AI_Generator.html` – 浏览器端发票生成页面，结合信笺背景打印为 PDF。  
- `Template_Quotation_StudyAbroad.md` – 留学项目报价单模板，可贴入信笺 HTML 或 Word 后发给客户。  
- 与 `99_System_and_Tools/app.py` 的发票生成函数配合，可在本地通过 Flask + ReportLab 自动生成带信笺背景的 PDF 发票。

### `04_Brand_Assets` – Brand Assets / 品牌资产

- Logo 与视觉主素材：  
  - `Brand_Logo_Main.png` – 透明背景主 Logo，所有新合同/发票/宣传物料建议统一使用。  
  - `Brand_Letterhead_A4.png` – A4 信笺背景图，用于 HTML 模板与发票生成。  
  - `Brand_Mascot_Main.jpeg` / `Brand_Mascot_CharacterSheet.jpeg` – 吉祥物主视觉与角色设定。  
  - `acra.png` – ACRA 相关图像（非 Logo）。  
- 图片库：  
  - `Source_Images/` – 学校与场地原始照片。  
  - `Generated/` / `Generated_Images/` – 预留给 AI 生成或处理后的品牌图。  
- `Marketing_Brand_Guide.md` – 更完整的品牌与营销视觉指南。

### `05_Marketing_Media` – Marketing Media / 市场宣传素材

- PDF 与文案：  
  - `ACADEMY.pdf`、`Maple 留学产品宣传手册.pdf`、`枫叶留学境外管家服务.pdf` 等对外宣传资料及其 `.txt` 抽取版本。  
  - `README_Products.md` – 产品/服务线总览与对应宣传文档说明。  
  - `Deck_Maple_Group_Concierge.md`、`Flyer_Overseas_Butler_Service.md`、`Flyer_StudyAbroad_Overview.md` – 文案与宣传单页草稿。  
- 媒体素材：多段校园/教室/活动视频与照片（MOV/HEIC/PNG/JPG）。  
- 子目录：  
  - `ai_upscaled/` – 经过 AI 放大/增强的图片。  
  - `Confirmed_Text/` – 确认过的对外文案。  
  - `Unsorted/` – 临时素材，建议结合 `99_System_and_Tools/app.py` 进行分类归档。

### `05_Company_Website` – Company Website / 公司官网

- `maple-web/` – 官网前端代码（Next.js/React），包含 `.next` 构建输出与 `node_modules` 依赖。  
- 内容与规划：  
  - `Maple_Group_Site_Structure.md` – 网站信息架构与导航设计。  
  - `Maple_Group_Site_Content.md` + 多个 `content_*.md` – 各频道/产品页面的详细文案（留学、本科项目、K12、公立学校考试等）。  
  - `DEEPSEEK_TASKS.md`、`WEBSITE_IMPROVEMENT_PLAN.md`、`TODO.md` – 已完成与待完成的网站改版任务清单。  
  - `README_Website_Setup.md` – 在本地运行、构建和部署网站的步骤说明。

### `99_System_and_Tools` – System Scripts & Templates / 系统脚本与模板

- 应用与脚本：  
  - `app.py` – Flask Web 应用：  
    - 使用 CLIP 模型对 `05_Marketing_Media` 中的图片按「Classroom / Campus / Students / Mascot / Other」等标签自动分类并重命名。  
    - 使用 ReportLab + `Brand_Letterhead_A4.png` 生成带信笺背景、自动编号的发票 PDF（输出到 `03_Finance_and_Invoices`）。  
  - `Script_Generate_PDFs.py` – 旧流程：从 Drafts 中读取文本、调用 Gemini 翻译并生成双语 PDF（目前标记为 Legacy/高级用）。  
  - `Script_Generate_Partner_Package.py` – 读取 4 个 HTML 模板，合并生成 `Maple_Education_Partner_Package_Bilingual.pdf`。  
  - `Script_Review_Contracts.py` + `Report_Contract_Review_Last.md` – 使用 AI 审阅合同并输出审阅报告。  
  - `Script_Extract_Documents_To_MD.py` – 从 DOCX/PDF 批量抽取文本到 `02_Internal_SOPs/Extracted_MD/`。  
  - `Script_Generate_Images_Local.py` / `Script_Generate_Brand_Prompts.py` / `Script_Download_Source_Images.py` – 品牌图像生成与素材下载辅助脚本。  
- `templates/` – 通用信笺/合同/发票 HTML 模板（例如 `letterhead_preview.html`、`letterhead_invoice.html`、`letterhead_contract.html` 等）。  
- `Legacy_Tools/` – 旧版 `contract-tools` 与早期信笺模板，仅作参考，不推荐在新流程中使用。  
- `venv` / `venv_gpu` – Python 虚拟环境（Windows/WSL 本地开发使用）。

---

## 4. Ready-to-Use Packages & Workflows / 可直接使用的成品与流程

- **Partner Package 合作伙伴资料包**  
  - 模板来源：`01_Legal_and_Contracts/Templates/Template_01~04_*.html`。  
  - 成品位置：`02_Operations_and_Data/Partner_Package/` 以及 `01_Legal_and_Contracts/Executed/Maple_Education_Partner_Package_Bilingual.pdf`。  
  - 内容包含：代理合作协议、返佣项目清单（新加坡/马来西亚/泰国）、代理工作流程、学生信息收集表、Logo 与使用说明。

- **Standard Contracts & Forms 标准合同与表单**  
  - 所有新合同与学生表单应从 `01_Legal_and_Contracts/Templates/` 中选用对应 HTML 模板，按 `如何生成PDF.md` 的指引在浏览器中打印为 PDF。  
  - 学生信息通过微信在线表单收集，HTML 表单用于打印空白表或与合作方分享字段结构。

- **Invoices & Quotations 发票与报价单**  
  - 浏览器前端：`03_Finance_and_Invoices/2025-11-23_INV_Maple_Invoice_AI_Generator.html`。  
  - 后端脚本：在 `99_System_and_Tools/app.py` 中通过 `/generate_invoice` 接口生成 PDF。  
  - 报价单：使用 `Template_Quotation_StudyAbroad.md` 作为文本母版，套用信笺模板排版。

- **Internal SOPs & Self-Employed EP 内部流程与自雇 EP**  
  - 学生服务主流程与对外文档节点：见 `02_Internal_SOPs/SOP_Student_Service_Lifecycle.md` 与 `SOP_Document_Flow_ClientFacing.md`。  
  - 中国客户自雇 EP 与相关移民服务：见 `Guide_Self_Employed_EP_Application.md` 与配套中文长文档。

- **Brand & Marketing 品牌与营销**  
  - Logo、信笺与吉祥物：集中在 `04_Brand_Assets/`。  
  - 营销 PDF 与视频素材：集中在 `05_Marketing_Media/`，可配合 `99_System_and_Tools/app.py` 进行图片分类。  
  - 品牌视觉规范：见 `README.md` 的简版与 `Marketing_Brand_Guide.md` 的完整版。

- **Website Content 官网内容与改版计划**  
  - 页面文案与结构：`05_Company_Website/Maple_Group_Site_Structure.md`、`Maple_Group_Site_Content.md` 和各 `content_*.md`。  
  - 技术与 UI 待办：`05_Company_Website/WEBSITE_IMPROVEMENT_PLAN.md` 与 `TODO.md`。

---

## 5. Conventions & Next Steps Snapshot / 约定与后续重点

- **Naming Convention 命名规范**  
  - 推荐格式：`YYYY-MM-DD_[TYPE]_[Description]_[Version].[ext]`，例如：`2025-11-23_AGT_AgencyAgreement_v1.0.pdf`。  
  - 常用类型代码：`AGT`(Agreement)、`INV`(Invoice)、`DAT`(Data)、`IMG`(Image)、`DOC`(Document)。

- **Document Creation Rules 文档创建原则**  
  - 新文档：建议统一使用 HTML 模板 + 浏览器打印为 A4 PDF，搭配 `Brand_Logo_Main.png` 与信笺背景。  
  - 不再新增 DOCX/TXT 作为主流程文件；旧版本集中归档于 `00_已弃用_Deprecated/` 或 `02_Internal_SOPs/Extracted_MD/`。

- **Official Contact Info 官方联系方式**  
  - Email: `Maple@maplesgedu.com` · Website: `https://maplesgedu.com`  
  - SG / WhatsApp: `+65 8686 3695` · CN / WeChat: `+86 1350 693 8797`

- **Next-Step Focus (from TODO) 后续重点方向（摘自 TODO）**  
  - 进一步统一所有 HTML 模板的 Logo 与色板，消除残留 JPG Logo 与旧色值。  
  - 给 `01_Legal_and_Contracts/Executed/` 里的历史合同统一重命名并迁移旧版到 `00_已弃用_Deprecated/`。  
  - 丰富 `02_Operations_and_Data/` 中的结构化数据与统计报表。  
  - 按网站改版计划持续更新 `05_Company_Website/maple-web` 代码与内容文档。  
  - 梳理与升级营销素材（例如 Partner Deck、短视频脚本、说明书），与品牌视觉规范保持一致。
```