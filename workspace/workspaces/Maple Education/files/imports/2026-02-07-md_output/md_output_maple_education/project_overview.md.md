---
title: "project_overview.md"
source_path: "project_overview.md"
tags: ["合同", "指南", "宣传", "财务", "SOP", "流程", "模板", "表格", "清单", "报告"]
ocr: false
---

# project_overview.md

简介：合同/协议类文件，包含条款、费用、责任与流程说明。

## 内容

```text
# Maple Education – 项目总览 / Project Overview

## 1. 项目定位 Project Purpose
- 本仓库是 Maple Education Pte. Ltd. 的**文件中枢 + 模板 + 工具库**，用于管理合同、报价单、SOP、品牌资产、网站以及内部脚本。
- 面向对象：内部团队（法务、运营、市场、技术）、合作代理，以及未来会接手文档体系的新同事。

## 2. 目录概览 Key Directories
- `01_Legal_and_Contracts/` – 法律文件与合同模板  
  - `Templates/`：HTML 模板 + 对应 `.md` 正文（以 `.md` 为文字「母版」，HTML 负责排版）。  
  - `Drafts/`：具体项目/学生/代理的合同草稿与 PDF。  
  - `Executed/`：已签署/已执行的最终 PDF。
- `02_Internal_SOPs/` – 内部 SOP 与业务流程说明  
  - `SOP_Student_Service_Lifecycle.md`：学生服务主线流程。  
  - `SOP_Document_Flow_ClientFacing.md`：对外文档在各阶段怎么发。  
  - `Guide_Self_Employed_EP_Application.md`：自雇 EP 指南。  
  - `Extracted_MD/`：从历史 DOCX/PDF 提取的参考文本，仅归档使用。
- `02_Operations_and_Data/` – Partner Package 与结构化数据（待逐步充实）。
- `03_Finance_and_Invoices/` – 报价单模板与发票生成页面。
- `04_Brand_Assets/` – Logo、字形、品牌插画与营销素材规划（详见 `Marketing_Brand_Guide.md`）。
- `05_Marketing_Media/` – 面向客户/代理的 PDF 产品手册与文案总览。
- `05_Company_Website/` – WordPress 官网代码 + 本地/测试环境搭建说明。
- `99_System_and_Tools/` – 自动化脚本与信笺 HTML 模板；`Legacy_Tools/` 仅保留历史脚本说明。
- `00_已弃用_Deprecated/` – 已淘汰的旧格式文件和脚本，仅作历史参考。

## 3. 文档层级 Documentation Layers
- 顶层导航：`README.md` – 公司信息、品牌简版规范、目录与典型任务索引。
- 任务与缺口：`TODO.md` – 品牌统一、合同更新、官网与素材的后续工作清单。
- 信笺与 PDF 生成：`LETTERHEAD_README.md` + `01_Legal_and_Contracts/Templates/如何生成PDF.md`。
- 模板正文：各类 `.md` 模板（合同、学生信息表、报价单、SOP 等）是「文字源」，所有对外 PDF 均应从这些模板派生。
- 整理结果：`文件整理完成报告.md` – 2025‑11‑24 时点的整理成果快照。

## 4. 当前共识 Current Conventions
- 新文档一律：**HTML 模板 + 浏览器打印为 A4 PDF**，不再新增 DOCX/TXT 流程。
- 正式联系方式统一为：  
  - Email `Maple@maplesgedu.com` · Website `maplesgedu.com`  
  - SG/WhatsApp `+65 8686 3695` · CN/WeChat `+86 1350 693 8797`
- `00_已弃用_Deprecated/` 与 `02_Internal_SOPs/Extracted_MD/` 下的 `.md` 均视为历史或自动抽取文本，**不作为对外或内部操作的最新依据**；最新流程与条款以本目录下的模板和 SOP 为准。
```
