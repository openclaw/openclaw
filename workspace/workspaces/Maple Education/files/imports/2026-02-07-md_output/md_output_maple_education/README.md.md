---
title: "README.md"
source_path: "README.md"
tags: ["合同", "返佣", "指南", "宣传", "财务", "SOP", "流程", "模板", "表格", "清单"]
ocr: false
---

# README.md

简介：说明文档，介绍该目录/项目用途与使用方式。

## 内容

```text
# Maple Education – Internal Docs Hub
# 枫叶留学内部资料库导航

**Last Updated 最后更新:** 2025-12-01  

---

## 1. Repo Purpose / 项目定位

- Maple Education Pte. Ltd. 的文件中枢 + 模板 + 工具库。  
- 管理合同与法律文件、SOP、运营与财务数据、品牌与营销素材、公司网站代码以及自动化脚本。  
- 面向对象：内部团队（法务 / 运营 / 市场 / 技术）、合作代理以及未来接手文档系统的新同事。  

---

## 2. Quick Company Info / 公司信息

- **Company 公司名称**: Maple Education Pte. Ltd.（新加坡枫叶留学）  
- **UEN**: 202349302E  
- **Registered Address 注册地址**:  
  111 North Bridge Road, #25-01, Peninsula Plaza, Singapore 179098  
- **Website 官网**: `https://maplesgedu.com`  
- **Email 邮箱**: `Maple@maplesgedu.com`  
- **Singapore / WhatsApp**: `+65 8686 3695`  
- **China / WeChat**: `+86 1350 693 8797`  

更多品牌定位与视觉规范见 `04_Brand_Assets/Marketing_Brand_Guide.md`。  

---

## 3. Key Top-Level Files / 顶层重要文件

- `MAPLE_EDUCATION_SUMMARY.md`  
  - 本目录的完整中英双语概览：用途、子目录说明、可直接使用的成品与流程。  
- `Product_Service_Catalog.md`  
  - 可售学校/路线/服务速查表：适用人群、最低要求、定价逻辑、搭售服务与待补充数据。  
- `School_Matchboard.html`  
  - 可筛选年龄/学历/预算的「学校与产品速配板」，并集中下载合同/宣传册。  
- `project_overview.md`  
  - 目录结构与文档层级总览；总结当前共识与约定。  
- `LETTERHEAD_README.md`  
  - 信笺 / 合同 / 发票 HTML 模板说明，以及如何从浏览器打印为 A4 PDF。  
- `TODO.md`  
  - 品牌统一、合同更新、网站与营销素材等中长期任务清单。  
- `文件整理完成报告.md`  
  - 2025‑11‑24 文件整理成果快照与可直接使用的成品列表。  

---

## 4. Directory Map / 目录导航

- `01_Legal_and_Contracts/` – Legal Documents & Contracts / 法律文件与合同  
  - `Templates/`：标准 HTML 模板（合同、学生信息表、代理流程、返佣清单等）。  
  - `Drafts/`：具体项目/学生/代理的草稿。  
  - `Executed/`：已签署或正式使用的 PDF（含 Partner Package）。  

- `02_Internal_SOPs/` – Internal SOPs / 内部流程  
  - `SOP_Student_Service_Lifecycle.md`：学生服务全流程。  
  - `SOP_Document_Flow_ClientFacing.md`：不同阶段对学生与代理发送哪些文件。  
  - `Guide_Self_Employed_EP_Application.md`：自雇 EP 与相关移民服务指南。  
  - `Extracted_MD/`：从历史 DOCX/PDF 抽取的文本，仅供参考，不作为最新依据。  

- `02_Operations_and_Data/` – Operations & Data / 运营与数据  
  - Partner Package 打包文件、结构化数据表与运营报表（逐步完善中）。  

- `03_Finance_and_Invoices/` – Finance & Invoices / 财务与发票  
  - `2025-11-23_INV_Maple_Invoice_AI_Generator.html`：浏览器内发票生成器，可打印为 PDF。  
  - `Template_Quotation_StudyAbroad.md`：留学项目报价单模板。  

- `04_Brand_Assets/` – Brand Assets / 品牌资产  
  - `Brand_Logo_Main.png`：官方透明 PNG Logo（新文档统一使用）。  
  - `Marketing_Brand_Guide.md`：品牌视觉规范与营销素材规划。  

- `05_Marketing_Media/` – Marketing Media / 市场宣传素材  
  - 面向客户和代理的产品手册、PDF、图片与视频等。  

- `05_Company_Website/` – Company Website / 公司官网  
  - `Maple_Group_Site_Structure.md`、`Maple_Group_Site_Content.md` 等文案与结构文件。  
  - `maple-web/`：网站代码与本地运行相关文件。  

- `99_System_and_Tools/` – System & Tools / 系统与工具  
  - `app.py`：图片分类、发票 PDF 生成等工具接口。  
  - `templates/`：通用信笺 / 合同 / 发票 HTML 模板（如 `letterhead_*.html`）。  
  - `Legacy_Tools/`：早期脚本和模板，仅供参考，不推荐用于新流程。  

- `00_已弃用_Deprecated/` – Deprecated Files / 已弃用文件  
  - 旧版 DOCX/TXT、旧发票、旧 Logo 与历史 WordPress 代码，仅作归档使用。  
  - **不要从此目录复制文件作为新文档基础。**  

---

## 5. Document Rules / 文档规范

- **Naming 命名规范**  
  - 建议格式：`YYYY-MM-DD_[TYPE]_[Description]_[Version].[ext]`  
  - 常用类型：`AGT`(Agreement)、`INV`(Invoice)、`DAT`(Data)、`IMG`(Image)、`DOC`(Document)  
  - 示例：`2025-11-23_AGT_AgencyAgreement_v1.0.pdf`  

- **Creation 文档创建原则**  
  - 新的对外合同、表单、发票与信笺文档：  
    - 优先从 `01_Legal_and_Contracts/Templates/` 或 `99_System_and_Tools/templates/letterhead_*.html` 复制。  
    - 偏好使用 `.md` 作为文字母版，HTML 负责版式与信笺。  
  - 不再新增 DOCX/TXT 作为主流程文件；旧版本集中归档于 `00_已弃用_Deprecated/` 或 `02_Internal_SOPs/Extracted_MD/`。  

- **PDF Export 生成 PDF**  
  - 使用 Chrome / Edge 浏览器打开 HTML 模板，直接打印为 PDF：  
    - 纸张：A4；边距：无；缩放：100%；背景图形：开启；页眉/页脚：关闭。  
  - 详细步骤见：  
    - `01_Legal_and_Contracts/Templates/如何生成PDF.md`  
    - `LETTERHEAD_README.md`  

- **Source of Truth 文本源**  
  - 各类 `.md` 模板是条款与文案的来源；所有 PDF 仅作为输出结果。  
  - `00_已弃用_Deprecated/` 与 `02_Internal_SOPs/Extracted_MD/` 下内容仅作为历史参考，不作为当前流程依据。  

---

## 6. Typical Entry Points / 常用入口

- **发送合作伙伴资料包 Partner Package**  
  - 成品：`01_Legal_and_Contracts/Executed/Maple_Education_Partner_Package_Bilingual.pdf`  
  - 相关文件与素材：`02_Operations_and_Data/Partner_Package/`  

- **起草新代理或学生合同 New Contract**  
  - 使用：`01_Legal_and_Contracts/Templates/Template_01_代理合作协议.{md,html}`  
  - 按 `如何生成PDF.md` 与 `LETTERHEAD_README.md` 指南生成最终 PDF。  

- **查看学生服务流程与对外文件节点**  
  - `02_Internal_SOPs/SOP_Student_Service_Lifecycle.md`  
  - `02_Internal_SOPs/SOP_Document_Flow_ClientFacing.md`  

- **生成发票与报价单 Invoices & Quotations**  
  - 发票生成：`03_Finance_and_Invoices/2025-11-23_INV_Maple_Invoice_AI_Generator.html`  
  - 报价单：`03_Finance_and_Invoices/Template_Quotation_StudyAbroad.md`  

- **品牌与营销素材 Brand & Marketing**  
  - 视觉规范与 Logo：`04_Brand_Assets/`（尤其是 `Marketing_Brand_Guide.md`）  
  - 对外宣传 PDF 与多媒体：`05_Marketing_Media/`  

如需更详细的说明或上下文，请优先阅读 `MAPLE_EDUCATION_SUMMARY.md` 与 `project_overview.md`。
```
