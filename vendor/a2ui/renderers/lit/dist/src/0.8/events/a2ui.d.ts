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
export {};
//# sourceMappingURL=a2ui.d.ts.map