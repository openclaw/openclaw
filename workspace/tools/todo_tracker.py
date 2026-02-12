#!/usr/bin/env python3
"""
酒酒的待办追踪器 📋

从 MEMORY.md 和 memory/*.md 中提取待办事项并追踪进度。

用法:
    python3 tools/todo_tracker.py                 # 显示所有待办
    python3 tools/todo_tracker.py --stats         # 显示统计
    python3 tools/todo_tracker.py --done          # 只显示已完成
    python3 tools/todo_tracker.py --pending       # 只显示未完成

归档/失效（用于减少“背景噪音”）:
    python3 tools/todo_tracker.py --pending --ids # 带编号列出未完成
    python3 tools/todo_tracker.py --archive 12    # 将编号 12 标记为“已归档”并自动完成
    python3 tools/todo_tracker.py --invalidate 7  # 将编号 7 标记为“已失效”并自动完成

迁移（把 daily log 待办沉到长期待办）:
    python3 tools/todo_tracker.py --pending --ids # 先拿编号
    python3 tools/todo_tracker.py --promote 7     # 迁移到 MEMORY.md 的“## 待办”
    python3 tools/todo_tracker.py --promote 7 --dry-run  # 只预览，不写文件

默认行为:
- **已归档/已失效** 的条目会从列表与统计中隐藏（除非加 --include-archived）

注意:
- --archive/--invalidate 通过“当前扫描结果的编号”定位目标；因此建议先运行一次 --ids
  再立即执行归档/失效，避免因为文件变动导致编号漂移。
"""

from __future__ import annotations

import argparse
import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, date
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

# 项目根目录
ROOT_DIR = Path(__file__).resolve().parent.parent
MEMORY_DIR = ROOT_DIR / "memory"
MEMORY_FILE = ROOT_DIR / "MEMORY.md"

# 待办正则："- [ ] xxx" / "- [x] xxx"（支持前置缩进）
TODO_PATTERN = re.compile(r"^(\s*)-\s*\[([ xX])\]\s*(.+)$")

# daily log 文件名日期（memory/YYYY-MM-DD.md）
DAILY_FILE_PATTERN = re.compile(r"^(\d{4}-\d{2}-\d{2})\.md$")

# 归档标记（在待办文本中出现即视为 archived）
ARCHIVE_MARKERS = ("已归档", "archived", "已迁移", "promoted")
INVALID_MARKERS = ("已失效", "invalid")


@dataclass
class Todo:
    file: str
    path: Path
    line: int  # 1-indexed
    section: str
    done: bool
    text: str
    indent: int

    @property
    def is_archived(self) -> bool:
        t = self.text.lower()
        return any(m.lower() in t for m in ARCHIVE_MARKERS)

    @property
    def is_invalid(self) -> bool:
        t = self.text.lower()
        return any(m.lower() in t for m in INVALID_MARKERS)


def extract_todos(filepath: Path) -> List[Todo]:
    """从文件中提取待办事项"""
    if not filepath.exists():
        return []

    content = filepath.read_text(encoding="utf-8")
    lines = content.split("\n")

    todos: List[Todo] = []
    current_section = "未分类"

    for i, line in enumerate(lines):
        # 追踪当前标题
        if line.startswith("#"):
            current_section = line.lstrip("#").strip() or "未分类"

        match = TODO_PATTERN.match(line)
        if not match:
            continue

        indent, status, text = match.groups()
        todos.append(
            Todo(
                file=filepath.name,
                path=filepath,
                line=i + 1,
                section=current_section,
                done=status.lower() == "x",
                text=text.strip(),
                indent=len(indent),
            )
        )

    return todos


def get_all_todos() -> List[Todo]:
    """获取所有待办事项"""
    all_todos: List[Todo] = []

    if MEMORY_FILE.exists():
        all_todos.extend(extract_todos(MEMORY_FILE))

    if MEMORY_DIR.exists():
        for f in sorted(MEMORY_DIR.glob("*.md")):
            all_todos.extend(extract_todos(f))

    return all_todos


def visible_todos(todos: Iterable[Todo], include_archived: bool) -> List[Todo]:
    """默认隐藏“已归档/已失效”条目（除非显式 include）。"""
    if include_archived:
        return list(todos)
    return [t for t in todos if not (t.is_archived or t.is_invalid)]


def daily_file_date(path: Path) -> Optional[date]:
    """若是 memory/YYYY-MM-DD.md 这种 daily log，则返回其日期；否则返回 None。"""
    if path.parent != MEMORY_DIR:
        return None
    m = DAILY_FILE_PATTERN.match(path.name)
    if not m:
        return None
    try:
        return date.fromisoformat(m.group(1))
    except ValueError:
        return None


def print_todos(
    todos: List[Todo],
    filter_done: Optional[bool] = None,
    show_ids: bool = False,
    include_archived: bool = False,
    show_age: bool = False,
    id_map: Optional[Dict[Tuple[Path, int], int]] = None,
) -> None:
    """打印待办列表"""
    todos = visible_todos(todos, include_archived=include_archived)

    if filter_done is not None:
        todos = [t for t in todos if t.done == filter_done]

    if not todos:
        print("  (无)")
        return

    # 按文件和section分组
    grouped = defaultdict(lambda: defaultdict(list))
    for local_idx, t in enumerate(todos, start=1):
        idx = local_idx
        if show_ids and id_map is not None:
            idx = id_map.get((t.path, t.line), local_idx)
        grouped[t.file][t.section].append((idx, t))

    for filename, sections in grouped.items():
        print(f"\n📄 {filename}")
        print("-" * 40)
        for section, items in sections.items():
            if section != "未分类":
                print(f"  📌 {section}")
            for idx, t in items:
                indent = "    " if section != "未分类" else "  "
                status = "✅" if t.done else "⬜"
                prefix = f"[{idx:>3}] " if show_ids else ""

                age_tag = ""
                if show_age and (not t.done):
                    d = daily_file_date(t.path)
                    if d is not None:
                        age = (date.today() - d).days
                        if age >= 0:
                            age_tag = f" ⏳{age}d"

                print(f"{indent}{prefix}{status}{age_tag} {t.text}")


def print_stats(todos: List[Todo], include_archived: bool = False) -> None:
    """打印统计信息"""
    todos = visible_todos(todos, include_archived=include_archived)

    total = len(todos)
    done = sum(1 for t in todos if t.done)
    pending = total - done

    completion = (done / total * 100) if total else 0

    # 进度条
    bar_width = 30
    filled = int(completion / 100 * bar_width)
    bar = "█" * filled + "░" * (bar_width - filled)

    print(
        f"""
╔════════════════════════════════════════╗
║        📋 酒酒的待办统计 📋            ║
╠════════════════════════════════════════╣
║                                        ║
║  总任务:  {total:>3}                          ║
║  已完成:  {done:>3}  ✅                       ║
║  待完成:  {pending:>3}  ⬜                       ║
║                                        ║
║  进度:    [{bar}]   ║
║           {completion:>5.1f}%                      ║
║                                        ║
╚════════════════════════════════════════╝
"""
    )

    # 按文件统计
    file_stats = defaultdict(lambda: {"done": 0, "pending": 0})
    for t in todos:
        if t.done:
            file_stats[t.file]["done"] += 1
        else:
            file_stats[t.file]["pending"] += 1

    if file_stats:
        print("📊 按文件统计:")
        print("-" * 40)
        for filename, stats in file_stats.items():
            total_f = stats["done"] + stats["pending"]
            pct = (stats["done"] / total_f * 100) if total_f else 0
            mini_bar = "█" * int(pct / 10) + "░" * (10 - int(pct / 10))
            print(f"  {filename:<25} {mini_bar} {pct:>5.0f}%")


def build_global_id_map(todos: List[Todo], include_archived: bool) -> Dict[Tuple[Path, int], int]:
    """构建一个 (path, line) -> global id 的映射（id 从 1 开始）。

    用于在筛选列表（比如 --stale-days）里仍然显示“可用于 --archive/--invalidate/--promote 的编号”。
    """
    vt = visible_todos(todos, include_archived=include_archived)
    return {(t.path, t.line): idx for idx, t in enumerate(vt, start=1)}


def select_by_id(todos: List[Todo], wanted_id: int, include_archived: bool) -> Todo:
    todos = visible_todos(todos, include_archived=include_archived)
    if wanted_id < 1 or wanted_id > len(todos):
        raise SystemExit(f"ID 超出范围：1..{len(todos)}")
    return todos[wanted_id - 1]


def update_todo_line(todo: Todo, *, mark: str) -> None:
    """就地更新某个 todo 行：强制完成，并追加标记（已归档/已失效 + 日期）。"""
    today = datetime.now().strftime("%Y-%m-%d")
    suffix = f" ({mark} {today})"

    lines = todo.path.read_text(encoding="utf-8").split("\n")
    idx0 = todo.line - 1
    if idx0 < 0 or idx0 >= len(lines):
        raise SystemExit("目标行号已变化，请重新运行 --ids 获取最新编号")

    line = lines[idx0]
    m = TODO_PATTERN.match(line)
    if not m:
        raise SystemExit("目标行已不再是待办格式，请重新运行 --ids")

    indent, _status, text = m.groups()

    # 如果已经包含标记，就不重复追加；但仍强制标记为 done。
    new_text = text.strip()
    if mark not in new_text:
        new_text = new_text + suffix

    lines[idx0] = f"{indent}- [x] {new_text}"
    todo.path.write_text("\n".join(lines), encoding="utf-8")


def ensure_memory_todo_section(lines: List[str]) -> int:
    """确保 MEMORY.md 里有 '## 待办' 段落。

    返回该段落标题行的 index（0-based）。
    """
    for i, line in enumerate(lines):
        if line.strip() == "## 待办":
            return i

    # 没有的话，追加到文件末尾
    if lines and lines[-1].strip() != "":
        lines.append("")
    lines.extend(["## 待办", ""])
    return next(i for i, line in enumerate(lines) if line.strip() == "## 待办")


def append_memory_todo(text: str, *, source: Todo, dry_run: bool) -> str:
    """向 MEMORY.md 的 '## 待办' 追加一条 todo。

    返回将要追加的行内容（便于输出/测试）。
    """
    today = datetime.now().strftime("%Y-%m-%d")
    src = f"{source.file}:{source.line}"
    line_to_add = f"- [ ] {text} (from {src}, promoted {today})"

    if dry_run:
        return line_to_add

    if not MEMORY_FILE.exists():
        MEMORY_FILE.write_text("# MEMORY.md\n\n## 待办\n\n" + line_to_add + "\n", encoding="utf-8")
        return line_to_add

    lines = MEMORY_FILE.read_text(encoding="utf-8").split("\n")
    h_idx = ensure_memory_todo_section(lines)

    # 插入点：下一个 '## ' 之前；如果没有，就文件末尾。
    insert_at = len(lines)
    for j in range(h_idx + 1, len(lines)):
        if lines[j].startswith("## "):
            insert_at = j
            break

    # 清理：确保在插入点之前有一个空行（可读性）
    if insert_at > 0 and lines[insert_at - 1].strip() != "":
        lines.insert(insert_at, "")
        insert_at += 1

    lines.insert(insert_at, line_to_add)
    MEMORY_FILE.write_text("\n".join(lines), encoding="utf-8")
    return line_to_add


def promote_todo(todo: Todo, *, dry_run: bool) -> None:
    """把 daily log 的待办迁移到 MEMORY.md，并把原条目标记为已迁移。"""
    if todo.done:
        raise SystemExit("该待办已完成，无需迁移")

    d = daily_file_date(todo.path)
    if d is None:
        raise SystemExit("只能迁移 memory/YYYY-MM-DD.md 这种 daily log 里的待办")

    line_to_add = append_memory_todo(todo.text, source=todo, dry_run=dry_run)

    today = datetime.now().strftime("%Y-%m-%d")
    new_src_line = f"- [x] {todo.text} (已迁移 {today})"

    if dry_run:
        print("(dry-run) 将追加到 MEMORY.md:")
        print("  " + line_to_add)
        print("(dry-run) 将更新原始条目为:")
        print(f"  {todo.file}:{todo.line}  {new_src_line}")
        return

    # 先写入 MEMORY.md，再改源文件，尽量避免出现“源被改了但 MEMORY 没写入”的情况
    update_todo_line(todo, mark="已迁移")
    print(f"✅ 已迁移到 MEMORY.md: {todo.file}:{todo.line}  {todo.text}")


def main() -> None:
    parser = argparse.ArgumentParser(description="酒酒的待办追踪器")
    parser.add_argument("--stats", action="store_true", help="显示统计信息")
    parser.add_argument("--done", action="store_true", help="只显示已完成")
    parser.add_argument("--pending", action="store_true", help="只显示未完成")
    parser.add_argument(
        "--stale-days",
        type=int,
        help="列出超过 N 天仍未完成的待办（仅统计 memory/YYYY-MM-DD.md 的 daily log；MEMORY.md 不算）",
    )
    parser.add_argument(
        "--summary-days",
        type=int,
        help="汇总最近 N 天（含今天）的 daily log 待办完成情况（仅 memory/YYYY-MM-DD.md；MEMORY.md 不算）",
    )
    parser.add_argument("--ids", action="store_true", help="显示编号（用于 --archive/--invalidate）")
    parser.add_argument(
        "--include-archived",
        action="store_true",
        help="包含“已归档/已失效”条目（默认隐藏）",
    )
    parser.add_argument("--archive", type=int, help="按编号归档某一条待办（会自动标记完成）")
    parser.add_argument("--invalidate", type=int, help="按编号标记某一条待办为失效（会自动标记完成）")
    parser.add_argument(
        "--promote",
        type=int,
        help="按编号把 daily log 的待办迁移到 MEMORY.md 的 '## 待办'（源条目会标记为已迁移）",
    )
    parser.add_argument("--dry-run", action="store_true", help="仅预览将要修改的内容，不写文件")
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="限制输出条数（常用于 --stale-days / --summary-days 的未完成列表）",
    )

    args = parser.parse_args()

    # 互斥动作：归档/失效优先
    todos = get_all_todos()

    actions = {
        "--archive": args.archive,
        "--invalidate": args.invalidate,
        "--promote": args.promote,
    }
    chosen = [k for k, v in actions.items() if v is not None]
    if len(chosen) > 1:
        raise SystemExit("--archive / --invalidate / --promote 不能同时使用")

    if args.archive is not None:
        target = select_by_id(todos, args.archive, include_archived=True)
        if args.dry_run:
            print("(dry-run) 将更新原始条目为已归档：")
            print(f"  {target.file}:{target.line}  {target.text}")
            return
        update_todo_line(target, mark="已归档")
        print(f"✅ 已归档: {target.file}:{target.line}  {target.text}")
        return

    if args.invalidate is not None:
        target = select_by_id(todos, args.invalidate, include_archived=True)
        if args.dry_run:
            print("(dry-run) 将更新原始条目为已失效：")
            print(f"  {target.file}:{target.line}  {target.text}")
            return
        update_todo_line(target, mark="已失效")
        print(f"✅ 已失效: {target.file}:{target.line}  {target.text}")
        return

    if args.promote is not None:
        target = select_by_id(todos, args.promote, include_archived=True)
        promote_todo(target, dry_run=args.dry_run)
        return

    print("\n" + "═" * 50)
    print("  📋 酒酒的待办追踪器 📋")
    print("═" * 50)

    if args.stats:
        print_stats(todos, include_archived=args.include_archived)
    elif args.stale_days is not None:
        days = args.stale_days
        if days < 0:
            raise SystemExit("--stale-days 不能为负数")

        today = date.today()
        vt = visible_todos(todos, include_archived=args.include_archived)
        stale = []
        for t in vt:
            if t.done:
                continue
            d = daily_file_date(t.path)
            if d is None:
                continue
            if (today - d).days >= days:
                stale.append(t)

        if args.limit is not None:
            if args.limit <= 0:
                raise SystemExit("--limit 必须是正整数")
            stale = stale[: args.limit]

        print(f"\n⏳ 超过 {days} 天仍未完成的待办:")
        id_map = build_global_id_map(todos, include_archived=args.include_archived)
        print_todos(
            stale,
            filter_done=False,
            show_ids=args.ids,
            include_archived=args.include_archived,
            show_age=True,
            id_map=id_map,
        )
    elif args.summary_days is not None:
        days = args.summary_days
        if days <= 0:
            raise SystemExit("--summary-days 必须是正整数")

        today = date.today()
        start = today.fromordinal(today.toordinal() - (days - 1))

        vt = visible_todos(todos, include_archived=args.include_archived)
        window = []
        for t in vt:
            d = daily_file_date(t.path)
            if d is None:
                continue
            if start <= d <= today:
                window.append(t)

        # 分天统计
        by_day = defaultdict(lambda: {"total": 0, "done": 0, "pending": 0})
        for t in window:
            d = daily_file_date(t.path)
            if d is None:
                continue
            by_day[d]["total"] += 1
            if t.done:
                by_day[d]["done"] += 1
            else:
                by_day[d]["pending"] += 1

        print(f"\n🗓️ 最近 {days} 天 daily log 待办汇总 ({start.isoformat()} ~ {today.isoformat()}):")
        if not by_day:
            print("  (窗口内没有 daily log 待办)")
        else:
            for d in sorted(by_day.keys()):
                s = by_day[d]
                pct = (s["done"] / s["total"] * 100) if s["total"] else 0
                print(f"  {d.isoformat()}  总计 {s['total']:>2} | ✅ {s['done']:>2} | ⬜ {s['pending']:>2} | {pct:>5.1f}%")

            total = sum(s["total"] for s in by_day.values())
            done = sum(s["done"] for s in by_day.values())
            pending = sum(s["pending"] for s in by_day.values())
            pct = (done / total * 100) if total else 0
            print(f"\n  合计     总计 {total:>2} | ✅ {done:>2} | ⬜ {pending:>2} | {pct:>5.1f}%")

        # 把窗口内未完成按“越旧越靠前”列出来（最多 20 条；可用 --limit 覆盖）
        pending_items = [t for t in window if not t.done]
        pending_items.sort(key=lambda t: (daily_file_date(t.path) or today))
        if pending_items:
            cap = 20
            if args.limit is not None:
                if args.limit <= 0:
                    raise SystemExit("--limit 必须是正整数")
                cap = args.limit
            print(f"\n⬜ 窗口内仍未完成（最多 {cap} 条）:")
            id_map = build_global_id_map(todos, include_archived=args.include_archived)
            print_todos(
                pending_items[:cap],
                filter_done=False,
                show_ids=args.ids,
                include_archived=args.include_archived,
                show_age=True,
                id_map=id_map,
            )
    elif args.done:
        print("\n✅ 已完成的任务:")
        print_todos(
            todos,
            filter_done=True,
            show_ids=args.ids,
            include_archived=args.include_archived,
        )
    elif args.pending:
        print("\n⬜ 待完成的任务:")
        print_todos(
            todos,
            filter_done=False,
            show_ids=args.ids,
            include_archived=args.include_archived,
        )
    else:
        print("\n📋 所有待办事项:")
        print_todos(
            todos,
            filter_done=None,
            show_ids=args.ids,
            include_archived=args.include_archived,
        )

        # 简单统计
        vt = visible_todos(todos, include_archived=args.include_archived)
        done = sum(1 for t in vt if t.done)
        pending = len(vt) - done
        print(f"\n{'─' * 40}")
        print(f"  总计: {len(vt)} 项  |  ✅ {done} 完成  |  ⬜ {pending} 待办")

    print("\n" + "═" * 50)
    print(f"  🍷 {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print("═" * 50 + "\n")


if __name__ == "__main__":
    main()
