type ColorShade = 0 | 5 | 10 | 15 | 20 | 25 | 30 | 35 | 40 | 50 | 60 | 70 | 80 | 90 | 95 | 98 | 99 | 100;
export type PaletteKeyVals = "n" | "nv" | "p" | "s" | "t" | "e";
export declare const shades: ColorShade[];
type CreatePalette<Prefix extends PaletteKeyVals> = {
    [Key in `${Prefix}${ColorShade}`]: string;
};
export type PaletteKey<Prefix extends PaletteKeyVals> = Array<keyof CreatePalette<Prefix>>;
export type PaletteKeys = {
    neutral: PaletteKey<"n">;
    neutralVariant: PaletteKey<"nv">;
    primary: PaletteKey<"p">;
    secondary: PaletteKey<"s">;
    tertiary: PaletteKey<"t">;
    error: PaletteKey<"e">;
};
export type ColorPalettes = {
    neutral: CreatePalette<"n">;
    neutralVariant: CreatePalette<"nv">;
    primary: CreatePalette<"p">;
    secondary: CreatePalette<"s">;
    tertiary: CreatePalette<"t">;
    error: CreatePalette<"e">;
};
export {};
//# sourceMappingURL=colors.d.ts.map