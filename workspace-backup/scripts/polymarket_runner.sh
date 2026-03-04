#!/bin/bash
# Polymarket 自动交易启动脚本

# 设置环境变量
# export POLYMARKET_PRIVATE_KEY="your-private-key-here"
# export POLYMARKET_FUNDER_ADDRESS="your-funder-address-here"  # 如果使用 email/Magic 钱包

# 安装依赖
pip install py-clob-client -q

# 运行交易机器人
cd /home/node/.openclaw/workspace/scripts
python3 polymarket_bot.py
