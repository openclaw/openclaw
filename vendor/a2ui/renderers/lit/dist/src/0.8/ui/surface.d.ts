import { nothing } from "lit";
import { SurfaceID, Surface as SurfaceState } from "../types/types";
import { A2uiMessageProcessor } from "../data/model-processor.js";
import { Root } from "./root.js";
export declare class Surface extends Root {
    #private;
    accessor surfaceId: SurfaceID | null;
    accessor surface: SurfaceState | null;
    accessor processor: A2uiMessageProcessor | null;
    static styles: import("lit").CSSResult[];
    render(): typeof nothing | import("lit").TemplateResult<1>;
}
//# sourceMappingURL=surface.d.ts.map