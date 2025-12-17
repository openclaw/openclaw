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

import { Component, input } from '@angular/core';
import { Types } from '@a2ui/lit/0.8';
import { DynamicComponent } from '../rendering/dynamic-component';
import { Renderer } from '../rendering/renderer';

@Component({
  selector: 'a2ui-button',
  imports: [Renderer],
  template: `
    <button
      [class]="theme.components.Button"
      [style]="theme.additionalStyles?.Button"
      (click)="handleClick()"
    >
      <ng-container
        a2ui-renderer
        [surfaceId]="surfaceId()!"
        [component]="component().properties.child"
      />
    </button>
  `,
  styles: `
    :host {
      display: block;
      flex: var(--weight);
      min-height: 0;
    }
  `,
})
export class Button extends DynamicComponent<Types.ButtonNode> {
  readonly action = input.required<Types.Action | null>();

  protected handleClick() {
    const action = this.action();

    if (action) {
      super.sendAction(action);
    }
  }
}
