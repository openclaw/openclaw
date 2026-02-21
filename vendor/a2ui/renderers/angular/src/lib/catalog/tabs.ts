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

import { Component, computed, input, signal } from '@angular/core';
import { DynamicComponent } from '../rendering/dynamic-component';
import { Renderer } from '../rendering/renderer';
import { Styles, Types } from '@a2ui/lit/0.8';

@Component({
  selector: 'a2ui-tabs',
  imports: [Renderer],
  template: `
    @let tabs = this.tabs();
    @let selectedIndex = this.selectedIndex();

    <section [class]="theme.components.Tabs.container" [style]="theme.additionalStyles?.Tabs">
      <div [class]="theme.components.Tabs.element">
        @for (tab of tabs; track tab) {
          <button
            (click)="this.selectedIndex.set($index)"
            [disabled]="selectedIndex === $index"
            [class]="buttonClasses()[selectedIndex]"
          >
            {{ resolvePrimitive(tab.title) }}
          </button>
        }
      </div>

      <ng-container
        a2ui-renderer
        [surfaceId]="surfaceId()!"
        [component]="tabs[selectedIndex].child"
      />
    </section>
  `,
  styles: `
    :host {
      display: block;
      flex: var(--weight);
    }
  `,
})
export class Tabs extends DynamicComponent {
  protected selectedIndex = signal(0);
  readonly tabs = input.required<Types.ResolvedTabItem[]>();

  protected readonly buttonClasses = computed(() => {
    const selectedIndex = this.selectedIndex();

    return this.tabs().map((_, index) => {
      return index === selectedIndex
        ? Styles.merge(
          this.theme.components.Tabs.controls.all,
          this.theme.components.Tabs.controls.selected,
        )
        : this.theme.components.Tabs.controls.all;
    });
  });
}
