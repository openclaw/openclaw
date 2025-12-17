import { PropertyValues } from "lit";
import { Root } from "./root.js";
import { StringValue } from "../types/primitives.js";
export declare class Tabs extends Root {
    #private;
    accessor titles: StringValue[] | null;
    accessor selected: number;
    static styles: import("lit").CSSResult[];
    protected willUpdate(changedProperties: PropertyValues<this>): void;
    render(): import("lit").TemplateResult<1>;
}
//# sourceMappingURL=tabs.d.ts.map