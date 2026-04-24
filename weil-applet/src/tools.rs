/// Generates the JSON tool schema array returned by the `tools()` MCP method.
///
/// The schema follows the OpenAI function-calling format that the Weilliptic
/// cerebrum `Driver` expects.  Each entry's `"name"` must exactly match the
/// corresponding `#[query]` method exported by the `OpenClaw` `#[smart_contract]`
/// impl so that cross-contract tool dispatch routes to the right WASM export.
///
/// Tools exposed here are all read-only (query) so they are safe to call from
/// within any agentic loop that targets this contract as its MCP server.
pub fn tool_schema_json() -> String {
    serde_json::json!([
        {
            "type": "function",
            "function": {
                "name": "web_fetch",
                "description": "Fetch the content of any public URL via HTTP. \
                                Use GET by default; supply a body for POST/PUT.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": {
                            "type": "string",
                            "description": "Fully-qualified URL to request."
                        },
                        "method": {
                            "type": "string",
                            "enum": ["GET", "POST", "PUT", "DELETE", "PATCH"],
                            "description": "HTTP method (default: GET)."
                        },
                        "body": {
                            "type": "string",
                            "description": "Request body (for POST / PUT)."
                        }
                    },
                    "required": ["url"]
                },
                "returns": { "type": "string" }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "recall_memory",
                "description": "Recall a value previously stored with the `remember` \
                                method.  Memory is scoped to the current caller address.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "key": {
                            "type": "string",
                            "description": "The memory key to look up."
                        }
                    },
                    "required": ["key"]
                },
                "returns": { "type": "string" }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_transcript",
                "description": "Return the conversation transcript for a session. \
                                Each entry is a JSON object with `role` and `content`.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "session_key": {
                            "type": "string",
                            "description": "Session identifier, e.g. 'telegram:+1234567890'."
                        }
                    },
                    "required": ["session_key"]
                },
                "returns": { "type": "string" }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "list_sessions",
                "description": "List all session keys that have an active transcript.",
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "required": []
                },
                "returns": { "type": "string" }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "list_crons",
                "description": "List all scheduled cron jobs defined in the contract.",
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "required": []
                },
                "returns": { "type": "string" }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "list_agents",
                "description": "List all named external MCP agents registered in the \
                                contract, along with their contract addresses.",
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "required": []
                },
                "returns": { "type": "string" }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "status",
                "description": "Return a high-level health and statistics summary for \
                                this OpenClaw applet.",
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "required": []
                },
                "returns": { "type": "string" }
            }
        }
    ])
    .to_string()
}
