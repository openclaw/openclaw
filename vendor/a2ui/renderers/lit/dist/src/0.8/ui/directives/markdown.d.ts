import { Directive, DirectiveParameters, Part } from "lit/directive.js";
declare class MarkdownDirective extends Directive {
    #private;
    update(_part: Part, [value, tagClassMap]: DirectiveParameters<this>): import("lit/directive.js").DirectiveResult<typeof import("lit/directives/unsafe-html.js").UnsafeHTMLDirective>;
    /**
     * Renders the markdown string to HTML using MarkdownIt.
     *
     * Note: MarkdownIt doesn't enable HTML in its output, so we render the
     * value directly without further sanitization.
     * @see https://github.com/markdown-it/markdown-it/blob/master/docs/security.md
     */
    render(value: string, tagClassMap?: Record<string, string[]>): import("lit/directive.js").DirectiveResult<typeof import("lit/directives/unsafe-html.js").UnsafeHTMLDirective>;
}
export declare const markdown: (value: string, tagClassMap?: Record<string, string[]> | undefined) => import("lit/directive.js").DirectiveResult<typeof MarkdownDirective>;
export declare function renderMarkdownToHtmlString(value: string): string;
export {};
//# sourceMappingURL=markdown.d.ts.map