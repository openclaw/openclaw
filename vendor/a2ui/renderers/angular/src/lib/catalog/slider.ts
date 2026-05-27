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
import { Primitives } from '@a2ui/lit/0.8';
import { DynamicComponent } from '../rendering/dynamic-component';

@Component({
  selector: '[a2ui-slider]',
  template: `
    <section [class]="theme.components.Slider.container">
      <label [class]="theme.components.Slider.label" [for]="inputId">
        {{ label() }}
      </label>

      <input
        autocomplete="off"
        type="range"
        [value]="resolvedValue()"
        [min]="minValue()"
        [max]="maxValue()"
        [id]="inputId"
        (input)="handleInput($event)"
        [class]="theme.components.Slider.element"
        [style]="theme.additionalStyles?.Slider"
      />
    </section>
  `,
  styles: `
    :host {
      display: block;
      flex: var(--weight);
    }

    input {
      display: block;
      width: 100%;
      box-sizing: border-box;
    }
  `,
})
export class Slider extends DynamicComponent {
  readonly value = input.required<Primitives.NumberValue | null>();
  readonly label = input('');
  readonly minValue = input.required<number | undefined>();
  readonly maxValue = input.required<number | undefined>();

  protected readonly inputId = super.getUniqueId('a2ui-slider');
  protected resolvedValue = computed(() => super.resolvePrimitive(this.value()) ?? 0);

  protected handleInput(event: Event) {
    const path = this.value()?.path;

    if (!(event.target instanceof HTMLInputElement) || !path) {
      return;
    }

    this.processor.setData(this.component(), path, event.target.valueAsNumber, this.surfaceId());
  }
}
