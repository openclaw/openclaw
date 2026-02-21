# A2UI Protocol Message Validation Logic

This document outlines the validation rules implemented in the `validateSchema` function. The purpose of this validator is to check for constraints that are not easily expressed in the JSON schema itself, such as conditional requirements and reference integrity.

An A2UI message is a JSON object that can have a `surfaceId` and one of the following properties, defining the message type: `beginRendering`, `surfaceUpdate`, `dataModelUpdate`, or `deleteSurface`.

## Common Properties

- **`surfaceId`**: An optional string that identifies the UI surface the message applies to.

## `BeginRendering` Message Rules

- **Required**: Must have a `root` property, which is the ID of the root component to render.

## `SurfaceUpdate` Message Rules

### 1. Component ID Integrity

- **Uniqueness**: All component `id`s within the `components` array must be unique.
- **Reference Validity**: Any property that references a component ID (e.g., `child`, `children`, `entryPointChild`, `contentChild`) must point to an ID that actually exists in the `components` array.

### 2. Component-Specific Property Rules

For each component in the `components` array, the following rules apply:

- **General**:
  - A component must have an `id` and a `componentProperties` object.
  - The `componentProperties` object must contain exactly one key, which defines the component's type (e.g., "Heading", "Text").

- **Heading**:
  - **Required**: Must have a `text` property.
- **Text**:
  - **Required**: Must have a `text` property.
- **Image**:
  - **Required**: Must have a `url` property.
- **Video**:
  - **Required**: Must have a `url` property.
- **AudioPlayer**:
  - **Required**: Must have a `url` property.
- **TextField**:
  - **Required**: Must have a `label` property.
- **DateTimeInput**:
  - **Required**: Must have a `value` property.
- **MultipleChoice**:
  - **Required**: Must have a `selections` property.
- **Slider**:
  - **Required**: Must have a `value` property.
- **Container Components** (`Row`, `Column`, `List`):
  - **Required**: Must have a `children` property.
  - The `children` object must contain _either_ `explicitList` _or_ `template`, but not both.
- **Card**:
  - **Required**: Must have a `child` property.
- **Tabs**:
  - **Required**: Must have a `tabItems` property, which must be an array.
  - Each item in `tabItems` must have a `title` and a `child`.
- **Modal**:
  - **Required**: Must have both `entryPointChild` and `contentChild` properties.
- **Button**:
  - **Required**: Must have `label` and `action` properties.
- **CheckBox**:
  - **Required**: Must have `label` and `value` properties.
- **Divider**:
  - No required properties.

## `DataModelUpdate` Message Rules

- **Required**: A `DataModelUpdate` message must have a `contents` property.
- The `path` property is optional.
- If `path` is not present, the `contents` object will replace the entire data model.
- If `path` is present, the `contents` will be set at that location in the data model.
- No other properties besides `path` and `contents` are allowed.

## `DeleteSurface` Message Rules

- **Required**: Must have a `delete` property set to `true`.
- No other properties are allowed.
