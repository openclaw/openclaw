/*
 Copyright 2025 Google LLC

 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at

      https://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
 */

type ColorShade =
  | 0
  | 5
  | 10
  | 15
  | 20
  | 25
  | 30
  | 35
  | 40
  | 50
  | 60
  | 70
  | 80
  | 90
  | 95
  | 98
  | 99
  | 100;

export type PaletteKeyVals = "n" | "nv" | "p" | "s" | "t" | "e";
export const shades: ColorShade[] = [
  0, 5, 10, 15, 20, 25, 30, 35, 40, 50, 60, 70, 80, 90, 95, 98, 99, 100,
];

type CreatePalette<Prefix extends PaletteKeyVals> = {
  [Key in `${Prefix}${ColorShade}`]: string;
};

export type PaletteKey<Prefix extends PaletteKeyVals> = Array<
  keyof CreatePalette<Prefix>
>;

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
