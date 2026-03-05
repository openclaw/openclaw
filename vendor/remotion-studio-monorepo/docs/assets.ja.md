# アセットガイド

アプリで静的アセットを整理して参照する方法です。

## フォルダ

各アプリは `public/` からファイルを提供します。

推奨されるレイアウト：

```
public/
  assets/
    images/  # PNG/JPG/SVG
    audio/   # MP3/WAV/WEBM
    video/   # MP4/WEBM
    fonts/   # WOFF/TTF (@font-face + staticFile を使用)
    css/     # オプションのCSS
    data/    # JSONなど
    lottie/  # Lottie JSON
```

## 参照方法

- 画像: `/assets/images/logo.png`
- 音声: `/assets/audio/bgm.mp3`
- 動画: `/assets/video/clip.mp4`

歌詞（LRC）：音声ファイルと同じベース名で隣に配置します。

```ts
const lrc = await fetch("/assets/audio/song.lrc").then((r) => r.text());
```

## ヒント

- 大きなバイナリファイルには、Git LFSまたは外部ストレージ/CDNの使用を検討してください。
- 一部のライブラリはCSSのインポートが必要です。例: `import 'your-lib/dist/styles.css'`
