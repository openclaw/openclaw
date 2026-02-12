---
title: "如何生成PDF.md"
source_path: "01_Legal_and_Contracts/Templates/如何生成PDF.md"
tags: ["合同", "说明", "md"]
ocr: false
---

# 如何生成PDF.md

简介：内容概述：# 如何正确生成PDF文件

## 内容

```text
# 如何正确生成PDF文件
# How to Generate PDF Files Correctly

## ⚠️ 重要 Important

**不要使用命令行工具生成PDF！**
**DO NOT use command-line tools to generate PDF!**

wkhtmltopdf等工具无法正确渲染我们的letterhead格式。
Command-line tools like wkhtmltopdf cannot properly render our letterhead format.

## ✅ 正确方法 Correct Method

### 方法一：使用Chrome浏览器（推荐）

1. **打开HTML文件 Open HTML File**
   - 双击HTML文件，用浏览器打开
   - 或右键 → "打开方式" → Chrome/Edge

2. **打开打印对话框 Open Print Dialog**
   - 按 `Ctrl + P` (Windows) 或 `Cmd + P` (Mac)
   - 或点击浏览器菜单 → 打印

3. **设置打印选项 Configure Print Settings**
   ```
   目标 Destination: 保存为PDF (Save as PDF)
   纸张大小 Paper size: A4
   边距 Margins: 无 (None)
   背景图形 Background graphics: ✓ 启用 (Enabled)
   页眉和页脚 Headers and footers: ✗ 关闭 (Disabled)
   缩放 Scale: 100% (默认 Default)
   ```

4. **保存PDF Save PDF**
   - 点击"保存"按钮
   - 选择保存位置
   - 命名格式：`YYYY-MM-DD_[Type]_[Description].pdf`

### 方法二：使用Microsoft Edge

步骤与Chrome完全相同。
Steps are identical to Chrome.

### 方法三：使用Firefox

1. 打开HTML文件
2. `Ctrl + P` 打开打印
3. 目标选择"Microsoft Print to PDF"或"保存为PDF"
4. 设置：
   - 纸张：A4
   - 边距：无
   - 打印背景：启用
5. 保存

## 📋 打印设置详解

### Chrome/Edge 设置截图说明

**必须设置的选项：**

1. **目标 (Destination)**
   - ✅ 选择"保存为PDF"
   - ❌ 不要选择实体打印机

2. **纸张大小 (Paper size)**
   - ✅ A4 (210 x 297 mm)
   - ❌ 不要用Letter或其他尺寸

3. **边距 (Margins)**
   - ✅ 无 (None) / 最小 (Minimum)
   - ❌ 不要用默认边距
   - **这很重要！** 我们的header和footer需要紧贴边缘

4. **背景图形 (Background graphics)**
   - ✅ **必须勾选！**
   - 否则logo、水印和背景颜色都不会显示

5. **页眉和页脚 (Headers and footers)**
   - ✅ **必须取消勾选！**
   - 否则会显示浏览器自动添加的日期/页码

6. **缩放 (Scale)**
   - ✅ 保持100% (默认)
   - ❌ 不要调整缩放

### 高级设置（可选）

**更多设置 (More settings) → CSS媒体类型**
- 可以选择"打印"，但通常不需要改动

## 🎯 质量检查 Quality Check

生成PDF后，请检查：

✅ **正确的标志 Correct Signs:**
- Logo清晰可见在左上角
- Header紧贴页面顶部
- Footer紧贴页面底部
- 中央有淡淡的水印
- 右上角有蓝色的"CONTRACT"或其他标题
- 中英文对照格式正确
- 所有文字清晰可读

❌ **错误的标志 Wrong Signs:**
- 内容挤在一起
- 没有logo或水印
- Header/Footer位置不对
- 有多余的页眉页脚（如日期、页码）
- 文字模糊或重叠
- 颜色不对

## 📱 移动设备说明

如果在移动设备上需要生成PDF：

**iOS (iPhone/iPad):**
1. 用Safari打开HTML文件
2. 点击分享按钮
3. 选择"打印"
4. 双指放大预览
5. 点击分享 → 存储为PDF

**Android:**
1. 用Chrome打开HTML文件
2. 点击菜单（三个点）
3. 选择"打印"
4. 目标选择"保存为PDF"
5. 下载PDF

## 🔧 常见问题 Troubleshooting

### Q: PDF中没有显示logo和背景？
**A:** 确保勾选了"背景图形 (Background graphics)"选项。

### Q: 页面顶部或底部有多余的文字（日期、URL等）？
**A:** 取消勾选"页眉和页脚 (Headers and footers)"选项。

### Q: Header和Footer没有紧贴边缘？
**A:** 将边距设置为"无 (None)"。

### Q: 内容显示不完整或被裁切？
**A:**
1. 检查纸张大小是否为A4
2. 检查缩放是否为100%
3. 确保使用Chrome或Edge浏览器

### Q: 中文显示为乱码或方块？
**A:**
1. 确保使用现代浏览器（Chrome/Edge/Firefox最新版）
2. 系统需要安装中文字体

### Q: 能否直接编辑PDF？
**A:**
- 不建议直接编辑PDF
- 应该编辑HTML源文件，然后重新生成PDF
- 这样可以保持格式一致性

## 📝 文件命名建议

生成的PDF文件建议命名格式：

```
2025-11-23_AGT_代理合同_ABC公司.pdf
2025-11-23_DAT_学生信息表_张三.pdf
2025-11-23_INV_发票_订单001.pdf
```

**格式说明：**
- 日期：`YYYY-MM-DD`
- 类型：`AGT`(合同), `DAT`(数据表), `INV`(发票), `DOC`(文档)
- 描述：具体说明
- 对象：公司名/人名/订单号等

---

**需要帮助？**
如有问题，请联系：Maple@maplesgedu.com

**Last Updated:** 2025-11-24
```
