import { nothing } from "lit";
import { Root } from "./root.js";
import { StringValue, BooleanValue } from "../types/primitives";
export declare class Checkbox extends Root {
    #private;
    accessor value: BooleanValue | null;
    accessor label: StringValue | null;
    static styles: import("lit").CSSResult[];
    render(): typeof nothing | import("lit").TemplateResult<1>;
}
//# sourceMappingURL=checkbox.d.ts.map