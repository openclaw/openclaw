import { EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
  highlightSpecialChars,
} from "@codemirror/view";
import { json } from "@codemirror/lang-json";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { css, html, LitElement } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";

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

  @state() private editorReady = false;

  private view?: EditorView;

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
  override connectedCallback(): void {
    super.connectedCallback();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.view?.destroy();
  }

  override firstUpdated(): void {
    this.mountEditor();
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("value") && this.view) {
      const current = this.view.state.doc.toString();
      if (current !== this.value) {
        this.view.dispatch({
          changes: { from: 0, to: current.length, insert: this.value ?? "" },
        });
      }
    }
    if (changed.has("readonly") && this.view) {
      this.view.dispatch({
        effects: EditorState.readonly.reconfigure(this.readonly),
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
    this.editorReady = true;
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

      // Tab indentation
      indentWithTab,

      // JSON language mode
      json(),

      // Lint gutter
      lintGutter(),

      // JSON linter
      linter((view) => {
        const diagnostics: Diagnostic[] = [];
        const docText = view.state.doc.toString().trim();

        if (!docText) return diagnostics;

        try {
          JSON.parse(docText);
        } catch (e) {
          if (e instanceof SyntaxError) {
            // Try to extract line/col from error message
            const match = e.message.match(/position\s+(\d+)/i);
            const pos = match ? parseInt(match[1], 10) : 0;

            diagnostics.push({
              from: Math.min(pos, docText.length),
              to: Math.min(pos + 1, docText.length),
              severity: "error",
              message: e.message,
            });
          }
        }
        return diagnostics;
      }),

      // Keymaps
      keymap.of([...defaultKeymap, ...historyKeymap]),

      // Dispatch on change
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const newValue = update.state.doc.toString();
          this.dispatchEvent(
            new CustomEvent("change", {
              detail: { value: newValue },
              bubbles: true,
              composed: true,
            }),
          );
        }
      }),

      // Readonly
      EditorState.readonly.of(this.readonly),
    ];

    return base;
  }

  // ---------------------------------------------------------------------------
  // Public methods
  // ---------------------------------------------------------------------------
  /** Format the JSON content with proper indentation */
  format(): void {
    if (!this.view) return;
    const rawDoc = this.view.state.doc.toString();
    const doc = rawDoc.trim();
    if (!doc) return;

    try {
      const parsed = JSON.parse(doc);
      const formatted = JSON.stringify(parsed, null, 2);
      this.view.dispatch({
        changes: { from: 0, to: rawDoc.length, insert: formatted },
      });
    } catch {
      // Not valid JSON, ignore format
    }
  }

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
      <div
        class="cm-editor-wrap ${this.readonly ? "cm-editor-wrap--readonly" : ""}"
      >
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
