# YouTube → WordPress Article Workflow

## Overview

Turn YouTube videos into polished WordPress blog articles automatically.

---

## Phase 1: Video Content Extraction

### Option A: YouTube Transcript (Fast, Free)

1. Extract transcript via YouTube's built-in captions
2. Use `yt-dlp` or web scraping for transcript fetch
3. Clean up timestamps and formatting

### Option B: Audio Transcription (Higher Quality)

1. Download audio with `yt-dlp`
2. Transcribe with Whisper (local) or API (AssemblyAI, Deepgram)
3. Better accuracy for videos without captions

### Option C: Full Video Analysis (Richest Content)

1. Extract key frames with ffmpeg
2. Use vision model to describe visuals
3. Combine transcript + visual descriptions

**Recommendation:** Start with Option A (transcript), add Option B if quality issues.

---

## Phase 2: Content Transformation

### Step 1: Structure Analysis

- Identify main topics/sections
- Extract key points, quotes, data
- Note timestamps for reference

### Step 2: Article Drafting

- **Title:** Catchy, SEO-friendly
- **Introduction:** Hook + summary
- **Body:** Organized sections with headers
- **Conclusion:** Key takeaways + CTA
- **Meta:** Description, tags, categories

### Step 3: Enhancement

- Add relevant links
- Suggest images/screenshots
- Format with proper headings (H2, H3)
- Add bullet points for scannability

---

## Phase 3: WordPress Publishing

### Manual Review (Recommended)

1. Draft generated in workspace
2. Human reviews and edits
3. Copy to WordPress admin
4. Add featured image
5. Schedule or publish

### Automated Publishing (Optional)

- WordPress REST API integration
- Auto-create draft posts
- Requires: Application password, site URL

---

## Tools Needed

| Task                  | Tool                      | Status           |
| --------------------- | ------------------------- | ---------------- |
| Video download        | `yt-dlp`                  | ✅ Available     |
| Transcript extraction | `yt-dlp --write-auto-sub` | ✅ Available     |
| Audio extraction      | `ffmpeg`                  | ✅ Available     |
| Transcription (local) | `whisper` CLI             | ⚠️ Check install |
| Article drafting      | LLM (current)             | ✅ Ready         |
| WordPress API         | REST + auth               | 🔲 Setup needed  |

---

## Workflow Commands

```bash
# Download video info + transcript
yt-dlp --write-auto-sub --sub-lang en --skip-download "VIDEO_URL"

# Download audio only
yt-dlp -x --audio-format mp3 "VIDEO_URL"

# Extract frames
ffmpeg -i video.mp4 -vf "fps=1/60" frame_%03d.jpg
```

---

## Implementation Steps

### Week 1: Core Pipeline

- [ ] Create `youtube-to-wordpress/` folder
- [ ] Script: fetch transcript from URL
- [ ] Prompt template for article generation
- [ ] Output: Markdown draft file

### Week 2: Polish

- [ ] Add SEO optimization (title, meta)
- [ ] Suggest internal/external links
- [ ] Format for readability

### Week 3: WordPress Integration (Optional)

- [ ] Set up WordPress Application Password
- [ ] Script: create draft via REST API
- [ ] Test with sample article

---

## Example Usage

```
User: Turn this video into a blog post: https://youtube.com/watch?v=xyz

Agent:
1. Fetches transcript
2. Generates structured article
3. Saves to workspace as draft
4. Asks for review before publishing
```

---

## Cost Estimate

| Method             | Cost        | Quality                  |
| ------------------ | ----------- | ------------------------ |
| YouTube transcript | Free        | Good (if captions exist) |
| Whisper local      | Free        | Excellent                |
| Whisper API        | ~$0.36/hour | Excellent                |
| AssemblyAI         | ~$0.50/hour | Excellent                |

---

## Next Steps

1. **Confirm approach:** Transcript-only or full transcription?
2. **Test video:** Share a YouTube URL to test the pipeline
3. **WordPress:** Do you want auto-publishing or manual review?

---

_Ready to build. Share a test video URL to start._
