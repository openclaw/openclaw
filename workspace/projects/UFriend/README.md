# UFriend Workspace

目标：把 **UFriend / UFriend Media / RED Service** 资料研究透、沉淀成可复用的产品理解文档，并尽可能把公开的媒体内容爬取/归档。

## 目录
- `docs/`：研究与沉淀（最终产物）
- `assets/`：PDF/原始资料
- `media/`：爬取到的图片/视频/网页快照等
- `scripts/`：爬虫、解析脚本
- `notes/`：临时笔记

## 当前已导入
- `/home/leonard/.clawdbot/media/inbound/310117e6-ec63-40ef-aa0a-41c5ea8c6ba8.pdf`
  - 已用 `pdftotext` 抽取到：`docs/ufriend_pdf_text.txt`
  - 已抽取 PDF 内所有 URL：`docs/links_from_pdf.txt`

## 下一步
1. 把 PDF 逐段拆解成结构化产品文档：`docs/product-understanding.md`
2. 明确“UFriend media”爬取范围（小红书账号？官网？IG/TikTok？）
3. 若要爬小红书（XHS/REDNote）内容：通常需要登录态/cookie 或人工导出；我可以先做“链接清单+抓取方案+可运行脚本”，再根据你提供的登录方式执行。
