/**
 * This is only safe for (and intended to be used for) text node positions. If
 * you are using attribute position, then this is only safe if the attribute
 * value is surrounded by double-quotes, and is unsafe otherwise (because the
 * value could break out of the attribute value and e.g. add another attribute).
 */
export declare function escapeNodeText(str: string | null | undefined): string;
export declare function unescapeNodeText(str: string | null | undefined): string;
//# sourceMappingURL=sanitizer.d.ts.map