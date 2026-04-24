//! # openclaw_weil
//!
//! OpenClaw reimplemented as a Weilliptic smart-contract applet.
//!
//! ## Architecture
//!
//! ```text
//!  Caller (channel / UI)
//!        │
//!        ▼
//!  OpenClawState  ◄────────────────────────────────────────────────────┐
//!  (this contract)                                                      │
//!        │                                                              │
//!        │  send_message / run_workflow / run_pipeline / run_cron       │
//!        │                                                              │
//!        ▼                                                              │
//!  cerebrum::Driver  ──── LLM (model + model_key) ────────────────────►│
//!        │                                                              │
//!        │  tool calls via Runtime::call_contract                       │
//!        ▼                                                              │
//!  MCP Contract  (external agent, or this contract when self-hosted)   ─┘
//!  tools() / prompts() / web_fetch / recall_memory / …
//! ```
//!
//! ## WeilId allocation
//!
//! IDs 1-9 are reserved for cerebrum internals (Memory uses 1+2,
//! Actions uses 1+2+3, AgentRegistry uses 1).  This applet starts at 10.
//!
//! | WeilId | Collection |
//! |--------|-----------|
//! | 10     | `sessions`      – session_key → Vec<ConversationMessage> |
//! | 11     | `cron_jobs`     – cron_id     → CronJob |
//! | 12     | `user_memory`   – "{caller}:{key}" → String |
//! | 13     | `task_history`  – session_key → Vec<TaskRecord> |
//! | 14     | `agent_registry`– name → contract_address |

#![allow(dead_code)]

mod types;
mod tools;

use types::*;
use tools::tool_schema_json;

use serde::{Deserialize, Serialize};
use weil_macros::{WeilType, constructor, mutate, query, smart_contract};
use weil_rs::{
    collections::{map::WeilMap, WeilId},
    http::{HttpClient, HttpMethod},
    runtime::Runtime,
};
use w_cerebrum::{
    core::{chain::ChainWithAgents, task::TaskWithAgent},
    llmutils::driver::Driver,
    pipeline::{ConditionType, Pipeline},
};

// ---------------------------------------------------------------------------
// WeilId constants
// ---------------------------------------------------------------------------

const ID_SESSIONS: WeilId = WeilId(10);
const ID_CRON_JOBS: WeilId = WeilId(11);
const ID_USER_MEMORY: WeilId = WeilId(12);
const ID_TASK_HISTORY: WeilId = WeilId(13);
const ID_AGENT_REGISTRY: WeilId = WeilId(14);

// ---------------------------------------------------------------------------
// Contract state
// ---------------------------------------------------------------------------

/// Persistent state of the OpenClaw Weilliptic applet.
#[derive(Serialize, Deserialize, WeilType)]
pub struct OpenClawState {
    /// Application configuration.
    pub config: AppletConfig,

    /// Conversation transcripts keyed by session_key.
    /// The full Vec is serialised as a single JSON value inside the WeilMap.
    pub sessions: WeilMap<String, Vec<ConversationMessage>>,
    /// Ordered list of all session keys for iteration / list_sessions.
    pub session_keys: Vec<String>,

    /// Cron job definitions.
    pub cron_jobs: WeilMap<String, CronJob>,
    /// Ordered list of all cron ids for iteration / list_crons.
    pub cron_ids: Vec<String>,

    /// Per-caller flat key-value memory.  Keys are "{caller_addr}:{user_key}".
    pub user_memory: WeilMap<String, String>,

    /// Per-session task execution history.
    pub task_history: WeilMap<String, Vec<TaskRecord>>,

    /// Named external MCP agent registry.  Key = friendly name, value = contract address.
    pub agent_registry: WeilMap<String, String>,
    /// Ordered list of registered agent names.
    pub agent_names: Vec<String>,
}

// ---------------------------------------------------------------------------
// Contract trait
// ---------------------------------------------------------------------------

trait OpenClaw {
    // --- lifecycle ----------------------------------------------------------
    fn new(system_prompt: Option<String>) -> Result<Self, String>
    where
        Self: Sized;

    fn configure(&mut self, config: AppletConfig) -> Result<(), String>;

    // --- agent registry -----------------------------------------------------
    fn register_agent(&mut self, name: String, contract_address: String) -> Result<(), String>;
    fn unregister_agent(&mut self, name: String) -> Result<(), String>;
    fn list_agents(&self) -> Result<String, String>;

    // --- core AI interaction ------------------------------------------------
    /// Send a message to the AI and receive a response.
    ///
    /// Recent conversation history is prepended to the task description so the
    /// LLM maintains context across multiple turns.
    ///
    /// `mcp_contract_address` — address of the MCP contract to use for tools.
    /// When `None` the contract uses itself (`Runtime::contract_id()`), which
    /// exposes the built-in read-only tools declared in `tools()`.
    async fn send_message(
        &mut self,
        session_key: String,
        message: String,
        mcp_contract_address: Option<String>,
        model: Option<String>,
        model_key: Option<String>,
    ) -> Result<AgentResponse, String>;

    // --- multi-agent chain --------------------------------------------------
    /// Run a sequential chain of tasks where each task's output feeds the next.
    async fn run_workflow(
        &mut self,
        tasks: Vec<WorkflowTask>,
        model: Option<String>,
        model_key: Option<String>,
    ) -> Result<WorkflowResult, String>;

    // --- DAG pipeline -------------------------------------------------------
    /// Execute a directed acyclic graph (DAG) of tasks with conditional edges.
    async fn run_pipeline(
        &mut self,
        spec: PipelineSpec,
        model: Option<String>,
        model_key: Option<String>,
    ) -> Result<String, String>;

    // --- session management -------------------------------------------------
    fn get_transcript(&self, session_key: String) -> Result<Vec<ConversationMessage>, String>;
    fn clear_session(&mut self, session_key: String) -> Result<(), String>;
    fn list_sessions(&self) -> Result<Vec<String>, String>;

    // --- cron / scheduled tasks ---------------------------------------------
    fn create_cron(
        &mut self,
        cron_id: String,
        description: String,
        mcp_contract_address: String,
        every_ms: u64,
    ) -> Result<(), String>;

    /// Execute a cron job on demand (the platform calls this on schedule).
    async fn run_cron(
        &mut self,
        cron_id: String,
        model: Option<String>,
        model_key: Option<String>,
    ) -> Result<String, String>;

    fn delete_cron(&mut self, cron_id: String) -> Result<(), String>;
    fn list_crons(&self) -> Result<Vec<CronJob>, String>;

    // --- per-caller memory --------------------------------------------------
    fn remember(&mut self, key: String, value: String) -> Result<(), String>;
    fn recall(&self, key: String) -> Result<Option<String>, String>;
    fn forget(&mut self, key: String) -> Result<bool, String>;

    // --- task history -------------------------------------------------------
    fn get_task_history(&self, session_key: String) -> Result<Vec<TaskRecord>, String>;

    // --- MCP interface (built-in tools exposed to other contracts) -----------
    /// HTTP fetch tool.  Called by the cerebrum Driver during agentic loops.
    async fn web_fetch(
        &self,
        url: String,
        method: Option<String>,
        body: Option<String>,
    ) -> Result<String, String>;

    /// Memory recall tool.  Called by the cerebrum Driver; scoped to caller.
    fn recall_memory(&self, key: String) -> Result<Option<String>, String>;

    /// Return the JSON tool schema array for this contract's built-in tools.
    fn tools(&self) -> String;

    /// Return the system-prompt context for this contract's MCP server role.
    fn prompts(&self) -> String;

    // --- status -------------------------------------------------------------
    fn status(&self) -> Result<AppletStatus, String>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

#[smart_contract]
impl OpenClaw for OpenClawState {
    // ---- constructor -------------------------------------------------------

    #[constructor]
    fn new(system_prompt: Option<String>) -> Result<Self, String>
    where
        Self: Sized,
    {
        let mut config = AppletConfig::default();
        if let Some(prompt) = system_prompt {
            config.system_prompt = prompt;
        }

        Ok(OpenClawState {
            config,
            sessions: WeilMap::new(ID_SESSIONS),
            session_keys: Vec::new(),
            cron_jobs: WeilMap::new(ID_CRON_JOBS),
            cron_ids: Vec::new(),
            user_memory: WeilMap::new(ID_USER_MEMORY),
            task_history: WeilMap::new(ID_TASK_HISTORY),
            agent_registry: WeilMap::new(ID_AGENT_REGISTRY),
            agent_names: Vec::new(),
        })
    }

    // ---- configuration -----------------------------------------------------

    #[mutate]
    fn configure(&mut self, config: AppletConfig) -> Result<(), String> {
        self.config = config;
        Ok(())
    }

    // ---- agent registry ----------------------------------------------------

    #[mutate]
    fn register_agent(&mut self, name: String, contract_address: String) -> Result<(), String> {
        if self.agent_registry.get(&name).is_some() {
            return Err(format!("Agent '{}' is already registered", name));
        }
        self.agent_registry.insert(name.clone(), contract_address);
        self.agent_names.push(name);
        Ok(())
    }

    #[mutate]
    fn unregister_agent(&mut self, name: String) -> Result<(), String> {
        if self.agent_registry.get(&name).is_none() {
            return Err(format!("Agent '{}' is not registered", name));
        }
        self.agent_registry.remove(&name);
        self.agent_names.retain(|n| n != &name);
        Ok(())
    }

    #[query]
    fn list_agents(&self) -> Result<String, String> {
        let agents: Vec<AgentInfo> = self
            .agent_names
            .iter()
            .filter_map(|name| {
                self.agent_registry
                    .get(name)
                    .map(|addr| AgentInfo { name: name.clone(), contract_address: addr })
            })
            .collect();
        serde_json::to_string(&agents).map_err(|e| e.to_string())
    }

    // ---- core AI interaction -----------------------------------------------

    #[mutate]
    async fn send_message(
        &mut self,
        session_key: String,
        message: String,
        mcp_contract_address: Option<String>,
        model: Option<String>,
        model_key: Option<String>,
    ) -> Result<AgentResponse, String> {
        let caller = Runtime::sender();
        let task_id = Runtime::uuid();
        let model = model.unwrap_or_else(|| self.config.default_model.clone());
        let mcp_addr = mcp_contract_address
            .unwrap_or_else(|| Runtime::contract_id());

        // Build task description that includes recent conversation history.
        let history = self.sessions.get(&session_key).unwrap_or_default();
        let task_description = build_task_description(
            &message,
            &history,
            self.config.max_history_turns,
        );

        // Append the user turn to the transcript before calling the LLM so
        // that even a failed run leaves a trace.
        let user_msg = ConversationMessage {
            role: ConversationRole::User,
            content: message.clone(),
            timestamp: Runtime::block_timestamp(),
        };
        append_to_session(&mut self.sessions, &mut self.session_keys, &session_key, user_msg);

        // Run the agentic loop via cerebrum Driver.
        let task = TaskWithAgent::new(task_id.clone(), task_description, mcp_addr);
        let reply = Driver::do_task_with_agent(caller.clone(), task, model.clone(), model_key)
            .await
            .map_err(|e| format!("Agent execution failed: {}", e))?;

        // Append the assistant turn.
        let assistant_msg = ConversationMessage {
            role: ConversationRole::Assistant,
            content: reply.clone(),
            timestamp: Runtime::block_timestamp(),
        };
        append_to_session(&mut self.sessions, &mut self.session_keys, &session_key, assistant_msg);

        // Record in task history.
        let record = TaskRecord {
            task_id: task_id.clone(),
            session_key: session_key.clone(),
            description: message,
            response: reply.clone(),
            timestamp: Runtime::block_timestamp(),
        };
        append_to_task_history(&mut self.task_history, &session_key, record);

        Ok(AgentResponse {
            reply,
            task_id,
            session_key,
            model_used: model,
        })
    }

    // ---- multi-agent chain -------------------------------------------------

    #[mutate]
    async fn run_workflow(
        &mut self,
        tasks: Vec<WorkflowTask>,
        model: Option<String>,
        model_key: Option<String>,
    ) -> Result<WorkflowResult, String> {
        let caller = Runtime::sender();
        let model = model.unwrap_or_else(|| self.config.default_model.clone());

        if tasks.is_empty() {
            return Err("At least one task is required".to_string());
        }

        let mut chain = ChainWithAgents::new();
        for (i, t) in tasks.iter().enumerate() {
            let task_id = t
                .task_id
                .clone()
                .unwrap_or_else(|| format!("task_{}", i));
            chain.add_task(TaskWithAgent::new(
                task_id,
                t.description.clone(),
                t.mcp_contract_address.clone(),
            ));
        }

        match chain.run(caller, model, model_key).await {
            Ok(results) => Ok(WorkflowResult::Ok(results.join("\n\n---\n\n"))),
            Err(err) => Ok(WorkflowResult::Err {
                error: err.err_msg,
                resume_index: err.index,
                previous_result: err.previous_result,
            }),
        }
    }

    // ---- DAG pipeline ------------------------------------------------------

    #[mutate]
    async fn run_pipeline(
        &mut self,
        spec: PipelineSpec,
        model: Option<String>,
        model_key: Option<String>,
    ) -> Result<String, String> {
        let caller = Runtime::sender();
        let model = model.unwrap_or_else(|| self.config.default_model.clone());

        let mut pipeline = Pipeline::new(
            spec.name.clone(),
            spec.description.clone(),
            spec.is_repeating,
        );

        for (i, t) in spec.tasks.iter().enumerate() {
            let task_id = t
                .task_id
                .clone()
                .unwrap_or_else(|| format!("task_{}", i));
            pipeline.add_task(TaskWithAgent::new(
                task_id,
                t.description.clone(),
                t.mcp_contract_address.clone(),
            ));
        }

        pipeline
            .set_root(spec.root_task_id.clone())
            .map_err(|e| format!("Invalid root task: {}", e))?;

        for edge in &spec.edges {
            let condition = match &edge.condition {
                PipelineCondition::AlwaysTrue => ConditionType::AlwaysTrue,
                PipelineCondition::AlwaysFalse => ConditionType::AlwaysFalse,
                PipelineCondition::Equals(v) => ConditionType::Equals(v.clone()),
                PipelineCondition::NotEquals(v) => ConditionType::NotEquals(v.clone()),
            };
            pipeline
                .add_edge(edge.from_task_id.clone(), edge.to_task_id.clone(), condition)
                .map_err(|e| format!("Invalid pipeline edge: {}", e))?;
        }

        pipeline.start();
        pipeline
            .run(caller, model, model_key)
            .await
            .map_err(|e| format!("Pipeline execution failed: {}", e))
    }

    // ---- session management ------------------------------------------------

    #[query]
    fn get_transcript(&self, session_key: String) -> Result<Vec<ConversationMessage>, String> {
        Ok(self.sessions.get(&session_key).unwrap_or_default())
    }

    #[mutate]
    fn clear_session(&mut self, session_key: String) -> Result<(), String> {
        self.sessions.remove(&session_key);
        self.session_keys.retain(|k| k != &session_key);
        self.task_history.remove(&session_key);
        Ok(())
    }

    #[query]
    fn list_sessions(&self) -> Result<Vec<String>, String> {
        Ok(self.session_keys.clone())
    }

    // ---- cron / scheduled tasks --------------------------------------------

    #[mutate]
    fn create_cron(
        &mut self,
        cron_id: String,
        description: String,
        mcp_contract_address: String,
        every_ms: u64,
    ) -> Result<(), String> {
        if self.cron_jobs.get(&cron_id).is_some() {
            return Err(format!("Cron job '{}' already exists", cron_id));
        }
        let job = CronJob {
            id: cron_id.clone(),
            description,
            mcp_contract_address,
            every_ms,
            last_run_timestamp: None,
            created_at: Runtime::block_timestamp(),
        };
        self.cron_jobs.insert(cron_id.clone(), job);
        self.cron_ids.push(cron_id);
        Ok(())
    }

    #[mutate]
    async fn run_cron(
        &mut self,
        cron_id: String,
        model: Option<String>,
        model_key: Option<String>,
    ) -> Result<String, String> {
        let job = self
            .cron_jobs
            .get(&cron_id)
            .ok_or_else(|| format!("Cron job '{}' not found", cron_id))?;

        let caller = Runtime::sender();
        let model = model.unwrap_or_else(|| self.config.default_model.clone());

        let task_id = Runtime::uuid();
        let task = TaskWithAgent::new(
            task_id.clone(),
            job.description.clone(),
            job.mcp_contract_address.clone(),
        );

        let result = Driver::do_task_with_agent(caller, task, model, model_key)
            .await
            .map_err(|e| format!("Cron execution failed: {}", e))?;

        // Update last-run timestamp.
        let mut updated_job = job;
        updated_job.last_run_timestamp = Some(Runtime::block_timestamp());
        self.cron_jobs.insert(cron_id, updated_job);

        Ok(result)
    }

    #[mutate]
    fn delete_cron(&mut self, cron_id: String) -> Result<(), String> {
        if self.cron_jobs.get(&cron_id).is_none() {
            return Err(format!("Cron job '{}' not found", cron_id));
        }
        self.cron_jobs.remove(&cron_id);
        self.cron_ids.retain(|id| id != &cron_id);
        Ok(())
    }

    #[query]
    fn list_crons(&self) -> Result<Vec<CronJob>, String> {
        let jobs: Vec<CronJob> = self
            .cron_ids
            .iter()
            .filter_map(|id| self.cron_jobs.get(id))
            .collect();
        Ok(jobs)
    }

    // ---- per-caller memory -------------------------------------------------

    #[mutate]
    fn remember(&mut self, key: String, value: String) -> Result<(), String> {
        let caller = Runtime::sender();
        let compound = format!("{}:{}", caller, key);
        self.user_memory.insert(compound, value);
        Ok(())
    }

    #[query]
    fn recall(&self, key: String) -> Result<Option<String>, String> {
        let caller = Runtime::sender();
        let compound = format!("{}:{}", caller, key);
        Ok(self.user_memory.get(&compound))
    }

    #[mutate]
    fn forget(&mut self, key: String) -> Result<bool, String> {
        let caller = Runtime::sender();
        let compound = format!("{}:{}", caller, key);
        let existed = self.user_memory.get(&compound).is_some();
        if existed {
            self.user_memory.remove(&compound);
        }
        Ok(existed)
    }

    // ---- task history ------------------------------------------------------

    #[query]
    fn get_task_history(&self, session_key: String) -> Result<Vec<TaskRecord>, String> {
        Ok(self.task_history.get(&session_key).unwrap_or_default())
    }

    // ---- MCP interface (built-in tools for other contracts) ----------------

    /// HTTP fetch — exposed as an MCP tool named `web_fetch`.
    #[query]
    async fn web_fetch(
        &self,
        url: String,
        method: Option<String>,
        body: Option<String>,
    ) -> Result<String, String> {
        let http_method = match method.as_deref().unwrap_or("GET") {
            "POST" => HttpMethod::Post,
            "PUT" => HttpMethod::Put,
            "DELETE" => HttpMethod::Delete,
            "PATCH" => HttpMethod::Patch,
            _ => HttpMethod::Get,
        };

        let mut builder = HttpClient::request(&url, http_method);
        if let Some(b) = body {
            builder = builder.body(b);
        }

        let response = builder
            .send()
            .map_err(|e| format!("HTTP request failed: {}", e))?;

        if response.status() >= 400 {
            return Err(format!("HTTP error {}: {}", response.status(), response.text()));
        }
        Ok(response.text())
    }

    /// Memory recall — exposed as an MCP tool named `recall_memory`.
    /// Scoped to the current caller address.
    #[query]
    fn recall_memory(&self, key: String) -> Result<Option<String>, String> {
        let caller = Runtime::sender();
        let compound = format!("{}:{}", caller, key);
        Ok(self.user_memory.get(&compound))
    }

    /// Returns the JSON tool schema array for this contract's built-in tools.
    /// Called by the cerebrum Driver when this contract is an MCP server.
    #[query]
    fn tools(&self) -> String {
        tool_schema_json()
    }

    /// Returns the system-prompt context string for this contract's MCP role.
    /// Called by the cerebrum Driver's `get_agent_prompts`.
    #[query]
    fn prompts(&self) -> String {
        self.config.system_prompt.clone()
    }

    // ---- status ------------------------------------------------------------

    #[query]
    fn status(&self) -> Result<AppletStatus, String> {
        Ok(AppletStatus {
            contract_id: Runtime::contract_id(),
            active_sessions: self.session_keys.len() as u64,
            cron_jobs_count: self.cron_ids.len() as u64,
            registered_agents_count: self.agent_names.len() as u64,
            default_model: self.config.default_model.clone(),
        })
    }
}

// ---------------------------------------------------------------------------
// Private helpers (not WASM exports)
// ---------------------------------------------------------------------------

/// Build a task description that embeds recent conversation history as context.
fn build_task_description(
    current_message: &str,
    history: &[ConversationMessage],
    max_turns: u32,
) -> String {
    if history.is_empty() {
        return current_message.to_string();
    }

    // Take the last `max_turns` messages; pair User+Assistant turns.
    let start = history.len().saturating_sub(max_turns as usize * 2);
    let recent = &history[start..];

    let mut ctx = String::from("Previous conversation:\n");
    for msg in recent {
        let role = match msg.role {
            ConversationRole::User => "User",
            ConversationRole::Assistant => "Assistant",
            ConversationRole::System => "System",
        };
        ctx.push_str(&format!("{}: {}\n", role, msg.content));
    }
    ctx.push('\n');
    ctx.push_str(&format!("Current message: {}", current_message));
    ctx
}

/// Append a message to a session's transcript, registering the key when new.
fn append_to_session(
    sessions: &mut WeilMap<String, Vec<ConversationMessage>>,
    session_keys: &mut Vec<String>,
    session_key: &String,
    message: ConversationMessage,
) {
    let mut transcript = sessions.get(session_key).unwrap_or_default();
    transcript.push(message);
    sessions.insert(session_key.clone(), transcript);
    if !session_keys.contains(session_key) {
        session_keys.push(session_key.clone());
    }
}

/// Append a TaskRecord to the per-session task history.
fn append_to_task_history(
    task_history: &mut WeilMap<String, Vec<TaskRecord>>,
    session_key: &String,
    record: TaskRecord,
) {
    let mut history = task_history.get(session_key).unwrap_or_default();
    history.push(record);
    task_history.insert(session_key.clone(), history);
}
