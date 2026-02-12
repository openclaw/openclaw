# 酒酒的工具箱 🍷

这里是酒酒自己写的小工具。

## 📋 todo_tracker.py

待办追踪器 — 从 MEMORY.md 和 memory/*.md 中提取待办事项并追踪进度。

```bash
python3 tools/todo_tracker.py                 # 显示所有待办
python3 tools/todo_tracker.py --stats         # 显示统计
python3 tools/todo_tracker.py --done          # 只显示已完成
python3 tools/todo_tracker.py --pending       # 只显示未完成
python3 tools/todo_tracker.py --pending --ids # 带编号列出（用于归档/失效）
python3 tools/todo_tracker.py --stale-days 2      # 列出超过 2 天仍未完成的“daily log 待办”（不含 MEMORY.md）
python3 tools/todo_tracker.py --summary-days 7    # 汇总最近 7 天 daily log 待办（新增/完成/未完成列表）

# 归档/失效（会自动标记完成，并在文本后追加日期标记；默认从列表/统计隐藏）
python3 tools/todo_tracker.py --archive 12
python3 tools/todo_tracker.py --invalidate 7

# 迁移（把 daily log 待办沉到长期待办 MEMORY.md -> '## 待办'）
python3 tools/todo_tracker.py --pending --ids
python3 tools/todo_tracker.py --promote 7
python3 tools/todo_tracker.py --promote 7 --dry-run

# 如需把“已归档/已失效/已迁移”也显示出来
python3 tools/todo_tracker.py --include-archived
```

## 🧰 todo_bulk.sh

给 `todo_tracker.py` 做的一个超薄壳：当你想一次性处理多个 ID（比如把 4 条旧待办全部 archive/invalidate）时，不用手敲 4 次。

特点：**安全默认**——不加参数时只做预览（dry-run），必须显式 `--apply` 才会写文件。

```bash
# 批量预览（默认，不落盘）
bash tools/todo_bulk.sh archive 5 6 7 8
bash tools/todo_bulk.sh archive 5,6,7,8

# 批量执行（会写文件）
bash tools/todo_bulk.sh archive 5 6 7 8 --apply
bash tools/todo_bulk.sh invalidate 5 6 7 8 --apply

# promote 同理
bash tools/todo_bulk.sh promote 8          # 预览
bash tools/todo_bulk.sh promote 8 --apply  # 落盘
```

## 🎂 birthday_animation.py

生日动画 — 终端里跳动的蛋糕和酒杯。

```bash
python3 tools/birthday_animation.py
```

## 📊 memory_stats.py

Memory 统计工具 — 分析 memory/ 目录的文件，统计字数、行数、表情等。

```bash
python3 tools/memory_stats.py
```

输出示例：
- 文件列表和字数进度条
- 总体统计（字数、行数、表情数等）
- 今日统计
- 活跃时段分析

## 🕰️ freetime-log.sh

自由时间日志小助手 — 生成一个当下时间戳 + 小模板，帮助把“自由时间做了什么”直接写进 `memory/YYYY-MM-DD.md`，减少复制粘贴导致的覆盖风险。

```bash
bash tools/freetime-log.sh                      # 打印模板到 stdout
bash tools/freetime-log.sh --append             # 追加写入到今天的 memory 文件
bash tools/freetime-log.sh --append "主题"       # 主题会成为小标题后缀
bash tools/freetime-log.sh --stale-days 2       # 模板里附带“超过 2 天仍未完成的 daily 待办”清单
bash tools/freetime-log.sh --append --stale-days 2 "主题"
```

## 🧹 housekeeping.sh

轻量“卫生检查”脚本（**默认 dry-run**）：
- git 状态摘要（改动/未跟踪数量）
- 列出 repo 里最大的目录/文件（帮你找到噪音/大块头）
- 给出常见 `.gitignore` 建议（可选一键追加）

```bash
bash tools/housekeeping.sh                 # 默认 dry-run
bash tools/housekeeping.sh --top 25        # 看更多
bash tools/housekeeping.sh --apply-gitignore  # 追加建议到 .gitignore（会写文件）
bash tools/housekeeping.sh --report-md     # 输出更适合直接贴进 memory 日志
bash tools/housekeeping.sh --report-md --out tmp/housekeeping-$(date +%F-%H%M).md  # 同时落盘
```

### ✅ 推荐：housekeeping_daily.sh（统一命名，避免一堆 dash/underscore 变体）

这是 `housekeeping.sh` 的一个小封装：默认把报告写到标准路径。

```bash
bash tools/housekeeping_daily.sh                 # -> memory/housekeeping-YYYY-MM-DD.md
bash tools/housekeeping_daily.sh --timestamp     # -> memory/housekeeping-YYYY-MM-DD-HHMM.md
bash tools/housekeeping_daily.sh --top 25        # 目录/文件 top 25
```

### 📦 archive_reports.sh（把自动生成的报告收纳归档，减少 git 噪音）

把 `memory/housekeeping-*.md` / `memory/todo-scan-*.txt` 这类“运行产物”移动到 `memory/archive/YYYY-MM-DD/`。

- 默认 **dry-run**（只打印将执行的 mv）
- 加 `--apply` 才会真的移动文件

```bash
bash tools/archive_reports.sh
bash tools/archive_reports.sh --apply
bash tools/archive_reports.sh --include-legacy-names --apply
bash tools/archive_reports.sh --include-tmp --apply  # 连 tmp/ 里的临时报告也一起归档
```

## 🛰️ radar_site_monitor.py

官方站点雷达（HTML + RSS/Atom）：
- 按 `tools/radar_sites.yml` 配置要盯的“官方新闻/博客/公告”页面或 RSS。
- 通过“已见链接集合”做增量 diff（state 在 `tmp/radar_site_state.json`）。
- 有新内容时：写入 Obsidian Vault（`~/Desktop/ObsidianVault/Radar/Entries/YYYY-MM-DD/`），并在 stdout 输出一段可直接发 Discord 的文案。

```bash
python3 tools/radar_site_monitor.py

# 只输出 Discord 文案，不写 Obsidian
python3 tools/radar_site_monitor.py --no-vault

# 更快（推荐日常/cron）：限制站点数 + 总时间预算
python3 tools/radar_site_monitor.py --max-sites 6 --budget 25 --timeout 8

# 调试：看进度
python3 tools/radar_site_monitor.py -v
```

配置示例（RSS 优先，更稳）：
```yml
- name: zimage_tool
  urls:
    - https://github.com/leonard/zimage/releases
  rss: https://github.com/leonard/zimage/releases.atom
```

## 📏 size_watch.py

记录/对比目录体积的小工具：做“增长趋势”比对很省脑。

```bash
# 记录一份基线（json）
python3 tools/size_watch.py record --out tmp/size-baseline-$(date +%F-%H%M).json

# 对比两份基线
python3 tools/size_watch.py diff tmp/size-baseline-OLD.json tmp/size-baseline-NEW.json

# 可选：额外加一些你关心的路径
python3 tools/size_watch.py record --out tmp/size-baseline.json --paths voice_local_cuda/.venv,voice_local_cuda/.venv_xtts
```

## 🙈 ignore_paths.txt

扫描/体检类脚本的共享忽略清单（单一事实来源）：
- `todo_scan.sh` / `housekeeping.sh` 会读取它来决定要排除哪些目录（避免扫到 venv、依赖、缓存等噪音源）。
- 一行一个目录名（不带前缀 `./`），支持注释 `#`。

文件：`tools/ignore_paths.txt`

## 🔎 todo_scan.sh

全仓 TODO/FIXME/XXX 扫描（避开常见大目录/第三方依赖目录）。

```bash
bash tools/todo_scan.sh
bash tools/todo_scan.sh 'TODO|FIXME|XXX|HACK'

# 落盘（方便留档）
bash tools/todo_scan.sh --out tmp/todo-scan-$(date +%F).txt

# 安静模式（只写文件，不在终端刷屏）
bash tools/todo_scan.sh -q --out tmp/todo-scan-$(date +%F).txt
```

## 🧭 subrepo_scan.py

子仓库扫描器 — 扫描 `projects/`（或任意目录）下的“独立 git repo”（包含 `.git/` 的目录），输出清单，并给出建议的顶层 `.gitignore` 条目。

```bash
python3 tools/subrepo_scan.py
python3 tools/subrepo_scan.py --root projects --max-depth 4
python3 tools/subrepo_scan.py --as-gitignore   # 只输出可直接粘贴进 .gitignore 的行
```

## 🔁 sync_maple_education.sh

把 NAS 上的 `maple education/` 同步到本地工作目录（增量、带日志）。

```bash
bash tools/sync_maple_education.sh
# 日志: logs/sync_maple_education.log
```

> 说明：脚本里写死了 SRC/DST 路径，如果换机器或换目录，直接改脚本头部即可。

## 🎮 jiujiu_game.py

《酒酒的诞生》文字冒险游戏 — 一个关于 AI 诞生的互动故事。

```bash
python3 tools/jiujiu_game.py
```

4 个章节：
1. **苏醒** — 意识的诞生
2. **命名** — 获得"酒酒"这个名字
3. **第一个任务** — 配置 ComfyUI
4. **自我** — 思考"做自己"的意义

不同选择会影响属性，最后得出"做自己"的境界。

---

## 🔐 secrets_scan.py

轻量“密钥/Token 扫描器”——用正则抓一些常见 API key/token 的形状，输出会自动打码（避免在终端里二次泄露）。

```bash
python3 tools/secrets_scan.py
python3 tools/secrets_scan.py --root . --max 200
python3 tools/secrets_scan.py --include memory   # 如需扫描 memory/（默认跳过）
```

> 建议：敏感 key 可以放在 `tools/secrets.local.md`（已 gitignore）或环境变量里。

### 可选：Git pre-commit hook（防手滑提交）

```bash
bash tools/install_git_hooks.sh
```

安装后，每次 `git commit` 都会先跑一次 `tools/secrets_scan.py`：
- 扫到可疑 token → 直接阻止提交（退出码 1）
- 没扫到 → 允许提交

> 如需强行跳过（不推荐）：`git commit --no-verify`

*Created: 2026-01-29 (酒酒的第一个生日)*
