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

import { computed, Component, input } from '@angular/core';
import { Primitives, Types } from '@a2ui/lit/0.8';
import { DynamicComponent } from '../rendering/dynamic-component';

@Component({
  selector: 'a2ui-text-field',
  styles: `
    :host {
      display: flex;
      flex: var(--weight);
    }

    section,
    input,
    label {
      box-sizing: border-box;
    }

    input {
      display: block;
      width: 100%;
    }

    label {
      display: block;
      margin-bottom: 4px;
    }
  `,
  template: `
    @let resolvedLabel = this.resolvedLabel();

    <section [class]="theme.components.TextField.container">
      @if (resolvedLabel) {
        <label [for]="inputId" [class]="theme.components.TextField.label">{{
          resolvedLabel
        }}</label>
      }

      <input
        autocomplete="off"
        [class]="theme.components.TextField.element"
        [style]="theme.additionalStyles?.TextField"
        (input)="handleInput($event)"
        [id]="inputId"
        [value]="inputValue()"
        placeholder="Please enter a value"
        [type]="inputType() === 'number' ? 'number' : 'text'"
      />
    </section>
  `,
})
export class TextField extends DynamicComponent {
  readonly text = input.required<Primitives.StringValue | null>();
  readonly label = input.required<Primitives.StringValue | null>();
  readonly inputType = input.required<Types.ResolvedTextField['type'] | null>();

  protected inputValue = computed(() => super.resolvePrimitive(this.text()) || '');
  protected resolvedLabel = computed(() => super.resolvePrimitive(this.label()));
  protected inputId = super.getUniqueId('a2ui-input');

  protected handleInput(event: Event) {
    const path = this.text()?.path;

    if (!(event.target instanceof HTMLInputElement) || !path) {
      return;
    }

    this.processor.setData(this.component(), path, event.target.value, this.surfaceId());
  }
}
