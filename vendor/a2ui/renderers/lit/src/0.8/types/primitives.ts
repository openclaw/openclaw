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

export interface StringValue {
  /**
   * A data binding reference to a location in the data model (e.g., '/user/name').
   */
  path?: string;
  /**
   * A fixed, hardcoded string value.
   */
  literalString?: string;
  /**
   * A fixed, hardcoded string value.
   */
  literal?: string;
}

export interface NumberValue {
  /**
   * A data binding reference to a location in the data model (e.g., '/user/name').
   */
  path?: string;
  /**
   * A fixed, hardcoded number value.
   */
  literalNumber?: number;
  /**
   * A fixed, hardcoded number value.
   */
  literal?: number;
}

export interface BooleanValue {
  /**
   * A data binding reference to a location in the data model (e.g., '/user/name').
   */
  path?: string;
  /**
   * A fixed, hardcoded boolean value.
   */
  literalBoolean?: boolean;
  /**
   * A fixed, hardcoded boolean value.
   */
  literal?: boolean;
}
