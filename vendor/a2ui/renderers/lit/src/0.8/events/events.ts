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

import type * as A2UI from "./a2ui.js";
import { BaseEventDetail } from "./base.js";

const eventInit = {
  bubbles: true,
  cancelable: true,
  composed: true,
};

type EnforceEventTypeMatch<T extends Record<string, BaseEventDetail<string>>> =
  {
    [K in keyof T]: T[K] extends BaseEventDetail<infer EventType>
      ? EventType extends K
        ? T[K]
        : never
      : never;
  };

export type StateEventDetailMap = EnforceEventTypeMatch<{
  "a2ui.action": A2UI.A2UIAction;
}>;

export class StateEvent<
  T extends keyof StateEventDetailMap
> extends CustomEvent<StateEventDetailMap[T]> {
  static eventName = "a2uiaction";

  constructor(readonly payload: StateEventDetailMap[T]) {
    super(StateEvent.eventName, { detail: payload, ...eventInit });
  }
}

declare global {
  interface HTMLElementEventMap {
    a2uiaction: StateEvent<"a2ui.action">;
  }
}
