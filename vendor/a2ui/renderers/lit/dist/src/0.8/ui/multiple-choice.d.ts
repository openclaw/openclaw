import { PropertyValues } from "lit";
import { Root } from "./root.js";
import { StringValue } from "../types/primitives.js";
export declare class MultipleChoice extends Root {
    #private;
    accessor description: string | null;
    accessor options: {
        label: StringValue;
        value: string;
    }[];
    accessor selections: StringValue | string[];
    static styles: import("lit").CSSResult[];
    protected willUpdate(changedProperties: PropertyValues<this>): void;
    render(): import("lit").TemplateResult<1>;
}
//# sourceMappingURL=multiple-choice.d.ts.map