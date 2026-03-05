# MCPセットアップ（Claude / Codex）

## Claude Code

ターミナルから追加：

```bash
claude mcp add
# Name: remotion-documentation
# Command: npx
# Args: @remotion/mcp@latest
```

手動設定：

```json
{
  "mcpServers": {
    "remotion-documentation": {
      "command": "npx",
      "args": ["@remotion/mcp@latest"]
    }
  }
}
```

チャットで使用: "Use remotion-documentation to look up the render h264 flag."

## Codex CLI

`~/.codex/config.toml` に追記：

```toml
[mcp_servers.remotion_documentation]
type = "stdio"
command = "npx"
args = ["@remotion/mcp@latest"]
```
