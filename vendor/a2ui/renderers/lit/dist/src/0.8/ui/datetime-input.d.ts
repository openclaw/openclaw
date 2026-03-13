import { nothing } from "lit";
import { Root } from "./root.js";
import { StringValue } from "../types/primitives.js";
export declare class DateTimeInput extends Root {
    #private;
    accessor value: StringValue | null;
    accessor label: StringValue | null;
    accessor enableDate: boolean;
    accessor enableTime: boolean;
    static styles: import("lit").CSSResult[];
    render(): typeof nothing | import("lit").TemplateResult<1>;
}
//# sourceMappingURL=datetime-input.d.ts.map