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
import { DynamicComponent } from '../rendering/dynamic-component';
import { Primitives } from '@a2ui/lit/0.8';

@Component({
  selector: 'a2ui-datetime-input',
  template: `
    <section [class]="theme.components.DateTimeInput.container">
      <label [for]="inputId" [class]="theme.components.DateTimeInput.label">{{ label() }}</label>

      <input
        autocomplete="off"
        [attr.type]="inputType()"
        [id]="inputId"
        [class]="theme.components.DateTimeInput.element"
        [style]="theme.additionalStyles?.DateTimeInput"
        [value]="inputValue()"
        (input)="handleInput($event)"
      />
    </section>
  `,
  styles: `
    :host {
      display: block;
      flex: var(--weight);
      min-height: 0;
      overflow: auto;
    }

    input {
      display: block;
      width: 100%;
      box-sizing: border-box;
    }
  `,
})
export class DatetimeInput extends DynamicComponent {
  readonly value = input.required<Primitives.StringValue | null>();
  readonly enableDate = input.required<boolean>();
  readonly enableTime = input.required<boolean>();
  protected readonly inputId = super.getUniqueId('a2ui-datetime-input');

  protected inputType = computed(() => {
    const enableDate = this.enableDate();
    const enableTime = this.enableTime();

    if (enableDate && enableTime) {
      return 'datetime-local';
    } else if (enableDate) {
      return 'date';
    } else if (enableTime) {
      return 'time';
    }

    return 'datetime-local';
  });

  protected label = computed(() => {
    // TODO: this should likely be passed from the model.
    const inputType = this.inputType();

    if (inputType === 'date') {
      return 'Date';
    } else if (inputType === 'time') {
      return 'Time';
    }

    return 'Date & Time';
  });

  protected inputValue = computed(() => {
    const inputType = this.inputType();
    const parsed = super.resolvePrimitive(this.value()) || '';
    const date = parsed ? new Date(parsed) : null;

    if (!date || isNaN(date.getTime())) {
      return '';
    }

    const year = this.padNumber(date.getFullYear());
    const month = this.padNumber(date.getMonth());
    const day = this.padNumber(date.getDate());
    const hours = this.padNumber(date.getHours());
    const minutes = this.padNumber(date.getMinutes());

    // Browsers are picky with what format they allow for the `value` attribute of date/time inputs.
    // We need to parse it out of the provided value. Note that we don't use `toISOString`,
    // because the resulting value is relative to UTC.
    if (inputType === 'date') {
      return `${year}-${month}-${day}`;
    } else if (inputType === 'time') {
      return `${hours}:${minutes}`;
    }

    return `${year}-${month}-${day}T${hours}:${minutes}`;
  });

  protected handleInput(event: Event) {
    const path = this.value()?.path;

    if (!(event.target instanceof HTMLInputElement) || !path) {
      return;
    }

    this.processor.setData(this.component(), path, event.target.value, this.surfaceId());
  }

  private padNumber(value: number) {
    return value.toString().padStart(2, '0');
  }
}
