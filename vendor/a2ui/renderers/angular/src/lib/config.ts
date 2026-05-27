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

import { EnvironmentProviders, makeEnvironmentProviders } from '@angular/core';
import { Catalog, Theme } from './rendering';

export function provideA2UI(config: { catalog: Catalog; theme: Theme }): EnvironmentProviders {
  return makeEnvironmentProviders([
    { provide: Catalog, useValue: config.catalog },
    { provide: Theme, useValue: config.theme },
  ]);
}
