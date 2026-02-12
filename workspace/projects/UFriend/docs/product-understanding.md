# UFriend（UFriend Media / RED Service）产品理解（初稿）

> 资料来源：`ufriend_pdf_text.txt`（Copyright 2023 © UFriend Media Pte. Ltd.）

## 1. 公司是谁（UFriend Media）
- **公司名**：UFriend Media Pte. Ltd.
- **定位**：专业数字服务公司（新加坡 + 马来西亚）
- **行业经验**：Lifestyle（生活方式）领域多年经验
- **核心能力**：
  - Digital marketing service
  - Integrated O2O solutions（线上线下一体化）
  - Content creation & ads
  - E-commerce system
  - E-wallet payment

## 2. 他们主打的“RED Service”是什么
这里的 **RED** 指“小红书 / RedNote”。

PDF 信息点：
- 规模/用户画像（截至 2019.10 的一组数据）：
  - 注册用户：300M
  - 女性用户：77%
  - 一二线城市用户：56%
  - 90后占比：72%
  - 90% 用户会在 RED 上探索品牌/产品信息
  - 280k+ 每日新增笔记
  - 22,000+ Brand Official Account
  - 43,000+ Brand Official Page
  - 20,000+ 每日带品牌 tag 的笔记

产品逻辑：
- 用“内容 + 互动”让品牌讲故事，并与用户建立连接
- 用户在 RED 里：Explore / Communicate / Shop / Share
- 入口形态：New Feed / Content Post / Hot Topic / Shopping

## 3. RED 产品模块（PDF 里出现的功能块）
### 3.1 Listing Upgrade（账号升级）
对比：Personal Account vs Business Account
- Personal：无认证
- Business：
  - Business Verification
  - Offline Address
  - Contact Number
  - Follower Interaction
  - Content Management

### 3.2 Business Account 的运营后台能力
- 能查看账号整体表现（overview）
- 能看单条内容曝光：Impression / Organic Readership
- 粉丝画像：
  - 地域（Followers Location Segregation）
  - 性别（Gender）
  - 年龄（Age）
  - 兴趣（Interests）
  - 来源（Source）

### 3.3 Marketing Tools
- 提到一个典型工具：**“Lucky Draw”抽奖**
  - 用于月度活动，刺激老粉互动 + 拉新

### 3.4 Traffic Driving（导流）
PDF 里出现的广告形态：
- Feed Ads（Message）
- Feed Ads（Website）
- Search（后文还有更多，待继续整理）

## 4. 客户与案例（PDF 列表：部分）
PDF 展示了大量“已运营/服务的 RED 账号”，包括自有账号与品牌客户。

### 4.1 自有账号
- HiGoWhere SG（新加坡去哪嗨｜39.3K）
- HiGoWhere MY（来亚去哪嗨｜33.3K）

### 4.2 品牌客户（示例）
- Retail：Watsons Malaysia / King Power Duty Free / Shilla Duty Free Singapore / Heinemann Duty Free / Signature Market / Lazada Malaysia
- Hotels：EQ KL / IOI Resort City / Pan Pacific / Artyzen Singapore
- Attractions：Singapore Science Centre / Royal Selangor Visitor Centre
- F&B：Paradise Group / Red House Seafood / Jumbo Group / Peach Garden / Arteastiq / Zhang Liang Mala Tang 等

> 完整链接清单见：`links_from_pdf.txt`

## 5. 目前我对“UFriend media 爬取/吃透”的理解
你说的“UFriend media”我理解可能有三类：
1) **UFriend 自有账号的内容资产**（例如 HiGoWhere SG/MY 在小红书的笔记/图片/视频）
2) **品牌客户账号**（但严格来说不一定适合全量爬取，更多是案例研究/抽样）
3) **UFriend 对外的媒体资料**（官网、PDF、宣传页、案例页）

### 5.1 风险与现实
- 小红书网页端对爬虫/未登录访问限制较多，常见：
  - 需要登录态 cookie
  - 反爬（频率、JS 渲染、签名）

### 5.2 我建议的“可落地方案”（两段式）
- **第一段（无需账号/最稳）**：
  - 把 PDF 里的账号链接做“目录化归档”（已完成）
  - 对自有账号做抽样分析：TOP 笔记主题、内容结构、引流方式、互动话术
  - 需要你提供：你最关心的目标（涨粉？带货？线下引流？招商？）

- **第二段（需要登录/更彻底）**：
  - 你提供一种方式：
    - ① 你手机/浏览器导出 cookie（我写脚本抓）
    - ② 你直接给我一批“笔记链接”列表（我抓内容与媒体）
    - ③ 你允许我用浏览器接管（Browser Relay）在登录状态下自动翻页下载（最像人）
  - 我可以落地：
    - 抓取笔记正文/标题/标签/发布时间/互动数
    - 下载图片/视频
    - 输出一个“内容资产库”JSON + 归档目录

## 6. 下一步待办
- [ ] 把 `ufriend_pdf_text.txt` 后续章节（RED Ads / Search / 其他产品）补全整理
- [ ] 输出一份“产品地图”：账号升级 → 内容 → 广告导流 → 转化（店铺/网站/WhatsApp/小程序/电商）
- [ ] 确认爬取范围：仅自有账号？还是也包含部分品牌客户？

