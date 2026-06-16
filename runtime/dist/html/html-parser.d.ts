/**
 * Tiny tag-soup tolerant HTML parser.
 *
 * Scope: enough to feed the layout/paint stages of the milestone C
 * pipeline. Not standards-compliant — no scripts, no DOM, no custom
 * elements, no namespaces, no <template> contents. Lowercase tag names.
 * Errors recover by advancing one character.
 *
 *   - Comments and DOCTYPEs are skipped.
 *   - Raw-text elements (script/style/noscript/iframe/template) are
 *     consumed wholesale until their close tag and produce no children.
 *   - Void elements never push a stack frame.
 *   - Reopening certain block elements (p, li, dt, dd, tr, td, th)
 *     auto-closes the previous instance — the most common tag-soup case.
 *   - Whitespace-only text nodes are dropped at parse time.
 *
 * The synthetic root is `#document` with all top-level nodes as children.
 */
export type HtmlNode = HtmlElement | HtmlText;
export interface HtmlElement {
    type: 'element';
    tag: string;
    attrs: Record<string, string>;
    children: HtmlNode[];
    /** Back-pointer set by `attachParents` after the tree is built. */
    parent?: HtmlElement | null;
}
export interface HtmlText {
    type: 'text';
    text: string;
}
export declare function parseHtml(source: string): HtmlElement;
/**
 * Find the first `<title>` element and return its concatenated text content,
 * with whitespace collapsed and trimmed. Returns `null` if no title is
 * present or it contains only whitespace. Used by the shell to surface a
 * human-readable label for history + bookmark entries.
 */
export declare function extractTitle(root: HtmlElement): string | null;
export declare function countNodes(root: HtmlElement): {
    elements: number;
    texts: number;
};
//# sourceMappingURL=html-parser.d.ts.map