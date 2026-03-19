import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";

type GovdossApprovalItem = {
  id: string;
  method: string;
  subject: string;
  risk: string;
  status: string;
};

type GovdossUsageSummary = {
  totalUnits: number;
  byCategory: Record<string, number>;
};

@customElement("govdoss-control-plane-view")
export class GovdossControlPlaneView extends LitElement {
  static styles = css`
    :host {
      display: block;
      color: var(--oc-color-text, #e5e7eb);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 16px;
    }
    .card {
      border: 1px solid rgba(148, 163, 184, 0.18);
      border-radius: 16px;
      padding: 16px;
      background: rgba(15, 23, 42, 0.72);
    }
    .title {
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      opacity: 0.8;
      margin-bottom: 12px;
    }
    .metric {
      font-size: 32px;
      font-weight: 700;
      line-height: 1.1;
    }
    .subtle {
      margin-top: 8px;
      opacity: 0.75;
      font-size: 13px;
    }
    .queue {
      display: grid;
      gap: 10px;
    }
    .queue-item {
      border: 1px solid rgba(148, 163, 184, 0.12);
      border-radius: 12px;
      padding: 12px;
      background: rgba(2, 6, 23, 0.45);
    }
    .row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
    }
    .badge {
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 12px;
      border: 1px solid rgba(148, 163, 184, 0.2);
    }
    .actions {
      display: flex;
      gap: 8px;
      margin-top: 10px;
    }
    button {
      border: 0;
      border-radius: 10px;
      padding: 8px 12px;
      cursor: pointer;
      font: inherit;
    }
    .approve { background: #14532d; color: white; }
    .reject { background: #7f1d1d; color: white; }
    .resume { background: #1d4ed8; color: white; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th, td {
      text-align: left;
      padding: 8px 6px;
      border-bottom: 1px solid rgba(148, 163, 184, 0.12);
    }
  `;

  @property({ attribute: false }) approvals: GovdossApprovalItem[] = [];
  @property({ attribute: false }) usage: GovdossUsageSummary = { totalUnits: 0, byCategory: {} };
  @property({ type: String }) tenantId = "default-tenant";
  @property({ type: String }) planTier = "team";

  private emit(action: string, detail: Record<string, unknown>) {
    this.dispatchEvent(new CustomEvent(action, { detail, bubbles: true, composed: true }));
  }

  render() {
    const pending = this.approvals.filter((item) => item.status === "pending");
    const approved = this.approvals.filter((item) => item.status === "approved");
    const categories = Object.entries(this.usage.byCategory || {});

    return html`
      <div class="grid">
        <section class="card">
          <div class="title">Tenant</div>
          <div class="metric">${this.tenantId}</div>
          <div class="subtle">Plan tier: ${this.planTier}</div>
        </section>

        <section class="card">
          <div class="title">Approvals</div>
          <div class="metric">${pending.length}</div>
          <div class="subtle">${approved.length} approved and ready to resume</div>
        </section>

        <section class="card">
          <div class="title">Usage</div>
          <div class="metric">${this.usage.totalUnits}</div>
          <div class="subtle">Total billable units recorded</div>
        </section>
      </div>

      <div class="grid" style="margin-top:16px;">
        <section class="card">
          <div class="title">Approval Queue</div>
          <div class="queue">
            ${pending.length === 0
              ? html`<div class="subtle">No pending approvals.</div>`
              : pending.map(
                  (item) => html`
                    <div class="queue-item">
                      <div class="row">
                        <strong>${item.method}</strong>
                        <span class="badge">${item.risk}</span>
                      </div>
                      <div class="subtle">Subject: ${item.subject}</div>
                      <div class="actions">
                        <button class="approve" @click=${() => this.emit("govdoss-approve", { approvalId: item.id })}>Approve</button>
                        <button class="reject" @click=${() => this.emit("govdoss-reject", { approvalId: item.id })}>Reject</button>
                      </div>
                    </div>
                  `,
                )}
          </div>
        </section>

        <section class="card">
          <div class="title">Ready to Resume</div>
          <div class="queue">
            ${approved.length === 0
              ? html`<div class="subtle">No approved actions waiting to resume.</div>`
              : approved.map(
                  (item) => html`
                    <div class="queue-item">
                      <div class="row">
                        <strong>${item.method}</strong>
                        <span class="badge">${item.status}</span>
                      </div>
                      <div class="subtle">Subject: ${item.subject}</div>
                      <div class="actions">
                        <button class="resume" @click=${() => this.emit("govdoss-resume", { approvalId: item.id })}>Resume Execution</button>
                      </div>
                    </div>
                  `,
                )}
          </div>
        </section>
      </div>

      <section class="card" style="margin-top:16px;">
        <div class="title">Usage Breakdown</div>
        <table>
          <thead>
            <tr><th>Category</th><th>Units</th></tr>
          </thead>
          <tbody>
            ${categories.length === 0
              ? html`<tr><td colspan="2">No usage recorded yet.</td></tr>`
              : categories.map(([category, units]) => html`<tr><td>${category}</td><td>${units}</td></tr>`)}
          </tbody>
        </table>
      </section>
    `;
  }
}
