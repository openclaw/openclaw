// Generated from schemas/. Do not edit.

export type CreateProjectRequest = {
  readonly "schema_version": "1.0.0";
  readonly "display_name": string;
  readonly "description"?: string;
  readonly "project_kind": "application" | "library" | "documentation" | "infrastructure";
  readonly "source": ({
    readonly "type": "empty";
    readonly "default_branch": string;
  }) | ({
    readonly "type": "git_repository";
    readonly "git_repository_id": string;
  }) | ({
    readonly "type": "template";
    readonly "template_id": string;
    readonly "parameters"?: ReadonlyArray<{
      readonly "name": string;
      readonly "value": string | number | boolean | null;
    }>;
  });
  readonly "deployment_policy": ({
    readonly "type": "disabled";
  }) | ({
    readonly "type": "server";
    readonly "deployment_target_id": string;
  }) | ({
    readonly "type": "registry";
    readonly "package_registry_id": string;
  });
  readonly "policy_ids"?: ReadonlyArray<string>;
  readonly "tags"?: ReadonlyArray<string>;
};

export type ProjectAcceptedResponse = {
  readonly "schema_version": "1.0.0";
  readonly "message_id": string;
  readonly "correlation_id": string;
  readonly "project_id": string;
  readonly "aggregate_version": 1;
  readonly "status": "provisioning";
  readonly "accepted_at": string;
};

export type ProjectActivatedEvent = {
  readonly "schema_version": "1.0.0";
  readonly "message_id": string;
  readonly "correlation_id": string;
  readonly "causation_id": string;
  readonly "occurred_at": string;
  readonly "project_id": string;
  readonly "aggregate_version": number;
  readonly "status": "active";
  readonly "slug": string;
  readonly "git_repository_id": string;
  readonly "head_commit_sha": string;
  readonly "git_object_format": "sha1" | "sha256";
  readonly "default_branch": string;
};

export type ProjectProvisioningFailedEvent = {
  readonly "schema_version": "1.0.0";
  readonly "message_id": string;
  readonly "correlation_id": string;
  readonly "causation_id": string;
  readonly "occurred_at": string;
  readonly "project_id": string;
  readonly "aggregate_version": number;
  readonly "status": "failed";
  readonly "failure_stage": "validation" | "workspace_creation" | "repository_clone" | "template_application" | "git_initialization";
  readonly "failure_code": string;
  readonly "retryable": boolean;
  readonly "description": string;
};

export type ProjectResponse = (({
  readonly "schema_version": "1.0.0";
  readonly "project_id": string;
  readonly "aggregate_version": number;
  readonly "owner_principal_id": string;
  readonly "display_name": string;
  readonly "description"?: string;
  readonly "slug": string;
  readonly "project_kind": "application" | "library" | "documentation" | "infrastructure";
  readonly "source": ({
    readonly "type": "empty";
    readonly "default_branch": string;
  }) | ({
    readonly "type": "git_repository";
    readonly "git_repository_id": string;
  }) | ({
    readonly "type": "template";
    readonly "template_id": string;
    readonly "parameters"?: ReadonlyArray<{
      readonly "name": string;
      readonly "value": string | number | boolean | null;
    }>;
  });
  readonly "deployment_policy": ({
    readonly "type": "disabled";
  }) | ({
    readonly "type": "server";
    readonly "deployment_target_id": string;
  }) | ({
    readonly "type": "registry";
    readonly "package_registry_id": string;
  });
  readonly "policy_ids": ReadonlyArray<string>;
  readonly "tags": ReadonlyArray<string>;
  readonly "created_at": string;
  readonly "updated_at": string;
}) & ({
  readonly "status": "provisioning";
})) | (({
  readonly "schema_version": "1.0.0";
  readonly "project_id": string;
  readonly "aggregate_version": number;
  readonly "owner_principal_id": string;
  readonly "display_name": string;
  readonly "description"?: string;
  readonly "slug": string;
  readonly "project_kind": "application" | "library" | "documentation" | "infrastructure";
  readonly "source": ({
    readonly "type": "empty";
    readonly "default_branch": string;
  }) | ({
    readonly "type": "git_repository";
    readonly "git_repository_id": string;
  }) | ({
    readonly "type": "template";
    readonly "template_id": string;
    readonly "parameters"?: ReadonlyArray<{
      readonly "name": string;
      readonly "value": string | number | boolean | null;
    }>;
  });
  readonly "deployment_policy": ({
    readonly "type": "disabled";
  }) | ({
    readonly "type": "server";
    readonly "deployment_target_id": string;
  }) | ({
    readonly "type": "registry";
    readonly "package_registry_id": string;
  });
  readonly "policy_ids": ReadonlyArray<string>;
  readonly "tags": ReadonlyArray<string>;
  readonly "created_at": string;
  readonly "updated_at": string;
}) & ({
  readonly "git_repository_id": string;
  readonly "head_commit_sha": string;
  readonly "git_object_format": "sha1" | "sha256";
  readonly "default_branch": string;
}) & ({
  readonly "status": "active" | "suspended" | "archived";
})) | (({
  readonly "schema_version": "1.0.0";
  readonly "project_id": string;
  readonly "aggregate_version": number;
  readonly "owner_principal_id": string;
  readonly "display_name": string;
  readonly "description"?: string;
  readonly "slug": string;
  readonly "project_kind": "application" | "library" | "documentation" | "infrastructure";
  readonly "source": ({
    readonly "type": "empty";
    readonly "default_branch": string;
  }) | ({
    readonly "type": "git_repository";
    readonly "git_repository_id": string;
  }) | ({
    readonly "type": "template";
    readonly "template_id": string;
    readonly "parameters"?: ReadonlyArray<{
      readonly "name": string;
      readonly "value": string | number | boolean | null;
    }>;
  });
  readonly "deployment_policy": ({
    readonly "type": "disabled";
  }) | ({
    readonly "type": "server";
    readonly "deployment_target_id": string;
  }) | ({
    readonly "type": "registry";
    readonly "package_registry_id": string;
  });
  readonly "policy_ids": ReadonlyArray<string>;
  readonly "tags": ReadonlyArray<string>;
  readonly "created_at": string;
  readonly "updated_at": string;
}) & ({
  readonly "failure_stage": "validation" | "workspace_creation" | "repository_clone" | "template_application" | "git_initialization";
  readonly "failure_code": string;
  readonly "retryable": boolean;
  readonly "description": string;
}) & ({
  readonly "status": "failed";
}));

export type CreateJobRequest = {
  readonly "schema_version": "1.0.0";
  readonly "project_id": string;
  readonly "task": string;
  readonly "priority": "low" | "normal" | "high" | "urgent";
  readonly "deadline_at"?: string;
  readonly "timeout_seconds"?: number;
  readonly "constraints"?: ReadonlyArray<string>;
  readonly "input_artifact_ids"?: ReadonlyArray<string>;
  readonly "input_evidence_ids"?: ReadonlyArray<string>;
  readonly "policy_ids"?: ReadonlyArray<string>;
};

export type JobAcceptedResponse = {
  readonly "schema_version": "1.0.0";
  readonly "message_id": string;
  readonly "correlation_id": string;
  readonly "project_id": string;
  readonly "job_id": string;
  readonly "aggregate_version": 1;
  readonly "status": "queued";
  readonly "accepted_at": string;
};

export type JobResponse = {
  readonly "schema_version": "1.0.0";
  readonly "job_id": string;
  readonly "project_id": string;
  readonly "aggregate_version": number;
  readonly "status": "queued" | "executing" | "awaiting_review" | "reviewing" | "approved" | "promoting" | "completed" | "changes_requested" | "awaiting_input" | "cancellation_requested" | "cancelled" | "failed";
  readonly "task": string;
  readonly "priority": "low" | "normal" | "high" | "urgent";
  readonly "current_execution_id"?: string;
  readonly "current_review_id"?: string;
  readonly "current_promotion_id"?: string;
  readonly "created_at": string;
  readonly "updated_at": string;
};

export type StartExecutionCommand = {
  readonly "schema_version": "1.0.0";
  readonly "message_id": string;
  readonly "correlation_id": string;
  readonly "occurred_at": string;
  readonly "project_id": string;
  readonly "job_id": string;
  readonly "git_repository_id": string;
  readonly "base_commit_sha": string;
  readonly "task": string;
  readonly "constraints"?: ReadonlyArray<string>;
  readonly "policy_ids"?: ReadonlyArray<string>;
  readonly "skill_ids"?: ReadonlyArray<string>;
};

export type ExecutionAcceptedResponse = {
  readonly "schema_version": "1.0.0";
  readonly "message_id": string;
  readonly "correlation_id": string;
  readonly "project_id": string;
  readonly "job_id": string;
  readonly "execution_id": string;
  readonly "status": "queued";
  readonly "accepted_at": string;
};

export type ExecutionCompletedEvent = {
  readonly "schema_version": "1.0.0";
  readonly "message_id": string;
  readonly "correlation_id": string;
  readonly "causation_id": string;
  readonly "occurred_at": string;
  readonly "project_id": string;
  readonly "job_id": string;
  readonly "execution_id": string;
  readonly "worktree_id": string;
  readonly "commit_sha": string;
  readonly "branch_name": string;
  readonly "artifact_ids": ReadonlyArray<string>;
  readonly "evidence_ids": ReadonlyArray<string>;
  readonly "summary": string;
};

export type ExecutionFailedEvent = {
  readonly "schema_version": "1.0.0";
  readonly "message_id": string;
  readonly "correlation_id": string;
  readonly "causation_id": string;
  readonly "occurred_at": string;
  readonly "project_id": string;
  readonly "job_id": string;
  readonly "execution_id": string;
  readonly "failure_code": string;
  readonly "retryable": boolean;
  readonly "description": string;
  readonly "artifact_ids": ReadonlyArray<string>;
};

export type StartReviewCommand = {
  readonly "schema_version": "1.0.0";
  readonly "message_id": string;
  readonly "correlation_id": string;
  readonly "occurred_at": string;
  readonly "project_id": string;
  readonly "job_id": string;
  readonly "execution_id": string;
  readonly "git_repository_id": string;
  readonly "commit_sha": string;
  readonly "worktree_id": string;
  readonly "artifact_ids": ReadonlyArray<string>;
  readonly "evidence_ids": ReadonlyArray<string>;
  readonly "policy_ids"?: ReadonlyArray<string>;
};

export type ReviewAcceptedResponse = {
  readonly "schema_version": "1.0.0";
  readonly "message_id": string;
  readonly "correlation_id": string;
  readonly "project_id": string;
  readonly "job_id": string;
  readonly "execution_id": string;
  readonly "review_id": string;
  readonly "status": "queued";
  readonly "accepted_at": string;
};

export type ReviewCompletedEvent = {
  readonly "schema_version": "1.0.0";
  readonly "message_id": string;
  readonly "correlation_id": string;
  readonly "causation_id": string;
  readonly "occurred_at": string;
  readonly "project_id": string;
  readonly "job_id": string;
  readonly "execution_id": string;
  readonly "review_id": string;
  readonly "decision": "approved" | "needs_changes" | "rejected";
  readonly "findings": ReadonlyArray<{
    readonly "severity": "info" | "warning" | "error" | "critical";
    readonly "code": string;
    readonly "message": string;
    readonly "artifact_id"?: string;
  }>;
  readonly "artifact_ids": ReadonlyArray<string>;
  readonly "summary": string;
};

export type ArtifactManifest = {
  readonly "schema_version": "1.0.0";
  readonly "artifact_id": string;
  readonly "project_id": string;
  readonly "job_id": string;
  readonly "artifact_type": "execution_log" | "diff" | "test_result" | "build_result" | "evidence" | "review_result";
  readonly "owner": "pi_service" | "review_service" | "openclaw_core";
  readonly "sha256": string;
  readonly "size_bytes": number;
  readonly "created_at": string;
  readonly "finalization_status": "writing" | "finalized";
  readonly "retention_policy_id": string;
};
