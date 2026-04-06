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
import { Types } from '@a2ui/lit/0.8';
import { Renderer } from '../rendering/renderer';

@Component({
  selector: 'a2ui-surface',
  imports: [Renderer],
  template: `
    @let surfaceId = this.surfaceId();
    @let surface = this.surface();

    @if (surfaceId && surface) {
      <ng-container a2ui-renderer [surfaceId]="surfaceId" [component]="surface.componentTree!" />
    }
  `,
  styles: `
    :host {
      display: flex;
      min-height: 0;
      max-height: 100%;
      flex-direction: column;
      gap: 16px;
    }
  `,
  host: {
    '[style]': 'styles()',
  },
})
export class Surface {
  readonly surfaceId = input.required<Types.SurfaceID | null>();
  readonly surface = input.required<Types.Surface | null>();

  protected readonly styles = computed(() => {
    const surface = this.surface();
    const styles: Record<string, string> = {};

    if (surface?.styles) {
      for (const [key, value] of Object.entries(surface.styles)) {
        switch (key) {
          // Here we generate a palette from the singular primary color received
          // from the surface data. We will want the values to range from
          // 0 <= x <= 100, where 0 = back, 100 = white, and 50 = the primary
          // color itself. As such we use a color-mix to create the intermediate
          // values.
          //
          // Note: since we use half the range for black to the primary color,
          // and half the range for primary color to white the mixed values have
          // to go up double the amount, i.e., a range from black to primary
          // color needs to fit in 0 -> 50 rather than 0 -> 100.
          case 'primaryColor': {
            styles['--p-100'] = '#ffffff';
            styles['--p-99'] = `color-mix(in srgb, ${value} 2%, white 98%)`;
            styles['--p-98'] = `color-mix(in srgb, ${value} 4%, white 96%)`;
            styles['--p-95'] = `color-mix(in srgb, ${value} 10%, white 90%)`;
            styles['--p-90'] = `color-mix(in srgb, ${value} 20%, white 80%)`;
            styles['--p-80'] = `color-mix(in srgb, ${value} 40%, white 60%)`;
            styles['--p-70'] = `color-mix(in srgb, ${value} 60%, white 40%)`;
            styles['--p-60'] = `color-mix(in srgb, ${value} 80%, white 20%)`;
            styles['--p-50'] = value;
            styles['--p-40'] = `color-mix(in srgb, ${value} 80%, black 20%)`;
            styles['--p-35'] = `color-mix(in srgb, ${value} 70%, black 30%)`;
            styles['--p-30'] = `color-mix(in srgb, ${value} 60%, black 40%)`;
            styles['--p-25'] = `color-mix(in srgb, ${value} 50%, black 50%)`;
            styles['--p-20'] = `color-mix(in srgb, ${value} 40%, black 60%)`;
            styles['--p-15'] = `color-mix(in srgb, ${value} 30%, black 70%)`;
            styles['--p-10'] = `color-mix(in srgb, ${value} 20%, black 80%)`;
            styles['--p-5'] = `color-mix(in srgb, ${value} 10%, black 90%)`;
            styles['--0'] = '#00000';
            break;
          }

          case 'font': {
            styles['--font-family'] = value;
            styles['--font-family-flex'] = value;
            break;
          }
        }
      }
    }

    return styles;
  });
}
