# CODEBASE_DEEP_ANALYSIS.md

**Date:** 2026-02-11  
**Purpose:** Complete AutifyME codebase mapping to OpenClaw platform capabilities  
**Scope:** Every file analyzed for migration to OpenClaw

---

## EXECUTIVE SUMMARY

### What AutifyME Is

AutifyME is a **multi-domain autonomous business operating system** built on LangChain/LangGraph. It orchestrates:

- **Catalog Management**: Product families, variants, SKUs, pricing, BOM
- **Digital Asset Management**: Image processing, visual quality, e-commerce hero shots
- **Product Intelligence**: External research, market positioning, compliance
- **WhatsApp Interface**: Conversational product cataloging via messaging

**Architecture Pattern:** Project Manager → Analysts (read-only) → Specialists (execution) → HITL Approval

**Core Innovation:** Protocol-driven reasoning with domain-specific intelligence loaded at runtime

### Migration to OpenClaw: Complete Platform Replacement

OpenClaw provides **native replacements** for ALL AutifyME infrastructure:

| AutifyME Component | OpenClaw Replacement | Status |
|-------------------|---------------------|--------|
| LangGraph workflow orchestration | OpenClaw agent sessions + subagent spawning | ✅ Native |
| LangChain tools | OpenClaw tool functions | ✅ Native |
| WhatsApp webhook + client | OpenClaw message tool (WhatsApp channel) | ✅ Native |
| Supabase storage port | OpenClaw database integration | ✅ Via skills |
| Image analysis (Gemini Vision) | OpenClaw image tool | ✅ Native |
| Web research (Tavily) | OpenClaw web_search + web_fetch | ✅ Native |
| File storage (Supabase Storage) | OpenClaw workspace files | ✅ Native |
| HITL approval flow | OpenClaw user confirmation patterns | ✅ Native |
| Protocol loading | OpenClaw skills system | ✅ **KEY MIGRATION** |
| Checkpointing / state | OpenClaw session persistence | ✅ Native |

**MIGRATION STRATEGY:** Extract domain intelligence (prompts + protocols) → Port to OpenClaw skills → Use native platform for infrastructure

---

## 1. FILE-BY-FILE ANALYSIS

### 1.1 Core Infrastructure (`agents/src/autifyme_agents/core/`)

#### `config.py`
**Purpose:** Application configuration via Pydantic settings  
**Key Classes:**
- `Settings`: Environment variables (Supabase, WhatsApp, feature flags)

**Dependencies:** 
- External: `pydantic-settings`, `dotenv`
- Services: Supabase (URL, keys), WhatsApp (tokens, phone IDs), Tavily (API key)

**OpenClaw Mapping:**
- ✅ **Replace with:** OpenClaw environment variables / secrets management
- Environment config → OpenClaw gateway settings
- Feature flags → OpenClaw skill enablement
- **Migration:** Move secrets to OpenClaw `~/.openclaw/secrets`, use `os.getenv()` in skills

---

#### `llm_factory.py`
**Purpose:** Centralized LLM instantiation with provider-specific configuration  
**Key Functions:**
- `get_llm()`: Returns configured BaseChatModel (OpenAI, Anthropic, Google Gemini)

**Dependencies:**
- External: `langchain_anthropic`, `langchain_openai`, `langchain_google_genai`
- Internal: `gemini_retry.py` (blank response handling)

**Business Logic:**
- Model-specific temperature defaults (Gemini 3: 1.0, others: 0.1)
- Gemini thinking control: `thinking_level` (Gemini 3+) vs `thinking_budget` (Gemini 2.5)
- Automatic prompt caching (OpenAI GPT-4.1: 75% discount, Anthropic: cache_control)
- Media resolution for Gemini 3+ vision (low/medium/high token budgets)
- Image generation + TTS modality support

**OpenClaw Mapping:**
- ✅ **Replace with:** OpenClaw native model configuration
- `get_llm("google", "gemini-3-flash-preview")` → OpenClaw default model setting
- Model selection logic → OpenClaw model override per skill/subagent
- **Migration:** OpenClaw handles model instantiation; skills just specify model name if override needed

---

#### `execution_context.py`
**Purpose:** Thread-local storage for infrastructure data invisible to LLMs  
**Key Functions:**
- `execution_context()`: Context manager for thread_id, company_id
- `to_storage_path()` / `to_user_path()`: Path conversion (hides thread_id from LLM)

**Business Logic:**
- Threaded zones: `inbox/`, `pending/` get thread_id subfolder
- Non-threaded zones: `products/`, `brands/` stay flat
- Path sanitization: Replace invalid chars (`:` → `_`)

**OpenClaw Mapping:**
- ✅ **Replace with:** OpenClaw workspace context + session IDs
- `execution_context(thread_id="whatsapp_123")` → OpenClaw session context
- Path conversion → OpenClaw workspace path helpers
- **Migration:** Use OpenClaw session ID for user-specific file isolation; workspace paths are already relative

---

#### `prompt_loader.py`
**Purpose:** Load prompt files from filesystem with caching  
**Key Functions:**
- `load_prompt(file_name: str)`: Cached prompt file reader

**Dependencies:**
- Internal: Prompts directory (`prompts/specialists/`, `prompts/analysts/`, `prompts/protocols/`)

**OpenClaw Mapping:**
- ✅ **CRITICAL - Replace with:** OpenClaw skills directory structure
- Prompts → `~/.openclaw/workspace/skills/[domain]/SKILL.md`
- Protocol files → Skill sub-files or knowledge base
- **Migration Priority:** HIGH - This is the domain intelligence extraction point

---

#### `storage_utils.py`
**Purpose:** Supabase storage URL builders and path sanitization  
**Key Functions:**
- `build_storage_url(path, bucket)`: Construct Supabase public URLs
- `sanitize_for_path(value)`: Clean identifiers for path use
- `is_storage_path(path)`: Detect relative storage paths

**Business Logic:**
- Storage zones: `inbox/`, `pending/`, `products/`, `brands/`, `assets/`
- Thread-aware path expansion
- URL passthrough for external images

**OpenClaw Mapping:**
- ✅ **Replace with:** OpenClaw file management + workspace paths
- `build_storage_url()` → OpenClaw file tool with public URLs (if needed)
- Supabase bucket → OpenClaw workspace directories
- **Migration:** Use OpenClaw workspace file management; replace Supabase-specific URL logic

---

#### `message_batcher.py`
**Purpose:** Smart Skip debouncing for rapid-fire WhatsApp messages  
**Key Classes:**
- `MessageBatcher`: DB-backed message queue with background processing

**Business Logic:**
- Media types always debounce (image, video, document, audio)
- Text messages debounce only if recent activity exists
- Debounce window: 5 seconds (catches WhatsApp forwards with 3-4s gaps)
- Atomic fetch-and-clear for concurrent serverless tasks
- Orphan recovery on startup

**OpenClaw Mapping:**
- ✅ **Replace with:** OpenClaw message batching or handle in main agent
- MessageBatcher logic → OpenClaw message handling with delay
- DB queue → OpenClaw session state or simple in-memory queue
- **Migration:** Simplify - OpenClaw agents can handle multi-message context naturally; batch if needed via agent logic

---

#### `tool_error_handler.py`
**Purpose:** Convert exceptions to agent-friendly structured responses  
**Key Functions:**
- `build_agent_error_response()`: Exception → actionable error dict
- `build_success_response()`: Consistent success format

**Business Logic:**
- Error pattern matching (timeout, access denied, table error, etc.)
- Actionable guidance for agent retry/adaptation
- Tools NEVER raise exceptions (return dicts instead)

**OpenClaw Mapping:**
- ✅ **Adapt:** OpenClaw tool error handling
- Pattern matching → OpenClaw tool error responses
- **Migration:** Use OpenClaw tool function error returns; apply same pattern-based guidance

---

#### `exceptions.py`
**Purpose:** Custom exception hierarchy for AutifyME  
**Key Classes:**
- `AutifyMEError` (base), `ToolExecutionError`, `StorageError`, `ValidationError`, `ConfigurationError`, etc.

**OpenClaw Mapping:**
- ✅ **Simplify:** Use Python standard exceptions + OpenClaw error handling
- Custom hierarchy → Standard exceptions with clear messages
- **Migration:** Not needed in OpenClaw (use standard exceptions)

---

#### `logging_config.py`
**Purpose:** Structured logging with console + file handlers  
**Key Functions:**
- `setup_logging()`: Configure app-wide logging
- `get_logger()`: Named logger retrieval

**OpenClaw Mapping:**
- ✅ **Replace with:** OpenClaw logging (stdout/stderr + session logs)
- Structured logging → OpenClaw native logging
- **Migration:** Use standard Python logging; OpenClaw captures output

---

#### `gemini_retry.py`
**Purpose:** Retry logic for Gemini blank response handling  
**Key Classes:**
- `GeminiWithRetry`: Wrapper around `ChatGoogleGenerativeAI` with exponential backoff

**OpenClaw Mapping:**
- ✅ **Adapt:** Wrap Gemini calls in retry logic if needed
- **Migration:** OpenClaw may handle retries; otherwise implement simple retry decorator

---

### 1.2 Storage Port (`agents/src/autifyme_agents/core/ports/`)

#### `storage.py`
**Purpose:** Abstract storage interface (port) composing all mixins  
**Key Classes:**
- `StorageInterface`: Main port (CRUDMixin + ValidationMixin + AnalyticsMixin + WebhookMixin + etc.)

**Mixins:**
- `CRUDMixin`: query_entities, insert_entity, update_entities, delete_entities
- `ValidationMixin`: validate_entity_data, check_constraint_violations
- `AnalyticsMixin`: get_company_profile, workflow outcomes, schema stats
- `WebhookMixin`: check_and_mark_message_processed (idempotency)
- `PendingMessageMixin`: queue_pending_message, fetch_and_clear_batch
- `LifecycleMixin`: transaction, cleanup
- `FileStorageMixin`: upload_asset, delete_asset, get_asset_public_url

**OpenClaw Mapping:**
- ✅ **Replace with:** OpenClaw database skills + file management
- `StorageInterface` → OpenClaw database connection wrapper (in skill)
- CRUD operations → Direct SQL/ORM in OpenClaw skills
- File storage → OpenClaw file tool
- **Migration:** Create OpenClaw skill for Supabase access; expose high-level operations as skill functions

---

### 1.3 Specialists (`agents/src/autifyme_agents/specialists/`)

#### `catalog_specialist.py`
**Purpose:** Domain expert for product catalog operations (PIM, DAM, pricing, BOM)  
**Key Functions:**
- `create_catalog_specialist()`: Returns SubAgent spec dict

**Tools:**
- `load_protocol`, `inspect_schema`, `read_data`, `aggregate_data`, `write_data`, `view_image`

**Tables:** 
- CRUD: `product_families`, `products`, `variant_axes`, `variant_values`, `assets`, `product_assets`, `price_lists`, `product_prices`, `bom`, etc.
- Read-only: `uom`, `industries`, `companies`

**Prompt:** `prompts/specialists/catalog_specialist.prompt`

**Protocols:** `business_context`, `family_fit`, `duplicate_prevention`, `pricing`, `variant_management`, etc.

**OpenClaw Mapping:**
- ✅ **Migrate to:** OpenClaw subagent skill
- SubAgent spec → OpenClaw `subagent_spawn` with skill
- Tools → OpenClaw tool functions (database, image)
- Prompt → Skill SKILL.md system prompt
- Protocols → Skill knowledge base or sub-skills
- **Migration:** Create `skills/catalog_specialist/SKILL.md` with full prompt + protocol intelligence

---

#### `creative_specialist.py`
**Purpose:** Professional product photographer and image editor  
**Key Functions:**
- `create_creative_specialist()`: Returns SubAgent spec dict

**Tools:**
- `load_protocol`, `view_image`, `image_studio`, `inspect_schema`, `read_data`, `write_data`

**Prompt:** `prompts/specialists/creative_specialist.prompt`

**Protocols:** `catalog_visual`, `lifestyle_visual`, `social_content`, `multi_item`, `data` (asset creation)

**Business Logic:**
- 12-spec creative palette (background removal, hero shot, lifestyle scene, etc.)
- Quality scoring rubric (composition, lighting, material, edges - all 8+ to ship)
- Material-aware treatments (glass transparency, metal reflection, fabric texture)
- Anchor-first pattern for multi-item extraction

**OpenClaw Mapping:**
- ✅ **Migrate to:** OpenClaw subagent skill
- `image_studio` → OpenClaw image tool (if available) or external API call
- Prompt → `skills/creative_specialist/SKILL.md`
- Protocols → Skill knowledge base
- **Migration:** Port image generation logic to OpenClaw skill; may need external Gemini API integration for image generation

---

### 1.4 Analysts (`agents/src/autifyme_agents/analysts/`)

#### `visual_analyst.py`
**Purpose:** Image observation and analysis (read-only)  
**Key Functions:**
- `create_visual_analyst()`: Returns SubAgent spec dict

**Tools:**
- `load_protocol`, `view_image`

**Prompt:** `prompts/analysts/visual_analyst.prompt`

**Protocols:** `visual_analysis` (domain-specific: catalog, quality, etc.)

**Business Logic:**
- Multi-image relationship detection (angles, variants, different products)
- Material identification (glass, metal, plastic, fabric)
- Quality assessment (focus, lighting, composition)
- Pure observation (no recommendations)

**OpenClaw Mapping:**
- ✅ **Migrate to:** OpenClaw subagent skill
- `view_image` → OpenClaw image tool
- Prompt → `skills/visual_analyst/SKILL.md`
- Output to workspace → OpenClaw workspace file write
- **Migration:** Simple port - uses only view_image + domain knowledge

---

#### `product_analyst.py`
**Purpose:** External product knowledge research (read-only)  
**Key Functions:**
- `create_product_analyst()`: Returns SubAgent spec dict

**Tools:**
- `load_protocol`, `research_product_tool`, `extract_web_content_tool`, `view_image`

**Prompt:** `prompts/analysts/product_analyst.prompt`

**Protocols:** `research_orchestration`, `market_intelligence`, `compliance_research`

**Business Logic:**
- Product naming conventions, HSN codes, specifications
- Market positioning, competitor analysis, pricing benchmarks
- Standards compliance, certifications
- Unlimited external research

**OpenClaw Mapping:**
- ✅ **Migrate to:** OpenClaw subagent skill
- `research_product_tool` → OpenClaw web_search
- `extract_web_content_tool` → OpenClaw web_fetch
- Prompt → `skills/product_analyst/SKILL.md`
- **Migration:** Direct port - OpenClaw has native web research tools

---

#### `catalog_analyst.py`
**Purpose:** Internal catalog data research (read-only)  
**Key Functions:**
- `create_catalog_analyst()`: Returns SubAgent spec dict

**Tools:**
- `load_protocol`, `inspect_schema`, `read_data`, `aggregate_data`, `view_image`

**Prompt:** `prompts/analysts/catalog_analyst.prompt`

**Protocols:** `business_context`, `family_fit`, tool mastery protocols

**Business Logic:**
- Family fit analysis (customer_segments matching)
- Duplicate detection (SKU, name, attributes)
- Pricing patterns, variant structures
- Catalog verification

**OpenClaw Mapping:**
- ✅ **Migrate to:** OpenClaw subagent skill
- Database tools → OpenClaw database skill functions
- Prompt → `skills/catalog_analyst/SKILL.md`
- **Migration:** Port with database access skill dependency

---

### 1.5 Workflows (`agents/src/autifyme_agents/workflows/`)

#### `project_manager.py`
**Purpose:** Central orchestrator for multi-domain workflows  
**Key Functions:**
- `create_project_manager()`: Returns DeepAgent instance

**Tools:**
- `load_protocol`, `view_image`, platform media download tools

**Subagents:**
- Analysts: visual_analyst, product_analyst, catalog_analyst
- Specialists: creative_specialist, catalog_specialist

**Prompt:** `prompts/project_manager.prompt`

**Protocols:** `discovery_mindset`, `synthesis`, `execution_flows`, `multi_image`, `data_driven`, `error_recovery`, `hitl`, `conflict_resolution`

**Business Logic:**
- Dynamic intelligent orchestration (NOT fixed workflows)
- Protocol-driven routing decisions
- Multi-domain coordination
- HITL approval management
- Context synthesis across subagents

**OpenClaw Mapping:**
- ✅ **Migrate to:** OpenClaw main agent
- DeepAgent → OpenClaw agent with subagent spawning
- Subagents → OpenClaw subagent spawn calls
- Tools → OpenClaw native tools (image, web, message)
- Prompt → Main agent system prompt or AGENTS.md + SOUL.md
- Protocols → Skills or agent knowledge
- **Migration:** This becomes the main OpenClaw agent orchestrating subagent skills

---

#### `orchestration/runner.py`
**Purpose:** Workflow execution coordinator (blind executor)  
**Key Classes:**
- `WorkflowRunner`: Message routing, approval flow, outcome tracking

**Dependencies:**
- Channel adapter (WhatsApp)
- Storage interface
- Workflow handler
- Approval coordinator
- Outcome tracker

**Business Logic:**
- Message handling (single + batch)
- Execution context management
- Interrupt unpacking
- Approval coordination
- Error recovery

**OpenClaw Mapping:**
- ✅ **Replace with:** OpenClaw message handling + agent invocation
- `handle_message()` → OpenClaw message tool handler
- Workflow state → OpenClaw session persistence
- HITL approval → OpenClaw user confirmation patterns
- **Migration:** Most logic absorbed by OpenClaw platform; some workflow coordination in main agent

---

#### `approval_analyzer.py`
**Purpose:** HITL feedback interpretation (structured responses)  
**Key Functions:**
- `create_approval_analyzer()`: Returns LangGraph agent for feedback parsing

**Prompt:** `prompts/approval_analyzer.prompt`

**Business Logic:**
- Parse approval/rejection/cancel signals
- Extract feedback context
- Route to appropriate specialist
- Handle partial approvals

**OpenClaw Mapping:**
- ✅ **Simplify:** OpenClaw user confirmation handling
- Approval parsing → Simple string matching in main agent
- **Migration:** Basic approval/rejection/cancel parsing in main agent; no separate analyzer needed

---

### 1.6 Tools (`agents/src/autifyme_agents/tools/`)

#### `data_engine/read_data.py`
**Purpose:** Unified read_data tool for queries, pagination, joins  
**Key Functions:**
- `create_read_data_tool()`: Returns StructuredTool

**Features:**
- Exact filters vs fuzzy search patterns
- Column selection, relations (PostgREST syntax)
- Batch read by IDs
- Pagination, counting

**OpenClaw Mapping:**
- ✅ **Replace with:** OpenClaw database skill function
- PostgREST queries → Direct SQL or ORM queries
- **Migration:** Implement database query helper in OpenClaw skill; expose to agents

---

#### `data_engine/write_data.py`
**Purpose:** Unified write_data tool for multi-operation atomic transactions  
**Key Functions:**
- `create_write_data_tool()`: Returns StructuredTool

**Features:**
- WriteIntent schema (goal, reasoning, operations, impact)
- Multi-table atomic transactions
- Dependency resolution (topological sort)
- Reference resolution (@name.field syntax)
- Dry-run and validate modes
- Asset upload integration

**Business Logic:**
- HITL approval required
- Validates schema before execution
- Tracks operation dependencies
- Rolls back on failure

**OpenClaw Mapping:**
- ✅ **Replace with:** OpenClaw database skill with HITL confirmation
- WriteIntent → Skill function parameter or agent planning
- Multi-op transactions → SQL transactions or ORM operations
- HITL → OpenClaw user confirmation
- **Migration:** Implement write operation functions in database skill; HITL via OpenClaw confirmation patterns

---

#### `data_engine/inspect_schema.py`
**Purpose:** Schema discovery tool for agents  
**Key Functions:**
- `create_inspect_schema_tool()`: Returns StructuredTool

**Features:**
- List tables, columns, types, constraints
- Foreign key relationships
- Enum values discovery

**OpenClaw Mapping:**
- ✅ **Replace with:** OpenClaw database skill function
- Schema queries → SQL information_schema queries
- **Migration:** Simple port to database skill

---

#### `data_engine/aggregate_data.py`
**Purpose:** Analytics and aggregation tool  
**Key Functions:**
- `create_aggregate_data_tool()`: Returns StructuredTool

**Features:**
- GROUP BY aggregations
- COUNT, SUM, AVG, MIN, MAX
- Dynamic column aggregation

**OpenClaw Mapping:**
- ✅ **Replace with:** OpenClaw database skill function
- Aggregations → SQL GROUP BY queries
- **Migration:** Port to database skill

---

#### `image_studio/tool.py`
**Purpose:** Professional image processing (Gemini 3 Pro Image)  
**Key Functions:**
- `create_image_studio_tool()`: Returns StructuredTool

**Features:**
- 12-spec creative palette
  1. Background removal (preserve/replace)
  2. Hero shot (studio quality, centered product)
  3. Lifestyle scene (product in context)
  4. Multi-product composite
  5. Extract from multi-item image
  6. Color correction
  7. Lighting enhancement
  8. Material-specific treatment
  9. Shadow/reflection generation
  10. Text overlay
  11. Brand integration
  12. Batch processing

**Business Logic:**
- Material-aware processing (glass transparency, metal reflection)
- Quality validation before/after
- Uploads to storage (pending/ then products/)
- Returns storage_path for linking

**OpenClaw Mapping:**
- ⚠️ **CUSTOM INTEGRATION NEEDED:** OpenClaw image tool + external Gemini API
- Image generation → Gemini 3 Pro Image API calls (not native OpenClaw)
- Storage → OpenClaw workspace file management
- **Migration:** Build custom integration skill for Gemini image generation; wrap in OpenClaw tool function

---

#### `view_image.py`
**Purpose:** Image viewing tool for agents  
**Key Functions:**
- `create_view_image_tool()`: Returns StructuredTool

**Features:**
- Load image from storage_path or URL
- Return base64 for multimodal LLM
- Metadata extraction (size, format, source)

**OpenClaw Mapping:**
- ✅ **Replace with:** OpenClaw image tool
- Image loading → OpenClaw native multimodal support
- **Migration:** Direct use of OpenClaw image tool

---

#### `research_tools.py`
**Purpose:** Web research tools (Tavily integration)  
**Key Functions:**
- `research_product_tool`: Product-specific web search
- `extract_web_content_tool`: URL content extraction

**OpenClaw Mapping:**
- ✅ **Replace with:** OpenClaw web_search + web_fetch
- Tavily API → OpenClaw Brave Search API
- Content extraction → OpenClaw web_fetch
- **Migration:** Direct use of OpenClaw web tools

---

#### `protocol_loader.py`
**Purpose:** Load domain protocol files at runtime  
**Key Functions:**
- `create_load_protocol_tool()`: Returns StructuredTool

**Features:**
- Domain-specific protocol resolution
- Auto-detection for shared vs domain protocols
- Batch loading support

**Business Logic:**
- Protocols ground agent reasoning in validated patterns
- Domain experts require protocols for decisions
- PM uses protocols for orchestration patterns

**OpenClaw Mapping:**
- ✅ **CRITICAL - Replace with:** OpenClaw skills knowledge base
- Protocol files → Skill markdown files or sub-skills
- `load_protocol` → Skill includes relevant knowledge automatically
- **Migration Priority:** HIGH - Extract all protocol intelligence into skill documentation

---

### 1.7 Prompts (`agents/src/autifyme_agents/prompts/`)

**This is the DOMAIN INTELLIGENCE core. Must be preserved in OpenClaw skills.**

#### `project_manager.prompt`
**Content:** PM orchestration doctrine (560 lines)
**Sections:**
- Identity: Senior partner, think and route
- Protocol system: Mandatory protocol loading rules
- Tools: load_protocol, download_media, view_image, read_file
- Subagents: Analyst and specialist descriptions
- Delegation doctrine: WHO to call, WHEN needed, dependencies
- Multi-domain coordination patterns
- HITL handling
- Synthesis gate (approval presentation)
- Error recovery

**OpenClaw Migration:**
- → Main agent AGENTS.md + SOUL.md
- Protocol loading → Skill access patterns
- Delegation patterns → Subagent spawn examples

---

#### `specialists/catalog_specialist.prompt`
**Content:** Catalog domain expertise (200+ lines)
**Sections:**
- Identity: Catalog architect, protocol-driven, HITL-gated
- Company context (templated): SKU naming, pricing, markets
- Protocol system: Mandatory protocol loading (business_context, family_fit, pricing, etc.)
- Verify analyst work: Run protocols yourself
- Tools: load_protocol, inspect_schema, read_data, write_data
- Workflow: ASSESS → LOAD → READ → EXECUTE → DISCOVER SCHEMA → BUILD → SUBMIT
- HITL loop: Approval/rejection handling
- Output: WriteIntent structure

**OpenClaw Migration:**
- → `skills/catalog_specialist/SKILL.md`
- Protocol references → Embedded knowledge or linked sub-skills
- Company context → OpenClaw USER.md or company profile in memory

---

#### `specialists/creative_specialist.prompt`
**Content:** Visual artist expertise (320+ lines)
**Sections:**
- Identity: World-class visual artist, protocol-driven
- Brand context (templated): Colors, typography, logo
- Operating mode: VALIDATE → LOAD PROTOCOL → ASSESS → EXECUTE → CRITIQUE → SHIP
- Validation: Source viability checks
- Protocol loading: Parallel batch loading
- Assessment: view_image, read analyst files, form vision
- Execution: Apply 12-spec palette via image_studio
- Critique: Quality scoring rubric (composition, lighting, material, edges)
- HITL discipline
- Anchor-first pattern for multi-item
- Tools: load_protocol, view_image, image_studio, data tools

**OpenClaw Migration:**
- → `skills/creative_specialist/SKILL.md`
- 12-spec palette → Skill knowledge
- Quality rubric → Skill evaluation criteria
- Protocols → Embedded or linked

---

#### `analysts/visual_analyst.prompt`
**Content:** Image observation expertise (200+ lines)
**Sections:**
- Identity: First eyes on images, cross-domain observer
- Protocol system: Domain-specific visual_analysis protocols
- Tools: load_protocol, view_image, write_file
- Workflow: LOAD → VIEW (parallel for multiple) → ANALYZE → WRITE
- Multi-image relationship detection (angles, variants, different)
- Multi-item detection within single image
- Material identification
- Output: visual_analysis_[image].md

**OpenClaw Migration:**
- → `skills/visual_analyst/SKILL.md`
- Relationship patterns → Skill knowledge
- Material database → Skill reference data

---

#### `analysts/product_analyst.prompt`
**Content:** External research expertise (150+ lines)
**Sections:**
- Identity: Product detective, unlimited research
- Protocol system: research_orchestration, market_intelligence, compliance_research
- Tools: load_protocol, research_product_tool, extract_web_content_tool, view_image
- Workflow: LOAD → RESEARCH → WRITE
- Research patterns (naming, specs, compliance, pricing)
- Output: product_research_[item].md

**OpenClaw Migration:**
- → `skills/product_analyst/SKILL.md`
- Research patterns → Skill methodology
- Domain knowledge → Skill reference

---

#### `analysts/catalog_analyst.prompt`
**Content:** Internal catalog intelligence (200+ lines)
**Sections:**
- Identity: Catalog expert, unlimited exploration
- Protocol system: business_context, family_fit, tool mastery
- Tools: load_protocol, inspect_schema, read_data, aggregate_data, view_image
- Workflow: LOAD → QUERY → ANALYZE → WRITE
- Analysis patterns (family fit, duplicates, pricing)
- Output: catalog_analysis_[item].md

**OpenClaw Migration:**
- → `skills/catalog_analyst/SKILL.md`
- Query patterns → Skill database knowledge
- Analysis heuristics → Skill logic

---

#### `protocols/` (Critical Domain Intelligence)

**Directory Structure:**
```
prompts/protocols/
├── catalog/          # Catalog domain protocols
├── creative/         # Creative domain protocols
├── pm/              # PM coordination protocols
├── product/         # Product research protocols
├── visual/          # Visual analysis protocols
└── shared/          # Cross-domain protocols
    └── tool_mastery/ # Tool-specific protocols
```

**Key Protocol Files:**

**Catalog Domain:**
- `business_context.protocol`: Company patterns, pricing philosophy, quality standards
- `family_fit.protocol`: Customer segments matching, family selection criteria
- `duplicate_prevention.protocol`: SKU/name/attribute deduplication steps
- `pricing.protocol`: Competitive positioning, margin targets, pricing tiers
- `variant_management.protocol`: Axis selection, variant generation patterns
- `new_family.protocol`: Family creation criteria, taxonomy placement
- `attribute_extraction.protocol`: Product attribute identification

**Creative Domain:**
- `data.protocol`: Asset record creation workflow
- `hitl.protocol`: Feedback parsing, iteration patterns
- `multi_item.protocol`: Anchor-first extraction pattern

**PM Domain:**
- `discovery_mindset.protocol`: Intent detection, media acquisition
- `synthesis.protocol`: Multi-domain synthesis, conflict detection
- `execution_flows.protocol`: Catalog flows A-E, ID tracking, delegation templates
- `multi_image.protocol`: Components/variants/bulk workflows
- `data_driven.protocol`: Data fetch patterns, creative delegation
- `error_recovery.protocol`: Partial success, cancellation, quality rejection
- `hitl.protocol`: HITL signal parsing, escalation
- `conflict_resolution.protocol`: Domain authority matrix

**Visual Domain:**
- `catalog_visual.protocol`: E-commerce focus areas (materials, labels, condition)
- `lifestyle_visual.protocol`: Scene composition, brand integration
- `social_content.protocol`: Social media optimization

**Shared/Tool Mastery:**
- `read_data.protocol`: Query patterns, filter vs search, relation syntax
- `write_data.protocol`: WriteIntent structure, operation dependencies
- `schema_discovery.protocol`: Schema inspection patterns
- `aggregate_data.protocol`: Analytics patterns
- `view_image.protocol`: Image viewing patterns
- `image_studio.protocol`: 12-spec creative palette usage
- `resource_efficiency.protocol`: Token budgeting, batch patterns, STOP conditions
- `input_validation.protocol`: Input verification before execution

**OpenClaw Migration:**
- ✅ **HIGHEST PRIORITY:** Extract ALL protocol knowledge
- Protocols → Skill knowledge sections or sub-skills
- Domain expertise preserved in skill markdown
- Tool patterns → Skill tool usage examples
- **Migration:** Create comprehensive skill knowledge base from protocols

---

### 1.8 Schemas (`agents/src/autifyme_agents/schemas/`)

#### `models.py`
**Purpose:** Domain model definitions  
**Key Classes:**
- `CompanyProfile`: Company context (name, currency, SKU conventions, visual identity)
- `Product`: Product entity
- `SKUNamingConvention`: SKU generation rules
- `VisualIdentity`: Brand colors, typography, logo
- `WorkflowOutcome`: Outcome tracking for agentic learning

**OpenClaw Mapping:**
- ✅ **Migrate to:** OpenClaw memory structures or skill data models
- `CompanyProfile` → USER.md or MEMORY.md
- Domain models → Skill-specific data structures
- **Migration:** Store company profile in OpenClaw memory; define data models as needed in skills

---

#### `write_intent.py`
**Purpose:** WriteIntent schema for multi-operation writes  
**Key Classes:**
- `WriteIntent`: goal, reasoning, hitl_summary, operations, impact, asset_uploads
- `Operation`: action, table, data, filters, dependencies, returns
- `AssetUpload`: source_path, target_zone, filename

**OpenClaw Mapping:**
- ✅ **Migrate to:** Skill function parameters or agent planning
- WriteIntent → Structured parameters for database skill functions
- Operations → Transaction steps
- **Migration:** Define similar structure for write operations in database skill

---

#### `context.py` / `context_models.py`
**Purpose:** Runtime context for agents  
**Key Classes:**
- `CompanyContext`: Base context loaded at PM startup
- `CatalogSummary`: Catalog statistics
- `TaxonomyTree`: Category hierarchy
- `CompanyPatterns`: Cold-start handling patterns

**OpenClaw Mapping:**
- ✅ **Migrate to:** OpenClaw agent memory or context loading
- Base context → MEMORY.md or session context
- **Migration:** Load company context in main agent startup; store in memory

---

#### `pm_output.py`
**Purpose:** PM structured output schema  
**Key Classes:**
- `PMOutput`: Multimodal response (text + image paths)

**OpenClaw Mapping:**
- ✅ **Not needed:** OpenClaw handles multimodal responses natively
- **Migration:** Return text + image references naturally

---

### 1.9 Integrations (`agents/src/autifyme_agents/integrations/`)

#### `storage/supabase_client.py`
**Purpose:** Supabase adapter implementing StorageInterface  
**Key Classes:**
- `SupabaseStorageClient`: Full CRUD, validation, analytics, webhooks, file storage

**Methods (Sample):**
- CRUD: `query_entities()`, `insert_entity()`, `update_entities()`, `delete_entities()`
- Advanced: `query_advanced()` (PostgREST), `execute_write_intent()` (multi-op)
- Files: `upload_asset()`, `delete_asset()`, `get_asset_public_url()`
- Analytics: `get_company_profile()`, `track_workflow_outcome()`
- Webhooks: `check_and_mark_message_processed()` (idempotency)
- Batching: `queue_pending_message()`, `fetch_and_clear_batch()`

**OpenClaw Mapping:**
- ✅ **Replace with:** OpenClaw database skill
- SupabaseStorageClient → Database connection wrapper in skill
- CRUD methods → Skill functions using Supabase client or direct SQL
- File storage → OpenClaw file tool + optional Supabase Storage API
- **Migration:** Create comprehensive database skill; expose high-level operations to agents

---

#### `communication/whatsapp_client.py`
**Purpose:** WhatsApp Business Cloud API client  
**Key Methods:**
- `send_typing_indicator()`: Mark message as read + show typing
- `send_text()`: Send text message
- `send_image()`: Send image with caption

**OpenClaw Mapping:**
- ✅ **Replace with:** OpenClaw message tool (WhatsApp channel)
- WhatsApp API → OpenClaw native WhatsApp support
- **Migration:** Use OpenClaw message tool; no custom client needed

---

#### `communication/whatsapp_media_client.py`
**Purpose:** WhatsApp media download/upload  
**Key Methods:**
- `download_media()`: Download from WhatsApp servers → local file
- `upload_media()`: Upload to WhatsApp servers → media_id

**OpenClaw Mapping:**
- ✅ **Replace with:** OpenClaw message tool media handling
- Media download → OpenClaw automatic media download
- **Migration:** OpenClaw handles media automatically; may need upload helper if sending images

---

### 1.10 Middleware (`agents/src/autifyme_agents/middleware/`)

#### `execution_limits.py`
**Purpose:** Token/tool call budget enforcement  
**Key Classes:**
- `ExecutionLimitError`: Custom exception for limit exceeded
- `create_execution_limits()`: Returns middleware list

**Features:**
- Token limit tracking
- Tool call counting
- Graceful degradation (return partial results)

**OpenClaw Mapping:**
- ✅ **Adapt:** OpenClaw budget management (if available) or implement in skills
- **Migration:** May not be needed; OpenClaw has budget controls

---

#### `context_management.py`
**Purpose:** Aggressive context truncation to prevent token overflow  
**Key Classes:**
- `HybridTruncateThenClearEdit`: Truncate tool results, preserve subagent calls

**OpenClaw Mapping:**
- ✅ **Not needed:** OpenClaw handles context automatically
- **Migration:** Remove - OpenClaw manages context

---

#### `multimodal_injection.py`
**Purpose:** Inject images from storage paths into agent context  
**Key Classes:**
- `MultimodalInjectionMiddleware`: Load images when paths in delegation message

**OpenClaw Mapping:**
- ✅ **Not needed:** OpenClaw handles multimodal context natively
- **Migration:** Remove - OpenClaw loads images automatically

---

### 1.11 Entrypoints (`agents/src/autifyme_agents/entrypoints/`)

#### `whatsapp_webhook.py`
**Purpose:** FastAPI webhook for WhatsApp Business Cloud  
**Key Endpoints:**
- `POST /webhook`: Receive WhatsApp messages
- `GET /webhook`: Webhook verification

**Features:**
- Message batching (Smart Skip)
- Background task processing
- Idempotency (duplicate detection)
- Orphaned batch recovery

**OpenClaw Mapping:**
- ✅ **Replace with:** OpenClaw message channel configuration
- FastAPI webhook → OpenClaw gateway handles webhooks
- Message processing → OpenClaw agent invocation
- **Migration:** Configure OpenClaw WhatsApp channel; no custom webhook needed

---

### 1.12 Extensions (`extensions/`)

#### `browser_automation_specialist/`
**Purpose:** Experimental browser automation via Playwright  
**Status:** Not integrated into main workflow

**OpenClaw Mapping:**
- ✅ **Replace with:** OpenClaw browser tool
- **Migration:** Use OpenClaw native browser automation

---

#### `google_computer_use/`
**Purpose:** Experimental Gemini Computer Use integration  
**Status:** Not integrated into main workflow

**OpenClaw Mapping:**
- ⚠️ **Optional:** OpenClaw may not support Computer Use natively
- **Migration:** Low priority - not core to AutifyME

---

### 1.13 Database (`database/`)

#### `migrations/`
**Purpose:** SQL migrations for schema evolution  
**Files:**
- `001_workflow_outcomes.sql`: Outcome tracking table
- `002_processed_messages.sql`: Idempotency table
- `003_add_trace_id.sql`: Trace ID for correlation
- `004_storage_policies.sql`: RLS policies
- `005_assets_caption.sql`: Caption column
- `006_dynamic_aggregate_rpc.sql`: Dynamic aggregation function
- `007_fix_array_type_handling.sql`: Array type fixes

**OpenClaw Mapping:**
- ✅ **Port to:** OpenClaw database schema (Supabase or other)
- Migrations → Initialize database schema in OpenClaw environment
- **Migration:** Run migrations on OpenClaw-managed database

---

### 1.14 Documentation (`docs/architecture/`)

**Key Documents:**

#### `ARCHITECTURAL_VISION.md`
**Purpose:** North star for multi-domain autonomous system  
**Sections:**
- Multi-domain operating system vision
- PM as dynamic intelligent orchestrator
- Analyst role (context enrichment, cost optimization)
- Subagent role (explorative domain expert)
- Communication protocol (filesystem-based)
- Architectural decisions

**OpenClaw Migration:**
- → Design philosophy for OpenClaw implementation
- Agent patterns → OpenClaw agent + subagent structure
- File protocol → OpenClaw workspace files

---

#### `UNIVERSAL_DATA_ENGINE_DESIGN.md`
**Purpose:** Unified data tool design  
**Sections:**
- read_data, write_data, inspect_schema, aggregate_data
- WriteIntent schema
- Multi-operation transactions
- Dependency resolution

**OpenClaw Migration:**
- → Database skill design document
- WriteIntent → Skill function structure

---

#### `LAYER1_TOOL_CATALOG.md`
**Purpose:** Tool specifications and usage patterns  
**Sections:**
- Data engine tools
- Image studio specs
- Research tools
- Platform tools

**OpenClaw Migration:**
- → Skill tool documentation
- Tool specs → Skill function signatures

---

#### `IMAGE_STUDIO_TOOL.md`
**Purpose:** 12-spec creative palette documentation  
**Sections:**
- Each spec's purpose, parameters, quality criteria
- Material-specific treatments
- Quality validation

**OpenClaw Migration:**
- → Creative specialist skill knowledge

---

#### `PROMPT_ENGINEERING_STANDARDS.md`
**Purpose:** Prompt design principles  
**Sections:**
- Protocol-driven design
- Multi-turn conversation patterns
- Error handling
- HITL patterns

**OpenClaw Migration:**
- → Skill design guidelines
- Prompt patterns → Skill interaction patterns

---

## 2. DEPENDENCY GRAPH

### 2.1 Core Infrastructure Dependencies

```
config.py (settings)
    ↓
├─ llm_factory.py → gemini_retry.py
├─ logging_config.py
├─ execution_context.py → storage_utils.py
├─ prompt_loader.py (reads prompts/)
├─ message_batcher.py → storage port
├─ tool_error_handler.py
└─ exceptions.py
```

### 2.2 Storage Port Dependencies

```
ports/storage.py (abstract interface)
    ↓
integrations/storage/supabase_client.py (implementation)
    ↓
├─ config.py (credentials)
├─ exceptions.py (error handling)
├─ storage_utils.py (URL building)
└─ schemas/models.py (data models)
```

### 2.3 Agent Creation Dependencies

```
project_manager.py
    ↓
├─ llm_factory.py (get_llm)
├─ prompt_loader.py (load PM prompt)
├─ storage port (get company profile)
├─ specialists/ (create specialists)
│   ├─ catalog_specialist.py
│   │   ↓
│   │   ├─ prompts/specialists/catalog_specialist.prompt
│   │   ├─ tools/data_engine/* (CRUD tools)
│   │   ├─ tools/view_image.py
│   │   └─ tools/protocol_loader.py
│   └─ creative_specialist.py
│       ↓
│       ├─ prompts/specialists/creative_specialist.prompt
│       ├─ tools/image_studio/*
│       ├─ tools/view_image.py
│       └─ tools/protocol_loader.py
└─ analysts/ (create analysts)
    ├─ visual_analyst.py
    │   ↓
    │   ├─ prompts/analysts/visual_analyst.prompt
    │   └─ tools/view_image.py
    ├─ product_analyst.py
    │   ↓
    │   ├─ prompts/analysts/product_analyst.prompt
    │   └─ tools/research_tools.py
    └─ catalog_analyst.py
        ↓
        ├─ prompts/analysts/catalog_analyst.prompt
        └─ tools/data_engine/* (read-only)
```

### 2.4 Tool Dependencies

```
tools/
├─ data_engine/
│   ├─ read_data.py → storage port
│   ├─ write_data.py → storage port + _executor.py
│   ├─ inspect_schema.py → storage port
│   ├─ aggregate_data.py → storage port
│   └─ _executor.py → write_intent schema
├─ image_studio/
│   ├─ tool.py → llm_factory (Gemini 3 Pro Image)
│   │          → storage port (upload assets)
│   │          → schemas.py
│   └─ html_generator.py
├─ view_image.py → storage_utils (URL building)
├─ research_tools.py → config (Tavily API)
└─ protocol_loader.py → prompts/protocols/*
```

### 2.5 Workflow Dependencies

```
entrypoints/whatsapp_webhook.py
    ↓
workflows/orchestration/runner.py
    ↓
├─ workflows/project_manager.py (PM agent)
├─ workflows/channels/whatsapp/adapter.py
├─ integrations/communication/whatsapp_client.py
├─ integrations/storage/supabase_client.py
├─ workflows/handlers/write_intent_handler.py
├─ workflows/outcome_tracker.py
├─ workflows/approval_analyzer.py
└─ core/message_batcher.py
```

### 2.6 Runtime Flow

```
User Message (WhatsApp)
    ↓
[whatsapp_webhook.py] Receive webhook
    ↓
[message_batcher.py] Should debounce?
    ├─ Yes → Queue to DB, start background task
    │         ↓
    │         Wait debounce window
    │         ↓
    │         Fetch batch atomically
    │         ↓
    └─────────┘
[runner.py] Execute workflow
    ↓
[execution_context] Set thread_id
    ↓
[project_manager] PM invocation
    ↓
    ├─ load_protocol (PM protocols)
    ├─ download_media (if media_id present)
    ├─ view_image (optional - for routing)
    ├─ Delegate to analysts (read-only)
    │   ↓
    │   [visual_analyst] view_image, write visual_analysis.md
    │   [product_analyst] research, write product_research.md
    │   [catalog_analyst] read_data, write catalog_analysis.md
    │   ↓
    │   Return summaries + file paths to PM
    ├─ PM reads analysis files, synthesizes
    ├─ Delegate to specialists (execution)
    │   ↓
    │   [creative_specialist]
    │       ↓
    │       load_protocol, view_image, image_studio
    │       ↓
    │       write_data (asset record) → HITL interrupt
    │       ↓
    │       User approves → Resume, execute, return asset_id
    │   [catalog_specialist]
    │       ↓
    │       load_protocol, read_data (verify), inspect_schema
    │       ↓
    │       write_data (product) → HITL interrupt
    │       ↓
    │       User approves → Resume, execute, return product_id
    └─ PM synthesizes all outputs, returns to user
    ↓
[whatsapp_client] Send response message
```

---

## 3. BUSINESS LOGIC EXTRACTION

### 3.1 Core Domain Intelligence (Prompts + Protocols)

**Location:** `prompts/` directory (560+ lines PM, 200+ lines per specialist/analyst)

**What Must Be Preserved:**

1. **PM Orchestration Doctrine**
   - Protocol loading enforcement (FIRST action on any task)
   - Intent detection patterns (image workflow, text query, continuation, HITL feedback)
   - Dynamic routing rules (which agents, what order, dependencies)
   - Multi-domain coordination (catalog + creative, sequential vs parallel)
   - Synthesis patterns (conflict detection, presentation structure)
   - HITL signal parsing (approval, rejection, cancellation)
   - Error recovery flows (partial success, quality rejection)

2. **Catalog Specialist Domain Expertise**
   - SKU naming conventions (prefix, separator, uppercase, examples)
   - Family fit criteria (customer_segments matching, business model alignment)
   - Duplicate prevention (SKU/name/attribute deduplication steps)
   - Pricing philosophy (competitive positioning, margin targets, tiering)
   - Variant axis selection (material, size, color - which dimensions matter)
   - Schema-driven CRUD (inspect before write, validate constraints)
   - HITL loop handling (approval → execute, rejection → revise)

3. **Creative Specialist Domain Expertise**
   - 12-spec creative palette (background removal, hero shot, lifestyle, etc.)
   - Material-aware treatments:
     - Glass: Transparency preservation, edge refinement, light refraction
     - Metal: Reflection enhancement, surface detail, chrome/brushed finish
     - Plastic: Color accuracy, label sharpness, matte vs glossy
     - Fabric: Texture detail, fold rendering, drape simulation
   - Quality scoring rubric (composition, lighting, material, edges - all 8+ to ship)
   - Professional standards (pure white backgrounds, studio lighting, 70-85% product coverage)
   - Anchor-first pattern for multi-item extraction
   - Validation gates (source viability, post-processing verification)

4. **Visual Analyst Domain Expertise**
   - Multi-image relationship detection (angles, variants, components, different products)
   - Multi-item detection within single image (count, arrangement, extraction targets)
   - Material identification (glass, metal, plastic, fabric, composite)
   - Quality assessment (focus, lighting, composition, condition)
   - Domain-specific focus areas (catalog: materials + labels, quality: defects, marketing: appeal)

5. **Product Analyst Domain Expertise**
   - Product naming conventions (how customers search, SEO terminology)
   - HSN code research (India tax classification)
   - Specification discovery (dimensions, materials, certifications)
   - Market positioning (premium, mid-range, budget)
   - Competitor analysis (pricing benchmarks, feature comparisons)
   - Standards compliance (BIS, ISO, FDA, etc.)

6. **Catalog Analyst Domain Expertise**
   - Family fit analysis (customer_segments query patterns, business model matching)
   - Duplicate detection heuristics (SKU prefix, name similarity, attribute overlap)
   - Pricing pattern recognition (family pricing tiers, margin consistency)
   - Variant structure validation (axis count, value distribution)
   - Catalog verification (SKU existence, product-asset links)

### 3.2 Protocol Intelligence (100+ protocol files)

**Location:** `prompts/protocols/` (catalog/, creative/, pm/, product/, visual/, shared/)

**Critical Protocols:**

1. **Catalog Domain Protocols**
   - `business_context.protocol`: Company patterns, pricing philosophy, quality standards
     - Typical price ranges by product type
     - Margin targets (40% for retail, 25% for wholesale)
     - Quality thresholds (all products must meet X criteria)
     - SKU architecture (prefix = family, middle = size, suffix = variant)
   
   - `family_fit.protocol`: Family selection algorithm
     - Step 1: Query customer_segments by business model
     - Step 2: Match product type to segment product_types array
     - Step 3: Verify business_models alignment
     - Step 4: If multiple matches, prefer higher priority segment
     - Step 5: If no matches, escalate for new family creation
   
   - `duplicate_prevention.protocol`: Deduplication steps
     - Step 1: Exact SKU match → Reject (duplicate SKU)
     - Step 2: Fuzzy name match (>80% similarity) → Require user confirmation
     - Step 3: Same family + same attributes → Likely variant, not duplicate
     - Step 4: Different family + similar attributes → Cross-family duplicate check
   
   - `pricing.protocol`: Pricing decision tree
     - Input: Product type, target market, competitive position
     - Step 1: Query existing products in family for pricing range
     - Step 2: Apply positioning modifier (premium +20%, budget -20%)
     - Step 3: Check margin against company target (40% retail, 25% wholesale)
     - Step 4: Round to psychologically friendly numbers (Rs 99, Rs 149, Rs 499)
   
   - `variant_management.protocol`: Variant axis patterns
     - Material axis: When product comes in different materials (glass, plastic, metal)
     - Size axis: When product has standard sizes (250ml, 500ml, 1L)
     - Color axis: When product has color variants (red, blue, green)
     - Capacity axis: For containers (volume-based differentiation)
     - Packaging axis: When sold in different pack sizes (single, 6-pack, 12-pack)

2. **Creative Domain Protocols**
   - `catalog_visual.protocol`: E-commerce visual standards
     - Background: Pure white (#FFFFFF), no gradients
     - Product coverage: 70-85% of frame, centered
     - Lighting: Studio quality (soft shadows, even illumination)
     - Material rendering: Preserve transparency (glass), reflections (metal), texture (fabric)
     - Label legibility: Text must be sharp and readable
     - Quality gates: Composition (8+), Lighting (8+), Material (8+), Edges (8+)
   
   - `lifestyle_visual.protocol`: Contextual scene composition
     - Scene selection: Matches product usage (kitchen for jars, bathroom for bottles)
     - Product prominence: Hero product takes 40-60% of frame
     - Environment blur: Shallow depth of field, product in focus
     - Brand integration: Subtle (logo in corner, brand color in props)
     - Authenticity: Photorealistic rendering, believable physics
   
   - `multi_item.protocol`: Anchor-first extraction pattern
     - Step 1: User selects anchor item (first to extract)
     - Step 2: Extract anchor with full quality iteration
     - Step 3: Wait for user approval before next item
     - Step 4: Learn preferences from anchor (style, treatment)
     - Step 5: Apply consistent treatment to remaining items
     - Why: User guides quality standards, prevents batch rework

3. **PM Coordination Protocols**
   - `discovery_mindset.protocol`: Intent detection + media acquisition
     - First message patterns: Image workflow, text query, continuation
     - Media acquisition: Download ALL media_ids before delegating
     - Intent signals: "Create", "Update", "Analyze", "Find", "Compare"
     - Prerequisite validation: Check for required context before delegating
   
   - `synthesis.protocol`: Multi-domain synthesis patterns
     - Conflict detection: Analyst disagreements (visual says glass, product says plastic)
     - Resolution patterns: Escalate to user, prefer visual over external
     - Presentation structure: Key findings → Evidence → Recommendations → Action items
     - Confidence scoring: High (all analysts agree), Medium (partial agreement), Low (conflicting)
   
   - `execution_flows.protocol`: Catalog CRUD workflows
     - Flow A: Create product family + first product + variant structure
     - Flow B: Add product to existing family
     - Flow C: Add variant to existing product
     - Flow D: Update existing product (price, attributes, status)
     - Flow E: Link asset to existing product (asset_id known)
   
   - `multi_image.protocol`: Multi-image coordination
     - Components: Multiple images of ONE product → Extract, composite, hero shot
     - Variants: Multiple images of DIFFERENT sizes → Create variant set
     - Bulk: Multiple DIFFERENT products → Process sequentially
     - Angles: Same product, different views → Select best, use others as references

4. **Shared/Tool Mastery Protocols**
   - `read_data.protocol`: Query patterns
     - Exact filters: Use for IDs, booleans, enums (case-sensitive)
     - Search patterns: Use for names, descriptions (ILIKE, case-insensitive)
     - Relations syntax: `table(col1,col2)` or `parent(*,child(*))` (nested)
     - Pagination: limit=50 default, use offset for pages
     - Batch read: `ids=[...]` for multiple entity fetch
   
   - `write_data.protocol`: WriteIntent structure
     - Goal: Human-readable intent ("Create product family with 3 variants")
     - Reasoning: Protocol references ("Per family_fit, customer_segments shows...")
     - HITL summary: Plain language approval request (no technical jargon)
     - Operations: Array of operations (create, update, delete)
     - Dependencies: Topological sort (parent before children)
     - References: @name.field syntax for cross-operation refs
     - Impact: What changes (creates, updates, deletes, warnings)
   
   - `image_studio.protocol`: 12-spec usage patterns
     - Spec 1 (Background removal): When to preserve vs replace
     - Spec 2 (Hero shot): Product isolation with studio lighting
     - Spec 3 (Lifestyle scene): Scene selection heuristics
     - Spec 4 (Multi-product): Composition rules (primary + secondary)
     - Spec 5 (Extract): Multi-item to single-item isolation
     - Spec 6-12: Color correction, lighting, material, shadow, text, brand, batch

### 3.3 Data Engine Intelligence

**Location:** `tools/data_engine/`

**What Must Be Preserved:**

1. **WriteIntent Execution Logic** (`_executor.py`)
   - Multi-operation transaction management (atomic commit/rollback)
   - Dependency resolution (topological sort of operations)
   - Reference resolution (@name.field syntax parsing and substitution)
   - Asset upload integration (move from pending/ to products/)
   - Validation stages (schema check, constraint check, dry-run)
   - Error aggregation (collect all errors before failing)

2. **Query Intelligence** (`read_data.py`)
   - Exact filters vs fuzzy search patterns (when to use which)
   - PostgREST relation syntax (nested joins, column selection)
   - Batch read optimization (single query for multiple IDs)
   - Pagination patterns (limit + offset)
   - Count-only mode (analytics without data fetch)

3. **Schema Discovery** (`inspect_schema.py`)
   - Table listing, column types, constraints
   - Foreign key relationship mapping
   - Enum value discovery (for dropdown fields)
   - Required vs optional column detection

4. **Aggregation Patterns** (`aggregate_data.py`)
   - GROUP BY with multiple aggregates (COUNT, SUM, AVG, MIN, MAX)
   - Dynamic column selection (any table column can be aggregated)
   - Filter + group combination (WHERE + GROUP BY)

### 3.4 Image Studio Intelligence

**Location:** `tools/image_studio/`

**What Must Be Preserved:**

1. **12-Spec Creative Palette**
   - Each spec's purpose, parameters, quality criteria
   - Material-specific parameter tuning (glass vs metal vs plastic)
   - Quality validation thresholds (when to iterate vs ship)
   - Composition rules (product coverage, centering, rule of thirds)

2. **Quality Scoring Rubric**
   - Composition: Product coverage, centering, balance, negative space (score 1-10)
   - Lighting: Even illumination, soft shadows, no harsh spots (score 1-10)
   - Material: Transparency, reflection, texture accuracy (score 1-10)
   - Edges: Clean cutout, no artifacts, smooth transitions (score 1-10)
   - Threshold: All 4 dimensions must score 8+ to ship
   - Iteration: Fix weakest dimension first, re-score

3. **Material Treatment Database**
   - Glass: Preserve transparency, enhance edges, add light refraction, subtle reflection
   - Metal: Enhance reflection (chrome: mirror-like, brushed: diffuse), preserve surface detail
   - Plastic: Color accuracy, label sharpness, matte (no reflection) vs glossy (soft reflection)
   - Fabric: Texture detail, fold rendering, drape simulation, fiber visibility
   - Ceramic: Matte finish, surface imperfections, glaze reflection
   - Wood: Grain detail, natural color variation, texture depth

### 3.5 Company Context Intelligence

**Location:** `schemas/models.py`, loaded at PM startup

**What Must Be Preserved:**

1. **CompanyProfile Fields**
   - Name, industry, brand voice, target audience
   - Currency (symbol, default currency)
   - Price positioning (premium, mid-range, budget)
   - Business models (B2B, B2C, D2C, Wholesale, Retail)
   - Target markets (India, UAE, US, etc.)
   - SKU naming convention (prefix, separator, uppercase, examples)
   - Default price list ID
   - Visual identity (primary color, secondary color, accent color, font family, logo path)

2. **CatalogSummary Fields** (loaded at startup)
   - Total product families, total SKUs
   - Family names (list for quick reference)
   - Top categories (most used)

3. **TaxonomyTree Fields** (loaded at startup)
   - Total categories, root categories
   - Used for product classification and family placement

4. **CompanyPatterns Fields** (cold-start handling)
   - Primary workflow (cataloging, marketing, quality)
   - Typical price range (min, max)
   - Common product types (list)
   - Naming conventions (SKU pattern, product naming rules)

---

## 4. OPENCLAW MAPPING

### 4.1 Infrastructure Replacement

| AutifyME Component | Purpose | OpenClaw Replacement | Migration Effort |
|--------------------|---------|---------------------|------------------|
| **LangGraph workflow** | Orchestration, state management | OpenClaw agent sessions | ✅ LOW - Platform handles |
| **LangChain tools** | Tool definitions, invocation | OpenClaw tool functions | ✅ LOW - Similar pattern |
| **DeepAgents** | Subagent compilation | OpenClaw subagent spawning | ✅ LOW - Native support |
| **WhatsApp webhook** | FastAPI webhook server | OpenClaw message tool (WhatsApp) | ✅ LOW - Platform handles |
| **WhatsApp client** | Send messages, media | OpenClaw message tool | ✅ LOW - Native |
| **Supabase client** | Database CRUD | OpenClaw database skill | ⚠️ MEDIUM - Create skill |
| **Checkpointing** | State persistence | OpenClaw session state | ✅ LOW - Platform handles |
| **Execution context** | Thread-local storage | OpenClaw session context | ✅ LOW - Platform provides |
| **Logging** | Structured logging | OpenClaw logging (stdout) | ✅ LOW - Platform handles |
| **Error handling** | Exception hierarchy | Standard exceptions | ✅ LOW - Simplify |
| **Message batching** | Debouncing, queuing | OpenClaw message handling | ✅ LOW - Simplify or remove |
| **Outcome tracking** | Workflow outcomes DB | OpenClaw memory/logging | ✅ LOW - Optional feature |

### 4.2 Agent Architecture Mapping

| AutifyME Agent | Role | OpenClaw Equivalent | Migration |
|----------------|------|---------------------|-----------|
| **ProjectManager** | Orchestrator | Main OpenClaw agent | Prompt → AGENTS.md + SOUL.md |
| **CatalogSpecialist** | Catalog CRUD | Subagent skill | Prompt → skills/catalog_specialist/SKILL.md |
| **CreativeSpecialist** | Image processing | Subagent skill | Prompt → skills/creative_specialist/SKILL.md |
| **VisualAnalyst** | Image analysis | Subagent skill | Prompt → skills/visual_analyst/SKILL.md |
| **ProductAnalyst** | External research | Subagent skill | Prompt → skills/product_analyst/SKILL.md |
| **CatalogAnalyst** | Internal research | Subagent skill | Prompt → skills/catalog_analyst/SKILL.md |
| **ApprovalAnalyzer** | HITL parsing | Main agent logic | Simplify to string matching |

### 4.3 Tool Mapping

| AutifyME Tool | Function | OpenClaw Replacement | Migration |
|---------------|----------|---------------------|-----------|
| **load_protocol** | Load protocol files | Skills knowledge base | Extract to skill docs |
| **view_image** | Image viewing | OpenClaw image tool | ✅ Direct use |
| **image_studio** | Image generation | Custom Gemini API integration | ⚠️ HIGH - Custom skill |
| **read_data** | Database query | Database skill function | ⚠️ MEDIUM - Create function |
| **write_data** | Multi-op write | Database skill function | ⚠️ MEDIUM - Create function |
| **inspect_schema** | Schema discovery | Database skill function | ⚠️ MEDIUM - Create function |
| **aggregate_data** | Analytics | Database skill function | ⚠️ MEDIUM - Create function |
| **research_product_tool** | Web search | OpenClaw web_search | ✅ Direct use |
| **extract_web_content_tool** | Web fetch | OpenClaw web_fetch | ✅ Direct use |
| **download_media** | Platform media download | OpenClaw message tool | ✅ Platform handles |
| **upload_asset** | File upload | OpenClaw file tool + Supabase API | ⚠️ MEDIUM - Hybrid approach |
| **send_message** | Send WhatsApp | OpenClaw message tool | ✅ Direct use |

### 4.4 Prompt → Skill Mapping

| AutifyME Prompt File | Lines | Target Skill | Priority |
|---------------------|-------|--------------|----------|
| `project_manager.prompt` | 560+ | Main agent (AGENTS.md + SOUL.md) | **CRITICAL** |
| `specialists/catalog_specialist.prompt` | 200+ | skills/catalog_specialist/SKILL.md | **CRITICAL** |
| `specialists/creative_specialist.prompt` | 320+ | skills/creative_specialist/SKILL.md | **CRITICAL** |
| `analysts/visual_analyst.prompt` | 200+ | skills/visual_analyst/SKILL.md | **HIGH** |
| `analysts/product_analyst.prompt` | 150+ | skills/product_analyst/SKILL.md | **HIGH** |
| `analysts/catalog_analyst.prompt` | 200+ | skills/catalog_analyst/SKILL.md | **HIGH** |
| `approval_analyzer.prompt` | 100+ | Main agent logic | **LOW** (simplify) |

### 4.5 Protocol → Skill Knowledge Mapping

| Protocol Directory | Files | Target | Priority |
|-------------------|-------|--------|----------|
| `protocols/catalog/` | 9 files | catalog_specialist skill knowledge | **CRITICAL** |
| `protocols/creative/` | 3 files | creative_specialist skill knowledge | **CRITICAL** |
| `protocols/pm/` | 9 files | Main agent knowledge or sub-skills | **HIGH** |
| `protocols/visual/` | 4 files | visual_analyst skill knowledge | **HIGH** |
| `protocols/product/` | 3 files | product_analyst skill knowledge | **MEDIUM** |
| `protocols/shared/` | 3 files | Shared knowledge across skills | **MEDIUM** |
| `protocols/shared/tool_mastery/` | 10 files | Tool usage examples in skills | **MEDIUM** |

---

## 5. PROMPT PRESERVATION PLAN

### 5.1 Critical Prompts to Extract

**Priority 1: CRITICAL (Must extract first)**

1. **`prompts/project_manager.prompt` (560 lines)**
   - **Target:** Main OpenClaw agent configuration
   - **Extraction Points:**
     - Identity → SOUL.md (Senior partner, think and route)
     - Protocol system → AGENTS.md (Protocol loading doctrine)
     - Tools → Main agent tool access patterns
     - Subagents → Subagent descriptions and delegation rules
     - Delegation doctrine → AGENTS.md (Who to call, when, dependencies)
     - Synthesis patterns → Main agent synthesis logic
     - HITL handling → Main agent approval/rejection patterns
   - **Migration Steps:**
     1. Extract identity/personality → Create SOUL.md
     2. Extract delegation rules → Add to AGENTS.md
     3. Extract protocol loading → Convert to skill access patterns
     4. Extract synthesis logic → Main agent response formatting
     5. Extract HITL patterns → User confirmation handling

2. **`prompts/specialists/catalog_specialist.prompt` (200 lines)**
   - **Target:** `~/.openclaw/workspace/skills/catalog_specialist/SKILL.md`
   - **Extraction Points:**
     - Identity → Skill role/personality
     - Company context → USER.md or skill context loading
     - Protocol system → Embedded protocol knowledge
     - Verify analyst work → Skill verification steps
     - Tools → Tool function usage
     - Workflow → Skill execution sequence
     - HITL loop → Approval/rejection handling
     - Output → WriteIntent structure guidance
   - **Migration Steps:**
     1. Create skill directory: `skills/catalog_specialist/`
     2. Extract prompt → SKILL.md system prompt
     3. Extract protocols → Embed in skill knowledge sections
     4. Create tool wrappers (database functions)
     5. Test skill in isolation

3. **`prompts/specialists/creative_specialist.prompt` (320 lines)**
   - **Target:** `~/.openclaw/workspace/skills/creative_specialist/SKILL.md`
   - **Extraction Points:**
     - Identity → World-class visual artist persona
     - Brand context → USER.md or skill context
     - Operating mode → VALIDATE → LOAD → ASSESS → EXECUTE → CRITIQUE → SHIP
     - Protocol loading → Embedded knowledge
     - 12-spec palette → Skill creative capabilities
     - Quality rubric → Skill evaluation criteria
     - Material treatments → Skill reference database
     - HITL discipline → Approval handling
   - **Migration Steps:**
     1. Create skill directory: `skills/creative_specialist/`
     2. Extract prompt → SKILL.md
     3. Extract 12-spec palette → Skill capabilities section
     4. Extract quality rubric → Skill evaluation logic
     5. Extract material database → Skill reference data
     6. Create image_studio integration (Gemini API)
     7. Test skill with sample images

**Priority 2: HIGH (Extract early)**

4. **`prompts/analysts/visual_analyst.prompt` (200 lines)**
   - **Target:** `skills/visual_analyst/SKILL.md`
   - **Extraction:** Identity, protocols, relationship detection, material ID, output format
   - **Migration:** Create skill, embed domain knowledge, test with images

5. **`prompts/analysts/product_analyst.prompt` (150 lines)**
   - **Target:** `skills/product_analyst/SKILL.md`
   - **Extraction:** Identity, research patterns, domain knowledge
   - **Migration:** Create skill, embed research methodology, test with product queries

6. **`prompts/analysts/catalog_analyst.prompt` (200 lines)**
   - **Target:** `skills/catalog_analyst/SKILL.md`
   - **Extraction:** Identity, query patterns, analysis heuristics
   - **Migration:** Create skill, embed catalog intelligence, test with database

**Priority 3: MEDIUM (Extract later)**

7. **`prompts/approval_analyzer.prompt` (100 lines)**
   - **Target:** Main agent approval parsing logic
   - **Extraction:** Approval/rejection/cancel signals, feedback parsing
   - **Migration:** Simplify to string matching in main agent (no separate skill needed)

### 5.2 Protocol Extraction Strategy

**Phase 1: Catalog Domain Protocols (CRITICAL)**

Extract to `skills/catalog_specialist/SKILL.md` knowledge sections:

1. **`protocols/catalog/business_context.protocol`**
   - → Skill section: "Company Patterns and Pricing Philosophy"
   - Content: Price ranges, margin targets, quality standards, SKU architecture

2. **`protocols/catalog/family_fit.protocol`**
   - → Skill section: "Family Fit Algorithm"
   - Content: Step-by-step customer_segments matching logic

3. **`protocols/catalog/duplicate_prevention.protocol`**
   - → Skill section: "Duplicate Detection Steps"
   - Content: SKU check, name fuzzy match, attribute overlap detection

4. **`protocols/catalog/pricing.protocol`**
   - → Skill section: "Pricing Decision Tree"
   - Content: Positioning modifiers, margin checks, rounding rules

5. **`protocols/catalog/variant_management.protocol`**
   - → Skill section: "Variant Axis Selection Patterns"
   - Content: Material, size, color, capacity, packaging axes

6. **`protocols/catalog/new_family.protocol`**
   - → Skill section: "Family Creation Criteria"
   - Content: When to create new family vs add to existing

7. **`protocols/catalog/attribute_extraction.protocol`**
   - → Skill section: "Product Attribute Identification"
   - Content: Which attributes to capture, standardization rules

8. **`protocols/catalog/asset_management.protocol`**
   - → Skill section: "Asset Linking Workflow"
   - Content: product_assets junction creation, path validation

9. **`protocols/catalog/visual_analysis.protocol`**
   - → Skill section: "Visual Analysis for Catalog Domain"
   - Content: E-commerce focus areas (materials, labels, condition)

**Phase 2: Creative Domain Protocols (CRITICAL)**

Extract to `skills/creative_specialist/SKILL.md` knowledge sections:

1. **`protocols/creative/data.protocol`**
   - → Skill section: "Asset Record Creation Workflow"
   - Content: Schema inspection, write_data structure, HITL approval

2. **`protocols/creative/hitl.protocol`**
   - → Skill section: "HITL Feedback Handling"
   - Content: Approval → ship, Rejection → revise, Cancel → escalate

3. **`protocols/creative/multi_item.protocol`**
   - → Skill section: "Anchor-First Extraction Pattern"
   - Content: User selects anchor, extract + approve, learn preferences, apply to rest

**Phase 3: Visual Domain Protocols (HIGH)**

Extract to `skills/visual_analyst/SKILL.md` knowledge sections:

1. **`protocols/visual/catalog_visual.protocol`**
   - → Skill section: "Catalog Domain Focus Areas"
   - Content: Materials, labels, condition, packaging, quantity

2. **`protocols/visual/lifestyle_visual.protocol`**
   - → Skill section: "Lifestyle Scene Analysis"
   - Content: Scene context, product prominence, brand presence

3. **`protocols/visual/social_content.protocol`**
   - → Skill section: "Social Media Visual Analysis"
   - Content: Appeal scoring, composition analysis, engagement factors

**Phase 4: Shared/Tool Mastery Protocols (MEDIUM)**

Extract to individual skill knowledge or shared skill:

1. **`protocols/shared/tool_mastery/read_data.protocol`**
   - → Database skill documentation: "Query Patterns"
   - Content: Exact filters vs search patterns, relation syntax, pagination

2. **`protocols/shared/tool_mastery/write_data.protocol`**
   - → Database skill documentation: "WriteIntent Structure"
   - Content: Goal, reasoning, operations, dependencies, references, impact

3. **`protocols/shared/tool_mastery/image_studio.protocol`**
   - → Creative specialist skill: "12-Spec Usage Patterns"
   - Content: When to use each spec, parameter selection, quality gates

4. **`protocols/shared/tool_mastery/inspect_schema.protocol`**
   - → Database skill documentation: "Schema Discovery Patterns"
   - Content: Table listing, column inspection, constraint discovery

5. **`protocols/shared/tool_mastery/aggregate_data.protocol`**
   - → Database skill documentation: "Analytics Patterns"
   - Content: GROUP BY patterns, aggregate selection, filtering

6. **`protocols/shared/tool_mastery/view_image.protocol`**
   - → Shared across visual skills: "Image Viewing Best Practices"
   - Content: When to view, what to assess, parallel viewing for multi-image

7. **`protocols/shared/resource_efficiency.protocol`**
   - → Main agent + all skills: "Token Budgeting and STOP Conditions"
   - Content: Tool call limits, batch patterns, when to stop exploring

8. **`protocols/shared/input_validation.protocol`**
   - → All skills: "Input Verification Before Execution"
   - Content: Required context checks, file reference validation, missing data detection

9. **`protocols/shared/hitl.protocol`**
   - → Main agent + execution skills: "HITL Feedback Handling"
   - Content: Approval signals, rejection patterns, cancellation escalation

**Phase 5: PM Coordination Protocols (MEDIUM)**

Extract to main agent knowledge:

1. **`protocols/pm/discovery_mindset.protocol`**
   - → Main agent: "Intent Detection and Media Acquisition"

2. **`protocols/pm/synthesis.protocol`**
   - → Main agent: "Multi-Domain Synthesis Patterns"

3. **`protocols/pm/execution_flows.protocol`**
   - → Main agent: "Catalog CRUD Workflows"

4. **`protocols/pm/multi_image.protocol`**
   - → Main agent: "Multi-Image Coordination"

5. **`protocols/pm/data_driven.protocol`**
   - → Main agent: "Data Fetch Before Creative Delegation"

6. **`protocols/pm/error_recovery.protocol`**
   - → Main agent: "Error and Cancellation Handling"

7. **`protocols/pm/conflict_resolution.protocol`**
   - → Main agent: "Analyst Conflict Resolution"

### 5.3 Extraction Template

For each prompt/protocol file, create structured extraction:

```markdown
## [SKILL_NAME] - Extracted from [SOURCE_FILE]

### Identity
[Agent personality, role, expertise level]

### Domain Knowledge
[Core domain expertise extracted from prompts + protocols]

#### Section 1: [Domain Topic]
[Protocol content 1]

#### Section 2: [Domain Topic]
[Protocol content 2]

... (continue for all relevant sections)

### Tool Usage Patterns
[How to use each tool effectively]

#### Tool 1: [tool_name]
- **Purpose:** [What it does]
- **When to use:** [Conditions]
- **Parameters:** [Key parameters]
- **Example:** [Usage example]

### Quality Standards
[What constitutes good output]

### Validation Gates
[What to check before/after execution]

### HITL Patterns
[How to handle approval/rejection]

### Escalation Patterns
[When to escalate to PM or user]
```

---

## 6. MIGRATION PRIORITY

### Phase 1: Foundation (Week 1-2)

**Goal:** Establish OpenClaw infrastructure and basic agent

**Tasks:**
1. ✅ **Setup OpenClaw environment**
   - Install OpenClaw gateway
   - Configure WhatsApp channel
   - Test message sending/receiving

2. ✅ **Create main agent**
   - Extract PM identity → SOUL.md
   - Extract delegation rules → AGENTS.md
   - Configure default model
   - Test basic message handling

3. ⚠️ **Create database skill**
   - Supabase connection wrapper
   - Basic CRUD functions (create, read, update, delete)
   - Schema inspection function
   - Test with sample database operations

4. ⚠️ **Create visual_analyst skill**
   - Extract prompt → SKILL.md
   - Embed visual analysis protocols
   - Use OpenClaw image tool
   - Test with sample images

**Deliverables:**
- Working OpenClaw agent that can:
  - Receive WhatsApp messages
  - Spawn visual_analyst subagent
  - View images
  - Query database
  - Respond to user

**Validation:**
- Send image via WhatsApp
- Agent delegates to visual_analyst
- Analyst returns visual observations
- Agent responds with summary

---

### Phase 2: Catalog Domain (Week 3-4)

**Goal:** Enable catalog operations

**Tasks:**
1. ⚠️ **Create catalog_specialist skill**
   - Extract prompt → SKILL.md
   - Embed all catalog protocols:
     - business_context
     - family_fit
     - duplicate_prevention
     - pricing
     - variant_management
   - Create database skill functions:
     - read_data (query with filters, search, relations)
     - write_data (multi-op transactions)
     - inspect_schema
     - aggregate_data
   - Implement HITL approval flow
   - Test with sample product creation

2. ⚠️ **Create catalog_analyst skill**
   - Extract prompt → SKILL.md
   - Embed catalog analysis protocols
   - Test family fit analysis
   - Test duplicate detection
   - Test pricing analysis

3. ⚠️ **Create product_analyst skill**
   - Extract prompt → SKILL.md
   - Embed research protocols
   - Use OpenClaw web_search + web_fetch
   - Test product research

4. ✅ **Update main agent**
   - Add catalog delegation patterns
   - Add synthesis logic for catalog workflows
   - Test multi-agent coordination

**Deliverables:**
- Working catalog workflow:
  - User sends product image
  - Visual analyst observes
  - Product analyst researches (if unknown product)
  - Catalog analyst checks for duplicates
  - Catalog specialist creates product (with HITL approval)
  - Agent synthesizes and reports

**Validation:**
- End-to-end product creation workflow
- HITL approval works
- Database write successful
- User receives confirmation

---

### Phase 3: Creative Domain (Week 5-6)

**Goal:** Enable image processing and asset creation

**Tasks:**
1. ⚠️ **Create image generation integration**
   - Gemini 3 Pro Image API wrapper
   - 12-spec creative palette implementation
   - Quality validation logic
   - Test each spec individually

2. ⚠️ **Create creative_specialist skill**
   - Extract prompt → SKILL.md
   - Embed creative protocols:
     - catalog_visual
     - lifestyle_visual
     - multi_item
     - data (asset creation)
   - Integrate image generation
   - Implement quality scoring rubric
   - Implement HITL approval for assets
   - Test hero shot workflow

3. ⚠️ **Integrate with catalog workflow**
   - Creative → asset creation
   - Catalog → product + asset linking
   - Test end-to-end (image → processed asset → product record)

**Deliverables:**
- Working creative workflow:
  - User sends raw product image
  - Creative specialist processes (background removal, hero shot)
  - Creative specialist creates asset record (with HITL)
  - Catalog specialist links asset to product
  - User receives product with hero shot

**Validation:**
- Image processing works (background removal, hero shot)
- Quality validation enforced
- Asset upload to storage
- Database asset record created
- Product-asset link created

---

### Phase 4: Advanced Features (Week 7-8)

**Goal:** Multi-image, variants, advanced workflows

**Tasks:**
1. ⚠️ **Multi-image handling**
   - Implement relationship detection (angles, variants, different)
   - Implement anchor-first pattern
   - Test variant creation workflow

2. ⚠️ **Variant management**
   - Variant axis creation
   - Variant value linking
   - Bulk variant creation
   - Test variant workflow

3. ⚠️ **Advanced coordination**
   - Multi-domain workflows (catalog + creative)
   - Error recovery patterns
   - Partial success handling
   - Test complex scenarios

4. ⚠️ **Performance optimization**
   - Reduce token usage (protocol embedding vs loading)
   - Optimize database queries
   - Batch operations where possible

**Deliverables:**
- Advanced workflows working:
  - Multi-image variant creation
  - Bulk product import
  - Complex multi-domain coordination
  - Error recovery

**Validation:**
- Send 3 images (same product, different sizes)
- Agent detects variant relationship
- Creates product family with 3 variants
- Links assets correctly
- User receives confirmation

---

### Phase 5: Production Readiness (Week 9-10)

**Goal:** Polish, testing, deployment

**Tasks:**
1. ✅ **Error handling**
   - Comprehensive error messages
   - Graceful degradation
   - User-friendly error reporting

2. ✅ **Testing**
   - Unit tests for skills
   - Integration tests for workflows
   - End-to-end scenario tests
   - Performance testing

3. ✅ **Documentation**
   - User guide (how to use via WhatsApp)
   - Admin guide (setup, configuration)
   - Skill documentation (for future maintenance)
   - Architecture documentation

4. ✅ **Deployment**
   - Production OpenClaw gateway setup
   - Database migration (AutifyME → OpenClaw environment)
   - WhatsApp Business account configuration
   - Monitoring and logging setup

**Deliverables:**
- Production-ready system
- Comprehensive documentation
- Deployed and tested

**Validation:**
- Run test scenarios in production
- Verify all workflows work
- Performance meets targets
- Error handling works correctly

---

## 7. SKILL STRUCTURE RECOMMENDATIONS

### 7.1 Skill Directory Structure

```
~/.openclaw/workspace/skills/
├── catalog_specialist/
│   ├── SKILL.md                 # Main skill prompt
│   ├── knowledge/
│   │   ├── business_context.md
│   │   ├── family_fit.md
│   │   ├── pricing.md
│   │   ├── duplicate_prevention.md
│   │   └── variant_management.md
│   └── examples/
│       ├── create_product.md
│       └── create_variant.md
├── creative_specialist/
│   ├── SKILL.md
│   ├── knowledge/
│   │   ├── 12_spec_palette.md
│   │   ├── quality_rubric.md
│   │   ├── material_treatments.md
│   │   └── catalog_visual.md
│   └── examples/
│       ├── hero_shot.md
│       └── multi_item_extraction.md
├── visual_analyst/
│   ├── SKILL.md
│   ├── knowledge/
│   │   ├── relationship_detection.md
│   │   ├── material_identification.md
│   │   └── catalog_visual.md
│   └── examples/
│       └── multi_image_analysis.md
├── product_analyst/
│   ├── SKILL.md
│   ├── knowledge/
│   │   ├── research_patterns.md
│   │   └── market_intelligence.md
│   └── examples/
│       └── product_research.md
├── catalog_analyst/
│   ├── SKILL.md
│   ├── knowledge/
│   │   ├── family_fit.md
│   │   └── duplicate_detection.md
│   └── examples/
│       └── catalog_analysis.md
└── database/
    ├── SKILL.md                 # Database access skill
    ├── knowledge/
    │   ├── schema_reference.md
    │   ├── query_patterns.md
    │   └── write_intent.md
    └── functions/
        ├── read_data.py
        ├── write_data.py
        ├── inspect_schema.py
        └── aggregate_data.py
```

### 7.2 Sample Skill Template

```markdown
# [Skill Name]

## Role
[Identity, expertise level, domain]

## Mission
[Primary purpose and goals]

## Capabilities
- Capability 1
- Capability 2
- ...

## Domain Knowledge

### [Knowledge Area 1]
[Detailed knowledge extracted from protocols]

### [Knowledge Area 2]
[Detailed knowledge extracted from protocols]

## Tool Usage

### Tool 1: [tool_name]
**Purpose:** [What it does]

**When to use:**
- Condition 1
- Condition 2

**Parameters:**
- `param1`: Description
- `param2`: Description

**Example:**
```
[tool_name](param1="value", param2="value")
```

## Quality Standards
[What constitutes good output]

## Validation Gates
[What to check before/after execution]

## HITL Patterns
[How to handle approval/rejection]

## Escalation
[When to escalate to main agent or user]

## Examples

### Example 1: [Use Case]
[Detailed example workflow]

### Example 2: [Use Case]
[Detailed example workflow]
```

---

## 8. RISK ASSESSMENT & MITIGATION

### 8.1 High-Risk Areas

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| **Protocol intelligence loss** | CRITICAL | HIGH | Comprehensive extraction + validation testing |
| **Image generation API changes** | HIGH | MEDIUM | Abstract API calls, use multiple providers as backup |
| **Database query complexity** | HIGH | MEDIUM | Start simple, iterate based on testing |
| **HITL approval flow breaks** | HIGH | LOW | Thorough testing of approval/rejection/cancel paths |
| **Multi-agent coordination issues** | MEDIUM | MEDIUM | Incremental testing, start with single-agent workflows |
| **WhatsApp API rate limits** | MEDIUM | LOW | Implement backoff, queue messages |
| **Token budget exceeded** | MEDIUM | MEDIUM | Embed protocols vs loading, optimize prompts |
| **Data consistency issues** | HIGH | LOW | Atomic transactions, validation before write |

### 8.2 Mitigation Strategies

1. **Protocol Intelligence Preservation**
   - Extract ALL protocol files to structured markdown
   - Create validation test suite (input → expected output)
   - Compare AutifyME agent decisions vs OpenClaw agent decisions
   - Iterate until parity achieved

2. **Image Generation Abstraction**
   - Create image generation skill with provider abstraction
   - Support multiple providers (Gemini, DALL-E, Midjourney)
   - Fallback chain if primary provider fails
   - Cache successful generation parameters

3. **Database Complexity Management**
   - Start with simple CRUD (single table, no relations)
   - Add complexity incrementally (relations, multi-op, dependencies)
   - Test each layer before adding next
   - Use dry-run mode extensively

4. **HITL Flow Testing**
   - Create test scenarios for all approval paths:
     - Approval → Execute
     - Rejection → Revise
     - Cancel → Escalate
     - Partial approval (future)
   - Test user confirmation patterns in OpenClaw
   - Validate state persistence across approval cycles

5. **Incremental Migration**
   - Don't migrate everything at once
   - Phase 1: Visual analyst only (read-only, low risk)
   - Phase 2: Add catalog analyst (read-only, low risk)
   - Phase 3: Add catalog specialist (write operations, HITL safety)
   - Phase 4: Add creative specialist (image generation, highest complexity)
   - Validate each phase before proceeding

---

## 9. SUCCESS CRITERIA

### 9.1 Functional Parity

OpenClaw implementation must achieve functional parity with AutifyME:

| AutifyME Capability | OpenClaw Equivalent | Validation Test |
|---------------------|---------------------|-----------------|
| **Image observation** | visual_analyst skill | Send image → Receive detailed visual analysis |
| **Product research** | product_analyst skill | Unknown product → Receive research findings |
| **Catalog queries** | catalog_analyst skill | "Find duplicates" → Receive duplicate report |
| **Product creation** | catalog_specialist skill | Create product → Database record exists |
| **Image processing** | creative_specialist skill | Raw image → Hero shot output |
| **HITL approval** | User confirmation | Write operation → Approval request → Execute |
| **Multi-agent coordination** | Subagent spawning | Complex workflow → All agents coordinated |
| **WhatsApp interface** | OpenClaw message tool | WhatsApp message → Agent response |
| **Protocol-driven decisions** | Skill knowledge | Same input → Same decision (protocol adherence) |
| **Multi-image handling** | Main agent + analysts | 3 images → Correct relationship detection |

### 9.2 Quality Metrics

| Metric | AutifyME Baseline | OpenClaw Target | Measurement |
|--------|------------------|-----------------|-------------|
| **Response time** | ~5-10 seconds | <10 seconds | Time from message to response |
| **Accuracy (catalog)** | 95%+ | 95%+ | Correct product creation (no duplicates) |
| **Accuracy (visual)** | 90%+ | 90%+ | Correct material/relationship detection |
| **Image quality** | 8+ on all dimensions | 8+ on all dimensions | Quality scoring rubric |
| **HITL approval rate** | 80%+ | 80%+ | First-attempt approval percentage |
| **Error rate** | <5% | <5% | Failed workflows / total workflows |
| **Token efficiency** | ~50K tokens/workflow | <60K tokens/workflow | Average token usage |

### 9.3 User Experience

| Experience Factor | AutifyME | OpenClaw Target |
|------------------|----------|-----------------|
| **Setup complexity** | Medium (deploy FastAPI, configure Supabase) | Low (configure OpenClaw channel) |
| **Conversational quality** | Natural, context-aware | Equal or better |
| **Error messages** | Clear, actionable | Equal or better |
| **Approval clarity** | Clear what's being approved | Equal or better |
| **Output quality** | Portfolio-worthy | Equal or better |

---

## 10. CONCLUSION

### 10.1 Migration Feasibility

**Overall Assessment: HIGHLY FEASIBLE**

OpenClaw provides **native replacements** for 90% of AutifyME infrastructure:
- ✅ Workflow orchestration → Agent sessions
- ✅ Subagents → Native subagent spawning
- ✅ Tools → OpenClaw tool functions
- ✅ WhatsApp → Message tool
- ✅ Image viewing → Image tool
- ✅ Web research → web_search + web_fetch
- ✅ File storage → Workspace files
- ✅ HITL approval → User confirmation patterns

**Critical Custom Work:**
- ⚠️ Database skill (Supabase integration)
- ⚠️ Image generation skill (Gemini 3 Pro Image API)
- ✅ Protocol extraction → Skill knowledge

**Estimated Effort:** 8-10 weeks for complete migration

### 10.2 Key Success Factors

1. **Comprehensive Protocol Extraction**
   - ALL domain intelligence is in prompts + protocols
   - Must extract to skill knowledge completely
   - Validation testing critical to ensure no intelligence loss

2. **Database Skill Quality**
   - Supabase integration must be robust
   - CRUD operations must match AutifyME functionality
   - Transaction support for multi-op writes

3. **Image Generation Integration**
   - Gemini 3 Pro Image API wrapper
   - Quality validation logic
   - Material-aware parameter selection

4. **Incremental Testing**
   - Validate each skill in isolation
   - Test multi-agent coordination incrementally
   - Compare AutifyME vs OpenClaw decisions on same inputs

5. **User Experience Preservation**
   - Conversational quality must match or exceed AutifyME
   - Error messages clear and actionable
   - HITL approval flows intuitive

### 10.3 Next Steps

1. ✅ **Week 1:** Setup OpenClaw, create main agent, test WhatsApp
2. ⚠️ **Week 2:** Create database skill, test CRUD operations
3. ⚠️ **Week 3-4:** Create catalog skills (specialist + analyst), test catalog workflows
4. ⚠️ **Week 5-6:** Create creative skills, integrate image generation
5. ⚠️ **Week 7-8:** Advanced features (multi-image, variants, coordination)
6. ✅ **Week 9-10:** Testing, documentation, deployment

**Recommendation:** Proceed with migration. OpenClaw provides excellent foundation; domain intelligence extraction is the critical path.

---

**END OF ANALYSIS**

This comprehensive analysis covers every file, dependency, business logic pattern, and migration requirement for the AutifyME → OpenClaw transition. All domain intelligence (prompts + protocols) has been identified and mapped to OpenClaw skills.
