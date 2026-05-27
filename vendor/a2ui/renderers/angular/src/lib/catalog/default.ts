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

import { inputBinding } from '@angular/core';
import { Types } from '@a2ui/lit/0.8';
import { Catalog } from '../rendering/catalog';
import { Row } from './row';
import { Column } from './column';
import { Text } from './text';

export const DEFAULT_CATALOG: Catalog = {
  Row: {
    type: () => Row,
    bindings: (node) => {
      const properties = (node as Types.RowNode).properties;
      return [
        inputBinding('alignment', () => properties.alignment ?? 'stretch'),
        inputBinding('distribution', () => properties.distribution ?? 'start'),
      ];
    },
  },

  Column: {
    type: () => Column,
    bindings: (node) => {
      const properties = (node as Types.ColumnNode).properties;
      return [
        inputBinding('alignment', () => properties.alignment ?? 'stretch'),
        inputBinding('distribution', () => properties.distribution ?? 'start'),
      ];
    },
  },

  List: {
    type: () => import('./list').then((r) => r.List),
    bindings: (node) => {
      const properties = (node as Types.ListNode).properties;
      return [inputBinding('direction', () => properties.direction ?? 'vertical')];
    },
  },

  Card: () => import('./card').then((r) => r.Card),

  Image: {
    type: () => import('./image').then((r) => r.Image),
    bindings: (node) => {
      const properties = (node as Types.ImageNode).properties;
      return [
        inputBinding('url', () => properties.url),
        inputBinding('usageHint', () => properties.usageHint),
      ];
    },
  },

  Icon: {
    type: () => import('./icon').then((r) => r.Icon),
    bindings: (node) => {
      const properties = (node as Types.IconNode).properties;
      return [inputBinding('name', () => properties.name)];
    },
  },

  Video: {
    type: () => import('./video').then((r) => r.Video),
    bindings: (node) => {
      const properties = (node as Types.VideoNode).properties;
      return [inputBinding('url', () => properties.url)];
    },
  },

  AudioPlayer: {
    type: () => import('./audio').then((r) => r.Audio),
    bindings: (node) => {
      const properties = (node as Types.AudioPlayerNode).properties;
      return [inputBinding('url', () => properties.url)];
    },
  },

  Text: {
    type: () => Text,
    bindings: (node) => {
      const properties = (node as Types.TextNode).properties;
      return [
        inputBinding('text', () => properties.text),
        inputBinding('usageHint', () => properties.usageHint || null),
      ];
    },
  },

  Button: {
    type: () => import('./button').then((r) => r.Button),
    bindings: (node) => {
      const properties = (node as Types.ButtonNode).properties;
      return [inputBinding('action', () => properties.action)];
    },
  },

  Divider: () => import('./divider').then((r) => r.Divider),

  MultipleChoice: {
    type: () => import('./multiple-choice').then((r) => r.MultipleChoice),
    bindings: (node) => {
      const properties = (node as Types.MultipleChoiceNode).properties;
      return [
        inputBinding('options', () => properties.options || []),
        inputBinding('value', () => properties.selections),
        inputBinding('description', () => 'Select an item'), // TODO: this should be defined in the properties
      ];
    },
  },

  TextField: {
    type: () => import('./text-field').then((r) => r.TextField),
    bindings: (node) => {
      const properties = (node as Types.TextFieldNode).properties;
      return [
        inputBinding('text', () => properties.text ?? null),
        inputBinding('label', () => properties.label),
        inputBinding('inputType', () => properties.type),
      ];
    },
  },

  DateTimeInput: {
    type: () => import('./datetime-input').then((r) => r.DatetimeInput),
    bindings: (node) => {
      const properties = (node as Types.DateTimeInputNode).properties;
      return [
        inputBinding('enableDate', () => properties.enableDate),
        inputBinding('enableTime', () => properties.enableTime),
        inputBinding('value', () => properties.value),
      ];
    },
  },

  CheckBox: {
    type: () => import('./checkbox').then((r) => r.Checkbox),
    bindings: (node) => {
      const properties = (node as Types.CheckboxNode).properties;
      return [
        inputBinding('label', () => properties.label),
        inputBinding('value', () => properties.value),
      ];
    },
  },

  Slider: {
    type: () => import('./slider').then((r) => r.Slider),
    bindings: (node) => {
      const properties = (node as Types.SliderNode).properties;
      return [
        inputBinding('value', () => properties.value),
        inputBinding('minValue', () => properties.minValue),
        inputBinding('maxValue', () => properties.maxValue),
        inputBinding('label', () => ''), // TODO: this should be defined in the properties
      ];
    },
  },

  Tabs: {
    type: () => import('./tabs').then((r) => r.Tabs),
    bindings: (node) => {
      const properties = (node as Types.TabsNode).properties;
      return [inputBinding('tabs', () => properties.tabItems)];
    },
  },

  Modal: {
    type: () => import('./modal').then((r) => r.Modal),
    bindings: () => [],
  },
};
