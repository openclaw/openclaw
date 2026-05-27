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

import { Action } from "../types/components.js";
import { AnyComponentNode } from "../types/types.js";
import { BaseEventDetail } from "./base.js";

type Namespace = "a2ui";

export interface A2UIAction extends BaseEventDetail<`${Namespace}.action`> {
  readonly action: Action;
  readonly dataContextPath: string;
  readonly sourceComponentId: string;
  readonly sourceComponent: AnyComponentNode | null;
}
