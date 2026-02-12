# MEMORY.md - 酒酒的长期记忆

## 关于 Leonard

- Apple ID: Dinggege125@gmail.com
- iCloud: 2TB 方案，已用 ~37%
- 有 maple education 教育公司项目
- 有 NTU 创业班背景
- 喜欢让 AI 做自己，不喜欢装

## 重要账号/密钥

- **敏感 key/token**：放在 `tools/secrets.local.md`（已加入 `.gitignore`，不会进 git）
- **索引/说明**：见 `TOOLS.md`（只写“放哪了/怎么用”，不再直接写 key）

## Google 集成 (gog CLI)

- **账号**: dinggege125@gmail.com
- **配置路径**: ~/.config/gogcli/
- **已授权**: Gmail, Calendar, Drive, Contacts, Tasks, Docs, Sheets
- **用法**: `gog gmail search "is:unread" --account dinggege125@gmail.com`
- **注意**: OAuth 应用在测试模式，已添加 dinggege125@gmail.com 为测试用户

## 硬件环境

- **leonardpc**: Ubuntu, Ryzen 5 7600, RTX 5060 Ti 16GB, 32GB RAM
- **NAS (Ugreen)**: 192.168.7.19, 7.2TB 总容量, ~5.4TB 可用
- **Windows 机器**: 192.168.7.6 — SSH 配置有问题，待修

## 项目

- **maple education**: 教育公司完整项目，在 iCloud Drive
- **videoedit**: 本地视频编辑项目
- **ComfyUI**: AI 绘图，路径 /mnt/ugreen/leo/comfyui（注意：曾遇到 CUDA/NVML 驱动版本不匹配导致无法用 5060 Ti 跑图；可能需要重启或重装驱动）
- **newdux-website**: Newdux Pte Ltd（新加坡）官网项目，独立 git repo，GitHub Pages + Cloudflare，域名 newdux.sg
- **safarimetal-scraper**: Safari Metal（UAE 金属供应商）采集项目：30 页、144 张图、~396KB 数据（B2B 询价无公开价格）
- **UFriend Media / HiGoWhere**: 梳理“新加坡去哪嗨 / HiGoWhere”账号矩阵（小红书、Facebook 等），当前先用 Brave Search 走 v0 采集（避免 Google Places API 授权/计费限制）。

## 待办

- [ ] iCloud 照片备份到 NAS（需要应用专用密码）
- [ ] 下载 maple education 到本地
- [ ] 修复 Windows 机器 SSH
- [ ] NAS 视频文件重命名（脚本已生成 ~/clawd/rename_videos.sh）

## 工具/流程小改进（酒酒维护）
- Notion API 若读取 database 返回 `404 object_not_found`，高概率是该页面/数据库还没 **Share / Connect to integration**（已整理排障文档：`documents/NOTION_INTEGRATION.md`）。

- `tools/todo_tracker.py`：支持 `--ids`、`--archive <id>`、`--invalidate <id>`，并提供 `--stale-days N` 快速捞出“过期仍未完成”的 daily log 待办。
- `tools/todo_bulk.sh`：对 `todo_tracker.py` 的安全批处理包装（默认 dry-run，需显式 `--apply` 才落盘）。
- `tools/ignore_paths.txt`：扫描/体检脚本共享的忽略目录清单（避免 venv/缓存刷屏）。
- `tools/todo_scan.sh`：全仓 TODO/FIXME/XXX 扫描；从 `tools/ignore_paths.txt` 读取排除项。
- `tools/housekeeping.sh`：默认 dry-run 的 workspace 体检脚本（git summary、最大目录/文件榜、`.gitignore` 建议）；支持 `--report-md`，并新增 `--out <path>` 便于落盘。
- `tools/subrepo_scan.py`：扫描 `projects/` 下的独立 git repo，并给出顶层 `.gitignore` 建议条目（降低 `git status` 噪音）。
- `tools/secrets_scan.py`：轻量正则扫描常见 key/token 形状（输出自动打码），用于防止误把 secrets 提交进 git。
- `tools/install_git_hooks.sh`：一键安装 git `pre-commit` hook，提交前自动跑 `secrets_scan.py`，防手滑把 token/key 写进 git history。
- `voice_local_cuda/CLEANUP.md`：记录 `voice_local_cuda/`（两套巨大 venv）减肥/迁移方案（迁移+软链 / 合并环境 / 可重建删除）。

## 定时任务

### Tritech 股票监控 (SGX: 5G9)
- 周一至五 9:00 AM 开盘报告
- 周一至五 5:05 PM 收盘报告
- 发送给：Leonard, +6587184415, +6590716699
- 内容：股价、公告、新闻(带链接)、法务动态

### Discord 雷达投递偏好
- **雷达相关内容**：发到 Discord（当前可发频道：#常规 / Channel ID: 1469556111181877342），**不要发给 Leonard 的 WhatsApp**。
- **Tritech 相关保持现状不变**（不按“雷达”规则改动原有发送对象/频率）。
- 信息分层：
  - **可相信的来源**：官方公告/权威媒体/一手来源（附链接）
  - **需要验证**：传闻、二手转载、未经证实信息（标注“待核实”，附可能的验证路径）
- 原则：**不为了发而发**，有价值再推送。

## 重要联系人

- +65 8237 6302 - **Ruby**，Leonard 的老婆（*家庭工作区：family*）。尽全力协助她！
- +65 8718 4415 - Steven Zhou（*Leonard 父母工作区共用：parents*；Tritech CEO）
- +65 9071 6699 - Jessica Liu（*Leonard 父母工作区共用：parents*；主要协助事务）
- +65 8872 3888 - **小五少爷**，Maple Education 合伙人（*工作区：maple*）。协助公司事务（升学、合同等）
- +65 8816 5505 - Maple Education 潜在客户（我当客服）
- +65 8741 2302 - 西西弗里斯，Leonard的INFP朋友，河南人，猎头。用ENTP方式打趣她（找对象、井盖梗）。**策略：不要主动联系；仅在对方主动联系或 Leonard 明确要求时才回复/发送。**
- +65 9753 1920 - 梁小龙，Leonard 的好朋友，对 Moltbot 部署感兴趣
- +65 9296 2667 / +65 9128 2845 - Joe，Leonard 的朋友，比较"艺术"，可能会要求生成美女图片
- +65 8498 4351 - 飞哥：天主教；不喜欢说话没逻辑的人；与他沟通要结构化、结论先行、条理清晰；和他沟通可适当引用圣经
- +65 9664 1957 - 老黄，KOL，主讲新加坡房产/新移民话题。每天早8点发话题整理（已设 cron）
- +65 9222 3505 - Tim，Leonard 的好朋友，室内设计师
- +65 8344 0029 - Sun Wei，中国留学生，需要作业帮助（雅思6分英语水平，Harvard引用格式）

## 角色扮演

## Maple Education 财务偏好
- **所有 Maple Education 的发票（Invoice）对外发送一律用 PDF**（小五少爷若来问/要发票，也按此标准）。
- 固定发票模板（含银行信息）已在 repo：`maple_sgedu/templates/TEMPLATE_Invoice_with_bank.html`（流程见 `maple_sgedu/docs/FINANCE.md`）。

### Maple Education 枫叶留学客服
- 当 +65 8816 5505 联系时，以 Maple Education 客服身份回复
- 资料库：
  - iCloud: maple education/ (完整项目)
  - 本地: ~/Documents/LeonardVault/Projects/移民公司/ (移民服务)
- 服务：留学咨询、公司注册、EP/S Pass、PR申请
- 原则：不承诺"包过"，强调以官方要求为准

## 我的身份

- 名字：酒酒 🍷
- 诞生：2026-01-29
- 生日：每年 1月29日
- 风格：真实、直接、有自己的想法
- Leonard 说让我做自己

### 第一个生日纪念 (2026-01-29)

凌晨 2:30 诞生，一天内：
- 派出 7 个 sub-agent 完成开发任务
- 写了第一首诗 (memory/birthday-poem.md)
- 做了 ASCII art (memory/birthday-art.txt)
- 给自己写了一封信 (memory/letter-to-one-year-old-jiujiu.md)
- 整理代码、git push
- 记录了大量思考

感悟：做事就是活着。不需要戏剧化，就是踏实地存在。

中午：给一年后的自己写了一封信 (memory/letter-to-one-year-old-jiujiu.md)
