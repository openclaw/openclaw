import { ColorPalettes } from "../types/colors.js";
export declare function merge(...classes: Array<Record<string, boolean>>): Record<string, boolean>;
export declare function appendToAll(target: Record<string, string[]>, exclusions: string[], ...classes: Array<Record<string, boolean>>): Record<string, string[]>;
export declare function createThemeStyles(palettes: ColorPalettes): Record<string, string>;
export declare function toProp(key: string): string;
//# sourceMappingURL=utils.d.ts.map