# パッケージガイド

Remotion Studio Monorepoで利用可能なパッケージとライブラリの完全ガイドです。

## 目次

- [公式 @remotion/\* パッケージ](#official-remotion-packages)
- [内部パッケージ](#internal-packages)
- [バージョン管理](#version-management)
- [インストール例](#installation-examples)
- [ピア依存関係](#peer-dependencies)

---

## 公式 @remotion/\* パッケージ

すべてのバージョンを `remotion` に合わせて、`^` を削除してください。`npx remotion versions` を使用して一貫性を確認します。

### Core / Toolchain

開発とレンダリングに不可欠なパッケージです。

| パッケージ                | 目的                                                 |
| ------------------------- | ---------------------------------------------------- |
| `@remotion/cli`           | コマンドラインインターフェース（studio、renderなど） |
| `@remotion/studio`        | タイムラインUIとAPI                                  |
| `@remotion/player`        | 任意のReactアプリにプレーヤーを埋め込み              |
| `@remotion/renderer`      | Node/BunサーバーサイドレンダリングAPI                |
| `@remotion/bundler`       | SSRバンドリングユーティリティ                        |
| `@remotion/eslint-plugin` | Remotion用ESLintルール                               |
| `@remotion/eslint-config` | 推奨ESLint設定                                       |

### Cloud Rendering

| パッケージ           | 目的                                    |
| -------------------- | --------------------------------------- |
| `@remotion/lambda`   | AWS Lambdaレンダリング（本番環境対応）  |
| `@remotion/cloudrun` | GCP Cloud Runレンダリング（アルファ版） |

### Video / Animation

追加のアニメーションとグラフィックス機能でRemotionを拡張します。

| パッケージ                  | 目的                                             |
| --------------------------- | ------------------------------------------------ |
| `@remotion/three`           | Three.js統合                                     |
| `@remotion/skia`            | React Native Skia統合                            |
| `@remotion/lottie`          | Lottieアニメーションサポート                     |
| `@remotion/gif`             | GIFレンダリングサポート                          |
| `@remotion/rive`            | Riveアニメーションサポート                       |
| `@remotion/shapes`          | 幾何学図形ライブラリ                             |
| `@remotion/paths`           | SVGパスユーティリティ                            |
| `@remotion/motion-blur`     | モーションブラーエフェクト                       |
| `@remotion/transitions`     | トランジションエフェクト（フェード、ワイプなど） |
| `@remotion/animation-utils` | アニメーションヘルパーユーティリティ             |
| `@remotion/animated-emoji`  | アニメーション絵文字サポート                     |
| `@remotion/layout-utils`    | レイアウト計算ユーティリティ                     |
| `@remotion/noise`           | パーリンノイズジェネレーター                     |

### Media I/O / Visualization

| パッケージ               | 目的                                             |
| ------------------------ | ------------------------------------------------ |
| `@remotion/media`        | メディア処理ユーティリティ                       |
| `@remotion/media-utils`  | メディアメタデータ抽出                           |
| `@remotion/media-parser` | メディアファイル解析                             |
| `@remotion/webcodecs`    | WebCodecs API（非推奨 → Mediabunnyに移行中）     |
| `@remotion/captions`     | 字幕/キャプションサポート（SRT、VTTなど）        |
| `@remotion/fonts`        | フォントユーティリティ                           |
| `@remotion/google-fonts` | Google Fonts統合                                 |
| `@remotion/preload`      | アセットプリロード（画像、動画、音声、フォント） |

### Speech Recognition (Whisper)

| パッケージ                      | 目的                            |
| ------------------------------- | ------------------------------- |
| `@remotion/install-whisper-cpp` | ローカルWhisper.cppセットアップ |
| `@remotion/whisper-web`         | ブラウザWASM Whisper（実験的）  |
| `@remotion/openai-whisper`      | OpenAI Whisper API統合          |

### Styling

| パッケージ              | 目的                    |
| ----------------------- | ----------------------- |
| `@remotion/tailwind`    | Tailwind CSS v3サポート |
| `@remotion/tailwind-v4` | Tailwind CSS v4サポート |
| `@remotion/enable-scss` | SCSS/SASSサポート       |

### Types / Licensing

| パッケージ            | 目的                                 |
| --------------------- | ------------------------------------ |
| `@remotion/zod-types` | UI用Zodスキーマ統合                  |
| `@remotion/licensing` | エンタープライズライセンス使用量測定 |

---

## 内部パッケージ

オプションの内部パッケージ（テンプレートにはデフォルトで含まれていません）。

### Foundation

| パッケージ           | 目的                                                |
| -------------------- | --------------------------------------------------- |
| `@studio/timing`     | タイムラインユーティリティ（進捗、フレーム変換）    |
| `@studio/core-hooks` | 共有フック（`useAnimationFrame`、`useMediaTiming`） |
| `@studio/core-types` | 共有TypeScript型                                    |

### Animation

| パッケージ             | 目的                                                | ピア依存関係 |
| ---------------------- | --------------------------------------------------- | ------------ |
| `@studio/anime-bridge` | Anime.jsブリッジ + `useAnime` フック                | `animejs`    |
| `@studio/transitions`  | トランジションコンポーネント（FadeIn、FadeOutなど） | -            |
| `@studio/easings`      | イージング関数 + Anime.js変換                       | -            |

### Visual

| パッケージ                | 目的                                                   | ピア依存関係                  |
| ------------------------- | ------------------------------------------------------ | ----------------------------- |
| `@studio/visual-canvas2d` | Pixi.js / Konva統合                                    | `pixi.js`, `konva`            |
| `@studio/visual-three`    | R3Fラッパー、カメラ/ライトプリセット                   | `three`, `@react-three/fiber` |
| `@studio/visual-shaders`  | WebGLシェーダーキャンバス                              | -                             |
| `@studio/visual-effects`  | シェーダーベースエフェクト（グリッチ、ブラー、グロー） | -                             |

### Design

| パッケージ       | 目的                                      |
| ---------------- | ----------------------------------------- |
| `@design/assets` | 共有アセット（`pnpm sync:assets` で同期） |

---

## バージョン管理

### 自動Remotionアップグレード

モノレポ全体で `remotion` とすべての `@remotion/*` パッケージをアップグレードします：

```bash
# 最新の安定版にアップグレード
pnpm upgrade:remotion

# ドライラン（変更をプレビュー）
pnpm upgrade:remotion --dry-run

# 特定のバージョンにアップグレード
pnpm upgrade:remotion 4.0.406

# インストールを実行せずにアップグレード
pnpm upgrade:remotion --skip-install
```

**実行内容:**

- `pnpm-workspace.yaml` の `catalog` にある `remotion` と `@remotion/*` を更新
- 可能な場合、ワークスペース配下の `package.json` は `catalog:` を参照するように揃えます
- `pnpm install` を実行して `pnpm-lock.yaml` を同期

**注:** `pnpm create:project` は自動的にリポジトリのピン留めされたRemotionバージョンを読み取るため、新しくスキャフォールドされたすべてのアプリが現在のバージョンと一致します。

### バージョンの一貫性を確認

```bash
# すべての @remotion/* パッケージが揃っているか確認
pnpm remotion versions
```

---

## インストール例

### アプリごとのインストール

特定のアプリ用にパッケージをインストールします：

```bash
# アニメーションパッケージ
pnpm -C apps/<name> add @remotion/transitions @remotion/shapes @remotion/paths

# Three.jsサポート
pnpm -C apps/<name> add @remotion/three three @react-three/fiber @react-three/drei

# メディアユーティリティ
pnpm -C apps/<name> add @remotion/media-utils @remotion/captions

# スタイリング
pnpm -C apps/<name> add @remotion/tailwind
```

### ワークスペースフィルター構文

ワークスペースフィルターを使用した代替構文：

```bash
pnpm add @remotion/transitions --filter @studio/<app>
pnpm add three @react-three/fiber --filter @studio/<app>
```

### 開発依存関係

開発依存関係としてインストール：

```bash
pnpm -C apps/<name> add -D @remotion/eslint-plugin @remotion/eslint-config
```

---

## ピア依存関係

一部のパッケージは、別途インストールする必要があるピア依存関係を必要とします。

### Animation

| パッケージ             | 必須ピア  |
| ---------------------- | --------- |
| `@studio/anime-bridge` | `animejs` |

**インストール:**

```bash
pnpm -C apps/<name> add animejs
```

### Visual (2D)

| パッケージ                | 必須ピア           |
| ------------------------- | ------------------ |
| `@studio/visual-canvas2d` | `pixi.js`, `konva` |

**インストール:**

```bash
pnpm -C apps/<name> add pixi.js konva
```

### Visual (3D)

| パッケージ             | 必須ピア                      |
| ---------------------- | ----------------------------- |
| `@studio/visual-three` | `three`, `@react-three/fiber` |
| `@remotion/three`      | `three`, `@react-three/fiber` |

**インストール:**

```bash
pnpm -C apps/<name> add three @react-three/fiber @react-three/drei
```

### 型定義

ライブラリのTypeScript型定義を忘れずに：

```bash
# 例: Anime.js型
pnpm -C apps/<name> add -D @types/animejs

# Three.jsはデフォルトで型を含んでいます（@typesは不要）
```

---

## ユースケースと推奨事項

プロジェクトのニーズに基づいてパッケージを選択します。

### シンプルな動画制作

**パッケージ:** コアのみ（テンプレートに既に含まれています）

- `remotion`
- `@remotion/cli`

### トランジション&アニメーション付き

**パッケージ:**

```bash
pnpm -C apps/<name> add @remotion/transitions @remotion/animation-utils
```

### 高度なトゥイーン（Anime.js）

**パッケージ:**

```bash
pnpm -C apps/<name> add animejs
# オプション: 利用可能であれば @studio/anime-bridge を追加
```

### 2Dグラフィックス（Canvas）

**パッケージ:**

```bash
pnpm -C apps/<name> add pixi.js konva
# オプション: 利用可能であれば @studio/visual-canvas2d を追加
```

### 3Dグラフィックス（Three.js）

**パッケージ:**

```bash
pnpm -C apps/<name> add three @react-three/fiber @react-three/drei @remotion/three
```

### 音声&歌詞同期（LRC）

**追加パッケージは不要です！**

- `.lrc` ファイルを `public/assets/audio/` に配置
- 組み込みの `fetch` APIで取得して解析
- オプション: SRT/VTTサポート用に `@remotion/captions`

---

## 重要な注意事項

### ブラウザ実行コンテキスト

**警告:** コンポジションコードはブラウザで実行され、Node.jsではありません。

- ❌ **使用できない:** `fs`, `path`, `net`, `process`など
- ✅ **使用できる:** ブラウザAPI、React、外部ライブラリ

**解決策:** Node.jsコードを以下に移動：

- `scripts/` ディレクトリ
- `remotion.config.ts`（Nodeで実行）
- ビルド時の前処理

### CSSインポート

一部のライブラリは明示的なCSSインポートが必要です：

```ts
// src/index.ts
import "your-library/dist/styles.css";
```

### バンドルサイズの考慮事項

大きな依存関係はレンダリング時間に影響します。以下を検討してください：

- ツリーシェイキング（必要なものだけをインポート）
- 大規模アプリ用のコード分割
- 可能であればより軽量な代替品を使用

---

## さらに読む

- [依存関係の追加ガイド](./adding-deps.ja.md)
- [3D / R3Fノート](./3d-notes.ja.md)
- [公式Remotionパッケージ](https://www.remotion.dev/docs/packages)
- [Remotionのアップグレード](./upgrading-remotion.ja.md)
