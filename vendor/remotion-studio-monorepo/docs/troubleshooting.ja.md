# トラブルシューティングガイド

Remotion Studio Monorepoでよくある問題とその解決策です。

## 目次

- [コマンドの問題](#command-issues)
- [Git](#git)
- [設定の問題](#configuration-issues)
- [依存関係 & インストール](#dependencies--installation)
- [ランタイムエラー](#runtime-errors)
- [開発サーバー](#development-server)

---

## コマンドの問題

### `remotion` コマンドが見つからない

**解決策:**

```bash
# 特定のアプリに追加
pnpm -F @studio/<app> add -D @remotion/cli

# またはワークスペース全体に追加
pnpm -w add -D @remotion/cli
```

### `pnpm` コマンドが見つからない

**解決策:**

```bash
# corepackを使用（Node 20+ 推奨）
corepack enable
corepack prepare pnpm@latest --activate

# またはグローバルにインストール
npm i -g pnpm
```

---

## Git

### `fatal: not a git repository`

**解決策:** サブディレクトリ内ではなく、リポジトリのルートでコマンドを実行していることを確認してください。

```bash
cd /path/to/remotion-studio-monorepo
git status
```

---

## 設定の問題

### `import.meta` 警告

**原因:** `import.meta.url` を使用する古い `remotion.config.ts`

**解決策:** テンプレートはパス解決に `process.cwd()` を使用します。この警告が表示される場合は、設定を更新してください：

```ts
// remotion.config.ts
import { Config } from "@remotion/cli/config";
import path from "path";

// import.meta.url の代わりに process.cwd() を使用
Config.overrideWebpackConfig((config) => {
  return {
    ...config,
    resolve: {
      ...config.resolve,
      alias: {
        ...config.resolve?.alias,
        "@": path.resolve(process.cwd(), "src"),
      },
    },
  };
});
```

### TypeScript: `must have at most one *` エラー

**原因:** `tsconfig.json` の単一の `paths` エントリに複数のワイルドカード

**解決策:** パスマッピングを分割して、エントリごとに最大1つの `*` にします：

```json
{
  "compilerOptions": {
    "paths": {
      "@/*": ["./src/*"],
      "@components/*": ["./src/components/*"]
    }
  }
}
```

### エントリポイントが見つからない

**症状:** `Error: Entry point not found`

**解決策:** 各アプリにRemotion v4のエントリポイントとして `src/index.ts`（または `.tsx`）があることを確認してください：

```ts
// src/index.ts
import { registerRoot } from "remotion";
import { Root } from "./Root";

registerRoot(Root);
```

**オプション:** `remotion.config.ts` でエントリポイントを明示的に設定：

```ts
import { Config } from "@remotion/cli/config";

Config.setEntryPoint("src/index.ts");
```

---

## 依存関係 & インストール

### `ffmpeg` が見つからない

**症状:** `ffmpeg: command not found` でレンダリングが失敗する

**解決策:**

```bash
# macOS
brew install ffmpeg

# Windows（Chocolateyを使用）
choco install ffmpeg

# Linux（Debian/Ubuntu）
sudo apt update && sudo apt install ffmpeg

# Linux（RHEL/CentOS/Fedora）
sudo yum install ffmpeg

# インストールを確認
ffmpeg -version
```

### Nodeバージョンの問題

**症状:** サポートされていないNode.js機能に関連するエラー

**解決策:** Node.js 18以上を使用（20推奨）

```bash
# nvmを使用
nvm install 20
nvm use 20

# 確認
node -v
```

### `pnpm install` が失敗する

**一般的な原因:**

1. **ネットワークの問題** → `--network-timeout 100000` を試す
2. **ロックファイルの競合** → `pnpm-lock.yaml` を削除して再試行
3. **キャッシュの破損** → `pnpm store prune` を実行してから再試行

```bash
# キャッシュをクリアして再インストール
pnpm store prune
rm -rf node_modules pnpm-lock.yaml
pnpm install
```

---

## ランタイムエラー

### ブラウザモジュールエラー（`fs`、`path`、`net`など）

**症状:** `Module not found: Can't resolve 'fs'`

**原因:** ブラウザで実行されるコード（Compositionコンポーネント）にNode.js専用モジュールがインポートされている

**解決策:**

- Node.jsコードを `scripts/` または `remotion.config.ts` に移動
- Webpackエイリアスを使用してブラウザ互換の代替品を提供
- 環境に基づいて条件付きインポートを使用

```ts
// remotion.config.ts - Nodeモジュールのフォールバックを追加
Config.overrideWebpackConfig((config) => {
  return {
    ...config,
    resolve: {
      ...config.resolve,
      fallback: {
        fs: false,
        path: false,
        net: false,
      },
    },
  };
});
```

### CSSインポートの欠落

**症状:** スタイルが適用されない

**解決策:** CSSファイルを明示的にインポート：

```ts
// src/index.ts またはコンポーネントファイル
import "./styles/app.css";
import "your-library/dist/styles.css";
```

### WebGL / Three.jsレンダリングの問題

**解決策:** `remotion.config.ts` でOpenGLレンダラーを設定：

```ts
import { Config } from "@remotion/cli/config";

Config.setChromiumOpenGlRenderer("angle");
// または環境に応じて 'egl' / 'swiftshader'
```

---

## 開発サーバー

### ポート競合（`EADDRINUSE`）

**症状:** `Error: listen EADDRINUSE: address already in use :::3000`

**解決策:**

```bash
# macOS/Linux: ポート3000を使用しているプロセスを検索
lsof -i :3000

# プロセスを終了
kill -9 <PID>

# または異なるポートを使用
pnpm dev -- --port 3001
```

**Windows:**

```powershell
# プロセスを検索
netstat -ano | findstr :3000

# プロセスを終了
taskkill /PID <PID> /F
```

### ホットリロードが機能しない

**解決策:**

1. 正しいディレクトリ（`apps/<name>`）にいることを確認
2. 開発サーバーを再起動：`pnpm dev`
3. ブラウザのキャッシュをクリアしてリロード
4. ファイルウォッチャーの制限を確認（Linux）：

```bash
# ファイルウォッチャーの制限を増やす
echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

---

## まだ問題がありますか？

1. **公式Remotionドキュメントを確認:** https://www.remotion.dev/docs
2. **GitHubのissueを検索:** https://github.com/remotion-dev/remotion/issues
3. **Remotion Discordに参加:** https://remotion.dev/discord
4. **このリポジトリのissueを確認:** https://github.com/Takamasa045/remotion-studio-monorepo/issues

---

## デバッグのヒント

### 詳細ログを有効にする

```bash
# デバッグ出力付きで実行
DEBUG=* pnpm dev

# Remotion固有のログ
REMOTION_LOGGING=verbose pnpm dev
```

### バージョンの整合性を確認

```bash
# すべての @remotion/* パッケージのバージョンが一致していることを確認
pnpm remotion versions
```

### クリーンビルド

```bash
# すべてのビルド成果物とキャッシュを削除
rm -rf node_modules .remotion dist out
pnpm install
```

### 分離してテスト

```bash
# 新しいテストアプリを作成
pnpm create:project -- test-app
cd apps/test-app
pnpm install
pnpm dev
```
