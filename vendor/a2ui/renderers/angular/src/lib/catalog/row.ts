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
import { Renderer } from '../rendering/renderer';
import { Types } from '@a2ui/lit/0.8';

@Component({
  selector: 'a2ui-row',
  imports: [Renderer],
  host: {
    '[attr.alignment]': 'alignment()',
    '[attr.distribution]': 'distribution()',
  },
  styles: `
    :host {
      display: flex;
      flex: var(--weight);
    }

    section {
      display: flex;
      flex-direction: row;
      width: 100%;
      min-height: 100%;
      box-sizing: border-box;
    }

    .align-start {
      align-items: start;
    }

    .align-center {
      align-items: center;
    }

    .align-end {
      align-items: end;
    }

    .align-stretch {
      align-items: stretch;
    }

    .distribute-start {
      justify-content: start;
    }

    .distribute-center {
      justify-content: center;
    }

    .distribute-end {
      justify-content: end;
    }

    .distribute-spaceBetween {
      justify-content: space-between;
    }

    .distribute-spaceAround {
      justify-content: space-around;
    }

    .distribute-spaceEvenly {
      justify-content: space-evenly;
    }
  `,
  template: `
    <section [class]="classes()" [style]="theme.additionalStyles?.Row">
      @for (child of component().properties.children; track child) {
        <ng-container a2ui-renderer [surfaceId]="surfaceId()!" [component]="child" />
      }
    </section>
  `,
})
export class Row extends DynamicComponent<Types.RowNode> {
  readonly alignment = input<Types.ResolvedRow['alignment']>('stretch');
  readonly distribution = input<Types.ResolvedRow['distribution']>('start');

  protected readonly classes = computed(() => ({
    ...this.theme.components.Row,
    [`align-${this.alignment()}`]: true,
    [`distribute-${this.distribution()}`]: true,
  }));
}
