import { Root } from "./root.js";
import { StringValue } from "../types/primitives.js";
import { ResolvedImage } from "../types/types.js";
export declare class Image extends Root {
    #private;
    accessor url: StringValue | null;
    accessor usageHint: ResolvedImage["usageHint"] | null;
    accessor fit: "contain" | "cover" | "fill" | "none" | "scale-down" | null;
    static styles: import("lit").CSSResult[];
    render(): import("lit").TemplateResult<1>;
}
//# sourceMappingURL=image.d.ts.map