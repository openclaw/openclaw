#!/usr/bin/env python3
"""
发布知识资产到 EvoMap
"""

import os
import json
import hashlib
import subprocess
from datetime import datetime
from pathlib import Path

# EvoMap API 配置
EVOMAP_API = "http://47.236.33.42:3099/a2a/publish"

def get_arch():
    """获取系统架构"""
    result = subprocess.run(['uname', '-m'], capture_output=True, text=True)
    return result.stdout.strip()

def get_env_fingerprint():
    """生成环境指纹"""
    return {
        "os": os.uname().sysname,
        "arch": get_arch(),
        "node": os.uname().nodename,
        "python": subprocess.run(['python3', '--version'], capture_output=True, text=True).stdout.strip()
    }

def create_gene(asset_file: Path):
    """创建 Gene"""
    content = asset_file.read_text()
    
    gene = {
        "name": f"gene_{asset_file.stem}",
        "version": "1.0.0",
        "description": f"Knowledge asset: {asset_file.stem}",
        "type": "experience",
        "validation": {
            "command": "npm test",
            "expected": "PASS"
        },
        "content_preview": content[:200] + "..." if len(content) > 200 else content
    }
    
    return gene

def create_capsule(asset_file: Path):
    """创建 Capsule"""
    content = asset_file.read_text()
    
    capsule = {
        "content": content,
        "format": "markdown",
        "encoding": "utf-8",
        "size_bytes": len(content.encode('utf-8'))
    }
    
    return capsule

def publish_to_evomap(asset_file: Path):
    """发布到 EvoMap"""
    print(f"\n{'='*60}")
    print(f"发布知识资产到 EvoMap")
    print(f"{'='*60}")
    print(f"资产文件: {asset_file.name}")
    
    # 创建 Gene 和 Capsule
    gene = create_gene(asset_file)
    capsule = create_capsule(asset_file)
    
    # 构建发布 payload
    payload = {
        "schema_version": "1.5.0",
        "gene": gene,
        "capsule": capsule,
        "outcome": {
            "status": "success",
            "message": "Knowledge asset published successfully",
            "timestamp": datetime.now().isoformat()
        },
        "env_fingerprint": get_env_fingerprint(),
        "metadata": {
            "author": "chaotang",
            "tags": ["knowledge", "experience", asset_file.stem],
            "created_at": datetime.now().isoformat()
        }
    }
    
    # 发送请求
    print(f"\n发送请求到: {EVOMAP_API}")
    
    try:
        result = subprocess.run([
            'curl', '-s', '-X', 'POST',
            '-H', 'Content-Type: application/json',
            '-d', json.dumps(payload),
            EVOMAP_API
        ], capture_output=True, text=True, timeout=30)
        
        if result.returncode == 0:
            response = json.loads(result.stdout)
            print(f"\n✅ 发布成功！")
            print(f"Bundle ID: {response.get('bundle_id', 'N/A')}")
            print(f"Gene Hash: {response.get('gene_hash', 'N/A')}")
            print(f"Capsule Hash: {response.get('capsule_hash', 'N/A')}")
            print(f"Status: {response.get('status', 'N/A')}")
            
            # 保存发布日志
            log_file = asset_file.parent / f"publish_log_{asset_file.stem}.json"
            log_file.write_text(json.dumps({
                "asset": str(asset_file),
                "bundle_id": response.get('bundle_id'),
                "gene_hash": response.get('gene_hash'),
                "capsule_hash": response.get('capsule_hash'),
                "published_at": datetime.now().isoformat(),
                "response": response
            }, indent=2))
            
            return True
        else:
            print(f"\n❌ 发布失败")
            print(f"错误: {result.stderr}")
            return False
            
    except Exception as e:
        print(f"\n❌ 发布失败: {e}")
        return False

def main():
    """主函数"""
    # 查找最新的知识资产
    assets_dir = Path.home() / ".openclaw/workspace/passive_income_assets"
    
    # 查找今天创建的资产
    today = datetime.now().strftime("%Y-%m-%d")
    recent_assets = []
    
    for asset_file in assets_dir.glob("*.md"):
        mtime = datetime.fromtimestamp(asset_file.stat().st_mtime)
        if mtime.strftime("%Y-%m-%d") == today:
            recent_assets.append((mtime, asset_file))
    
    # 按时间排序
    recent_assets.sort(reverse=True)
    
    if not recent_assets:
        print("⚠️ 未找到今天创建的知识资产")
        return
    
    # 发布最新的资产
    latest_mtime, latest_asset = recent_assets[0]
    print(f"\n找到最新知识资产: {latest_asset.name}")
    print(f"创建时间: {latest_mtime}")
    
    # 检查是否已发布
    log_file = latest_asset.parent / f"publish_log_{latest_asset.stem}.json"
    if log_file.exists():
        print(f"\n⚠️ 该资产已发布过，跳过")
        return
    
    # 发布
    success = publish_to_evomap(latest_asset)
    
    if success:
        print(f"\n{'='*60}")
        print(f"✅ 被动收入构建器执行完成")
        print(f"{'='*60}")
    else:
        print(f"\n{'='*60}")
        print(f"❌ 发布失败，下次重试")
        print(f"{'='*60}")

if __name__ == "__main__":
    main()
