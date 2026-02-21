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

import { StringValue } from "./primitives";

export interface Action {
  /**
   * A unique name identifying the action (e.g., 'submitForm').
   */
  name: string;
  /**
   * A key-value map of data bindings to be resolved when the action is triggered.
   */
  context?: {
    key: string;
    /**
     * The dynamic value. Define EXACTLY ONE of the nested properties.
     */
    value: {
      /**
       * A data binding reference to a location in the data model (e.g., '/user/name').
       */
      path?: string;
      /**
       * A fixed, hardcoded string value.
       */
      literalString?: string;
      literalNumber?: number;
      literalBoolean?: boolean;
    };
  }[];
}

export interface Text {
  text: StringValue;
  usageHint: "h1" | "h2" | "h3" | "h4" | "h5" | "caption" | "body";
}

export interface Image {
  url: StringValue;
  usageHint:
    | "icon"
    | "avatar"
    | "smallFeature"
    | "mediumFeature"
    | "largeFeature"
    | "header";
  fit?: "contain" | "cover" | "fill" | "none" | "scale-down";
}

export interface Icon {
  name: StringValue;
}

export interface Video {
  url: StringValue;
}

export interface AudioPlayer {
  url: StringValue;
  /**
   * A label, title, or placeholder text.
   */
  description?: StringValue;
}

export interface Tabs {
  /**
   * A list of tabs, each with a title and a child component ID.
   */
  tabItems: {
    /**
     * The title of the tab.
     */
    title: {
      /**
       * A data binding reference to a location in the data model (e.g., '/user/name').
       */
      path?: string;
      /**
       * A fixed, hardcoded string value.
       */
      literalString?: string;
    };
    /**
     * A reference to a component instance by its unique ID.
     */
    child: string;
  }[];
}

export interface Divider {
  /**
   * The orientation.
   */
  axis?: "horizontal" | "vertical";
  /**
   * The color of the divider (e.g., hex code or semantic name).
   */
  color?: string;
  /**
   * The thickness of the divider.
   */
  thickness?: number;
}

export interface Modal {
  /**
   * The ID of the component (e.g., a button) that triggers the modal.
   */
  entryPointChild: string;
  /**
   * The ID of the component to display as the modal's content.
   */
  contentChild: string;
}

export interface Button {
  /**
   * The ID of the component to display as the button's content.
   */
  child: string;

  /**
   * Represents a user-initiated action.
   */
  action: Action;
}

export interface Checkbox {
  label: StringValue;
  value: {
    /**
     * A data binding reference to a location in the data model (e.g., '/user/name').
     */
    path?: string;
    literalBoolean?: boolean;
  };
}

export interface TextField {
  text?: StringValue;
  /**
   * A label, title, or placeholder text.
   */
  label: StringValue;
  type?: "shortText" | "number" | "date" | "longText";
  /**
   * A regex string to validate the input.
   */
  validationRegexp?: string;
}

export interface DateTimeInput {
  value: StringValue;
  enableDate?: boolean;
  enableTime?: boolean;
  /**
   * The string format for the output (e.g., 'YYYY-MM-DD').
   */
  outputFormat?: string;
}

export interface MultipleChoice {
  selections: {
    /**
     * A data binding reference to a location in the data model (e.g., '/user/name').
     */
    path?: string;
    literalArray?: string[];
  };
  options?: {
    label: {
      /**
       * A data binding reference to a location in the data model (e.g., '/user/name').
       */
      path?: string;
      /**
       * A fixed, hardcoded string value.
       */
      literalString?: string;
    };
    value: string;
  }[];
  maxAllowedSelections?: number;
}

export interface Slider {
  value: {
    /**
     * A data binding reference to a location in the data model (e.g., '/user/name').
     */
    path?: string;
    literalNumber?: number;
  };
  minValue?: number;
  maxValue?: number;
}
