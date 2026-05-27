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

import { Component, computed, inject, input, ViewEncapsulation } from '@angular/core';
import { DynamicComponent } from '../rendering/dynamic-component';
import { Primitives, Styles, Types } from '@a2ui/lit/0.8';
import { MarkdownRenderer } from '../data/markdown';

interface HintedStyles {
  h1: Record<string, string>;
  h2: Record<string, string>;
  h3: Record<string, string>;
  h4: Record<string, string>;
  h5: Record<string, string>;
  body: Record<string, string>;
  caption: Record<string, string>;
}

@Component({
  selector: 'a2ui-text',
  template: `
    <section
      [class]="classes()"
      [style]="additionalStyles()"
      [innerHTML]="resolvedText()"
    ></section>
  `,
  encapsulation: ViewEncapsulation.None,
  styles: `
    a2ui-text {
      display: block;
      flex: var(--weight);
    }

    a2ui-text h1,
    a2ui-text h2,
    a2ui-text h3,
    a2ui-text h4,
    a2ui-text h5 {
      line-height: inherit;
      font: inherit;
    }
  `,
})
export class Text extends DynamicComponent {
  private markdownRenderer = inject(MarkdownRenderer);
  readonly text = input.required<Primitives.StringValue | null>();
  readonly usageHint = input.required<Types.ResolvedText['usageHint'] | null>();

  protected resolvedText = computed(() => {
    const usageHint = this.usageHint();
    let value = super.resolvePrimitive(this.text());

    if (value == null) {
      return '(empty)';
    }

    switch (usageHint) {
      case 'h1':
        value = `# ${value}`;
        break;
      case 'h2':
        value = `## ${value}`;
        break;
      case 'h3':
        value = `### ${value}`;
        break;
      case 'h4':
        value = `#### ${value}`;
        break;
      case 'h5':
        value = `##### ${value}`;
        break;
      case 'caption':
        value = `*${value}*`;
        break;
      default:
        value = String(value);
        break;
    }

    return this.markdownRenderer.render(
      value,
      Styles.appendToAll(this.theme.markdown, ['ol', 'ul', 'li'], {}),
    );
  });

  protected classes = computed(() => {
    const usageHint = this.usageHint();

    return Styles.merge(
      this.theme.components.Text.all,
      usageHint ? this.theme.components.Text[usageHint] : {},
    );
  });

  protected additionalStyles = computed(() => {
    const usageHint = this.usageHint();
    const styles = this.theme.additionalStyles?.Text;

    if (!styles) {
      return null;
    }

    let additionalStyles: Record<string, string> = {};

    if (this.areHintedStyles(styles)) {
      additionalStyles = styles[usageHint ?? 'body'];
    } else {
      additionalStyles = styles;
    }

    return additionalStyles;
  });

  private areHintedStyles(styles: unknown): styles is HintedStyles {
    if (typeof styles !== 'object' || !styles || Array.isArray(styles)) {
      return false;
    }

    const expected = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'caption', 'body'];
    return expected.every((v) => v in styles);
  }
}
