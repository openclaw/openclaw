/*
 Copyright 2025 Google LLC

 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at

      https://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
 */

export function extractJsonFromMarkdown(markdown: string): any[] {
  const jsonBlockRegex = /```json\s*([\s\S]*?)\s*```/g;
  const matches = [...markdown.matchAll(jsonBlockRegex)];
  const results: any[] = [];

  for (const match of matches) {
    if (match[1]) {
      const content = match[1].trim();
      // Try parsing as a single JSON object first
      try {
        results.push(JSON.parse(content));
      } catch (error) {
        // If that fails, try parsing as JSONL (line by line)
        const lines = content.split("\n");
        for (const line of lines) {
          if (line.trim()) {
            try {
              results.push(JSON.parse(line));
            } catch (e2) {
              // Ignore invalid lines
            }
          }
        }
      }
    }
  }
  return results;
}
