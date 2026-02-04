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

import { Component } from '@angular/core';
import { DynamicComponent } from '../rendering/dynamic-component';

@Component({
  selector: 'a2ui-divider',
  template: '<hr [class]="theme.components.Divider" [style]="theme.additionalStyles?.Divider"/>',
  styles: `
    :host {
      display: block;
      min-height: 0;
      overflow: auto;
    }

    hr {
      height: 1px;
      background: #ccc;
      border: none;
    }
  `,
})
export class Divider extends DynamicComponent {}
