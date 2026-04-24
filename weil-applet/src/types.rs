use serde::{Deserialize, Serialize};
use weil_macros::WeilType;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/// Top-level applet configuration stored in contract state.
#[derive(Debug, Serialize, Deserialize, Clone, WeilType)]
pub struct AppletConfig {
    /// System prompt injected at the start of every agent run.
    pub system_prompt: String,
    /// Default model identifier (e.g. "claude-sonnet-4-6").
    pub default_model: String,
    /// How many past conversation turns to include in the task context.
    pub max_history_turns: u32,
}

impl Default for AppletConfig {
    fn default() -> Self {
        Self {
            system_prompt: "You are OpenClaw, a multi-channel AI gateway assistant. \
                You help users with their requests using available tools. \
                You maintain conversation history, remember user preferences, \
                manage scheduled tasks, and coordinate multiple AI agents."
                .to_string(),
            default_model: "claude-sonnet-4-6".to_string(),
            max_history_turns: 20,
        }
    }
}

// ---------------------------------------------------------------------------
// Conversation / session
// ---------------------------------------------------------------------------

/// The role of a participant in a conversation.
#[derive(Debug, Serialize, Deserialize, Clone, WeilType)]
pub enum ConversationRole {
    User,
    Assistant,
    System,
}

/// A single message in a session transcript.
#[derive(Debug, Serialize, Deserialize, Clone, WeilType)]
pub struct ConversationMessage {
    pub role: ConversationRole,
    pub content: String,
    /// Block-chain timestamp string at the time of storage.
    pub timestamp: String,
}

/// The value returned by `send_message`.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentResponse {
    pub reply: String,
    pub task_id: String,
    pub session_key: String,
    pub model_used: String,
}

// ---------------------------------------------------------------------------
// Multi-agent workflows (chain)
// ---------------------------------------------------------------------------

/// A single task in a sequential workflow chain.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkflowTask {
    /// Optional task id; a UUID is generated when omitted.
    pub task_id: Option<String>,
    /// Natural-language description of what this task should accomplish.
    pub description: String,
    /// MCP contract address that provides the tools for this task.
    pub mcp_contract_address: String,
}

/// Outcome of `run_workflow`.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub enum WorkflowResult {
    /// All tasks completed; contains the final task result.
    Ok(String),
    /// A task failed; contains enough data to resume.
    Err {
        error: String,
        resume_index: u32,
        previous_result: Option<String>,
    },
}

// ---------------------------------------------------------------------------
// DAG pipeline
// ---------------------------------------------------------------------------

/// Edge condition in a pipeline specification.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub enum PipelineCondition {
    AlwaysTrue,
    AlwaysFalse,
    /// Follow this edge when the previous result equals this string.
    Equals(String),
    /// Follow this edge when the previous result does NOT equal this string.
    NotEquals(String),
}

/// A directed edge between two tasks in a pipeline.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PipelineEdgeSpec {
    pub from_task_id: String,
    pub to_task_id: String,
    pub condition: PipelineCondition,
}

/// Full pipeline specification supplied by the caller.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PipelineSpec {
    pub name: String,
    pub description: String,
    /// All tasks that form the DAG nodes.
    pub tasks: Vec<WorkflowTask>,
    /// The task_id (or index "0", "1", …) to start from.
    pub root_task_id: String,
    /// DAG edges with conditions.
    pub edges: Vec<PipelineEdgeSpec>,
    /// When `true`, the pipeline repeats after the last node completes.
    pub is_repeating: bool,
}

// ---------------------------------------------------------------------------
// Cron / scheduled tasks
// ---------------------------------------------------------------------------

/// A scheduled job stored in the contract.
#[derive(Debug, Serialize, Deserialize, Clone, WeilType)]
pub struct CronJob {
    pub id: String,
    pub description: String,
    pub mcp_contract_address: String,
    /// Minimum interval between runs in milliseconds (informational).
    pub every_ms: u64,
    /// Block-chain timestamp of the last execution, if any.
    pub last_run_timestamp: Option<String>,
    pub created_at: String,
}

// ---------------------------------------------------------------------------
// Task history
// ---------------------------------------------------------------------------

/// An entry in the per-session task log.
#[derive(Debug, Serialize, Deserialize, Clone, WeilType)]
pub struct TaskRecord {
    pub task_id: String,
    pub session_key: String,
    pub description: String,
    pub response: String,
    pub timestamp: String,
}

// ---------------------------------------------------------------------------
// Agent registry
// ---------------------------------------------------------------------------

/// An entry returned by `list_agents`.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentInfo {
    pub name: String,
    pub contract_address: String,
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/// High-level health / info response.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppletStatus {
    pub contract_id: String,
    pub active_sessions: u64,
    pub cron_jobs_count: u64,
    pub registered_agents_count: u64,
    pub default_model: String,
}
