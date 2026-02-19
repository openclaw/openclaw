/**
 * ConsentGuard Hub: Security & Approvals (Enterprise).
 * Combines Pending Requests Queue, Policy Management, and Gate Audit.
 */
import { html, nothing } from "lit";
import "../components/consent-request-card.ts";
import type { ExecApprovalRequest } from "../controllers/exec-approval.ts";
import { renderExecApprovals, resolveExecApprovalsState } from "./nodes-exec-approvals.ts";
import type { NodesProps } from "./nodes.ts";

export type ConsentGuardHubProps = NodesProps & {
  execApprovalQueue: ExecApprovalRequest[];
  execApprovalBusy: boolean;
  execApprovalError: string | null;
  onExecApprovalDecision: (
    decision: "allow-once" | "allow-always" | "deny",
    id?: string,
  ) => Promise<void>;
};

type ConsentResolveDetail = {
  id: string;
  decision: "allow-once" | "allow-always" | "deny";
};

export function renderConsentGuardHub(props: ConsentGuardHubProps) {
  const approvalsState = resolveExecApprovalsState(props);
  const queue = props.execApprovalQueue;
  const handleResolve = (event: Event) => {
    const detail = (event as CustomEvent<ConsentResolveDetail>).detail;
    event.stopPropagation();
    void props.onExecApprovalDecision(detail.decision, detail.id);
  };

  return html`
    <section class="card">
      <div class="card-title">Pending requests</div>
      <div class="card-sub">
        Human-in-the-loop approvals. Approve, deny, or add to allowlist.
      </div>
      ${
        props.execApprovalError
          ? html`<div class="pill danger" style="margin-top: 12px;">${props.execApprovalError}</div>`
          : nothing
      }
      ${
        queue.length === 0
          ? html`
              <div class="muted" style="margin-top: 12px">No pending requests.</div>
            `
          : html`
              <div class="row" style="margin-top: 12px; gap: 12px; flex-direction: column;">
                ${queue.map(
                  (entry) => html`
                    <consent-request-card
                      .request=${entry}
                      ?disabled=${props.execApprovalBusy}
                      @resolve=${handleResolve}
                    ></consent-request-card>
                  `,
                )}
              </div>
            `
      }
    </section>

    ${renderExecApprovals(approvalsState)}

    <section class="card">
      <div class="card-title">Gate audit</div>
      <div class="card-sub">
        Read-only log of approved/denied actions for compliance.
      </div>
      <div class="muted" style="margin-top: 12px;">
        Audit log will appear here when the gateway exposes an approvals audit API.
      </div>
    </section>
  `;
}
