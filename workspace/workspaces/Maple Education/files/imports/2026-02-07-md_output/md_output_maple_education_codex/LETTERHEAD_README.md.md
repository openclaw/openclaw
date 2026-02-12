---
title: "LETTERHEAD_README.md"
source_path: "LETTERHEAD_README.md"
tags: ["说明", "模板", "指南", "Maple", "合同", "费用", "md"]
ocr: false
---

# LETTERHEAD_README.md

简介：本文说明 Maple Education 官方信笺模板的文件位置、元素构成、打印规格与使用方法。

## 内容

```text
# Maple Education 信笺模板说明

> 当前正式信笺 HTML 模板位于：`99_System_and_Tools/templates/`  
> 旧版示意 PDF 位于：`99_System_and_Tools/Legacy_Tools/letterhead_template.pdf`

## 模板文件

### 基础模板

- **99_System_and_Tools/templates/letterhead_preview.html** – 基础信笺模板 HTML 文件
- **99_System_and_Tools/Legacy_Tools/letterhead_template.pdf** – 早期信笺模板 PDF 版本（仅作参考）

## 使用说明

**重要：** 这是 Maple Education 的官方信笺模板，以后所有正式文件都应使用此模板作为底板。

### 模板包含的元素：

1. **Header（页眉）**
   
   - Logo（透明背景PNG）
   - 公司名称：Maple Education Pte. Ltd. | 新加坡枫叶留学
   - 分隔线

2. **Watermark（水印）**
   
   - 页面中央的公司Logo水印
   - 透明度：5%
   - 尺寸：600px

3. **Footer（页脚）**
   
   - Email: Maple@maplesgedu.com
   - Website: maplesgedu.com
   - SG: +65 86863695
   - CN: +86 13506938797

### 打印规格

- **纸张大小：** A4 (210mm × 297mm)
- **页边距：** 0（Header和Footer紧贴边缘）
- **内容区域：**
  - 顶部：45mm（Header下方）
  - 底部：20mm（Footer上方）
  - 左右：20mm

### 如何使用

1. 复制 `letterhead_preview.html` 作为新文档的基础
2. 在 `content-area` div 中添加你的内容
3. 打印或导出PDF时选择A4纸张，边距设为0

### 专用模板

- **letterhead_invoice.html** - 发票模板（右上角显示"Invoice"）
- **letterhead_contract.html** - 合同模板（右上角显示"Contract"）

---

**创建日期：** 2025-11-23
**Logo文件：** 04_Brand_Assets/Brand_Logo_Main.png
```