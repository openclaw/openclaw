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

import { inject, Injectable, SecurityContext } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import MarkdownIt from 'markdown-it';

@Injectable({ providedIn: 'root' })
export class MarkdownRenderer {
  private originalClassMap = new Map<string, any>();
  private sanitizer = inject(DomSanitizer);

  private markdownIt = MarkdownIt({
    highlight: (str, lang) => {
      if (lang === 'html') {
        const iframe = document.createElement('iframe');
        iframe.classList.add('html-view');
        iframe.srcdoc = str;
        iframe.sandbox = '';
        return iframe.innerHTML;
      }

      return str;
    },
  });

  render(value: string, tagClassMap?: Record<string, string[]>) {
    if (tagClassMap) {
      this.applyTagClassMap(tagClassMap);
    }
    const htmlString = this.markdownIt.render(value);
    this.unapplyTagClassMap();
    return this.sanitizer.sanitize(SecurityContext.HTML, htmlString);
  }

  private applyTagClassMap(tagClassMap: Record<string, string[]>) {
    Object.entries(tagClassMap).forEach(([tag, classes]) => {
      let tokenName;
      switch (tag) {
        case 'p':
          tokenName = 'paragraph';
          break;
        case 'h1':
        case 'h2':
        case 'h3':
        case 'h4':
        case 'h5':
        case 'h6':
          tokenName = 'heading';
          break;
        case 'ul':
          tokenName = 'bullet_list';
          break;
        case 'ol':
          tokenName = 'ordered_list';
          break;
        case 'li':
          tokenName = 'list_item';
          break;
        case 'a':
          tokenName = 'link';
          break;
        case 'strong':
          tokenName = 'strong';
          break;
        case 'em':
          tokenName = 'em';
          break;
      }

      if (!tokenName) {
        return;
      }

      const key = `${tokenName}_open`;
      const original = this.markdownIt.renderer.rules[key];
      this.originalClassMap.set(key, original);

      this.markdownIt.renderer.rules[key] = (tokens, idx, options, env, self) => {
        const token = tokens[idx];
        for (const clazz of classes) {
          token.attrJoin('class', clazz);
        }

        if (original) {
          return original.call(this, tokens, idx, options, env, self);
        } else {
          return self.renderToken(tokens, idx, options);
        }
      };
    });
  }

  private unapplyTagClassMap() {
    for (const [key, original] of this.originalClassMap) {
      this.markdownIt.renderer.rules[key] = original;
    }

    this.originalClassMap.clear();
  }
}
