import { LitElement, nothing, PropertyValues, TemplateResult } from "lit";
import { A2uiMessageProcessor } from "../data/model-processor.js";
import { Theme, AnyComponentNode, SurfaceID } from "../types/types.js";
declare const Root_base: typeof LitElement;
export declare class Root extends Root_base {
    #private;
    accessor surfaceId: SurfaceID | null;
    accessor component: AnyComponentNode | null;
    accessor theme: Theme;
    accessor childComponents: AnyComponentNode[] | null;
    accessor processor: A2uiMessageProcessor | null;
    accessor dataContextPath: string;
    accessor enableCustomElements: boolean;
    set weight(weight: string | number);
    get weight(): string | number;
    static styles: import("lit").CSSResult[];
    protected willUpdate(changedProperties: PropertyValues<this>): void;
    /**
     * Clean up the effect when the component is removed from the DOM.
     */
    disconnectedCallback(): void;
    /**
     * Turns the SignalMap into a renderable TemplateResult for Lit.
     */
    private renderComponentTree;
    private renderCustomComponent;
    render(): TemplateResult | typeof nothing;
}
export {};
//# sourceMappingURL=root.d.ts.map