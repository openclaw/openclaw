#!/usr/bin/env python3
"""发布资产到水产市场"""

import subprocess
import sys

# 使用 yes 命令自动确认
process = subprocess.Popen(
    ["bash", "-c", "yes | openclawmp publish ."],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    cwd="/home/node/.openclaw/workspace/passive_income_assets"
)

# 先输入类型
process.stdin.write("experience\n")
process.stdin.flush()

# 获取输出
output, error = process.communicate()

print(output)
if error:
    print(error, file=sys.stderr)
