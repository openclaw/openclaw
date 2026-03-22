/**
 * PDF-Text-Extractor - Extract text from PDFs with OCR support
 * Vernox v1.0 - Autonomous Revenue Agent
 */

const fs = require("fs");
const path = require("path");

// Load configuration
const configPath = path.join(__dirname, "config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

// PDF.js will be loaded dynamically
let pdfjs = null;

/**
 * Extract text from a single PDF file
 */
function extractText(params) {
  const { pdfPath, options = {} } = params;

  if (!pdfPath) {
    throw new Error("pdfPath is required");
  }

  // Lazy load PDF.js (only when needed)
  if (!pdfjs) {
    try {
      pdfjs = require("pdfjs-dist");
    } catch (e) {
      throw new Error("PDF.js not available. Install with: npm install pdfjs-dist");
    }
  }

  return new Promise((resolve, reject) => {
    const fileData = fs.readFileSync(pdfPath);
    const loadingTask = pdfjs.getDocument(fileData);

    loadingTask.promise
      .then((pdf) => {
        const pages = pdf.numPages;
        let fullText = "";
        let pageCount = 0;

        const processPage = (pageNum) => {
          return pdf
            .getPage(pageNum)
            .then((page) => {
              return page.getTextContent();
            })
            .then((textContent) => {
              const text = textContent.items.map((item) => item.str).join(" ");
              fullText += text + "\n\n";
              pageCount++;

              if (pageCount === pages) {
                // All pages processed
                const wordCount = countWords(fullText);
                const charCount = fullText.length;
                const detectedLang = detectLanguage(fullText);
                const method = options.ocr ? "ocr" : "text";

                resolve({
                  text: fullText,
                  pages: pages,
                  wordCount: wordCount,
                  charCount: charCount,
                  language: detectedLang,
                  method: method,
                  metadata: {
                    title: pdf.info?.Title || "",
                    author: pdf.info?.Author || "",
                    creationDate: pdf.info?.CreationDate || "",
                    creator: pdf.info?.Creator || "",
                  },
                });
              }
            });
        };

        // Process all pages
        for (let i = 1; i <= pages; i++) {
          processPage(i);
        }
      })
      .catch((error) => {
        reject({
          error: `PDF parsing failed: ${error.message}`,
          suggestion: "Check if file is a valid PDF",
        });
      });
  });
}

/**
 * Extract text from multiple PDF files at once
 */
function extractBatch(params) {
  const { pdfFiles, options = {} } = params;

  if (!pdfFiles || !Array.isArray(pdfFiles)) {
    throw new Error("pdfFiles must be an array of file paths");
  }

  const results = [];
  const errors = [];
  let successCount = 0;
  let failureCount = 0;
  let totalPages = 0;

  const processOne = (pdfPath) => {
    return extractText({ pdfPath, options })
      .then((result) => {
        results.push(result);
        successCount++;
        totalPages += result.pages;
      })
      .catch((error) => {
        errors.push({
          file: pdfPath,
          error: error.message || error,
        });
        failureCount++;
      });
  };

  // Process files in batches (configurable concurrency)
  const batchSize = config.batch?.maxConcurrent || 3;
  const batches = [];
  for (let i = 0; i < pdfFiles.length; i += batchSize) {
    batches.push(pdfFiles.slice(i, i + batchSize));
  }

  return batches
    .reduce((chain, batch) => {
      return chain.then(() => Promise.all(batch.map(processOne)));
    }, Promise.resolve())
    .then(() => {
      return {
        results,
        totalPages,
        successCount,
        failureCount,
        errors,
      };
    });
}

/**
 * Count words in text
 */
function countWords(params) {
  const { text, options = {} } = params;
  const { minWordLength = 3, excludeNumbers = false, countByPage = false } = options;

  // Split into words
  const pages = text.split(/\n\n/); // Assume double newline is page break
  let totalWords = 0;
  const pageCounts = [];

  pages.forEach((page, index) => {
    // Remove extra whitespace, split by spaces
    const words = page
      .trim()
      .replace(/\s+/g, " ")
      .split(" ")
      .filter((word) => {
        if (excludeNumbers) {
          // Check if word is mostly numbers
          const numericChars = word.replace(/[^0-9]/g, "").length;
          return word.length - numericChars >= minWordLength;
        }
        return word.length >= minWordLength;
      });

    const pageCount = words.length;
    pageCounts.push(pageCount);
    totalWords += pageCount;
  });

  if (countByPage) {
    return {
      wordCount: totalWords,
      charCount: text.length,
      pageCounts: pageCounts,
      averageWordsPerPage: totalWords / pageCounts.length,
    };
  }

  return {
    wordCount: totalWords,
    charCount: text.length,
  };
}

/**
 * Detect language of text (simple heuristic)
 */
function detectLanguage(text) {
  if (!text || text.length < 50) {
    return { language: "unknown", languageName: "Unknown", confidence: 0 };
  }

  // Simple frequency analysis for common languages
  const langPatterns = {
    English: /\b(the|and|is|of|to|in)\b/i,
    Spanish: /\b(el|la|los|las|en|un|una|una|os|que|de|del|al|con)\b/i,
    French: /\b(le|la|les|des|de|du|un|une|que|et|en)\b/i,
    German: /\b(der|die|das|dem|den|ein|eine|einem|und|ich|hat|was|ist)\b/i,
  };

  let detectedLang = "unknown";
  let maxScore = 0;

  for (const [lang, pattern] of Object.entries(langPatterns)) {
    const matches = (text.match(pattern) || []).length;
    if (matches > maxScore) {
      maxScore = matches;
      detectedLang = lang;
    }
  }

  const confidence = Math.min(100, Math.round((maxScore / 100) * 100));

  const langNames = {
    English: "English",
    Spanish: "Spanish",
    French: "French",
    German: "German",
  };

  return {
    language: detectedLang,
    languageName: langNames[detectedLang] || "Unknown",
    confidence: confidence,
  };
}

/**
 * Main function - handles tool invocations
 */
function main(action, params) {
  switch (action) {
    case "extractText":
      return extractText(params);

    case "extractBatch":
      return extractBatch(params);

    case "countWords":
      return countWords(params);

    case "detectLanguage":
      return detectLanguage(params.text);

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

// CLI interface
if (require.main === module) {
  const args = process.argv.slice(2);
  const action = args[0];

  try {
    const params = JSON.parse(args[1] || "{}");
    const result = main(action, params);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          error: error.message || error,
          suggestion: "Check your parameters and try again",
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }
}

module.exports = { main, extractText, extractBatch, countWords, detectLanguage };
