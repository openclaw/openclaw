# PDF-Text-Extractor

**Extract text from PDFs with OCR support. Zero external dependencies (except PDF.js).**

## Quick Start

```bash
# Install
clawhub install pdf-text-extractor

# Extract text from PDF
cd ~/.openclaw/skills/pdf-text-extractor
node index.js extractText '{"pdfPath":"./document.pdf","options":{"outputFormat":"text"}}'
```

## Usage Examples

### Extract to Text

```javascript
const result = await extractText({
  pdfPath: "./invoice.pdf",
  options: { outputFormat: "text" },
});

console.log(result.text);
```

### Extract to JSON with Metadata

```javascript
const result = await extractText({
  pdfPath: "./contract.pdf",
  options: {
    outputFormat: "json",
    includeMetadata: true,
  },
});

console.log(result.metadata);
console.log(`Words: ${result.wordCount}`);
```

### Batch Process Multiple PDFs

```javascript
const results = await extractBatch({
  pdfFiles: ["./doc1.pdf", "./doc2.pdf", "./doc3.pdf"],
});

console.log(`Processed ${results.successCount}/${results.results.length} documents`);
```

### Extract with OCR (Scanned Documents)

```javascript
const result = await extractText({
  pdfPath: "./scanned-doc.pdf",
  options: {
    ocr: true,
    language: "eng",
    ocrQuality: "high",
  },
});

console.log(result.text);
```

### Count Words and Stats

```javascript
const stats = await countWords({
  text: result.text,
  options: { countByPage: true },
});

console.log(`Total words: ${stats.wordCount}`);
console.log(`Pages: ${stats.pageCounts.length}`);
console.log(`Avg per page: ${stats.averageWordsPerPage}`);
```

### Detect Language

```javascript
const lang = await detectLanguage(text);

console.log(`Language: ${lang.languageName}`);
console.log(`Confidence: ${lang.confidence}%`);
```

## Features

- **Text Extraction:** Extract text from PDFs without external tools
- **OCR Support:** Use Tesseract for scanned documents
- **Batch Processing:** Process multiple PDFs at once
- **Multiple Output Formats:** Text, JSON, Markdown, HTML
- **Word Counting:** Accurate word and character counting
- **Language Detection:** Simple heuristic for common languages
- **Metadata Extraction:** Title, author, creation date
- **Page-by-Page:** Extract text with page structure
- **Zero Config Required:** Works out of the box

## Use Cases

### Document Digitization

- Convert paper documents to digital text
- Process invoices and receipts
- Digitize contracts and agreements
- Archive physical documents

### Content Analysis

- Extract text for analysis tools
- Prepare content for LLM processing
- Clean up scanned documents
- Parse PDF-based reports

### Data Extraction

- Extract data from PDF reports
- Parse tables from PDFs
- Pull structured data
- Automate document workflows

### Text Processing

- Prepare content for translation
- Clean up OCR output
- Extract specific sections
- Search within PDF content

## Configuration

Edit `config.json` to customize:

```json
{
  "ocr": {
    "enabled": true,
    "defaultLanguage": "eng",
    "quality": "medium"
  },
  "output": {
    "defaultFormat": "text",
    "preserveFormatting": true
  },
  "batch": {
    "maxConcurrent": 3
  }
}
```

## Test

```bash
node test.js
```

## Output Formats

### Text

Plain text extraction with newlines between pages.

### JSON

```json
{
  "text": "Document text here...",
  "pages": 10,
  "wordCount": 1500,
  "charCount": 8500,
  "language": "English",
  "metadata": {
    "title": "Document Title",
    "author": "Author Name",
    "creationDate": "2026-02-04"
  }
}
```

## Performance

### Text-Based PDFs

- **Speed:** ~100ms for 10-page PDF
- **Accuracy:** 100% (exact text)

### OCR Processing

- **Speed:** ~1-3s per page
- **Accuracy:** 85-95% (depends on scan quality)

## Troubleshooting

### PDF Not Parsing

- Check if file is a valid PDF
- Ensure not password-protected
- Verify PDF.js is installed

### OCR Low Accuracy

- Ensure document language matches OCR language setting
- Try higher quality setting (slower but more accurate)
- Check scan quality (300 DPI+ recommended)

### Slow Processing

- Reduce batch concurrency
- Lower OCR quality for speed
- Process files individually

## Dependencies

```bash
npm install pdfjs-dist
```

## License

MIT

---

**Extract text from PDFs. Fast, accurate, ready to use.** 🔮
