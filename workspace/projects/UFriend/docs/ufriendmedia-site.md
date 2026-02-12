# ufriendmedia.com 站点梳理（初稿）

来源：对 `https://www.ufriendmedia.com/` 做了静态抓取与媒体归档。

## 抓取结果
- 页面数：8
- 下载到本地的静态资源（图片/CSS/JS 等）：约 198 个
- 归档目录：`media/ufriendmedia.com/`
  - `pages/`：每个页面的原始 HTML
  - `assets/`：图片/CSS/JS 等
  - `site_dump.json`：页面索引（url/title/links/assets/下载资源列表）

## 首页（首页主卖点）
首页标题：Digital Marketing Service | UFriend Media | Singapore

首页主信息：
- **UFriend Media**：新加坡 & 马来西亚的专业数字服务公司
- 核心信息块：**We Specialise In**（他们主推的渠道/平台能力）

## We Specialise In（主营渠道/平台）
从首页内容抓到的 6 个方向：
1) **Meituan-Dianping（美团点评）**：
   - 面向出境中国游客的生活方式超级 App
   - UFriend 自称为“authorized overseas operation agent”
   - 服务：advertising / voucher / reservation
2) **Facebook（含 Instagram / Messenger / WhatsApp）**：
   - 服务：advertising / account management
3) **Alipay（支付宝）**：
   - 服务：voucher services（自称 authorized overseas partner）
4) **TikTok**：
   - 服务：advertising / account management（自称 authorized overseas agency）
5) **WeChat（微信广告）**：
   - 服务：advertising / account management（自称 authorized overseas service provider）
6) **StarTaster Delivery**：
   - 新加坡华人外卖平台（500+ merchants）
   - UFriend 自称 sister company
   - 服务：food delivery / advertising

## 初步产品定位理解
UFriendMedia.com 更像是：
- 一家 **跨平台的海外数字营销/代运营/广告代理** 公司主页
- 主卖点不是“RED 小红书”单一渠道，而是 **中国平台（美团/支付宝/微信）+ 海外平台（FB/TikTok）** 的组合
- 与 PDF（RED Service）是同一家公司不同“产品线/提案”

## 下一步（更“吃透”）
1) 把 `site_dump.json` 的每个页面内容做结构化摘要（每页：业务点/服务项/CTA/客户/案例/表单字段）
2) 把 assets 分类（logo、banner、案例图、平台图标等），建立“可复用素材库”
3) 若需要爬更深（比如 Valued Clients / 联系表单 / 其他隐藏页面）：
   - 需要确认是否有 sitemap/robots 或需要浏览器渲染

