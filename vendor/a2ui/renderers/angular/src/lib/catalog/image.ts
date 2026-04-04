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

import { Component, computed, input } from '@angular/core';
import { Primitives, Styles, Types } from '@a2ui/lit/0.8';
import { DynamicComponent } from '../rendering/dynamic-component';

@Component({
  selector: 'a2ui-image',
  styles: `
    :host {
      display: block;
      flex: var(--weight);
      min-height: 0;
      overflow: auto;
    }

    img {
      display: block;
      width: 100%;
      height: 100%;
      box-sizing: border-box;
    }
  `,
  template: `
    @let resolvedUrl = this.resolvedUrl();

    @if (resolvedUrl) {
      <section [class]="classes()" [style]="theme.additionalStyles?.Image">
        <img [src]="resolvedUrl" />
      </section>
    }
  `,
})
export class Image extends DynamicComponent {
  readonly url = input.required<Primitives.StringValue | null>();
  readonly usageHint = input.required<Types.ResolvedImage['usageHint'] | null>();

  protected readonly resolvedUrl = computed(() => this.resolvePrimitive(this.url()));

  protected classes = computed(() => {
    const usageHint = this.usageHint();

    return Styles.merge(
      this.theme.components.Image.all,
      usageHint ? this.theme.components.Image[usageHint] : {},
    );
  });
}
