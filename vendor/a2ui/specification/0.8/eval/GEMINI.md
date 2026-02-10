# A2UI Protocol Message Validation Logic（轉為繁體中文）
（轉為繁體中文）
This document outlines the validation rules implemented in the `validateSchema` function. The purpose of this validator is to check for constraints that are not easily expressed in the JSON schema itself, such as conditional requirements and reference integrity.（轉為繁體中文）
（轉為繁體中文）
An A2UI message is a JSON object that can have a `surfaceId` and one of the following properties, defining the message type: `beginRendering`, `surfaceUpdate`, `dataModelUpdate`, or `deleteSurface`.（轉為繁體中文）
（轉為繁體中文）
## Common Properties（轉為繁體中文）
（轉為繁體中文）
- **`surfaceId`**: An optional string that identifies the UI surface the message applies to.（轉為繁體中文）
（轉為繁體中文）
## `BeginRendering` Message Rules（轉為繁體中文）
（轉為繁體中文）
- **Required**: Must have a `root` property, which is the ID of the root component to render.（轉為繁體中文）
（轉為繁體中文）
## `SurfaceUpdate` Message Rules（轉為繁體中文）
（轉為繁體中文）
### 1. Component ID Integrity（轉為繁體中文）
（轉為繁體中文）
- **Uniqueness**: All component `id`s within the `components` array must be unique.（轉為繁體中文）
- **Reference Validity**: Any property that references a component ID (e.g., `child`, `children`, `entryPointChild`, `contentChild`) must point to an ID that actually exists in the `components` array.（轉為繁體中文）
（轉為繁體中文）
### 2. Component-Specific Property Rules（轉為繁體中文）
（轉為繁體中文）
For each component in the `components` array, the following rules apply:（轉為繁體中文）
（轉為繁體中文）
- **General**:（轉為繁體中文）
  - A component must have an `id` and a `componentProperties` object.（轉為繁體中文）
  - The `componentProperties` object must contain exactly one key, which defines the component's type (e.g., "Heading", "Text").（轉為繁體中文）
（轉為繁體中文）
- **Heading**:（轉為繁體中文）
  - **Required**: Must have a `text` property.（轉為繁體中文）
- **Text**:（轉為繁體中文）
  - **Required**: Must have a `text` property.（轉為繁體中文）
- **Image**:（轉為繁體中文）
  - **Required**: Must have a `url` property.（轉為繁體中文）
- **Video**:（轉為繁體中文）
  - **Required**: Must have a `url` property.（轉為繁體中文）
- **AudioPlayer**:（轉為繁體中文）
  - **Required**: Must have a `url` property.（轉為繁體中文）
- **TextField**:（轉為繁體中文）
  - **Required**: Must have a `label` property.（轉為繁體中文）
- **DateTimeInput**:（轉為繁體中文）
  - **Required**: Must have a `value` property.（轉為繁體中文）
- **MultipleChoice**:（轉為繁體中文）
  - **Required**: Must have a `selections` property.（轉為繁體中文）
- **Slider**:（轉為繁體中文）
  - **Required**: Must have a `value` property.（轉為繁體中文）
- **Container Components** (`Row`, `Column`, `List`):（轉為繁體中文）
  - **Required**: Must have a `children` property.（轉為繁體中文）
  - The `children` object must contain _either_ `explicitList` _or_ `template`, but not both.（轉為繁體中文）
- **Card**:（轉為繁體中文）
  - **Required**: Must have a `child` property.（轉為繁體中文）
- **Tabs**:（轉為繁體中文）
  - **Required**: Must have a `tabItems` property, which must be an array.（轉為繁體中文）
  - Each item in `tabItems` must have a `title` and a `child`.（轉為繁體中文）
- **Modal**:（轉為繁體中文）
  - **Required**: Must have both `entryPointChild` and `contentChild` properties.（轉為繁體中文）
- **Button**:（轉為繁體中文）
  - **Required**: Must have `label` and `action` properties.（轉為繁體中文）
- **CheckBox**:（轉為繁體中文）
  - **Required**: Must have `label` and `value` properties.（轉為繁體中文）
- **Divider**:（轉為繁體中文）
  - No required properties.（轉為繁體中文）
（轉為繁體中文）
## `DataModelUpdate` Message Rules（轉為繁體中文）
（轉為繁體中文）
- **Required**: A `DataModelUpdate` message must have a `contents` property.（轉為繁體中文）
- The `path` property is optional.（轉為繁體中文）
- If `path` is not present, the `contents` object will replace the entire data model.（轉為繁體中文）
- If `path` is present, the `contents` will be set at that location in the data model.（轉為繁體中文）
- No other properties besides `path` and `contents` are allowed.（轉為繁體中文）
（轉為繁體中文）
## `DeleteSurface` Message Rules（轉為繁體中文）
（轉為繁體中文）
- **Required**: Must have a `delete` property set to `true`.（轉為繁體中文）
- No other properties are allowed.（轉為繁體中文）
