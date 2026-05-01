import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
} from "@codemirror/language";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { EditorState, type Extension, Compartment } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
  highlightSpecialChars,
} from "@codemirror/view";
import { json5 } from "codemirror-json5";
import JSON5 from "json5";
import { css, html, LitElement } from "lit";
import { customElement, property, query } from "lit/decorators.js";

/** CodeMirror theme extensions for dark mode */
const DARK_THEME = EditorView.theme({
  "&": { backgroundColor: "#1f2937", color: "#e5e7eb" },
  ".cm-content": { caretColor: "#e5e7eb" },
  ".cm-gutters": { backgroundColor: "#1f2937", color: "#6b7280", border: "none" },
  ".cm-activeLineGutter": { backgroundColor: "#374151" },
  ".cm-activeLine": { backgroundColor: "rgba(55, 65, 81, 0.5)" },
  ".cm-cursor": { borderLeftColor: "#e5e7eb" },
  ".cm-selectionBackground": { backgroundColor: "#374151 !important" },
  "&.cm-focused .cm-selectionBackground": { backgroundColor: "#4b5563 !important" },
  ".cm-matchingBracket": { backgroundColor: "#374151", outline: "1px solid #6b7280" },
  ".cm-foldPlaceholder": { backgroundColor: "#374151", color: "#9ca3af", border: "none" },
  ".cm-tooltip": { backgroundColor: "#1f2937", border: "1px solid #374151" },
  ".cm-tooltip-autocomplete": { "& > ul > li[aria-selected]": { backgroundColor: "#374151" } },
});

const LIGHT_THEME = EditorView.theme({});

/**
 * A JSON editor web component backed by CodeMirror 6.
 * Provides syntax highlighting, line numbers, active line highlighting,
 * history (undo/redo), and JSON linting for OpenClaw's raw config editor.
 */
@customElement("config-editor")
export class ConfigEditor extends LitElement {
  /** Current editor content */
  @property({ type: String }) value = "";

  /** Whether the editor is read-only */
  @property({ type: Boolean }) readonly = false;

  /** Whether the editor should use a dark theme */
  @property({ type: Boolean }) dark = false;

  @query("#editor-mount") editorContainer!: HTMLDivElement;

  private view?: EditorView;
  private readonlyCompartment = new Compartment();
  private themeCompartment = new Compartment();
  /** Guard flag: suppress external value update while the user is actively editing */
  private _userIsEditing = false;

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------
  static override styles = css`
    :host {
      display: block;
    }

    .cm-editor-wrap {
      border: 1px solid var(--oc-input-border, #d1d5db);
      border-radius: 6px;
      overflow: hidden;
      background: var(--oc-input-bg, #ffffff);
      transition: border-color 0.15s;
    }

    .cm-editor-wrap:focus-within {
      border-color: var(--oc-focus-border, #6366f1);
      box-shadow: 0 0 0 2px var(--oc-focus-ring, rgba(99, 102, 241, 0.15));
    }

    .cm-editor-wrap.cm-editor-wrap--readonly {
      background: var(--oc-input-bg-readonly, #f9fafb);
    }

    #editor-mount {
      height: 480px;
    }

    .cm-editor {
      height: 100%;
    }

    .cm-scroller {
      font-family: "JetBrains Mono", "Fira Code", "SF Mono", Menlo, monospace;
      font-size: 13px;
      line-height: 1.6;
    }

    /* Error gutter marker */
    .cm-lint-marker-error {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #ef4444;
      margin-top: 5px;
    }

    /* Format button */
    .editor-toolbar {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 6px;
      padding: 4px 8px;
      background: var(--oc-input-bg, #ffffff);
      border-bottom: 1px solid var(--oc-input-border, #d1d5db);
    }

    .editor-toolbar button {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 4px;
      border: 1px solid var(--oc-input-border, #d1d5db);
      background: var(--oc-input-bg, #ffffff);
      color: var(--oc-text-secondary, #6b7280);
      cursor: pointer;
      transition: all 0.1s;
    }

    .editor-toolbar button:hover {
      background: var(--oc-input-bg-hover, #f3f4f6);
      color: var(--oc-text-primary, #111827);
    }

    .editor-toolbar button:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    /* Dark theme overrides */
    :host([dark]) .cm-editor-wrap {
      border-color: #374151;
      background: #1f2937;
    }

    :host([dark]) .editor-toolbar {
      background: #1f2937;
      border-color: #374151;
    }

    :host([dark]) .editor-toolbar button {
      border-color: #374151;
      background: #1f2937;
      color: #9ca3af;
    }

    :host([dark]) .editor-toolbar button:hover {
      background: #374151;
      color: #f3f4f6;
    }
  `;

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------
  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.view?.destroy();
  }

  override firstUpdated(): void {
    this.mountEditor();
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("value") && this.view && !this._userIsEditing) {
      const current = this.view.state.doc.toString();
      if (current !== this.value) {
        this.view.dispatch({
          changes: { from: 0, to: current.length, insert: this.value ?? "" },
        });
      }
    }
    if (changed.has("readonly") && this.view) {
      this.view.dispatch({
        effects: this.readonlyCompartment.reconfigure(EditorState.readOnly.of(this.readonly)),
      });
    }
    if (changed.has("dark") && this.view) {
      this.view.dispatch({
        effects: this.themeCompartment.reconfigure(this.dark ? DARK_THEME : LIGHT_THEME),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Editor mounting
  // ---------------------------------------------------------------------------
  private mountEditor(): void {
    const extensions = this.buildExtensions();
    this.view = new EditorView({
      state: EditorState.create({ doc: this.value ?? "", extensions }),
      parent: this.editorContainer,
    });
  }

  private buildExtensions(): Extension {
    const base: Extension[] = [
      // History (undo/redo)
      history(),

      // Line numbers + active line
      lineNumbers(),
      highlightActiveLine(),
      highlightSpecialChars(),

      // Selection
      drawSelection(),

      // JSON5 language mode (OpenClaw raw config uses JSON5 with comments, unquoted keys, trailing commas)
      json5(),

      // Syntax highlighting
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),

      // Code folding
      foldGutter(),

      // Lint gutter
      lintGutter(),

      // JSON linter
      linter((view) => {
        const diagnostics: Diagnostic[] = [];
        const docText = view.state.doc.toString();

        if (!docText) {
          return diagnostics;
        }

        try {
          JSON5.parse(docText);
        } catch (e) {
          if (e instanceof SyntaxError) {
            const pos = this.errorOffset(docText, e.message);
            // -1 sentinel means unrecognized error format — skip marker silently
            if (pos >= 0) {
              diagnostics.push({
                from: Math.min(pos, docText.length),
                to: Math.min(pos + 1, docText.length),
                severity: "error",
                message: e.message,
              });
            }
          }
        }
        return diagnostics;
      }),

      // Keymaps (includes indentWithTab for Tab-key indentation)
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab, ...foldKeymap]),

      // Dispatch on change — set guard flag so updated() knows user is typing
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          this._userIsEditing = true;
          const newValue = update.state.doc.toString();
          this.dispatchEvent(
            new CustomEvent("change", {
              detail: { value: newValue },
              bubbles: true,
              composed: true,
            }),
          );
          // Reset guard after a short debounce so the next external value update isn't blocked
          setTimeout(() => { this._userIsEditing = false; }, 500);
        }
      }),

      // Readonly (via compartment so it can be reconfigured live)
      this.readonlyCompartment.of(EditorState.readOnly.of(this.readonly)),

      // Theme (via compartment so it can be toggled live)
      this.themeCompartment.of(this.dark ? DARK_THEME : LIGHT_THEME),
    ];

    return base;
  }

  /**
   * Convert a JSON5 SyntaxError message to a character offset in the document.
   * Returns -1 if the error format is not recognized (sentinel for "don't show marker").
   * Note: column positions use UTF-16 code units (JS string indices), which match
   * CodeMirror's internal representation.
   */
  private errorOffset(doc: string, message: string): number {
    // JSON5 format: "... at 3:5"
    const lc = message.match(/at\s+(\d+):(\d+)/i);
    if (lc) {
      const line = Number.parseInt(lc[1], 10);
      const col = Number.parseInt(lc[2], 10);
      if (col <= 0) return -1;
      const lines = doc.split("\n");
      const targetLine = line - 1;
      if (targetLine < 0 || targetLine >= lines.length) return -1;
      // Accumulate prior lines by their actual string length (UTF-16 code units)
      let offset = 0;
      for (let i = 0; i < targetLine; i++) {
        offset += lines[i].length + 1; // +1 for newline
      }
      // Clamp column to actual line length (1-indexed)
      const clampedCol = Math.min(col, lines[targetLine].length);
      return offset + clampedCol - 1;
    }

    // JSON format: "... at position 42"
    const pos = message.match(/position\s+(\d+)/i);
    if (pos) {
      return Number.parseInt(pos[1], 10);
    }

    // Unrecognized format — return sentinel so the linter skips the marker
    return -1;
  }

  // ---------------------------------------------------------------------------
  // Public methods
  // ---------------------------------------------------------------------------
  /** Format the JSON content with proper indentation */
  format = (): void => {
    if (!this.view) {
      return;
    }
    const rawDoc = this.view.state.doc.toString();
    const doc = rawDoc.trim();
    if (!doc) {
      return;
    }

    try {
      const parsed = JSON5.parse(doc);
      // Use JSON5.stringify so that unquoted keys, trailing commas, and
      // other JSON5-only features round-trip correctly.
      const formatted = JSON5.stringify(parsed, null, 2);
      this.view.dispatch({
        changes: { from: 0, to: rawDoc.length, insert: formatted },
      });
    } catch {
      // Not valid JSON/JSON5, ignore format
    }
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  override render() {
    return html`
      <div class="editor-toolbar">
        <button
          type="button"
          title="Format JSON (prettify)"
          @click=${this.format}
          ?disabled=${this.readonly}
        >
          Format
        </button>
      </div>
      <div class="cm-editor-wrap ${this.readonly ? "cm-editor-wrap--readonly" : ""}">
        <div id="editor-mount"></div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "config-editor": ConfigEditor;
  }
}
