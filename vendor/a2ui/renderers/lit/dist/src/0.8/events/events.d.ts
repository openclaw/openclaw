import type * as A2UI from "./a2ui.js";
import { BaseEventDetail } from "./base.js";
type EnforceEventTypeMatch<T extends Record<string, BaseEventDetail<string>>> = {
    [K in keyof T]: T[K] extends BaseEventDetail<infer EventType> ? EventType extends K ? T[K] : never : never;
};
export type StateEventDetailMap = EnforceEventTypeMatch<{
    "a2ui.action": A2UI.A2UIAction;
}>;
export declare class StateEvent<T extends keyof StateEventDetailMap> extends CustomEvent<StateEventDetailMap[T]> {
    readonly payload: StateEventDetailMap[T];
    static eventName: string;
    constructor(payload: StateEventDetailMap[T]);
}
declare global {
    interface HTMLElementEventMap {
        a2uiaction: StateEvent<"a2ui.action">;
    }
}
export {};
//# sourceMappingURL=events.d.ts.map