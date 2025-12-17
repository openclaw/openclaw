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

export * as Events from "./events/events.js";
export * as Types from "./types/types.js";
export * as Primitives from "./types/primitives.js";
export * as Styles from "./styles/index.js";
import * as Guards from "./data/guards.js";

import { create as createSignalA2uiMessageProcessor } from "./data/signal-model-processor.js";
import { A2uiMessageProcessor } from "./data/model-processor.js";
import A2UIClientEventMessage from "./schemas/server_to_client_with_standard_catalog.json" with { type: "json" };

export const Data = {
  createSignalA2uiMessageProcessor,
  A2uiMessageProcessor,
  Guards,
};

export const Schemas = {
  A2UIClientEventMessage,
};
