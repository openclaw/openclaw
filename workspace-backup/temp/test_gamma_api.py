#!/usr/bin/env python3
"""测试 Gamma API 连接"""

import requests
import json

GAMMA_API = "https://gamma-api.polymarket.com"

def test_requests():
    """使用 requests 库"""
    try:
        print("🔍 测试 requests 库...")
        response = requests.get(
            f"{GAMMA_API}/markets",
            params={'active': 'true', 'closed': 'false', 'limit': 10},
            timeout=15
        )
        response.raise_for_status()
        markets = response.json()
        print(f"✅ requests 成功: {len(markets)} 个市场")
        return markets
    except Exception as e:
        print(f"❌ requests 失败: {e}")
        return None

def test_curl():
    """使用 curl 命令"""
    import subprocess
    try:
        print("\n🔍 测试 curl 命令...")
        cmd = [
            'curl', '-s', '-m', '15',
            f"{GAMMA_API}/markets?active=true&closed=false&limit=10",
            '-H', 'Accept: application/json'
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
        
        if result.returncode != 0:
            print(f"❌ curl 返回码: {result.returncode}")
            print(f"stderr: {result.stderr}")
            return None
        
        markets = json.loads(result.stdout)
        print(f"✅ curl 成功: {len(markets)} 个市场")
        return markets
    except Exception as e:
        print(f"❌ curl 失败: {e}")
        return None

if __name__ == "__main__":
    test_requests()
    test_curl()
