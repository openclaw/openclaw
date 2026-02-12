# 提案：降低 workspace git 噪音（daily 报告产物）

背景：目前 `memory/housekeeping-*.md` / `memory/todo-scan-*.txt` 等属于“运行产物/日志”，数量增长快，会把真正需要 review 的改动淹没。

目标：
- 让 `git status` 更干净（更容易看出真正的代码/文档改动）
- 保留必要的“可追溯性”（关键摘要/索引还在）
- 不做破坏性清理（不删除，只是分类/忽略策略）

## 方案 A（推荐）：忽略所有自动生成的报告，只保留 index/摘要

1) `.gitignore` 增加：

- `memory/housekeeping-*.md`
- `memory/todo-scan-*.txt`
- `tmp/`
- `tmp_sgx/`

2) 保留并提交：
- `memory/housekeeping_index.md`（指向最新/关键报告的索引）
- 手写的 daily log：`memory/YYYY-MM-DD.md`

优点：最安静、最清晰。
缺点：如果将来需要回看某次详细报告，需要在本机保留（不在 git 历史里）。

## 方案 B：只忽略“带时间戳的多份”，保留每天 1 份

如果你希望每天的体检/扫描结果也能进 git，但又不想太多：

- 忽略：`memory/housekeeping-????-??-??-????.md`（HHMM 时间戳版本）
- 保留：`memory/housekeeping-YYYY-MM-DD.md`（每天 1 份）
- 忽略：`memory/todo-scan-????-??-??.txt`（每天扫描也可只保留 1 份）

优点：保留历史；噪音相对可控。
缺点：仍然会有日增文件；repo 会慢慢变大。

## 方案 C：归档到本地不进 git（但可手动打包）

- 把报告移动到 `memory/archive/`（此目录 `.gitignore`）
- 需要时手动 zip 某一天/某周报告发给自己或备份

优点：结构清晰。
缺点：需要多一步移动/归档动作（可脚本化）。

## 我建议的默认策略

- 优先 A：报告当产物，默认不入库；只提交 index + 重要摘要（写在 daily log 里）。
- 若你明确希望“可审计历史”，再选 B。

## 需要 Leonard 确认的点

1) 你希望 daily 报告进 git 吗？（A vs B）
2) `tmp_sgx/` 是否纯临时？如果是，建议 ignore。
3) 如果采用归档（C）：我已经写了 `tools/archive_reports.sh`（默认 dry-run，`--apply` 才移动）。你只要确认要不要用/要不要把 `memory/archive/` 加到 `.gitignore`。
