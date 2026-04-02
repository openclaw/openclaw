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

/**
 * A message from the client describing its capabilities, such as the component
 * catalog it supports. Exactly ONE of the properties in this object must be
 * set.
 */

export type ClientCapabilitiesUri = string;
export type ClientCapabilitiesDynamic = {
  components: { [key: string]: unknown };
  styles: { [key: string]: unknown };
};

export type ClientCapabilities =
  | { catalogUri: ClientCapabilitiesUri }
  | { dynamicCatalog: ClientCapabilitiesDynamic };

/**
 * A message sent from the client to the server. Exactly ONE of the properties
 * in this object must be set.
 */
export interface ClientToServerMessage {
  userAction?: UserAction;
  clientUiCapabilities?: ClientCapabilities;
  error?: ClientError;
  /** Demo content */
  request?: unknown;
}

/**
 * Represents a user-initiated action, sent from the client to the server.
 */
export interface UserAction {
  /**
   * The name of the action.
   */
  name: string;
  /**
   * The ID of the surface.
   */
  surfaceId: string;
  /**
   * The ID of the component that triggered the event.
   */
  sourceComponentId: string;
  /**
   * An ISO timestamp of when the event occurred.
   */
  timestamp: string;
  /**
   * A JSON object containing the key-value pairs from the component's
   * `action.context`, after resolving all data bindings.
   */
  context?: {
    [k: string]: unknown;
  };
}

/**
 * A message from the client indicating an error occurred, for example,
 * during UI rendering.
 */
export interface ClientError {
  [k: string]: unknown;
}
