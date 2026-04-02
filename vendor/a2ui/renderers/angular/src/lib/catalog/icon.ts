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
import { DynamicComponent } from '../rendering/dynamic-component';
import { Primitives } from '@a2ui/lit/0.8';

@Component({
  selector: 'a2ui-icon',
  styles: `
    :host {
      display: block;
      flex: var(--weight);
      min-height: 0;
      overflow: auto;
    }
  `,
  template: `
    @let resolvedName = this.resolvedName();

    @if (resolvedName) {
      <section [class]="theme.components.Icon" [style]="theme.additionalStyles?.Icon">
        <span class="g-icon">{{ resolvedName }}</span>
      </section>
    }
  `,
})
export class Icon extends DynamicComponent {
  readonly name = input.required<Primitives.StringValue | null>();
  protected readonly resolvedName = computed(() => this.resolvePrimitive(this.name()));
}
