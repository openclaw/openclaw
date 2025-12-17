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
  selector: 'a2ui-list',
  imports: [Renderer],
  host: {
    '[attr.direction]': 'direction()',
  },
  styles: `
    :host {
      display: block;
      flex: var(--weight);
      min-height: 0;
      overflow: auto;
    }

    :host([direction='vertical']) section {
      display: grid;
    }

    :host([direction='horizontal']) section {
      display: flex;
      max-width: 100%;
      overflow-x: scroll;
      overflow-y: hidden;
      scrollbar-width: none;

      > ::slotted(*) {
        flex: 1 0 fit-content;
        max-width: min(80%, 400px);
      }
    }
  `,
  template: `
    <section [class]="theme.components.List" [style]="theme.additionalStyles?.List">
      @for (child of component().properties.children; track child) {
        <ng-container a2ui-renderer [surfaceId]="surfaceId()!" [component]="child" />
      }
    </section>
  `,
})
export class List extends DynamicComponent<Types.ListNode> {
  readonly direction = input<'vertical' | 'horizontal'>('vertical');
}
