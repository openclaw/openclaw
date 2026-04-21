// Auto-generated from config schema/UI hint metadata. Do not edit directly.

export const VI_CONFIG_METADATA_TEXT: Readonly<Record<string, string>> = {
  "Absolute tool allowlist that replaces profile-derived defaults for strict environments. Use this only when you intentionally run a tightly curated subset of tool capabilities.":
    "Danh sách cho phép công cụ tuyệt đối thay thế các giá trị mặc định suy ra từ hồ sơ cho các môi trường nghiêm ngặt. Chỉ dùng mục này khi bạn chủ ý chạy một tập con khả năng công cụ được tuyển chọn chặt chẽ.",
  "Accent Color": "Màu nhấn",
  "Ack Reaction Emoji": "Emoji phản hồi xác nhận",
  "Ack Reaction Scope": "Phạm vi phản hồi xác nhận",
  "ACP Allowed Agents": "Các tác nhân ACP được phép",
  "ACP backend override for this binding (falls back to agent runtime ACP backend, then global acp.backend).":
    "Ghi đè ACP backend cho liên kết này (dùng ACP backend của runtime tác nhân nếu không có, sau đó đến acp.backend toàn cục).",
  "ACP Default Agent": "Tác nhân ACP mặc định",
  "ACP delivery style: live streams projected output incrementally, final_only buffers all projected ACP output until terminal turn events.":
    "Kiểu phân phối ACP: live streams chiếu đầu ra theo từng phần tăng dần, final_only đệm toàn bộ đầu ra ACP đã chiếu cho đến các sự kiện lượt cuối cùng.",
  "ACP Dispatch Enabled": "Bật điều phối ACP",
  "ACP Enabled": "Bật ACP",
  "ACP Max Concurrent Sessions": "Số phiên ACP đồng thời tối đa",
  "ACP runtime controls for enabling dispatch, selecting backends, constraining allowed agent targets, and tuning streamed turn projection behavior.":
    "Các điều khiển runtime ACP để bật điều phối, chọn backend, giới hạn các tác nhân đích được phép và tinh chỉnh hành vi chiếu lượt được truyền trực tuyến.",
  "ACP runtime defaults for this agent when runtime.type=acp. Binding-level ACP overrides still take precedence per conversation.":
    "Các giá trị mặc định runtime ACP cho tác nhân này khi runtime.type=acp. Các ghi đè ACP ở cấp liên kết vẫn được ưu tiên theo từng cuộc trò chuyện.",
  "ACP Runtime Install Command": "Lệnh cài đặt ACP Runtime",
  "ACP Runtime TTL (minutes)": "TTL ACP Runtime (phút)",
  "ACP session mode override for this binding (persistent or oneshot).":
    "Ghi đè chế độ phiên ACP cho liên kết này (persistent hoặc oneshot).",
  "ACP Stream": "Luồng ACP",
  "ACP Stream Coalesce Idle (ms)": "Thời gian chờ gộp khi nhàn rỗi của luồng ACP (ms)",
  "ACP Stream Delivery Mode": "Chế độ phân phối luồng ACP",
  "ACP Stream Hidden Boundary Separator": "Dấu phân tách ranh giới ẩn của luồng ACP",
  "ACP Stream Max Chunk Chars": "Số ký tự tối đa mỗi đoạn của luồng ACP",
  "ACP Stream Max Output Chars": "Số ký tự đầu ra tối đa của luồng ACP",
  "ACP Stream Max Session Update Chars": "Số ký tự cập nhật phiên tối đa của luồng ACP",
  "ACP Stream Repeat Suppression": "Chống lặp lại của luồng ACP",
  "ACP Stream Tag Visibility": "Hiển thị thẻ của luồng ACP",
  "ACP streaming projection controls for chunk sizing, metadata visibility, and deduped delivery behavior.":
    "Các điều khiển chiếu luồng ACP cho kích thước đoạn, khả năng hiển thị siêu dữ liệu và hành vi phân phối đã loại trùng lặp.",
  'Active Talk provider id (for example "acme-speech").':
    'ID nhà cung cấp Talk đang hoạt động (ví dụ: "acme-speech").',
  "Add a visible origin marker when sending cross-context (default: true).":
    "Thêm dấu đánh dấu nguồn gốc hiển thị khi gửi liên ngữ cảnh (mặc định: true).",
  "Additional custom redact regex patterns applied to log output before emission/storage. Use this to mask org-specific tokens and identifiers not covered by built-in redaction rules.":
    "Các mẫu regex che giấu tùy chỉnh bổ sung được áp dụng cho đầu ra nhật ký trước khi phát/lưu trữ. Dùng mục này để che các token và mã định danh riêng của tổ chức chưa được bao phủ bởi các quy tắc che giấu tích hợp.",
  "Additional directories searched for internal hook modules beyond default load paths. Keep this minimal and controlled to reduce accidental module shadowing.":
    "Các thư mục bổ sung được tìm kiếm cho các mô-đun hook nội bộ ngoài các đường dẫn tải mặc định. Giữ cấu hình này ở mức tối thiểu và được kiểm soát để giảm việc vô tình che khuất mô-đun.",
  "Additional explicit directories trusted for safe-bin path checks (PATH entries are never auto-trusted).":
    "Các thư mục rõ ràng bổ sung được tin cậy cho kiểm tra đường dẫn safe-bin (các mục PATH không bao giờ được tự động tin cậy).",
  "Additional HTTP headers merged into audio provider requests after provider defaults. Use this for tenant routing or proxy integration headers, and keep secrets in env-backed values.":
    "Các header HTTP bổ sung được hợp nhất vào các yêu cầu của nhà cung cấp âm thanh sau các giá trị mặc định của nhà cung cấp. Dùng mục này cho định tuyến tenant hoặc các header tích hợp proxy, và giữ bí mật trong các giá trị được hỗ trợ bởi env.",
  "Additional HTTP/gRPC metadata headers sent with OpenTelemetry export requests, often used for tenant auth or routing. Keep secrets in env-backed values and avoid unnecessary header sprawl.":
    "Các header siêu dữ liệu HTTP/gRPC bổ sung được gửi cùng các yêu cầu xuất OpenTelemetry, thường dùng cho xác thực tenant hoặc định tuyến. Giữ bí mật trong các giá trị được hỗ trợ bởi env và tránh mở rộng header không cần thiết.",
  "Additional plugin files or directories scanned by the loader beyond built-in defaults. Use dedicated extension directories and avoid broad paths with unrelated executable content.":
    "Các tệp hoặc thư mục plugin bổ sung được bộ nạp quét ngoài các giá trị mặc định tích hợp. Hãy dùng các thư mục mở rộng chuyên dụng và tránh các đường dẫn rộng có chứa nội dung thực thi không liên quan.",
  "Adds custom directories or files to include in QMD indexing, each with an optional name and glob pattern. Use this for project-specific knowledge locations that are outside default memory paths.":
    "Thêm các thư mục hoặc tệp tùy chỉnh để đưa vào lập chỉ mục QMD, mỗi mục có thể có tên và mẫu glob tùy chọn. Dùng mục này cho các vị trí tri thức riêng của dự án nằm ngoài các đường dẫn bộ nhớ mặc định.",
  "Adds custom HTTP headers to remote embedding requests, merged with provider defaults. Use this for proxy auth and tenant routing headers, and keep values minimal to avoid leaking sensitive metadata.":
    "Thêm các header HTTP tùy chỉnh vào các yêu cầu embedding từ xa, được hợp nhất với các giá trị mặc định của nhà cung cấp. Dùng mục này cho xác thực proxy và các header định tuyến tenant, và giữ giá trị ở mức tối thiểu để tránh rò rỉ siêu dữ liệu nhạy cảm.",
  "Adds extra directories or .md files to the memory index beyond default memory files. Use this when key reference docs live elsewhere in your repo; when multimodal memory is enabled, matching image/audio files under these paths are also eligible for indexing.":
    "Thêm các thư mục bổ sung hoặc tệp .md vào chỉ mục bộ nhớ ngoài các tệp bộ nhớ mặc định. Dùng mục này khi các tài liệu tham chiếu quan trọng nằm ở nơi khác trong repo của bạn; khi bộ nhớ đa phương thức được bật, các tệp hình ảnh/âm thanh khớp dưới các đường dẫn này cũng đủ điều kiện để lập chỉ mục.",
  "Adds MMR reranking to diversify results and reduce near-duplicate snippets in a single answer window. Enable when recall looks repetitive; keep off for strict score ordering.":
    "Thêm xếp hạng lại MMR để đa dạng hóa kết quả và giảm các đoạn gần trùng lặp trong một cửa sổ trả lời. Bật khi khả năng thu hồi có vẻ lặp lại; giữ tắt để duy trì thứ tự điểm số nghiêm ngặt.",
  "Age threshold in milliseconds for emitting stuck-session warnings while a session remains in processing state. Increase for long multi-tool turns to reduce false positives; decrease for faster hang detection.":
    "Ngưỡng tuổi tính bằng mili giây để phát cảnh báo phiên bị kẹt khi một phiên vẫn ở trạng thái đang xử lý. Tăng cho các lượt nhiều công cụ kéo dài để giảm cảnh báo sai; giảm để phát hiện treo nhanh hơn.",
  Agent: "Tác nhân",
  "Agent ACP Backend": "Backend ACP của tác nhân",
  "Agent ACP Harness Agent": "Tác nhân ACP Harness của tác nhân",
  "Agent ACP Mode": "Chế độ ACP của tác nhân",
  "Agent ACP Runtime": "Runtime ACP của tác nhân",
  "Agent ACP Working Directory": "Thư mục làm việc ACP của tác nhân",
  "Agent Avatar": "Ảnh đại diện tác nhân",
  "Agent avatar (workspace-relative path, http(s) URL, or data URI).":
    "Ảnh đại diện tác nhân (đường dẫn tương đối với workspace, URL http(s), hoặc data URI).",
  "Agent Communication Protocol runtime and streaming settings":
    "Thiết lập runtime và streaming của Agent Communication Protocol",
  "Agent Defaults": "Mặc định tác nhân",
  "Agent Embedded Harness": "Harness nhúng của tác nhân",
  "Agent Embedded Harness Fallback": "Dự phòng Harness nhúng của tác nhân",
  "Agent Embedded Harness Runtime": "Runtime Harness nhúng của tác nhân",
  "Agent Embedded Pi": "Pi nhúng của tác nhân",
  "Agent Embedded Pi Execution Contract": "Hợp đồng thực thi Pi nhúng của tác nhân",
  "Agent Fast Mode Default": "Mặc định chế độ nhanh của tác nhân",
  "Agent Heartbeat Suppress Tool Error Warnings": "Ẩn cảnh báo lỗi công cụ heartbeat của tác nhân",
  "Agent Heartbeat Timeout (Seconds)": "Thời gian chờ heartbeat của tác nhân (giây)",
  "Agent List": "Danh sách tác nhân",
  "Agent Reasoning Default": "Mặc định suy luận của tác nhân",
  "Agent Runtime": "Runtime tác nhân",
  "Agent runtime configuration root covering defaults and explicit agent entries used for routing and execution context. Keep this section explicit so model/tool behavior stays predictable across multi-agent workflows.":
    "Gốc cấu hình runtime tác nhân bao gồm các giá trị mặc định và các mục tác nhân tường minh được dùng cho định tuyến và ngữ cảnh thực thi. Giữ phần này tường minh để hành vi của model/công cụ luôn có thể dự đoán trong các quy trình làm việc đa tác nhân.",
  "Agent Runtime Type": "Loại runtime tác nhân",
  "Agent Sandbox Browser CDP Source Port Range":
    "Phạm vi cổng nguồn CDP của trình duyệt sandbox tác nhân",
  "Agent Sandbox Browser Network": "Mạng trình duyệt sandbox tác nhân",
  "Agent Sandbox Docker Allow Container Namespace Join":
    "Cho phép tham gia namespace container Docker sandbox tác nhân",
  "Agent Skill Filter": "Bộ lọc Skills của tác nhân",
  "Agent Thinking Default": "Mặc định suy nghĩ của tác nhân",
  "Agent Tool Allowlist Additions": "Bổ sung danh sách cho phép công cụ của tác nhân",
  "Agent Tool Policy by Provider": "Chính sách công cụ của tác nhân theo nhà cung cấp",
  "Agent Tool Profile": "Hồ sơ công cụ của tác nhân",
  "Agent-to-Agent Ping-Pong Turns": "Số lượt ping-pong giữa tác nhân với tác nhân",
  "Agent-to-Agent Target Allowlist": "Danh sách cho phép đích tác nhân với tác nhân",
  "Agent-to-Agent Tool Access": "Quyền truy cập công cụ giữa tác nhân với tác nhân",
  Agents: "Tác nhân",
  'AGENTS.md H2/H3 section names re-injected after compaction so the agent reruns critical startup guidance. Leave unset to use "Session Startup"/"Red Lines" with legacy fallback to "Every Session"/"Safety"; set to [] to disable reinjection entirely.':
    'Tên mục H2/H3 trong AGENTS.md được chèn lại sau khi nén để tác nhân chạy lại hướng dẫn khởi động quan trọng. Để trống để dùng "Session Startup"/"Red Lines" với phương án dự phòng cũ là "Every Session"/"Safety"; đặt thành [] để tắt hoàn toàn việc chèn lại.',
  "Allow /config": "Cho phép /config",
  "Allow /config chat command to read/write config on disk (default: false).":
    "Cho phép lệnh chat /config đọc/ghi cấu hình trên đĩa (mặc định: false).",
  "Allow /debug": "Cho phép /debug",
  "Allow /debug chat command for runtime-only overrides (default: false).":
    "Cho phép lệnh chat /debug cho các ghi đè chỉ trong thời gian chạy (mặc định: false).",
  "Allow /mcp": "Cho phép /mcp",
  "Allow /mcp chat command to manage OpenClaw MCP server config under mcp.servers (default: false).":
    "Cho phép lệnh chat /mcp quản lý cấu hình máy chủ MCP của OpenClaw trong mcp.servers (mặc định: false).",
  "Allow /plugins": "Cho phép /plugins",
  "Allow /plugins chat command to list discovered plugins and toggle plugin enablement in config (default: false).":
    "Cho phép lệnh chat /plugins liệt kê các plugin đã phát hiện và bật/tắt plugin trong cấu hình (mặc định: false).",
  "Allow /restart and gateway restart tool actions (default: true).":
    "Cho phép /restart và các hành động công cụ khởi động lại gateway (mặc định: true).",
  "Allow Bash Chat Command": "Cho phép lệnh chat Bash",
  "Allow bash chat command (`!`; `/bash` alias) to run host shell commands (default: false; requires tools.elevated).":
    "Cho phép lệnh chat bash (`!`; bí danh `/bash`) chạy các lệnh shell của máy chủ (mặc định: false; yêu cầu tools.elevated).",
  "Allow Cross-Context (Across Providers)": "Cho phép liên ngữ cảnh (giữa các nhà cung cấp)",
  "Allow Cross-Context (Same Provider)": "Cho phép liên ngữ cảnh (cùng nhà cung cấp)",
  "Allow Cross-Context Messaging": "Cho phép nhắn tin liên ngữ cảnh",
  "Allow Plugin Subagent Model Override": "Cho phép ghi đè mô hình subagent của plugin",
  "Allow Prompt Injection Hooks": "Cho phép hook chèn prompt",
  "Allow Restart": "Cho phép khởi động lại",
  "Allow RFC 2544 benchmark-range IPs (198.18.0.0/15) for fake-IP proxy compatibility such as Clash or Surge.":
    "Cho phép các IP benchmark-range RFC 2544 (198.18.0.0/15) để tương thích proxy fake-IP như Clash hoặc Surge.",
  "Allow sends across different providers (default: false).":
    "Cho phép gửi qua các nhà cung cấp khác nhau (mặc định: false).",
  "Allow sends to other channels within the same provider (default: true).":
    "Cho phép gửi tới các kênh khác trong cùng một nhà cung cấp (mặc định: true).",
  "Allow server-side URL fetches for `image_url` parts (default: false; data URIs remain supported). Set this to `false` to disable URL fetching entirely.":
    "Cho phép máy chủ lấy URL cho các phần `image_url` (mặc định: false; data URI vẫn được hỗ trợ). Đặt giá trị này thành `false` để tắt hoàn toàn việc lấy URL.",
  "Allow stdin-only safe binaries to run without explicit allowlist entries.":
    "Cho phép các binary an toàn chỉ dùng stdin chạy mà không cần mục allowlist rõ ràng.",
  "Allow/deny tool policy applied to spawned subagent runtimes for per-subagent hardening. Keep this narrower than parent scope when subagents run semi-autonomous workflows.":
    "Chính sách cho phép/từ chối công cụ được áp dụng cho các runtime tác nhân con được sinh ra để tăng cường bảo mật theo từng tác nhân con. Giữ phạm vi này hẹp hơn phạm vi cha khi tác nhân con chạy các quy trình bán tự động.",
  "Allow/deny tool policy applied when agents run in sandboxed execution environments. Keep policies minimal so sandbox tasks cannot escalate into unnecessary external actions.":
    "Chính sách cho phép/từ chối công cụ được áp dụng khi tác nhân chạy trong môi trường thực thi sandbox. Giữ chính sách ở mức tối thiểu để các tác vụ sandbox không thể leo thang thành các hành động bên ngoài không cần thiết.",
  'Allowed browser origins for Control UI/WebChat websocket connections (full origins only, e.g. https://control.example.com). Required for non-loopback Control UI deployments unless dangerous Host-header fallback is explicitly enabled. Setting ["*"] means allow any browser origin and should be avoided outside tightly controlled local testing.':
    'Các origin trình duyệt được phép cho kết nối websocket của Control UI/WebChat (chỉ origin đầy đủ, ví dụ: https://control.example.com). Bắt buộc cho các triển khai Control UI không dùng loopback trừ khi fallback Host-header nguy hiểm được bật rõ ràng. Đặt ["*"] nghĩa là cho phép mọi origin trình duyệt và nên tránh ngoài các thử nghiệm cục bộ được kiểm soát chặt chẽ.',
  "Allowed MIME types for `image_url` parts (case-insensitive list).":
    "Các loại MIME được phép cho các phần `image_url` (danh sách không phân biệt chữ hoa chữ thường).",
  'Allowed override targets for trusted plugin subagent runs as canonical "provider/model" refs. Use "*" only when you intentionally allow any model.':
    'Các đích ghi đè được phép cho các lần chạy tác nhân con plugin đáng tin cậy dưới dạng tham chiếu chuẩn "provider/model". Chỉ dùng "*" khi bạn chủ ý cho phép mọi model.',
  "Allowlist of accepted session-key prefixes for inbound hook requests when caller-provided keys are enabled. Use narrow prefixes to prevent arbitrary session-key injection.":
    "Allowlist các tiền tố session-key được chấp nhận cho các yêu cầu hook đến khi khóa do bên gọi cung cấp được bật. Dùng các tiền tố hẹp để ngăn chèn session-key tùy ý.",
  "Allowlist of ACP target agent ids permitted for ACP runtime sessions. Empty means no additional allowlist restriction.":
    "Allowlist các id tác nhân đích ACP được phép cho các phiên runtime ACP. Để trống nghĩa là không có hạn chế allowlist bổ sung.",
  "Allowlist of agent IDs that hook mappings are allowed to target when selecting execution agents. Use this to constrain automation events to dedicated service agents and reduce blast radius if a hook token is exposed.":
    "Allowlist các ID tác nhân mà ánh xạ hook được phép nhắm tới khi chọn tác nhân thực thi. Dùng mục này để giới hạn các sự kiện tự động hóa vào các tác nhân dịch vụ chuyên dụng và giảm phạm vi ảnh hưởng nếu token hook bị lộ.",
  "Allowlist of target agent IDs permitted for agent_to_agent calls when orchestration is enabled. Use explicit allowlists to avoid uncontrolled cross-agent call graphs.":
    "Allowlist các ID tác nhân đích được phép cho các lệnh gọi agent_to_agent khi điều phối được bật. Dùng allowlist tường minh để tránh đồ thị gọi chéo giữa các tác nhân không được kiểm soát.",
  "Allows access to private-network address ranges from browser tooling. Default is disabled when unset; enable only for explicitly trusted private-network destinations.":
    "Cho phép truy cập các dải địa chỉ mạng riêng từ công cụ trình duyệt. Mặc định sẽ bị tắt khi không đặt; chỉ bật cho các đích mạng riêng được tin cậy rõ ràng.",
  "Allows callers to supply a session key in hook requests when true, enabling caller-controlled routing. Keep false unless trusted integrators explicitly need custom session threading.":
    "Cho phép bên gọi cung cấp session key trong các yêu cầu hook khi là true, bật định tuyến do bên gọi kiểm soát. Giữ là false trừ khi các bộ tích hợp đáng tin cậy thực sự cần luồng phiên tùy chỉnh.",
  "Allows less-sanitized external Gmail content to pass into processing when enabled. Keep disabled for safer defaults, and enable only for trusted mail streams with controlled transforms.":
    "Cho phép nội dung Gmail bên ngoài ít được làm sạch hơn đi vào quá trình xử lý khi được bật. Giữ tắt để có mặc định an toàn hơn, và chỉ bật cho các luồng thư đáng tin cậy với các phép biến đổi được kiểm soát.",
  "Allows trusted Tailscale identity paths to satisfy gateway auth checks when configured. Use this only when your tailnet identity posture is strong and operator workflows depend on it.":
    "Cho phép các đường dẫn danh tính Tailscale đáng tin cậy đáp ứng các kiểm tra xác thực gateway khi được cấu hình. Chỉ dùng mục này khi tư thế danh tính tailnet của bạn mạnh và quy trình vận hành phụ thuộc vào nó.",
  "APNs delivery settings for iOS devices paired to this gateway. Use relay settings for official/TestFlight builds that register through the external push relay.":
    "Cài đặt phân phối APNs cho các thiết bị iOS được ghép nối với gateway này. Dùng cài đặt relay cho các bản dựng chính thức/TestFlight đăng ký thông qua relay push bên ngoài.",
  "Applies a legacy idle reset window in minutes for session reuse behavior across inactivity gaps. Use this only for compatibility and prefer structured reset policies under session.reset/session.resetByType.":
    "Áp dụng khoảng thời gian đặt lại nhàn rỗi kiểu cũ tính bằng phút cho hành vi tái sử dụng phiên qua các khoảng không hoạt động. Chỉ dùng mục này để tương thích và ưu tiên các chính sách đặt lại có cấu trúc trong session.reset/session.resetByType.",
  "Applies recency decay so newer memory can outrank older memory when scores are close. Enable when timeliness matters; keep off for timeless reference knowledge.":
    "Áp dụng suy giảm theo độ mới để bộ nhớ mới hơn có thể xếp trên bộ nhớ cũ hơn khi điểm số gần nhau. Bật khi tính kịp thời quan trọng; giữ tắt cho tri thức tham chiếu không phụ thuộc thời gian.",
  "apply_patch Workspace-Only": "apply_patch Chỉ Workspace",
  "Approval Agent Filter": "Bộ lọc tác nhân phê duyệt",
  "Approval Forwarding Mode": "Chế độ chuyển tiếp phê duyệt",
  "Approval Forwarding Targets": "Đích chuyển tiếp phê duyệt",
  "Approval routing controls for forwarding exec and plugin approval requests to chat destinations outside the originating session. Keep these disabled unless operators need explicit out-of-band approval visibility.":
    "Các điều khiển định tuyến phê duyệt để chuyển tiếp yêu cầu phê duyệt exec và plugin đến các đích trò chuyện bên ngoài phiên khởi tạo. Hãy giữ các mục này ở trạng thái tắt trừ khi người vận hành cần khả năng hiển thị phê duyệt ngoài băng tần một cách rõ ràng.",
  "Approval Session Filter": "Bộ lọc phiên phê duyệt",
  "Approval strategy for when exec commands require human confirmation before running. Use stricter ask behavior in shared channels and lower-friction settings in private operator contexts.":
    "Chiến lược phê duyệt khi các lệnh exec yêu cầu xác nhận của con người trước khi chạy. Sử dụng hành vi ask nghiêm ngặt hơn trong các kênh dùng chung và các thiết lập ít cản trở hơn trong ngữ cảnh người vận hành riêng tư.",
  "Approval Target Account ID": "ID tài khoản đích phê duyệt",
  "Approval Target Channel": "Kênh đích phê duyệt",
  "Approval Target Destination": "Đích phê duyệt",
  "Approval Target Thread ID": "ID luồng đích phê duyệt",
  Approvals: "Phê duyệt",
  "Approximate city sent to native Codex web search.":
    "Thành phố gần đúng được gửi đến tìm kiếm web Codex gốc.",
  "Approximate country sent to native Codex web search.":
    "Quốc gia gần đúng được gửi đến tìm kiếm web Codex gốc.",
  "Approximate region/state sent to native Codex web search.":
    "Khu vực/tỉnh bang gần đúng được gửi đến tìm kiếm web Codex gốc.",
  "Approximate timezone sent to native Codex web search.":
    "Múi giờ gần đúng được gửi đến tìm kiếm web Codex gốc.",
  "Assistant Appearance": "Giao diện trợ lý",
  "Assistant Avatar": "Ảnh đại diện trợ lý",
  "Assistant avatar image source used in UI surfaces (URL, path, or data URI depending on runtime support). Use trusted assets and consistent branding dimensions for clean rendering.":
    "Nguồn hình ảnh ảnh đại diện trợ lý được dùng trên các bề mặt UI (URL, đường dẫn hoặc data URI tùy theo hỗ trợ của môi trường chạy). Hãy dùng tài nguyên đáng tin cậy và kích thước thương hiệu nhất quán để hiển thị gọn gàng.",
  "Assistant display identity settings for name and avatar shown in UI surfaces. Keep these values aligned with your operator-facing persona and support expectations.":
    "Cài đặt nhận diện hiển thị của trợ lý cho tên và ảnh đại diện được hiển thị trên các bề mặt UI. Hãy giữ các giá trị này phù hợp với hình ảnh hướng tới người vận hành và kỳ vọng hỗ trợ của bạn.",
  "Assistant Name": "Tên trợ lý",
  "Async Media Completion Direct Send": "Gửi trực tiếp hoàn tất phương tiện không đồng bộ",
  "Attachment eligibility policy for video analysis, defining which message files can trigger video processing. Keep this explicit in shared channels to prevent accidental large media workloads.":
    "Chính sách điều kiện áp dụng cho tệp đính kèm đối với phân tích video, xác định những tệp tin nhắn nào có thể kích hoạt xử lý video. Hãy giữ thiết lập này rõ ràng trong các kênh dùng chung để tránh vô tình tạo khối lượng công việc phương tiện lớn.",
  "Attachment handling policy for image inputs, including which message attachments qualify for image analysis. Use restrictive settings in untrusted channels to reduce unexpected processing.":
    "Chính sách xử lý tệp đính kèm cho đầu vào hình ảnh, bao gồm những tệp đính kèm tin nhắn nào đủ điều kiện cho phân tích hình ảnh. Hãy dùng các thiết lập hạn chế trong các kênh không đáng tin cậy để giảm xử lý ngoài dự kiến.",
  "Attachment policy for audio inputs indicating which uploaded files are eligible for audio processing. Keep restrictive defaults in mixed-content channels to avoid unintended audio workloads.":
    "Chính sách tệp đính kèm cho đầu vào âm thanh, cho biết những tệp đã tải lên nào đủ điều kiện để xử lý âm thanh. Hãy giữ mặc định hạn chế trong các kênh có nội dung hỗn hợp để tránh khối lượng công việc âm thanh ngoài ý muốn.",
  Audio: "Âm thanh",
  "Audio Request Auth Header Name": "Tên Header xác thực yêu cầu âm thanh",
  "Audio Request Auth Header Prefix": "Tiền tố Header xác thực yêu cầu âm thanh",
  "Audio Request Auth Header Value": "Giá trị Header xác thực yêu cầu âm thanh",
  "Audio Request Auth Mode": "Chế độ xác thực yêu cầu âm thanh",
  "Audio Request Auth Override": "Ghi đè xác thực yêu cầu âm thanh",
  "Audio Request Bearer Token": "Bearer Token yêu cầu âm thanh",
  "Audio Request Headers": "Header yêu cầu âm thanh",
  "Audio Request Overrides": "Ghi đè yêu cầu âm thanh",
  "Audio Request Proxy": "Proxy yêu cầu âm thanh",
  "Audio Request Proxy Mode": "Chế độ proxy yêu cầu âm thanh",
  "Audio Request Proxy TLS": "TLS proxy yêu cầu âm thanh",
  "Audio Request Proxy URL": "URL proxy yêu cầu âm thanh",
  "Audio Request TLS": "TLS yêu cầu âm thanh",
  "Audio Transcription": "Phiên âm thanh",
  "Audio Transcription Command": "Lệnh phiên âm thanh",
  "Audio Transcription Timeout (sec)": "Thời gian chờ phiên âm thanh (giây)",
  "Audio Understanding Attachment Policy": "Chính sách tệp đính kèm hiểu âm thanh",
  "Audio Understanding Language": "Ngôn ngữ hiểu âm thanh",
  "Audio Understanding Max Bytes": "Số byte tối đa cho hiểu âm thanh",
  "Audio Understanding Max Chars": "Số ký tự tối đa cho hiểu âm thanh",
  "Audio Understanding Models": "Mô hình hiểu âm thanh",
  "Audio Understanding Prompt": "Prompt hiểu âm thanh",
  "Audio Understanding Scope": "Phạm vi hiểu âm thanh",
  "Audio Understanding Timeout (sec)": "Thời gian chờ hiểu âm thanh (giây)",
  Auth: "Xác thực",
  "Auth Cooldowns": "Thời gian chờ xác thực",
  'Auth override mode for audio requests: "provider-default" keeps the normal provider auth, "authorization-bearer" forces an Authorization bearer token, and "header" sends a custom header/value pair.':
    'Chế độ ghi đè xác thực cho yêu cầu âm thanh: "provider-default" giữ xác thực nhà cung cấp thông thường, "authorization-bearer" buộc dùng bearer token Authorization, và "header" gửi một cặp header/giá trị tùy chỉnh.',
  'Auth override mode: "provider-default", "authorization-bearer", or "header".':
    'Chế độ ghi đè xác thực: "provider-default", "authorization-bearer", hoặc "header".',
  "Auth Profile Order": "Thứ tự hồ sơ xác thực",
  "Auth Profiles": "Hồ sơ xác thực",
  "Auth-Permanent Backoff (minutes)": "Thời gian lùi Auth-Permanent (phút)",
  "Auth-Permanent Backoff Cap (minutes)": "Giới hạn thời gian lùi Auth-Permanent (phút)",
  "Authentication policy for gateway HTTP/WebSocket access including mode, credentials, trusted-proxy behavior, and rate limiting. Keep auth enabled for every non-loopback deployment.":
    "Chính sách xác thực cho quyền truy cập HTTP/WebSocket của Gateway, bao gồm chế độ, thông tin xác thực, hành vi trusted-proxy và giới hạn tốc độ. Luôn bật xác thực cho mọi triển khai không phải loopback.",
  "Authentication profile root used for multi-profile provider credentials and cooldown-based failover ordering. Keep profiles minimal and explicit so automatic failover behavior stays auditable.":
    "Gốc hồ sơ xác thực dùng cho thông tin xác thực nhà cung cấp nhiều hồ sơ và thứ tự chuyển đổi dự phòng dựa trên thời gian chờ. Giữ hồ sơ ở mức tối giản và tường minh để hành vi chuyển đổi dự phòng tự động luôn có thể kiểm tra được.",
  "Auto Update Beta Check Interval (hours)":
    "Khoảng thời gian kiểm tra beta cập nhật tự động (giờ)",
  "Auto Update Enabled": "Bật cập nhật tự động",
  "Auto Update Stable Delay (hours)": "Độ trễ ổn định cập nhật tự động (giờ)",
  "Auto Update Stable Jitter (hours)": "Độ dao động ổn định cập nhật tự động (giờ)",
  "Auto-generates a local TLS certificate/key pair when explicit files are not configured. Use only for local/dev setups and replace with real certificates for production traffic.":
    "Tự động tạo cặp chứng chỉ/khóa TLS cục bộ khi chưa cấu hình tệp tường minh. Chỉ dùng cho thiết lập cục bộ/dev và thay bằng chứng chỉ thật cho lưu lượng production.",
  "Auto-set when OpenClaw writes the config.": "Tự động đặt khi OpenClaw ghi cấu hình.",
  "Automatic session-store maintenance controls for pruning age, entry caps, and file rotation behavior. Start in warn mode to observe impact, then enforce once thresholds are tuned.":
    "Các điều khiển bảo trì tự động cho session-store để cắt tỉa theo tuổi, giới hạn số mục và hành vi xoay vòng tệp. Bắt đầu ở chế độ cảnh báo để quan sát tác động, sau đó mới thực thi khi các ngưỡng đã được tinh chỉnh.",
  "Automatically indexes default memory files (MEMORY.md and memory/**/*.md) into QMD collections. Keep enabled unless you want indexing controlled only through explicit custom paths.":
    "Tự động lập chỉ mục các tệp bộ nhớ mặc định (MEMORY.md và memory/**/*.md) vào các bộ sưu tập QMD. Giữ bật trừ khi bạn muốn việc lập chỉ mục chỉ được kiểm soát thông qua các đường dẫn tùy chỉnh tường minh.",
  "Automatically starts the mcporter daemon when mcporter-backed QMD mode is enabled (default: true). Keep enabled unless process lifecycle is managed externally by your service supervisor.":
    "Tự động khởi động daemon mcporter khi chế độ QMD dùng mcporter được bật (mặc định: true). Giữ bật trừ khi vòng đời tiến trình được quản lý bên ngoài bởi service supervisor của bạn.",
  "Avatar image path (relative to the agent workspace only) or a remote URL/data URL.":
    "Đường dẫn ảnh đại diện (chỉ tương đối với workspace của tác nhân) hoặc URL từ xa/data URL.",
  "Backoff delays in ms for each retry attempt (default: [30000, 60000, 300000]). Use shorter values for faster retries.":
    "Độ trễ backoff tính bằng ms cho mỗi lần thử lại (mặc định: [30000, 60000, 300000]). Dùng giá trị ngắn hơn để thử lại nhanh hơn.",
  'Backup provider used when primary embeddings fail: "openai", "gemini", "voyage", "mistral", "ollama", "local", or "none". Set a real fallback for production reliability; use "none" only if you prefer explicit failures.':
    'Nhà cung cấp dự phòng dùng khi embeddings chính thất bại: "openai", "gemini", "voyage", "mistral", "ollama", "local", hoặc "none". Đặt một phương án dự phòng thực cho độ tin cậy production; chỉ dùng "none" nếu bạn muốn lỗi tường minh.',
  "Base backoff (hours) when a profile fails due to billing/insufficient credits (default: 5).":
    "Thời gian backoff cơ bản (giờ) khi một hồ sơ thất bại do thanh toán/không đủ tín dụng (mặc định: 5).",
  "Base backoff (minutes) for high-confidence auth_permanent failures (default: 10). Keep this shorter than billing so providers recover automatically after transient upstream auth incidents.":
    "Thời gian backoff cơ bản (phút) cho các lỗi auth_permanent có độ tin cậy cao (mặc định: 10). Giữ giá trị này ngắn hơn thanh toán để nhà cung cấp tự động khôi phục sau các sự cố xác thực upstream tạm thời.",
  "Base directory for hook transform modules referenced by mapping transform.module paths. Use a controlled repo directory so dynamic imports remain reviewable and predictable.":
    "Thư mục cơ sở cho các mô-đun biến đổi hook được tham chiếu bởi các đường dẫn mapping transform.module. Sử dụng một thư mục repo được kiểm soát để các dynamic import luôn có thể được rà soát và dự đoán được.",
  "Base HTTPS URL for the external APNs relay service used by official/TestFlight iOS builds. Keep this aligned with the relay URL baked into the iOS build so registration and send traffic hit the same deployment.":
    "URL HTTPS cơ sở cho dịch vụ relay APNs bên ngoài được dùng bởi các bản dựng iOS chính thức/TestFlight. Giữ giá trị này đồng bộ với URL relay được tích hợp sẵn trong bản dựng iOS để lưu lượng đăng ký và gửi đều đến cùng một triển khai.",
  "Base URL for the provider endpoint used to serve model requests for that provider entry. Use HTTPS endpoints and keep URLs environment-specific through config templating where needed.":
    "URL cơ sở cho endpoint nhà cung cấp được dùng để phục vụ các yêu cầu mô hình cho mục nhà cung cấp đó. Sử dụng các endpoint HTTPS và giữ URL theo từng môi trường thông qua config templating khi cần.",
  "Bash Foreground Window (ms)": "Cửa sổ tiền cảnh Bash (ms)",
  "Bearer token attached to cron webhook POST deliveries when webhook mode is used. Prefer secret/env substitution and rotate this token regularly if shared webhook endpoints are internet-reachable.":
    "Bearer token được đính kèm vào các lần gửi POST webhook cron khi dùng chế độ webhook. Ưu tiên thay thế bằng secret/env và xoay vòng token này thường xuyên nếu các endpoint webhook dùng chung có thể truy cập từ internet.",
  "Bearer token used to authenticate this client to a remote gateway in token-auth deployments. Store via secret/env substitution and rotate alongside remote gateway auth changes.":
    "Bearer token được dùng để xác thực client này với một gateway từ xa trong các triển khai token-auth. Lưu trữ qua thay thế secret/env và xoay vòng cùng với các thay đổi xác thực gateway từ xa.",
  "Bearer token used when audio request auth.mode is authorization-bearer. Keep this in secret storage rather than inline config.":
    "Bearer token được dùng khi auth.mode của yêu cầu âm thanh là authorization-bearer. Giữ giá trị này trong kho lưu trữ bí mật thay vì config nội tuyến.",
  "Bearer token used when auth mode is authorization-bearer.":
    "Bearer token được dùng khi chế độ auth là authorization-bearer.",
  "Billing Backoff (hours)": "Backoff thanh toán (giờ)",
  "Billing Backoff Cap (hours)": "Giới hạn backoff thanh toán (giờ)",
  "Billing Backoff Overrides": "Ghi đè backoff thanh toán",
  "Bind address for the local Gmail callback HTTP server used when serving hooks directly. Keep loopback-only unless external ingress is intentionally required.":
    "Địa chỉ bind cho máy chủ HTTP callback Gmail cục bộ được dùng khi phục vụ hook trực tiếp. Chỉ giữ ở loopback trừ khi cố ý yêu cầu ingress bên ngoài.",
  "Binding Account ID": "ID tài khoản liên kết",
  "Binding Agent ID": "ID tác nhân liên kết",
  "Binding Channel": "Kênh liên kết",
  "Binding Guild ID": "ID guild liên kết",
  'Binding kind. Use "route" (or omit for legacy route entries) for normal routing, and "acp" for persistent ACP conversation bindings.':
    'Loại liên kết. Dùng "route" (hoặc bỏ qua đối với các mục route cũ) cho định tuyến thông thường, và "acp" cho các liên kết hội thoại ACP liên tục.',
  "Binding Match Rule": "Quy tắc khớp liên kết",
  "Binding Peer ID": "ID peer liên kết",
  "Binding Peer Kind": "Loại peer liên kết",
  "Binding Peer Match": "Khớp peer liên kết",
  "Binding Roles": "Vai trò liên kết",
  "Binding Team ID": "ID nhóm liên kết",
  "Binding Type": "Loại liên kết",
  Bindings: "Liên kết",
  "Blocks startup completion until the initial boot-time QMD sync finishes (default: false). Enable when you need fully up-to-date recall before serving traffic, and keep off for faster boot.":
    "Chặn hoàn tất khởi động cho đến khi quá trình đồng bộ QMD ban đầu lúc khởi động hoàn tất (mặc định: false). Bật khi bạn cần khả năng truy xuất luôn được cập nhật đầy đủ trước khi phục vụ lưu lượng, và giữ tắt để khởi động nhanh hơn.",
  "Bootstrap Max Chars": "Số ký tự tối đa khi khởi tạo",
  "Bootstrap Prompt Truncation Warning": "Cảnh báo cắt ngắn prompt khi khởi tạo",
  "Bootstrap Total Max Chars": "Tổng số ký tự tối đa khi khởi tạo",
  "Brave Search Mode": "Chế độ Brave Search",
  'Brave Search mode: "web" (URL results) or "llm-context" (pre-extracted page content for LLM grounding).':
    'Chế độ Brave Search: "web" (kết quả URL) hoặc "llm-context" (nội dung trang được trích xuất sẵn để làm ngữ cảnh cho LLM).',
  Broadcast: "Phát tán",
  "Broadcast Destination List": "Danh sách đích phát tán",
  "Broadcast routing map for sending the same outbound message to multiple peer IDs per source conversation. Keep this minimal and audited because one source can fan out to many destinations.":
    "Bản đồ định tuyến phát tán để gửi cùng một tin nhắn đi đến nhiều ID ngang hàng cho mỗi cuộc hội thoại nguồn. Giữ cấu hình này ở mức tối thiểu và được kiểm tra kỹ vì một nguồn có thể phân phối đến nhiều đích.",
  "Broadcast Strategy": "Chiến lược phát tán",
  Browser: "Trình duyệt",
  "Browser Accent Color": "Màu nhấn của trình duyệt",
  "Browser Allowed Hostnames": "Tên máy chủ được phép cho trình duyệt",
  "Browser Attach-only Mode": "Chế độ chỉ đính kèm của trình duyệt",
  "Browser CDP Port Range Start": "Cổng bắt đầu của dải cổng CDP trình duyệt",
  "Browser CDP URL": "URL CDP của trình duyệt",
  "Browser Dangerously Allow Private Network":
    "Cho phép mạng riêng trên trình duyệt theo cách không an toàn",
  "Browser Default Profile": "Hồ sơ mặc định của trình duyệt",
  "Browser Enabled": "Bật trình duyệt",
  "Browser Evaluate Enabled": "Bật evaluate trên trình duyệt",
  "Browser Executable Path": "Đường dẫn tệp thực thi của trình duyệt",
  "Browser Headless Mode": "Chế độ không giao diện của trình duyệt",
  "Browser Hostname Allowlist": "Danh sách cho phép hostname của trình duyệt",
  "Browser No-Sandbox Mode": "Chế độ không sandbox của trình duyệt",
  "Browser Profile Accent Color": "Màu nhấn của hồ sơ trình duyệt",
  "Browser Profile Attach-only Mode": "Chế độ chỉ đính kèm của hồ sơ trình duyệt",
  "Browser Profile CDP Port": "Cổng CDP của hồ sơ trình duyệt",
  "Browser Profile CDP URL": "URL CDP của hồ sơ trình duyệt",
  "Browser Profile Driver": "Trình điều khiển của hồ sơ trình duyệt",
  "Browser Profile User Data Dir": "Thư mục dữ liệu người dùng của hồ sơ trình duyệt",
  "Browser Profiles": "Hồ sơ trình duyệt",
  "Browser runtime controls for local or remote CDP attachment, profile routing, and screenshot/snapshot behavior. Keep defaults unless your automation workflow requires custom browser transport settings.":
    "Các tùy chọn điều khiển thời gian chạy của trình duyệt cho việc đính kèm CDP cục bộ hoặc từ xa, định tuyến hồ sơ và hành vi chụp ảnh màn hình/ảnh chụp nhanh. Giữ mặc định trừ khi quy trình tự động hóa của bạn yêu cầu cài đặt truyền tải trình duyệt tùy chỉnh.",
  "Browser Snapshot Defaults": "Mặc định ảnh chụp nhanh của trình duyệt",
  "Browser Snapshot Mode": "Chế độ ảnh chụp nhanh của trình duyệt",
  "Browser SSRF Policy": "Chính sách SSRF của trình duyệt",
  "Cache Trace": "Theo dõi bộ nhớ đệm",
  "Cache Trace Enabled": "Bật theo dõi bộ nhớ đệm",
  "Cache Trace File Path": "Đường dẫn tệp theo dõi bộ nhớ đệm",
  "Cache Trace Include Messages": "Bao gồm tin nhắn trong theo dõi bộ nhớ đệm",
  "Cache Trace Include Prompt": "Bao gồm prompt trong theo dõi bộ nhớ đệm",
  "Cache Trace Include System": "Bao gồm system trong theo dõi bộ nhớ đệm",
  "Cache TTL in minutes for web_fetch results.":
    "TTL bộ nhớ đệm tính bằng phút cho kết quả web_fetch.",
  "Cache TTL in minutes for web_search results.":
    "TTL bộ nhớ đệm tính bằng phút cho kết quả web_search.",
  "Cache-trace logging settings for observing cache decisions and payload context in embedded runs. Enable this temporarily for debugging and disable afterward to reduce sensitive log footprint.":
    "Cài đặt ghi nhật ký theo dõi bộ nhớ đệm để quan sát các quyết định bộ nhớ đệm và ngữ cảnh payload trong các lần chạy nhúng. Chỉ bật tạm thời để gỡ lỗi và tắt sau đó nhằm giảm dấu vết nhật ký nhạy cảm.",
  "Caches computed chunk embeddings in SQLite so reindexing and incremental updates run faster (default: true). Keep this enabled unless investigating cache correctness or minimizing disk usage.":
    "Lưu vào bộ nhớ đệm các embedding chunk đã tính toán trong SQLite để việc lập chỉ mục lại và cập nhật gia tăng chạy nhanh hơn (mặc định: true). Hãy giữ bật tùy chọn này trừ khi đang kiểm tra tính chính xác của bộ nhớ đệm hoặc muốn giảm mức sử dụng đĩa.",
  "Canvas Host": "Máy chủ Canvas",
  "Canvas Host Enabled": "Bật máy chủ Canvas",
  "Canvas Host Live Reload": "Tải lại trực tiếp máy chủ Canvas",
  "Canvas Host Port": "Cổng máy chủ Canvas",
  "Canvas Host Root Directory": "Thư mục gốc máy chủ Canvas",
  "Canvas host settings for serving canvas assets and local live-reload behavior used by canvas-enabled workflows. Keep disabled unless canvas-hosted assets are actively used.":
    "Cài đặt máy chủ Canvas để phục vụ tài nguyên canvas và hành vi tải lại trực tiếp cục bộ được dùng bởi các quy trình công việc hỗ trợ canvas. Giữ ở trạng thái tắt trừ khi đang chủ động sử dụng tài nguyên được lưu trữ trên canvas.",
  "Cap (hours) for billing backoff (default: 24).":
    "Giới hạn (giờ) cho thời gian lùi thanh toán (mặc định: 24).",
  "Cap (minutes) for auth_permanent backoff (default: 60).":
    "Giới hạn (phút) cho thời gian lùi auth_permanent (mặc định: 60).",
  "Caps how much QMD text can be injected into one turn across all hits. Use lower values to control prompt bloat and latency; raise only when context is consistently truncated.":
    "Giới hạn lượng văn bản QMD có thể được chèn vào một lượt trên tất cả kết quả khớp. Dùng giá trị thấp hơn để kiểm soát việc prompt phình to và độ trễ; chỉ tăng khi ngữ cảnh thường xuyên bị cắt bớt.",
  "Caps per-result snippet length extracted from QMD hits in characters (default: 700). Lower this when prompts bloat quickly, and raise only if answers consistently miss key details.":
    "Giới hạn độ dài đoạn trích trên mỗi kết quả được trích từ các kết quả khớp QMD theo số ký tự (mặc định: 700). Giảm giá trị này khi prompt nhanh chóng phình to, và chỉ tăng nếu câu trả lời thường xuyên bỏ sót chi tiết quan trọng.",
  "Caps total session entry count retained in the store to prevent unbounded growth over time. Use lower limits for constrained environments, or higher limits when longer history is required.":
    "Giới hạn tổng số mục phiên được giữ lại trong kho lưu trữ để ngăn tăng trưởng không giới hạn theo thời gian. Dùng giới hạn thấp hơn cho môi trường bị ràng buộc tài nguyên, hoặc cao hơn khi cần lịch sử dài hơn.",
  "Channel Defaults": "Mặc định kênh",
  "Channel Model Overrides": "Ghi đè mô hình theo kênh",
  "Channel provider configurations plus shared defaults that control access policies, heartbeat visibility, and per-surface behavior. Keep defaults centralized and override per provider only where required.":
    "Cấu hình nhà cung cấp kênh cùng với các giá trị mặc định dùng chung để kiểm soát chính sách truy cập, khả năng hiển thị heartbeat và hành vi theo từng bề mặt. Giữ các giá trị mặc định được tập trung và chỉ ghi đè theo từng nhà cung cấp khi cần.",
  "Channel/provider ID used for forwarded approval delivery, such as discord, slack, or a plugin channel id. Use valid channel IDs only so approvals do not silently fail due to unknown routes.":
    "ID kênh/nhà cung cấp dùng để chuyển tiếp việc gửi phê duyệt, chẳng hạn như discord, slack hoặc ID kênh plugin. Chỉ dùng ID kênh hợp lệ để việc phê duyệt không âm thầm thất bại do tuyến không xác định.",
  "Channel/provider ID used for forwarded plugin approval delivery, such as discord, slack, or a plugin channel id.":
    "ID kênh/nhà cung cấp dùng để chuyển tiếp việc gửi phê duyệt plugin, chẳng hạn như discord, slack hoặc ID kênh plugin.",
  "Channel/provider identifier this binding applies to, such as `telegram`, `discord`, or a plugin channel ID. Use the configured channel key exactly so binding evaluation works reliably.":
    "Định danh kênh/nhà cung cấp mà liên kết này áp dụng, chẳng hạn như `telegram`, `discord` hoặc ID kênh plugin. Dùng chính xác khóa kênh đã cấu hình để việc đánh giá liên kết hoạt động ổn định.",
  Channels: "Kênh",
  "Check for npm updates when the gateway starts (default: true).":
    "Kiểm tra cập nhật npm khi gateway khởi động (mặc định: true).",
  'Chooses which sources are indexed: "memory" reads MEMORY.md + memory files, and "sessions" includes transcript history. Keep ["memory"] unless you need recall from prior chat transcripts.':
    'Chọn nguồn nào được lập chỉ mục: "memory" đọc MEMORY.md + các tệp memory, và "sessions" bao gồm lịch sử bản ghi hội thoại. Giữ ["memory"] trừ khi bạn cần khả năng nhớ lại từ các bản ghi trò chuyện trước đó.',
  "Chunk size in tokens used when splitting memory sources before embedding/indexing. Increase for broader context per chunk, or lower to improve precision on pinpoint lookups.":
    "Kích thước khối theo token được dùng khi tách các nguồn memory trước khi embedding/lập chỉ mục. Tăng để có ngữ cảnh rộng hơn cho mỗi khối, hoặc giảm để cải thiện độ chính xác khi tra cứu chi tiết.",
  "CIDR/IP allowlist of upstream proxies permitted to provide forwarded client identity headers. Keep this list narrow so untrusted hops cannot impersonate users.":
    "Danh sách cho phép CIDR/IP của các proxy thượng nguồn được phép cung cấp các header danh tính máy khách được chuyển tiếp. Giữ danh sách này ở phạm vi hẹp để các bước nhảy không đáng tin cậy không thể mạo danh người dùng.",
  "CLI Backends": "Backend CLI",
  "CLI Banner": "Biểu ngữ CLI",
  "CLI Banner Tagline Mode": "Chế độ khẩu hiệu biểu ngữ CLI",
  "CLI presentation controls for local command output behavior such as banner and tagline style. Use this section to keep startup output aligned with operator preference without changing runtime behavior.":
    "Các tùy chọn trình bày của CLI cho hành vi đầu ra lệnh cục bộ như kiểu biểu ngữ và khẩu hiệu. Sử dụng phần này để giữ đầu ra khởi động phù hợp với tùy chọn của người vận hành mà không thay đổi hành vi khi chạy.",
  "CLI startup banner controls for title/version line and tagline style behavior. Keep banner enabled for fast version/context checks, then tune tagline mode to your preferred noise level.":
    "Các tùy chọn biểu ngữ khởi động CLI cho hành vi của dòng tiêu đề/phiên bản và kiểu khẩu hiệu. Giữ biểu ngữ được bật để kiểm tra nhanh phiên bản/ngữ cảnh, sau đó điều chỉnh chế độ khẩu hiệu theo mức độ nhiễu bạn mong muốn.",
  "CLI-managed install metadata (used by `openclaw plugins update` to locate install sources).":
    "Siêu dữ liệu cài đặt do CLI quản lý (được `openclaw plugins update` sử dụng để xác định nguồn cài đặt).",
  "Client TLS certificate presented to the proxy when mutual TLS is required.":
    "Chứng chỉ TLS phía máy khách được gửi tới proxy khi yêu cầu mutual TLS.",
  "Client TLS certificate presented to the upstream endpoint when mutual TLS is required.":
    "Chứng chỉ TLS phía máy khách được gửi tới điểm cuối upstream khi yêu cầu mutual TLS.",
  "Coalescer idle flush window in milliseconds for ACP streamed text before block replies are emitted.":
    "Khoảng thời gian flush khi nhàn rỗi của bộ coalescer tính bằng mili giây cho văn bản truyền luồng ACP trước khi phản hồi khối được phát ra.",
  "Codex Allowed Domains": "Miền được phép của Codex",
  "Codex Search Context Size": "Kích thước ngữ cảnh tìm kiếm Codex",
  "Codex User City": "Thành phố người dùng Codex",
  "Codex User Country": "Quốc gia người dùng Codex",
  "Codex User Region": "Vùng người dùng Codex",
  "Codex User Timezone": "Múi giờ người dùng Codex",
  "Codex Web Search Mode": "Chế độ tìm kiếm web Codex",
  "Collector endpoint URL used for OpenTelemetry export transport, including scheme and port. Use a reachable, trusted collector endpoint and monitor ingestion errors after rollout.":
    "URL điểm cuối collector dùng cho truyền tải xuất OpenTelemetry, bao gồm scheme và cổng. Hãy dùng một điểm cuối collector có thể truy cập và đáng tin cậy, đồng thời theo dõi lỗi tiếp nhận sau khi triển khai.",
  "Combines BM25 keyword matching with vector similarity for better recall on mixed exact + semantic queries. Keep enabled unless you are isolating ranking behavior for troubleshooting.":
    "Kết hợp đối sánh từ khóa BM25 với độ tương đồng vector để cải thiện khả năng truy hồi cho các truy vấn kết hợp chính xác + ngữ nghĩa. Hãy giữ bật trừ khi bạn đang cô lập hành vi xếp hạng để khắc phục sự cố.",
  "Command Elevated Access Rules": "Quy tắc truy cập nâng cao cho lệnh",
  "Command invocation recorded for the latest wizard run to preserve execution context. Use this to reproduce setup steps when verifying setup regressions.":
    "Lệnh gọi được ghi lại cho lần chạy wizard gần nhất để bảo toàn ngữ cảnh thực thi. Hãy dùng mục này để tái tạo các bước thiết lập khi xác minh hồi quy thiết lập.",
  "Command Owners": "Chủ sở hữu lệnh",
  "Command-based transcription settings for converting audio files into text before agent handling. Keep a simple, deterministic command path here so failures are easy to diagnose in logs.":
    "Cài đặt phiên âm dựa trên lệnh để chuyển đổi tệp âm thanh thành văn bản trước khi tác nhân xử lý. Hãy giữ đường dẫn lệnh ở đây đơn giản và xác định để dễ chẩn đoán lỗi trong nhật ký.",
  Commands: "Lệnh",
  Compaction: "Nén gọn",
  "Compaction Identifier Instructions": "Hướng dẫn định danh nén gọn",
  "Compaction Identifier Policy": "Chính sách định danh nén gọn",
  "Compaction Keep Recent Tokens": "Giữ lại token gần đây của nén gọn",
  "Compaction Max History Share": "Tỷ lệ lịch sử tối đa của nén gọn",
  "Compaction Memory Flush": "Xả bộ nhớ của nén gọn",
  "Compaction Memory Flush Enabled": "Bật xả bộ nhớ của nén gọn",
  "Compaction Memory Flush Prompt": "Prompt xả bộ nhớ của nén gọn",
  "Compaction Memory Flush Soft Threshold": "Ngưỡng mềm xả bộ nhớ của nén gọn",
  "Compaction Memory Flush System Prompt": "System Prompt xả bộ nhớ của nén gọn",
  "Compaction Memory Flush Transcript Size Threshold":
    "Ngưỡng kích thước bản ghi xả bộ nhớ của nén gọn",
  "Compaction Mode": "Chế độ nén gọn",
  "Compaction Model Override": "Ghi đè model nén gọn",
  "Compaction Notify User": "Thông báo người dùng về nén gọn",
  "Compaction Post-Index Sync": "Đồng bộ sau lập chỉ mục của nén gọn",
  "Compaction Preserve Recent Turns": "Giữ lại các lượt gần đây của nén gọn",
  "Compaction Provider": "Nhà cung cấp nén gọn",
  "Compaction Quality Guard": "Bộ bảo vệ chất lượng của nén gọn",
  "Compaction Quality Guard Enabled": "Bật bộ bảo vệ chất lượng của nén gọn",
  "Compaction Quality Guard Max Retries": "Số lần thử lại tối đa của bộ bảo vệ chất lượng nén gọn",
  "Compaction Reserve Token Floor": "Mức sàn token dự trữ của nén gọn",
  "Compaction Reserve Tokens": "Token dự trữ của nén gọn",
  'Compaction strategy mode: "default" uses baseline behavior, while "safeguard" applies stricter guardrails to preserve recent context. Keep "default" unless you observe aggressive history loss near limit boundaries.':
    'Chế độ chiến lược nén gọn: "default" sử dụng hành vi cơ sở, trong khi "safeguard" áp dụng các biện pháp bảo vệ nghiêm ngặt hơn để giữ lại ngữ cảnh gần đây. Giữ "default" trừ khi bạn nhận thấy lịch sử bị mất quá mức gần các ngưỡng giới hạn.',
  "Compaction Timeout (Seconds)": "Thời gian chờ nén gọn (giây)",
  "Compaction tuning for when context nears token limits, including history share, reserve headroom, and pre-compaction memory flush behavior. Use this when long-running sessions need stable continuity under tight context windows.":
    "Tinh chỉnh nén gọn cho thời điểm ngữ cảnh tiến gần giới hạn token, bao gồm tỷ lệ lịch sử, khoảng đệm dự trữ và hành vi xả bộ nhớ trước khi nén gọn. Sử dụng mục này khi các phiên chạy dài cần duy trì tính liên tục ổn định trong cửa sổ ngữ cảnh chặt chẽ.",
  "Config Last Touched At": "Lần chạm cấu hình gần nhất lúc",
  "Config Last Touched Version": "Phiên bản được chạm cấu hình gần nhất",
  "Config Reload": "Tải lại cấu hình",
  "Config Reload Debounce (ms)": "Độ trễ chống dội khi tải lại cấu hình (ms)",
  "Config Reload Mode": "Chế độ tải lại cấu hình",
  "Configured internal hook entry records used to register concrete runtime handlers and metadata. Keep entries explicit and versioned so production behavior is auditable.":
    "Các bản ghi mục hook nội bộ đã cấu hình được dùng để đăng ký các trình xử lý runtime cụ thể và siêu dữ liệu. Giữ các mục rõ ràng và có phiên bản để hành vi production có thể được kiểm tra.",
  "Configured model catalog (keys are full provider/model IDs).":
    "Danh mục model đã cấu hình (các khóa là ID đầy đủ của provider/model).",
  "Console Log Level": "Mức log console",
  "Console Log Style": "Kiểu log console",
  'Console output format style: "pretty", "compact", or "json" based on operator and ingestion needs. Use json for machine parsing pipelines and pretty/compact for human-first terminal workflows.':
    'Kiểu định dạng đầu ra console: "pretty", "compact" hoặc "json" tùy theo nhu cầu của người vận hành và hệ thống tiếp nhận. Dùng json cho các pipeline phân tích cú pháp máy và pretty/compact cho quy trình terminal ưu tiên con người.',
  'Console-specific log threshold: "silent", "fatal", "error", "warn", "info", "debug", or "trace" for terminal output control. Use this to keep local console quieter while retaining richer file logging if needed.':
    'Ngưỡng log dành riêng cho console: "silent", "fatal", "error", "warn", "info", "debug" hoặc "trace" để kiểm soát đầu ra terminal. Dùng mục này để giữ console cục bộ ít ồn hơn trong khi vẫn duy trì ghi log file chi tiết hơn nếu cần.',
  "Context Engine Plugin": "Plugin Context Engine",
  "Context Injection": "Chèn ngữ cảnh",
  "Control UI Allowed Origins": "Nguồn gốc được phép của Control UI",
  "Control UI Assets Root": "Thư mục gốc tài nguyên của Control UI",
  "Control UI Base Path": "Đường dẫn cơ sở của Control UI",
  "Control UI Enabled": "Bật Control UI",
  "Control UI hosting settings including enablement, pathing, and browser-origin/auth hardening behavior. Keep UI exposure minimal and pair with strong auth controls before internet-facing deployments.":
    "Thiết lập lưu trữ Control UI bao gồm bật/tắt, đường dẫn và hành vi tăng cường bảo mật cho browser-origin/auth. Giữ mức phơi bày UI ở mức tối thiểu và kết hợp với kiểm soát xác thực mạnh trước khi triển khai hướng internet.",
  "Controls chat command surfaces, owner gating, and elevated command access behavior across providers. Keep defaults unless you need stricter operator controls or broader command availability.":
    "Kiểm soát các bề mặt lệnh chat, giới hạn theo owner và hành vi truy cập lệnh nâng cao trên các provider. Giữ mặc định trừ khi bạn cần kiểm soát người vận hành chặt chẽ hơn hoặc phạm vi lệnh rộng hơn.",
  'Controls citation visibility in replies: "auto" shows citations when useful, "on" always shows them, and "off" hides them. Keep "auto" for a balanced signal-to-noise default.':
    'Kiểm soát khả năng hiển thị trích dẫn trong phản hồi: "auto" hiển thị trích dẫn khi hữu ích, "on" luôn hiển thị và "off" sẽ ẩn chúng. Giữ "auto" để có mặc định cân bằng giữa tín hiệu và nhiễu.',
  "Controls cross-session send permissions using allow/deny rules evaluated against channel, chatType, and key prefixes. Use this to fence where session tools can deliver messages in complex environments.":
    "Kiểm soát quyền gửi liên phiên bằng các quy tắc allow/deny được đánh giá theo channel, chatType và tiền tố khóa. Dùng mục này để giới hạn nơi các công cụ phiên có thể gửi tin nhắn trong các môi trường phức tạp.",
  'Controls how config edits are applied: "off" ignores live edits, "restart" always restarts, "hot" applies in-process, and "hybrid" tries hot then restarts if required. Keep "hybrid" for safest routine updates.':
    'Kiểm soát cách áp dụng các chỉnh sửa cấu hình: "off" bỏ qua chỉnh sửa trực tiếp, "restart" luôn khởi động lại, "hot" áp dụng trong tiến trình và "hybrid" thử hot rồi khởi động lại nếu cần. Giữ "hybrid" để cập nhật định kỳ an toàn nhất.',
  "Controls how fast older memory loses rank when temporal decay is enabled (half-life in days, default: 30). Lower values prioritize recent context more aggressively.":
    "Kiểm soát tốc độ bộ nhớ cũ mất thứ hạng khi bật temporal decay (half-life tính theo ngày, mặc định: 30). Giá trị thấp hơn sẽ ưu tiên ngữ cảnh gần đây mạnh hơn.",
  "Controls how long completed cron run sessions are kept before pruning (`24h`, `7d`, `1h30m`, or `false` to disable pruning; default: `24h`). Use shorter retention to reduce storage growth on high-frequency schedules.":
    "Kiểm soát thời gian giữ các phiên chạy cron đã hoàn tất trước khi dọn dẹp (`24h`, `7d`, `1h30m` hoặc `false` để tắt dọn dẹp; mặc định: `24h`). Dùng thời gian lưu giữ ngắn hơn để giảm tăng trưởng lưu trữ với các lịch chạy tần suất cao.",
  "Controls how often the system polls provider APIs for batch job status in milliseconds (default: 2000). Use longer intervals to reduce API chatter, or shorter intervals for faster completion detection.":
    "Kiểm soát tần suất hệ thống thăm dò API của provider để lấy trạng thái batch job theo mili giây (mặc định: 2000). Dùng khoảng thời gian dài hơn để giảm lưu lượng API hoặc ngắn hơn để phát hiện hoàn tất nhanh hơn.",
  "Controls how owner IDs are rendered in the system prompt. Allowed values: raw, hash. Default: raw.":
    "Kiểm soát cách ID chủ sở hữu được hiển thị trong system prompt. Giá trị cho phép: raw, hash. Mặc định: raw.",
  "Controls how strongly BM25 keyword relevance influences hybrid ranking (0-1). Increase for exact-term matching; decrease when semantic matches should rank higher.":
    "Kiểm soát mức độ liên quan từ khóa BM25 ảnh hưởng đến xếp hạng kết hợp mạnh đến đâu (0-1). Tăng để ưu tiên khớp chính xác thuật ngữ; giảm khi các kết quả khớp ngữ nghĩa nên được xếp hạng cao hơn.",
  "Controls how strongly semantic similarity influences hybrid ranking (0-1). Increase when paraphrase matching matters more than exact terms; decrease for stricter keyword emphasis.":
    "Kiểm soát mức độ tương đồng ngữ nghĩa ảnh hưởng đến xếp hạng kết hợp mạnh đến đâu (0-1). Tăng khi việc khớp diễn đạt lại quan trọng hơn các thuật ngữ chính xác; giảm để nhấn mạnh từ khóa nghiêm ngặt hơn.",
  "Controls interval for repeated typing indicators while replies are being prepared in typing-capable channels. Increase to reduce chatty updates or decrease for more active typing feedback.":
    "Kiểm soát khoảng thời gian cho các chỉ báo đang nhập lặp lại trong khi phản hồi đang được chuẩn bị ở các kênh hỗ trợ trạng thái nhập. Tăng để giảm các cập nhật quá thường xuyên hoặc giảm để có phản hồi trạng thái nhập tích cực hơn.",
  'Controls post-compaction session memory reindex mode: "off", "async", or "await" (default: "async"). Use "await" for strongest freshness, "async" for lower compaction latency, and "off" only when session-memory sync is handled elsewhere.':
    'Kiểm soát chế độ lập chỉ mục lại bộ nhớ phiên sau khi nén gọn: "off", "async", hoặc "await" (mặc định: "async"). Dùng "await" để có độ mới mạnh nhất, "async" để giảm độ trễ nén gọn, và chỉ dùng "off" khi việc đồng bộ bộ nhớ phiên được xử lý ở nơi khác.',
  'Controls provider catalog behavior: "merge" keeps built-ins and overlays your custom providers, while "replace" uses only your configured providers. In "merge", matching provider IDs preserve non-empty agent models.json baseUrl values, while apiKey values are preserved only when the provider is not SecretRef-managed in current config/auth-profile context; SecretRef-managed providers refresh apiKey from current source markers, and matching model contextWindow/maxTokens use the higher value between explicit and implicit entries.':
    'Kiểm soát hành vi danh mục nhà cung cấp: "merge" giữ các mục tích hợp sẵn và chồng các nhà cung cấp tùy chỉnh của bạn lên, trong khi "replace" chỉ dùng các nhà cung cấp đã cấu hình của bạn. Trong "merge", các ID nhà cung cấp trùng khớp sẽ giữ lại các giá trị baseUrl không rỗng trong models.json cơ sở của tác nhân, trong khi các giá trị apiKey chỉ được giữ lại khi nhà cung cấp không được SecretRef quản lý trong ngữ cảnh config/auth-profile hiện tại; các nhà cung cấp được SecretRef quản lý sẽ làm mới apiKey từ các dấu nguồn hiện tại, và contextWindow/maxTokens của model trùng khớp sẽ dùng giá trị cao hơn giữa mục tường minh và mục ngầm định.',
  'Controls tagline style in the CLI startup banner: "random" (default) picks from the rotating tagline pool, "default" always shows the neutral default tagline, and "off" hides tagline text while keeping the banner version line.':
    'Kiểm soát kiểu tagline trong banner khởi động CLI: "random" (mặc định) chọn từ nhóm tagline luân phiên, "default" luôn hiển thị tagline mặc định trung tính, và "off" ẩn văn bản tagline nhưng vẫn giữ dòng phiên bản của banner.',
  'Controls typing behavior timing: "never", "instant", "thinking", or "message" based emission points. Keep conservative modes in high-volume channels to avoid unnecessary typing noise.':
    'Kiểm soát thời điểm hành vi nhập được phát ra: "never", "instant", "thinking", hoặc "message" dựa trên các điểm phát. Giữ các chế độ thận trọng trong các kênh lưu lượng cao để tránh tạo nhiễu trạng thái nhập không cần thiết.',
  "Controls when link understanding runs relative to conversation context and message type. Keep scope conservative to avoid unnecessary fetches on messages where links are not actionable.":
    "Kiểm soát thời điểm việc hiểu liên kết chạy tương ứng với ngữ cảnh hội thoại và loại tin nhắn. Giữ phạm vi ở mức thận trọng để tránh các lần tìm nạp không cần thiết trên những tin nhắn mà liên kết không thể hành động được.",
  'Controls when workspace bootstrap files are injected into the system prompt: "always" (default) or "continuation-skip" for safe continuation turns after a completed assistant response.':
    'Kiểm soát thời điểm các tệp bootstrap của workspace được chèn vào system prompt: "always" (mặc định) hoặc "continuation-skip" cho các lượt tiếp tục an toàn sau khi phản hồi của trợ lý đã hoàn tất.',
  'Controls where approval prompts are sent: "session" uses origin chat, "targets" uses configured targets, and "both" sends to both paths. Use "session" as baseline and expand only when operational workflow requires redundancy.':
    'Kiểm soát nơi gửi lời nhắc phê duyệt: "session" dùng cuộc trò chuyện nguồn, "targets" dùng các đích đã cấu hình, và "both" gửi đến cả hai đường. Dùng "session" làm cơ sở và chỉ mở rộng khi quy trình vận hành cần dự phòng.',
  'Controls where plugin approval prompts are sent: "session" uses origin chat, "targets" uses configured targets, and "both" sends to both paths.':
    'Kiểm soát nơi gửi lời nhắc phê duyệt plugin: "session" dùng cuộc trò chuyện nguồn, "targets" dùng các đích đã cấu hình, và "both" gửi đến cả hai đường.',
  'Controls whether heartbeat delivery may target direct/DM chats: "allow" (default) permits DM delivery and "block" suppresses direct-target sends.':
    'Kiểm soát việc gửi heartbeat có thể nhắm đến các cuộc trò chuyện trực tiếp/DM hay không: "allow" (mặc định) cho phép gửi DM và "block" chặn gửi đến đích trực tiếp.',
  "Controls whether mapping execution results are delivered back to a channel destination versus being processed silently. Disable delivery for background automations that should not post user-facing output.":
    "Kiểm soát việc kết quả thực thi ánh xạ có được gửi lại đến đích kênh hay được xử lý âm thầm. Tắt gửi đối với các tự động hóa nền không nên đăng đầu ra hiển thị cho người dùng.",
  "Controls whether OpenClaw injects `options.num_ctx` for Ollama providers configured with the OpenAI-compatible adapter (`openai-completions`). Default is true. Set false only if your proxy/upstream rejects unknown `options` payload fields.":
    "Kiểm soát việc OpenClaw có chèn `options.num_ctx` cho các nhà cung cấp Ollama được cấu hình với adapter tương thích OpenAI (`openai-completions`) hay không. Mặc định là true. Chỉ đặt false nếu proxy/upstream của bạn từ chối các trường payload `options` không xác định.",
  "Controls whether this plugin may mutate prompts through typed hooks. Set false to block `before_prompt_build` and ignore prompt-mutating fields from legacy `before_agent_start`, while preserving legacy `modelOverride` and `providerOverride` behavior.":
    "Kiểm soát việc plugin này có thể thay đổi prompt thông qua typed hooks hay không. Đặt false để chặn `before_prompt_build` và bỏ qua các trường thay đổi prompt từ `before_agent_start` cũ, đồng thời vẫn giữ hành vi `modelOverride` và `providerOverride` cũ.",
  'Controls which sessions can be targeted by sessions_list/sessions_history/sessions_send. ("tree" default = current session + spawned subagent sessions; "self" = only current; "agent" = any session in the current agent id; "all" = any session; cross-agent still requires tools.agentToAgent).':
    'Kiểm soát những phiên nào có thể được nhắm đến bởi sessions_list/sessions_history/sessions_send. ("tree" mặc định = phiên hiện tại + các phiên tác nhân con được sinh ra; "self" = chỉ hiện tại; "agent" = bất kỳ phiên nào trong id tác nhân hiện tại; "all" = bất kỳ phiên nào; liên tác nhân vẫn yêu cầu tools.agentToAgent).',
  "Conversation identifier used with peer matching, such as a chat ID, channel ID, or group ID from the provider. Keep this exact to avoid silent non-matches.":
    "Mã định danh hội thoại dùng với đối sánh ngang hàng, chẳng hạn như chat ID, channel ID hoặc group ID từ nhà cung cấp. Giữ chính xác giá trị này để tránh không khớp một cách âm thầm.",
  "Cooldown/backoff controls for temporary profile suppression after billing-related failures and retry windows. Use these to prevent rapid re-selection of profiles that are still blocked.":
    "Các điều khiển cooldown/backoff để tạm thời chặn profile sau các lỗi liên quan đến thanh toán và các khoảng thời gian thử lại. Dùng các mục này để ngăn việc chọn lại quá nhanh các profile vẫn đang bị chặn.",
  "Critical threshold for repetitive patterns when detector is enabled (default: 20).":
    "Ngưỡng tới hạn cho các mẫu lặp lại khi bộ phát hiện được bật (mặc định: 20).",
  "Cron Enabled": "Bật Cron",
  "Cron Legacy Webhook (Deprecated)": "Cron Legacy Webhook (Không còn được dùng)",
  "Cron Max Concurrent Runs": "Số lần chạy đồng thời tối đa của Cron",
  "Cron Retry Backoff (ms)": "Backoff thử lại của Cron (ms)",
  "Cron Retry Error Types": "Các loại lỗi thử lại Cron",
  "Cron Retry Max Attempts": "Số lần thử lại Cron tối đa",
  "Cron Retry Policy": "Chính sách thử lại Cron",
  "Cron Run Log Keep Lines": "Số dòng giữ lại của nhật ký chạy Cron",
  "Cron Run Log Max Bytes": "Số byte tối đa của nhật ký chạy Cron",
  "Cron Run Log Pruning": "Cắt tỉa nhật ký chạy Cron",
  "Cron Session Retention": "Thời gian lưu giữ phiên Cron",
  "Cron Store Path": "Đường dẫn lưu trữ Cron",
  "Cron Webhook Bearer Token": "Bearer Token webhook Cron",
  "Cross-Context Marker": "Dấu đánh dấu liên ngữ cảnh",
  "Cross-Context Marker Prefix": "Tiền tố dấu đánh dấu liên ngữ cảnh",
  "Cross-Context Marker Suffix": "Hậu tố dấu đánh dấu liên ngữ cảnh",
  "Custom auth header name used when auth mode is header.":
    "Tên header xác thực tùy chỉnh được dùng khi chế độ xác thực là header.",
  "Custom auth header value used when auth mode is header.":
    "Giá trị header xác thực tùy chỉnh được dùng khi chế độ xác thực là header.",
  "Custom CA bundle used to verify the proxy TLS certificate chain.":
    "Gói CA tùy chỉnh được dùng để xác minh chuỗi chứng chỉ TLS của proxy.",
  "Custom CA bundle used to verify the upstream TLS certificate chain.":
    "Gói CA tùy chỉnh được dùng để xác minh chuỗi chứng chỉ TLS của upstream.",
  'Custom identifier-preservation instruction text used when identifierPolicy="custom". Keep this explicit and safety-focused so compaction summaries do not rewrite opaque IDs, URLs, hosts, or ports.':
    'Văn bản hướng dẫn bảo toàn định danh tùy chỉnh được dùng khi identifierPolicy="custom". Hãy giữ nội dung này rõ ràng và tập trung vào an toàn để các bản tóm tắt nén không ghi lại các ID mờ, URL, host hoặc port.',
  "Custom Redaction Patterns": "Mẫu che giấu tùy chỉnh",
  "DANGEROUS break-glass override that allows sandbox Docker network mode container:<id>. This joins another container namespace and weakens sandbox isolation.":
    "Ghi đè break-glass NGUY HIỂM cho phép chế độ mạng Docker sandbox container:<id>. Điều này tham gia vào namespace của một container khác và làm suy yếu khả năng cô lập sandbox.",
  "DANGEROUS toggle that enables Host-header based origin fallback for Control UI/WebChat websocket checks. This mode is supported when your deployment intentionally relies on Host-header origin policy; explicit gateway.controlUi.allowedOrigins remains the recommended hardened default.":
    "Công tắc NGUY HIỂM bật cơ chế dự phòng origin dựa trên header Host cho các kiểm tra websocket của Control UI/WebChat. Chế độ này được hỗ trợ khi triển khai của bạn cố ý dựa vào chính sách origin theo header Host; gateway.controlUi.allowedOrigins rõ ràng vẫn là mặc định tăng cường bảo mật được khuyến nghị.",
  "Dangerously Allow Host-Header Origin Fallback":
    "Cho phép dự phòng origin theo header Host một cách nguy hiểm",
  "Dangerously Disable Control UI Device Auth":
    "Tắt xác thực thiết bị Control UI một cách nguy hiểm",
  "Debounce window (ms) before applying config changes.":
    "Khoảng debounce (ms) trước khi áp dụng thay đổi cấu hình.",
  "Debounce window (ms) for batching rapid inbound messages from the same sender (0 to disable).":
    "Khoảng debounce (ms) để gom lô các tin nhắn đến nhanh từ cùng một người gửi (0 để tắt).",
  "Debounce window in milliseconds for coalescing rapid file-watch events before reindex runs. Increase to reduce churn on frequently-written files, or lower for faster freshness.":
    "Cửa sổ debounce tính bằng mili giây để gộp các sự kiện file-watch diễn ra nhanh trước khi chạy reindex. Tăng để giảm dao động trên các tệp được ghi thường xuyên, hoặc giảm để cập nhật mới nhanh hơn.",
  "Debounce window in milliseconds for coalescing rapid skill file changes before reload logic runs. Increase to reduce reload churn on frequent writes, or lower for faster edit feedback.":
    "Cửa sổ debounce tính bằng mili giây để gộp các thay đổi tệp Skills diễn ra nhanh trước khi logic reload chạy. Tăng để giảm dao động reload khi ghi thường xuyên, hoặc giảm để phản hồi chỉnh sửa nhanh hơn.",
  "Declared model list for a provider including identifiers, metadata, and optional compatibility/cost hints. Keep IDs exact to provider catalog values so selection and fallback resolve correctly.":
    "Danh sách model được khai báo cho một provider, bao gồm mã định danh, metadata và các gợi ý tương thích/chi phí tùy chọn. Giữ ID khớp chính xác với các giá trị trong danh mục của provider để việc chọn và fallback được phân giải đúng.",
  "Default accent color used for browser profile/UI cues where colored identity hints are displayed. Use consistent colors to help operators identify active browser profile context quickly.":
    "Màu nhấn mặc định dùng cho các dấu hiệu nhận diện browser profile/UI khi hiển thị gợi ý nhận diện bằng màu. Dùng màu nhất quán để giúp người vận hành nhanh chóng nhận biết ngữ cảnh browser profile đang hoạt động.",
  "Default ACP runtime backend id (for example: acpx). Must match a registered ACP runtime plugin backend.":
    "id backend runtime ACP mặc định (ví dụ: acpx). Phải khớp với một backend plugin runtime ACP đã được đăng ký.",
  "Default browser profile name selected when callers do not explicitly choose a profile. Use a stable low-privilege profile as the default to reduce accidental cross-context state use.":
    "Tên browser profile mặc định được chọn khi bên gọi không chỉ định rõ một profile. Dùng một profile ổn định với đặc quyền thấp làm mặc định để giảm việc vô tình dùng trạng thái chéo ngữ cảnh.",
  "Default channel behavior applied across providers when provider-specific settings are not set. Use this to enforce consistent baseline policy before per-provider tuning.":
    "Hành vi kênh mặc định được áp dụng trên các provider khi chưa thiết lập cài đặt riêng theo provider. Dùng mục này để áp dụng chính sách nền nhất quán trước khi tinh chỉnh theo từng provider.",
  "Default Context Visibility": "Hiển thị ngữ cảnh mặc định",
  "Default embedded agent harness policy. Use runtime=auto for plugin harness selection, runtime=pi for built-in PI, or a registered harness id such as codex.":
    "Chính sách harness tác nhân nhúng mặc định. Dùng runtime=auto để chọn plugin harness, runtime=pi cho PI tích hợp sẵn, hoặc một id harness đã đăng ký như codex.",
  "Default Embedded Harness": "Harness nhúng mặc định",
  "Default Embedded Harness Fallback": "Fallback harness nhúng mặc định",
  "Default Embedded Harness Runtime": "Runtime harness nhúng mặc định",
  "Default Group Policy": "Chính sách nhóm mặc định",
  'Default group policy across channels: "open", "disabled", or "allowlist". Keep "allowlist" for safer production setups unless broad group participation is intentional.':
    'Chính sách nhóm mặc định trên các kênh: "open", "disabled", hoặc "allowlist". Giữ "allowlist" cho các thiết lập production an toàn hơn, trừ khi chủ đích cho phép nhóm tham gia rộng rãi.',
  "Default Heartbeat Visibility": "Hiển thị heartbeat mặc định",
  "Default heartbeat visibility settings for status messages emitted by providers/channels. Tune this globally to reduce noisy healthy-state updates while keeping alerts visible.":
    "Cài đặt hiển thị heartbeat mặc định cho các thông báo trạng thái do provider/kênh phát ra. Điều chỉnh toàn cục để giảm các cập nhật trạng thái khỏe mạnh gây nhiễu mà vẫn giữ cảnh báo hiển thị.",
  "Default inactivity window in hours for thread-bound sessions across providers/channels (0 disables idle auto-unfocus). Default: 24.":
    "Cửa sổ không hoạt động mặc định tính bằng giờ cho các phiên gắn với luồng trên các provider/kênh (0 sẽ tắt tự động bỏ focus khi rảnh). Mặc định: 24.",
  "Default snapshot capture configuration used when callers do not provide explicit snapshot options. Tune this for consistent capture behavior across channels and automation paths.":
    "Cấu hình chụp snapshot mặc định được dùng khi bên gọi không cung cấp tùy chọn snapshot cụ thể. Điều chỉnh mục này để có hành vi chụp nhất quán trên các kênh và luồng tự động hóa.",
  "Default snapshot extraction mode controlling how page content is transformed for agent consumption. Choose the mode that balances readability, fidelity, and token footprint for your workflows.":
    "Chế độ trích xuất snapshot mặc định kiểm soát cách nội dung trang được chuyển đổi để tác nhân sử dụng. Chọn chế độ cân bằng giữa khả năng đọc, độ trung thực và mức sử dụng token cho quy trình làm việc của bạn.",
  'Default supplemental context visibility for fetched quote/thread/history content: "all" (keep all context), "allowlist" (only allowlisted senders), or "allowlist_quote" (allowlist + keep explicit quotes).':
    'Hiển thị ngữ cảnh bổ sung mặc định cho nội dung quote/thread/history được truy xuất: "all" (giữ toàn bộ ngữ cảnh), "allowlist" (chỉ người gửi trong allowlist), hoặc "allowlist_quote" (allowlist + giữ các quote tường minh).',
  "Default workspace path exposed to agent runtime tools for filesystem context and repo-aware behavior. Set this explicitly when running from wrappers so path resolution stays deterministic.":
    "Đường dẫn workspace mặc định được cung cấp cho các công cụ runtime tác nhân để dùng làm ngữ cảnh filesystem và hành vi nhận biết repo. Hãy đặt rõ giá trị này khi chạy từ wrapper để việc phân giải đường dẫn luôn xác định.",
  "Defines elevated command allow rules by channel and sender for owner-level command surfaces. Use narrow provider-specific identities so privileged commands are not exposed to broad chat audiences.":
    "Xác định các quy tắc cho phép lệnh nâng quyền theo kênh và người gửi cho các bề mặt lệnh cấp chủ sở hữu. Dùng các danh tính riêng theo provider với phạm vi hẹp để các lệnh đặc quyền không bị lộ cho nhóm đối tượng chat rộng.",
  "Defines how long exported session files are kept before automatic pruning, in days (default: unlimited). Set a finite value for storage hygiene or compliance retention policies.":
    "Xác định thời gian các tệp phiên đã xuất được giữ lại trước khi tự động dọn dẹp, tính bằng ngày (mặc định: không giới hạn). Đặt giá trị hữu hạn để đảm bảo vệ sinh lưu trữ hoặc tuân thủ chính sách lưu giữ.",
  "Defines optional rule match conditions that can combine channel, chatType, and key-prefix constraints. Keep matches narrow so policy intent stays readable and debugging remains straightforward.":
    "Xác định các điều kiện khớp quy tắc tùy chọn có thể kết hợp các ràng buộc channel, chatType và tiền tố khóa. Giữ phạm vi khớp hẹp để mục đích chính sách dễ hiểu và việc gỡ lỗi vẫn đơn giản.",
  "Defines reset policy for direct chats and supersedes the base session.reset configuration for that type. Use this as the canonical direct-message override instead of the legacy dm alias.":
    "Xác định chính sách đặt lại cho các cuộc trò chuyện trực tiếp và ghi đè cấu hình session.reset cơ sở cho loại đó. Dùng mục này làm cấu hình ghi đè tin nhắn trực tiếp chuẩn thay vì bí danh dm cũ.",
  "Defines reset policy for group chat sessions where continuity and noise patterns differ from DMs. Use shorter idle windows for busy groups if context drift becomes a problem.":
    "Xác định chính sách đặt lại cho các phiên trò chuyện nhóm, nơi tính liên tục và kiểu nhiễu khác với DM. Dùng khoảng thời gian chờ ngắn hơn cho các nhóm bận rộn nếu độ lệch ngữ cảnh trở thành vấn đề.",
  "Defines reset policy for thread-scoped sessions, including focused channel thread workflows. Use this when thread sessions should expire faster or slower than other chat types.":
    "Xác định chính sách đặt lại cho các phiên theo phạm vi luồng, bao gồm các quy trình làm việc tập trung trong luồng kênh. Dùng mục này khi các phiên luồng nên hết hạn nhanh hơn hoặc chậm hơn các loại trò chuyện khác.",
  'Defines rule decision as "allow" or "deny" when the corresponding match criteria are satisfied. Use deny-first ordering when enforcing strict boundaries with explicit allow exceptions.':
    'Xác định quyết định quy tắc là "allow" hoặc "deny" khi các tiêu chí khớp tương ứng được thỏa mãn. Dùng thứ tự ưu tiên deny trước khi áp dụng ranh giới nghiêm ngặt với các ngoại lệ allow rõ ràng.',
  "Defines the default reset policy object used when no type-specific or channel-specific override applies. Set this first, then layer resetByType or resetByChannel only where behavior must differ.":
    "Xác định đối tượng chính sách đặt lại mặc định được dùng khi không có cấu hình ghi đè theo loại hoặc theo kênh nào áp dụng. Hãy đặt mục này trước, sau đó chỉ thêm resetByType hoặc resetByChannel ở những nơi hành vi cần khác biệt.",
  "Defines the root location QMD should scan, using an absolute path or `~`-relative path. Use stable directories so collection identity does not drift across environments.":
    "Xác định vị trí gốc mà QMD nên quét, dùng đường dẫn tuyệt đối hoặc đường dẫn tương đối với `~`. Hãy dùng các thư mục ổn định để danh tính bộ sưu tập không bị thay đổi giữa các môi trường.",
  "Defines which sessions/channels are eligible for QMD recall using session.sendPolicy-style rules. Keep default direct-only scope unless you intentionally want cross-chat memory sharing.":
    "Xác định những phiên/kênh nào đủ điều kiện để QMD recall bằng các quy tắc kiểu session.sendPolicy. Giữ phạm vi mặc định chỉ cho direct trừ khi bạn thực sự muốn chia sẻ bộ nhớ giữa các cuộc trò chuyện.",
  "Delay in milliseconds before showing an in-progress notice after an exec approval is granted. Increase to reduce flicker for fast commands, or lower for quicker operator feedback.":
    "Độ trễ tính bằng mili giây trước khi hiển thị thông báo đang xử lý sau khi phê duyệt exec được cấp. Tăng để giảm nhấp nháy với các lệnh nhanh, hoặc giảm để phản hồi cho người vận hành nhanh hơn.",
  'Delay style for block replies ("off", "natural", "custom").':
    'Kiểu độ trễ cho phản hồi khối ("off", "natural", "custom").',
  'Delivery channel override for mapping outputs (for example "last", "telegram", "discord", "slack", "signal", "imessage", or "msteams"). Keep channel overrides explicit to avoid accidental cross-channel sends.':
    'Ghi đè kênh gửi cho đầu ra ánh xạ (ví dụ: "last", "telegram", "discord", "slack", "signal", "imessage", hoặc "msteams"). Hãy giữ các cấu hình ghi đè kênh rõ ràng để tránh gửi nhầm sang kênh khác.',
  'Delivery order for broadcast fan-out: "parallel" sends to all targets concurrently, while "sequential" sends one-by-one. Use "parallel" for speed and "sequential" for stricter ordering/backpressure control.':
    'Thứ tự gửi cho broadcast fan-out: "parallel" gửi đến tất cả đích đồng thời, còn "sequential" gửi lần lượt từng cái một. Dùng "parallel" để tăng tốc độ và "sequential" để kiểm soát thứ tự/backpressure chặt chẽ hơn.',
  "Deprecated age-retention field kept for compatibility with legacy configs using day counts. Use session.maintenance.pruneAfter instead so duration syntax and behavior are consistent.":
    "Trường giữ lại theo tuổi đã bị ngừng dùng nhưng vẫn được giữ để tương thích với các cấu hình cũ dùng số ngày. Hãy dùng session.maintenance.pruneAfter để cú pháp thời lượng và hành vi nhất quán.",
  "Deprecated alias for direct reset behavior kept for backward compatibility with older configs. Use session.resetByType.direct instead so future tooling and validation remain consistent.":
    "Bí danh đã ngừng dùng cho hành vi đặt lại direct, được giữ để tương thích ngược với các cấu hình cũ hơn. Hãy dùng session.resetByType.direct để các công cụ và bước xác thực trong tương lai vẫn nhất quán.",
  'Deprecated legacy fallback webhook URL used only for old jobs with `notify=true`. Migrate to per-job delivery using `delivery.mode="webhook"` plus `delivery.to`, and avoid relying on this global field.':
    'URL webhook dự phòng cũ đã ngừng dùng, chỉ được dùng cho các job cũ với `notify=true`. Hãy chuyển sang gửi theo từng job bằng `delivery.mode="webhook"` cùng với `delivery.to`, và tránh phụ thuộc vào trường toàn cục này.',
  "Destination identifier inside the selected channel when mapping replies should route to a fixed target. Verify provider-specific destination formats before enabling production mappings.":
    "Mã định danh đích trong kênh đã chọn khi phản hồi ánh xạ cần được định tuyến đến một đích cố định. Hãy xác minh định dạng đích theo từng nhà cung cấp trước khi bật ánh xạ trong môi trường production.",
  "Destination identifier inside the target channel (channel ID, user ID, or thread root depending on provider).":
    "Mã định danh đích trong kênh đích (ID kênh, ID người dùng hoặc gốc luồng tùy theo nhà cung cấp).",
  "Destination identifier inside the target channel (channel ID, user ID, or thread root depending on provider). Verify semantics per provider because destination format differs across channel integrations.":
    "Mã định danh đích trong kênh đích (ID kênh, ID người dùng hoặc gốc luồng tùy theo nhà cung cấp). Hãy xác minh ngữ nghĩa theo từng nhà cung cấp vì định dạng đích khác nhau giữa các tích hợp kênh.",
  'Determines whether maintenance policies are only reported ("warn") or actively applied ("enforce"). Keep "warn" during rollout and switch to "enforce" after validating safe thresholds.':
    'Xác định liệu các chính sách bảo trì chỉ được báo cáo ("warn") hay được áp dụng chủ động ("enforce"). Giữ "warn" trong quá trình triển khai và chuyển sang "enforce" sau khi xác thực các ngưỡng an toàn.',
  Diagnostics: "Chẩn đoán",
  "Diagnostics controls for targeted tracing, telemetry export, and cache inspection during debugging. Keep baseline diagnostics minimal in production and enable deeper signals only when investigating issues.":
    "Các điều khiển chẩn đoán cho truy vết có mục tiêu, xuất telemetry và kiểm tra cache trong quá trình gỡ lỗi. Hãy giữ chẩn đoán cơ bản ở mức tối thiểu trong production và chỉ bật tín hiệu sâu hơn khi điều tra sự cố.",
  "Diagnostics Enabled": "Bật chẩn đoán",
  "Diagnostics Flags": "Cờ chẩn đoán",
  "Direct inbound debounce settings used before queue/turn processing starts. Configure this for provider-specific rapid message bursts from the same sender.":
    "Cài đặt debounce inbound direct được dùng trước khi bắt đầu xử lý queue/turn. Hãy cấu hình mục này cho các đợt tin nhắn nhanh liên tiếp từ cùng một người gửi theo từng nhà cung cấp.",
  "Direct TLS client settings for audio provider requests, including custom CA trust, client certs, or SNI overrides for managed gateways and internal endpoints.":
    "Cài đặt TLS client trực tiếp cho các yêu cầu tới nhà cung cấp âm thanh, bao gồm CA trust tùy chỉnh, chứng chỉ client hoặc ghi đè SNI cho các Gateway được quản lý và endpoint nội bộ.",
  "Directories to prepend to PATH for exec runs (gateway/sandbox).":
    "Các thư mục được thêm vào đầu PATH cho các lần chạy exec (gateway/sandbox).",
  "Disables Chromium sandbox isolation flags for environments where sandboxing fails at runtime. Keep this off whenever possible because process isolation protections are reduced.":
    "Tắt các cờ cô lập sandbox của Chromium cho những môi trường mà sandbox không hoạt động khi chạy. Hãy giữ tùy chọn này ở trạng thái tắt bất cứ khi nào có thể vì các biện pháp bảo vệ cô lập tiến trình sẽ bị giảm.",
  "Disables Control UI device identity checks and relies on token/password only. Use only for short-lived debugging on trusted networks, then turn it off immediately.":
    "Tắt kiểm tra danh tính thiết bị của Control UI và chỉ dựa vào token/mật khẩu. Chỉ dùng cho gỡ lỗi ngắn hạn trên các mạng đáng tin cậy, sau đó tắt ngay.",
  Discovery: "Khám phá",
  "Display name shown for the assistant in UI views, chat chrome, and status contexts. Keep this stable so operators can reliably identify which assistant persona is active.":
    "Tên hiển thị cho trợ lý trong các chế độ xem UI, khung chat và ngữ cảnh trạng thái. Hãy giữ ổn định để người vận hành có thể nhận biết đáng tin cậy persona trợ lý nào đang hoạt động.",
  "DM Session Scope": "Phạm vi phiên DM",
  'DM session scoping: "main" keeps continuity, while "per-peer", "per-channel-peer", and "per-account-channel-peer" increase isolation. Use isolated modes for shared inboxes or multi-account deployments.':
    'Phạm vi phiên DM: "main" giữ tính liên tục, trong khi "per-peer", "per-channel-peer" và "per-account-channel-peer" tăng mức độ cô lập. Dùng các chế độ cô lập cho hộp thư dùng chung hoặc triển khai nhiều tài khoản.',
  "Docker network for sandbox browser containers (default: openclaw-sandbox-browser). Avoid bridge if you need stricter isolation.":
    "Mạng Docker cho các container trình duyệt sandbox (mặc định: openclaw-sandbox-browser). Tránh bridge nếu bạn cần mức cô lập nghiêm ngặt hơn.",
  'Drop strategy when queue cap is exceeded: "old", "new", or "summarize". Use summarize when preserving intent matters, or old/new when deterministic dropping is preferred.':
    'Chiến lược loại bỏ khi vượt quá giới hạn hàng đợi: "old", "new" hoặc "summarize". Dùng summarize khi cần giữ nguyên ý định, hoặc old/new khi ưu tiên loại bỏ theo cách xác định.',
  "Echo the audio transcript back to the originating chat before agent processing. When enabled, users immediately see what was heard from their voice note, helping them verify transcription accuracy before the agent acts on it. Default: false.":
    "Gửi lại bản chép lời âm thanh vào chính cuộc chat nguồn trước khi tác nhân xử lý. Khi bật, người dùng sẽ thấy ngay nội dung được nghe từ ghi chú thoại của họ, giúp họ xác minh độ chính xác của bản chép lời trước khi tác nhân hành động dựa trên đó. Mặc định: false.",
  "Echo Transcript to Chat": "Gửi lại bản chép lời vào chat",
  "Elevated Tool Access": "Quyền truy cập công cụ nâng cao",
  "Elevated tool access controls for privileged command surfaces that should only be reachable from trusted senders. Keep disabled unless operator workflows explicitly require elevated actions.":
    "Các điều khiển quyền truy cập công cụ nâng cao cho các bề mặt lệnh đặc quyền chỉ nên có thể truy cập từ những người gửi đáng tin cậy. Hãy giữ ở trạng thái tắt trừ khi quy trình vận hành yêu cầu rõ ràng các hành động nâng cao.",
  "Elevated Tool Allow Rules": "Quy tắc cho phép công cụ nâng cao",
  "Embedded harness fallback when no plugin harness matches or an auto-selected plugin harness fails before side effects. Set none to disable automatic PI fallback.":
    "Phương án dự phòng harness nhúng khi không có plugin harness nào khớp hoặc khi plugin harness được tự động chọn thất bại trước khi có tác dụng phụ. Đặt none để tắt cơ chế dự phòng PI tự động.",
  "Embedded harness runtime: auto, pi, or a registered plugin harness id such as codex.":
    "Runtime harness nhúng: auto, pi hoặc id plugin harness đã đăng ký như codex.",
  "Embedded Pi": "Pi nhúng",
  "Embedded Pi Execution Contract": "Hợp đồng thực thi Pi nhúng",
  'Embedded Pi execution contract: "default" keeps the standard runner behavior, while "strict-agentic" keeps OpenAI/OpenAI Codex GPT-5-family runs acting until they hit a real blocker instead of stopping at plans or filler.':
    'Hợp đồng thực thi Pi nhúng: "default" giữ hành vi runner tiêu chuẩn, trong khi "strict-agentic" giữ cho các lần chạy OpenAI/OpenAI Codex GPT-5-family tiếp tục hoạt động cho đến khi gặp trở ngại thực sự thay vì dừng ở kế hoạch hoặc nội dung đệm.',
  "Embedded Pi Project Settings Policy": "Chính sách cài đặt dự án Pi nhúng",
  "Embedded Pi runner hardening controls for how workspace-local Pi settings are trusted and applied in OpenClaw sessions.":
    "Các điều khiển tăng cường bảo mật runner Pi nhúng về cách các cài đặt Pi cục bộ theo workspace được tin cậy và áp dụng trong các phiên OpenClaw.",
  "Embedding model override used by the selected memory provider when a non-default model is required. Set this only when you need explicit recall quality/cost tuning beyond provider defaults.":
    "Ghi đè mô hình embedding được dùng bởi nhà cung cấp bộ nhớ đã chọn khi cần một mô hình không mặc định. Chỉ đặt tùy chọn này khi bạn cần tinh chỉnh rõ ràng chất lượng/chi phí truy hồi vượt ngoài mặc định của nhà cung cấp.",
  "Emoji reaction used to acknowledge inbound messages (empty disables).":
    "Biểu tượng cảm xúc phản ứng dùng để xác nhận tin nhắn đến (để trống để tắt).",
  "Enable Agent-to-Agent Tool": "Bật công cụ Agent-to-Agent",
  "Enable apply_patch": "Bật apply_patch",
  "Enable Audio Understanding": "Bật hiểu âm thanh",
  "Enable audio understanding so voice notes or audio clips can be transcribed/summarized for agent context. Disable when audio ingestion is outside policy or unnecessary for your workflows.":
    "Bật hiểu âm thanh để ghi âm giọng nói hoặc đoạn âm thanh có thể được chép lời/tóm tắt cho ngữ cảnh tác nhân. Tắt khi việc nạp âm thanh nằm ngoài chính sách hoặc không cần thiết cho quy trình làm việc của bạn.",
  "Enable automatic link understanding pre-processing so URLs can be summarized before agent reasoning. Keep enabled for richer context, and disable when strict minimal processing is required.":
    "Bật tiền xử lý hiểu liên kết tự động để URL có thể được tóm tắt trước khi tác nhân suy luận. Giữ bật để có ngữ cảnh phong phú hơn, và tắt khi cần xử lý tối thiểu nghiêm ngặt.",
  "Enable background auto-update for package installs (default: false).":
    "Bật tự động cập nhật nền cho cài đặt gói (mặc định: false).",
  "Enable broadcast action (default: true).": "Bật hành động phát quảng bá (mặc định: true).",
  "Enable direct channel sends for completed async music/video generation tasks instead of relying on the requester session wake path. Default off so detached media completion keeps the legacy model-delivery flow unless you opt in.":
    "Bật gửi trực tiếp tới kênh cho các tác vụ tạo nhạc/video bất đồng bộ đã hoàn tất thay vì dựa vào đường dẫn đánh thức phiên của bên yêu cầu. Mặc định tắt để việc hoàn tất phương tiện tách rời giữ luồng phân phối mô hình cũ trừ khi bạn chủ động bật.",
  "Enable Elevated Tool Access": "Bật quyền truy cập công cụ nâng cao",
  "Enable filesystem watching for skill-definition changes so updates can be applied without full process restart. Keep enabled in development workflows and disable in immutable production images.":
    "Bật theo dõi hệ thống tệp cho các thay đổi định nghĩa skill để có thể áp dụng cập nhật mà không cần khởi động lại toàn bộ tiến trình. Giữ bật trong quy trình phát triển và tắt trong image production bất biến.",
  "Enable generic repeated same-tool/same-params loop detection (default: true).":
    "Bật phát hiện vòng lặp lặp lại chung cùng-công-cụ/cùng-tham-số (mặc định: true).",
  "Enable Image Understanding": "Bật hiểu hình ảnh",
  "Enable image understanding so attached or referenced images can be interpreted into textual context. Disable if you need text-only operation or want to avoid image-processing cost.":
    "Bật hiểu hình ảnh để hình ảnh được đính kèm hoặc tham chiếu có thể được diễn giải thành ngữ cảnh văn bản. Tắt nếu bạn cần vận hành chỉ-văn-bản hoặc muốn tránh chi phí xử lý hình ảnh.",
  "Enable known poll tool no-progress loop detection (default: true).":
    "Bật phát hiện vòng lặp không tiến triển của công cụ thăm dò đã biết (mặc định: true).",
  "Enable lifecycle status reactions on supported channels. Slack and Discord treat unset as enabled when ack reactions are active; Telegram requires this to be true before lifecycle reactions are used.":
    "Bật phản ứng trạng thái vòng đời trên các kênh được hỗ trợ. Slack và Discord coi trạng thái chưa đặt là đã bật khi phản ứng ack đang hoạt động; Telegram yêu cầu giá trị này là true trước khi phản ứng vòng đời được sử dụng.",
  "Enable Link Understanding": "Bật hiểu liên kết",
  "Enable log signal export through OpenTelemetry in addition to local logging sinks. Use this when centralized log correlation is required across services and agents.":
    "Bật xuất tín hiệu nhật ký qua OpenTelemetry ngoài các đích ghi nhật ký cục bộ. Dùng tùy chọn này khi cần tương quan nhật ký tập trung trên các dịch vụ và tác nhân.",
  "Enable managed web_search and optional Codex-native search for eligible models.":
    "Bật web_search được quản lý và tìm kiếm gốc Codex tùy chọn cho các mô hình đủ điều kiện.",
  "Enable Memory Search": "Bật tìm kiếm bộ nhớ",
  "Enable Memory Search Multimodal": "Bật tìm kiếm bộ nhớ đa phương thức",
  "Enable Message Broadcast": "Bật phát quảng bá tin nhắn",
  "Enable metrics signal export to the configured OpenTelemetry collector endpoint. Keep enabled for runtime health dashboards, and disable only if metric volume must be minimized.":
    "Bật xuất tín hiệu số liệu tới endpoint collector OpenTelemetry đã cấu hình. Giữ bật cho bảng điều khiển tình trạng thời gian chạy, và chỉ tắt nếu cần giảm thiểu khối lượng số liệu.",
  "Enable Native Codex Web Search": "Bật tìm kiếm web Codex gốc",
  "Enable native Codex web search for Codex-capable models.":
    "Bật tìm kiếm web Codex gốc cho các mô hình hỗ trợ Codex.",
  "Enable or disable apply_patch for OpenAI and OpenAI Codex models when allowed by tool policy (default: true).":
    "Bật hoặc tắt apply_patch cho các mô hình OpenAI và OpenAI Codex khi được chính sách công cụ cho phép (mặc định: true).",
  "Enable or disable plugin/extension loading globally during startup and config reload (default: true). Keep enabled only when extension capabilities are required by your deployment.":
    "Bật hoặc tắt việc tải plugin/extension trên toàn cục trong quá trình khởi động và tải lại cấu hình (mặc định: true). Chỉ giữ bật khi việc triển khai của bạn cần các khả năng của extension.",
  "Enable ping-pong loop detection (default: true).":
    "Bật phát hiện vòng lặp ping-pong (mặc định: true).",
  "Enable Plugins": "Bật Plugin",
  "Enable repetitive tool-call loop detection and backoff safety checks (default: false).":
    "Bật phát hiện vòng lặp gọi công cụ lặp lại và các kiểm tra an toàn backoff (mặc định: false).",
  "Enable Status Reactions": "Bật Phản ứng Trạng thái",
  "Enable Structured Plan Tool": "Bật Công cụ Kế hoạch Có cấu trúc",
  'Enable targeted diagnostics logs by flag (e.g. ["telegram.http"]). Supports wildcards like "telegram.*" or "*".':
    'Bật nhật ký chẩn đoán có mục tiêu theo cờ, ví dụ ["telegram.http"]. Hỗ trợ ký tự đại diện như "telegram.*" hoặc "*".',
  "Enable the experimental structured `update_plan` tool for non-trivial multi-step work tracking. Leave this off unless you explicitly want the tool outside strict-agentic embedded Pi runs.":
    "Bật công cụ `update_plan` có cấu trúc thử nghiệm để theo dõi công việc nhiều bước không đơn giản. Hãy để tắt trừ khi bạn thực sự muốn dùng công cụ này ngoài các lần chạy Pi nhúng strict-agentic.",
  "Enable the OpenAI-compatible `POST /v1/chat/completions` endpoint (default: false).":
    "Bật endpoint `POST /v1/chat/completions` tương thích OpenAI (mặc định: false).",
  "Enable the web_fetch tool (lightweight HTTP fetch).":
    "Bật công cụ web_fetch (HTTP fetch gọn nhẹ).",
  "Enable trace signal export to the configured OpenTelemetry collector endpoint. Keep enabled when latency/debug tracing is needed, and disable if you only want metrics/logs.":
    "Bật xuất tín hiệu trace tới endpoint collector OpenTelemetry đã cấu hình. Giữ bật khi cần trace độ trễ/gỡ lỗi, và tắt nếu bạn chỉ muốn metrics/logs.",
  "Enable Video Understanding": "Bật Hiểu Video",
  "Enable video understanding so clips can be summarized into text for downstream reasoning and responses. Disable when processing video is out of policy or too expensive for your deployment.":
    "Bật khả năng hiểu video để các đoạn clip có thể được tóm tắt thành văn bản cho suy luận và phản hồi ở bước sau. Tắt khi việc xử lý video không phù hợp với chính sách hoặc quá tốn kém cho môi trường triển khai của bạn.",
  "Enable Web Fetch Tool": "Bật Công cụ Web Fetch",
  "Enable Web Search Tool": "Bật Công cụ Tìm kiếm Web",
  "Enables automatic live-reload behavior for canvas assets during development workflows. Keep disabled in production-like environments where deterministic output is preferred.":
    "Bật hành vi live-reload tự động cho các tài nguyên canvas trong quy trình phát triển. Giữ tắt trong các môi trường giống production, nơi ưu tiên đầu ra có tính xác định.",
  "Enables browser capability wiring in the gateway so browser tools and CDP-driven workflows can run. Disable when browser automation is not needed to reduce surface area and startup work.":
    "Bật kết nối khả năng trình duyệt trong Gateway để các công cụ trình duyệt và quy trình do CDP điều khiển có thể chạy. Tắt khi không cần tự động hóa trình duyệt để giảm bề mặt và công việc khởi động.",
  "Enables browser-side evaluate helpers for runtime script evaluation capabilities where supported. Keep disabled unless your workflows require evaluate semantics beyond snapshots/navigation.":
    "Bật các helper evaluate phía trình duyệt cho khả năng đánh giá script khi chạy ở những nơi được hỗ trợ. Giữ tắt trừ khi quy trình của bạn cần ngữ nghĩa evaluate vượt ngoài snapshot/navigation.",
  "Enables concise indicator-style heartbeat rendering instead of verbose status text where supported. Use indicator mode for dense dashboards with many active channels.":
    "Bật hiển thị heartbeat kiểu chỉ báo ngắn gọn thay cho văn bản trạng thái dài dòng ở những nơi được hỗ trợ. Dùng chế độ chỉ báo cho các dashboard dày đặc với nhiều kênh đang hoạt động.",
  "Enables cron job execution for stored schedules managed by the gateway. Keep enabled for normal reminder/automation flows, and disable only to pause all cron execution without deleting jobs.":
    "Bật thực thi cron job cho các lịch biểu đã lưu do Gateway quản lý. Giữ bật cho các luồng nhắc nhở/tự động hóa thông thường, và chỉ tắt để tạm dừng toàn bộ thực thi cron mà không xóa job.",
  "Enables elevated tool execution path when sender and policy checks pass. Keep disabled in public/shared channels and enable only for trusted owner-operated contexts.":
    "Bật đường dẫn thực thi công cụ nâng cao khi kiểm tra người gửi và chính sách đạt yêu cầu. Giữ tắt trong các kênh công khai/dùng chung và chỉ bật trong các ngữ cảnh đáng tin cậy do chủ sở hữu vận hành.",
  "Enables forwarding of exec approval requests to configured delivery destinations (default: false). Keep disabled in low-risk setups and enable only when human approval responders need channel-visible prompts.":
    "Bật chuyển tiếp các yêu cầu phê duyệt exec tới các đích phân phối đã cấu hình (mặc định: false). Giữ tắt trong các thiết lập rủi ro thấp và chỉ bật khi người phản hồi phê duyệt thủ công cần các lời nhắc hiển thị trên kênh.",
  "Enables forwarding of plugin approval requests to configured delivery destinations (default: false). Independent of approvals.exec.enabled.":
    "Bật chuyển tiếp các yêu cầu phê duyệt plugin tới các đích phân phối đã cấu hình (mặc định: false). Độc lập với approvals.exec.enabled.",
  "Enables image/audio memory indexing from extraPaths. This currently requires Gemini embedding-2, keeps the default memory roots Markdown-only, disables memory-search fallback providers, and uploads matching binary content to the configured remote embedding provider.":
    "Bật lập chỉ mục bộ nhớ hình ảnh/âm thanh từ extraPaths. Tính năng này hiện yêu cầu Gemini embedding-2, giữ các thư mục gốc bộ nhớ mặc định chỉ dùng Markdown, vô hiệu hóa các nhà cung cấp dự phòng memory-search, và tải lên nội dung nhị phân khớp tới nhà cung cấp embedding từ xa đã cấu hình.",
  "Enables loading environment variables from the user shell profile during startup initialization. Keep enabled for developer machines, or disable in locked-down service environments with explicit env management.":
    "Bật tải biến môi trường từ hồ sơ shell của người dùng trong quá trình khởi tạo khi khởi động. Giữ bật cho máy của nhà phát triển, hoặc tắt trong môi trường dịch vụ được khóa chặt với quản lý env tường minh.",
  "Enables OpenTelemetry export pipeline for traces, metrics, and logs based on configured endpoint/protocol settings. Keep disabled unless your collector endpoint and auth are fully configured.":
    "Bật pipeline xuất OpenTelemetry cho traces, metrics và logs dựa trên cài đặt endpoint/protocol đã cấu hình. Giữ tắt trừ khi endpoint collector và auth của bạn đã được cấu hình đầy đủ.",
  "Enables pre-compaction memory flush before the runtime performs stronger history reduction near token limits. Keep enabled unless you intentionally disable memory side effects in constrained environments.":
    "Bật xả bộ nhớ trước khi nén gọn trước khi runtime thực hiện giảm lịch sử mạnh hơn gần giới hạn token. Giữ bật trừ khi bạn cố ý vô hiệu hóa các tác dụng phụ của bộ nhớ trong môi trường bị ràng buộc.",
  "Enables processing for internal hooks and configured entries in the internal hook runtime. Keep disabled unless internal hooks are intentionally configured.":
    "Bật xử lý cho các hook nội bộ và các mục đã cấu hình trong runtime hook nội bộ. Giữ tắt trừ khi các hook nội bộ được cấu hình có chủ đích.",
  "Enables provider batch APIs for embedding jobs when supported (OpenAI/Gemini), improving throughput on larger index runs. Keep this enabled unless debugging provider batch failures or running very small workloads.":
    "Bật API batch của nhà cung cấp cho các tác vụ embedding khi được hỗ trợ (OpenAI/Gemini), cải thiện thông lượng trên các lần chạy lập chỉ mục lớn hơn. Giữ bật trừ khi đang gỡ lỗi lỗi batch của nhà cung cấp hoặc chạy khối lượng công việc rất nhỏ.",
  "Enables serving the gateway Control UI from the gateway HTTP process when true. Keep enabled for local administration, and disable when an external control surface replaces it.":
    "Bật phục vụ Control UI của gateway từ tiến trình HTTP của gateway khi đặt là true. Giữ bật cho quản trị cục bộ, và tắt khi có một bề mặt điều khiển bên ngoài thay thế nó.",
  "Enables summary quality audits and regeneration retries for safeguard compaction. Default: false, so safeguard mode alone does not turn on retry behavior.":
    "Bật kiểm tra chất lượng bản tóm tắt và thử lại tái tạo cho nén gọn bảo vệ. Mặc định: false, vì vậy chỉ riêng chế độ bảo vệ sẽ không bật hành vi thử lại.",
  "Enables text-command parsing in chat input in addition to native command surfaces where available. Keep this enabled for compatibility across channels that do not support native command registration.":
    "Bật phân tích lệnh văn bản trong đầu vào chat ngoài các bề mặt lệnh gốc khi có sẵn. Giữ bật để tương thích trên các kênh không hỗ trợ đăng ký lệnh gốc.",
  "Enables the agent_to_agent tool surface so one agent can invoke another agent at runtime. Keep off in simple deployments and enable only when orchestration value outweighs complexity.":
    "Bật bề mặt công cụ agent_to_agent để một tác nhân có thể gọi một tác nhân khác trong runtime. Giữ tắt trong các triển khai đơn giản và chỉ bật khi giá trị điều phối lớn hơn độ phức tạp.",
  "Enables the canvas host server process and routes for serving canvas files. Keep disabled when canvas workflows are inactive to reduce exposed local services.":
    "Bật tiến trình máy chủ canvas host và các route để phục vụ tệp canvas. Giữ tắt khi quy trình canvas không hoạt động để giảm các dịch vụ cục bộ bị lộ.",
  "Enables the hooks endpoint and mapping execution pipeline for inbound webhook requests. Keep disabled unless you are actively routing external events into the gateway.":
    "Bật endpoint hooks và pipeline thực thi ánh xạ cho các yêu cầu webhook đến. Giữ tắt trừ khi bạn đang chủ động định tuyến các sự kiện bên ngoài vào gateway.",
  "Enables the sqlite-vec extension used for vector similarity queries in memory search (default: true). Keep this enabled for normal semantic recall; disable only for debugging or fallback-only operation.":
    "Bật extension sqlite-vec được dùng cho truy vấn tương đồng vector trong memory search (mặc định: true). Giữ bật cho khả năng gợi nhớ ngữ nghĩa thông thường; chỉ tắt để gỡ lỗi hoặc vận hành chỉ dùng dự phòng.",
  "Enables the web channel runtime and related websocket lifecycle behavior. Keep disabled when web chat is unused to reduce active connection management overhead.":
    "Bật runtime kênh web và hành vi vòng đời websocket liên quan. Giữ tắt khi chat web không được sử dụng để giảm chi phí quản lý kết nối đang hoạt động.",
  "Enables TLS termination at the gateway listener so clients connect over HTTPS/WSS directly. Keep enabled for direct internet exposure or any untrusted network boundary.":
    "Bật kết thúc TLS tại listener của gateway để client kết nối trực tiếp qua HTTPS/WSS. Giữ bật khi phơi ra internet trực tiếp hoặc tại bất kỳ ranh giới mạng không đáng tin cậy nào.",
  "Enables wide-area discovery signaling when your environment needs non-local gateway discovery. Keep disabled unless cross-network discovery is operationally required.":
    "Bật tín hiệu khám phá diện rộng khi môi trường của bạn cần khám phá gateway ngoài mạng cục bộ. Giữ tắt trừ khi việc khám phá xuyên mạng là yêu cầu vận hành cần thiết.",
  "Enables x-real-ip fallback when x-forwarded-for is missing in proxy scenarios. Keep disabled unless your ingress stack requires this compatibility behavior.":
    "Bật dự phòng x-real-ip khi thiếu x-forwarded-for trong các tình huống proxy. Giữ tắt trừ khi stack ingress của bạn yêu cầu hành vi tương thích này.",
  "Enforce access-group allowlists/policies for commands.":
    "Thực thi allowlist/chính sách nhóm truy cập cho các lệnh.",
  "Envelope Elapsed": "Thời gian đã trôi qua của phong bì",
  "Envelope Timestamp": "Dấu thời gian phong bì",
  "Envelope Timezone": "Múi giờ phong bì",
  Environment: "Môi trường",
  "Environment import and override settings used to supply runtime variables to the gateway process. Use this section to control shell-env loading and explicit variable injection behavior.":
    "Cài đặt nhập và ghi đè môi trường được dùng để cung cấp biến runtime cho tiến trình gateway. Dùng phần này để kiểm soát việc tải shell-env và hành vi chèn biến tường minh.",
  "Environment Variable Overrides": "Ghi đè biến môi trường",
  "Error types to retry: rate_limit, overloaded, network, timeout, server_error. Use to restrict which errors trigger retries; omit to retry all transient types.":
    "Các loại lỗi để thử lại: rate_limit, overloaded, network, timeout, server_error. Dùng để giới hạn lỗi nào sẽ kích hoạt thử lại; bỏ qua để thử lại tất cả các loại tạm thời.",
  "Exec Approval Forwarding": "Chuyển tiếp phê duyệt Exec",
  "Exec Approval Running Notice (ms)": "Thông báo đang chạy phê duyệt Exec (ms)",
  "Exec Ask": "Hỏi Exec",
  "Exec Node Binding": "Liên kết nút Exec",
  "Exec Notify On Empty Success": "Thông báo Exec khi thành công nhưng trống",
  "Exec Notify On Exit": "Thông báo Exec khi thoát",
  "Exec PATH Prepend": "Thêm vào đầu PATH của Exec",
  "Exec Safe Bin Profiles": "Hồ sơ bin an toàn của Exec",
  "Exec Safe Bin Trusted Dirs": "Thư mục tin cậy bin an toàn của Exec",
  "Exec Safe Bins": "Bin an toàn của Exec",
  "Exec Security": "Bảo mật Exec",
  "Exec Target": "Đích Exec",
  "Exec Tool": "Công cụ Exec",
  "Exec-tool policy grouping for shell execution host, security mode, approval behavior, and runtime bindings. Keep conservative defaults in production and tighten elevated execution paths.":
    "Nhóm chính sách exec-tool cho máy chủ thực thi shell, chế độ bảo mật, hành vi phê duyệt và liên kết thời gian chạy. Giữ mặc định thận trọng trong môi trường production và siết chặt các đường dẫn thực thi nâng cao.",
  'Executable + args used to transcribe audio (first token must be a safe binary/path), for example `["whisper-cli", "--model", "small", "{input}"]`. Prefer a pinned command so runtime environments behave consistently.':
    'Executable + args dùng để chép lời âm thanh (token đầu tiên phải là binary/path an toàn), ví dụ `["whisper-cli", "--model", "small", "{input}"]`. Ưu tiên lệnh được ghim cố định để môi trường runtime hoạt động nhất quán.',
  "Execution security posture selector controlling sandbox/approval expectations for command execution. Keep strict security mode for untrusted prompts and relax only for trusted operator workflows.":
    "Bộ chọn tư thế bảo mật thực thi kiểm soát kỳ vọng sandbox/phê duyệt cho việc thực thi lệnh. Giữ chế độ bảo mật nghiêm ngặt cho prompt không đáng tin cậy và chỉ nới lỏng cho quy trình vận hành đáng tin cậy.",
  "Expands the candidate pool before reranking (default: 4). Raise this for better recall on noisy corpora, but expect more compute and slightly slower searches.":
    "Mở rộng nhóm ứng viên trước khi reranking (mặc định: 4). Tăng giá trị này để cải thiện khả năng thu hồi trên kho dữ liệu nhiễu, nhưng sẽ tốn thêm tài nguyên tính toán và tìm kiếm chậm hơn đôi chút.",
  "Expected sha256 TLS fingerprint for the remote gateway (pin to avoid MITM).":
    "Dấu vân tay TLS sha256 dự kiến cho Gateway từ xa (ghim để tránh MITM).",
  "Experimental built-in tool flags. Keep these off by default and enable only when you are intentionally testing a preview surface.":
    "Cờ công cụ tích hợp sẵn thử nghiệm. Giữ các mục này tắt theo mặc định và chỉ bật khi bạn chủ ý kiểm thử một bề mặt preview.",
  "Experimental Tools": "Công cụ thử nghiệm",
  "Explicit bind host/IP used when gateway.bind is set to custom for manual interface targeting. Use a precise address and avoid wildcard binds unless external exposure is required.":
    "Host/IP bind tường minh dùng khi gateway.bind được đặt thành custom để nhắm mục tiêu giao diện thủ công. Dùng địa chỉ chính xác và tránh bind ký tự đại diện trừ khi cần phơi bày ra bên ngoài.",
  "Explicit browser executable path when auto-discovery is insufficient for your host environment. Use absolute stable paths so launch behavior stays deterministic across restarts.":
    "Đường dẫn executable trình duyệt tường minh khi tự động phát hiện không đủ cho môi trường máy chủ của bạn. Dùng đường dẫn tuyệt đối ổn định để hành vi khởi chạy luôn xác định qua các lần khởi động lại.",
  "Explicit delivery targets used when forwarding mode includes targets, each with channel and destination details. Keep target lists least-privilege and validate each destination before enabling broad forwarding.":
    "Các đích phân phối tường minh dùng khi chế độ chuyển tiếp bao gồm targets, mỗi đích có chi tiết về kênh và nơi nhận. Giữ danh sách đích theo nguyên tắc đặc quyền tối thiểu và xác thực từng nơi nhận trước khi bật chuyển tiếp rộng.",
  "Explicit delivery targets used when plugin approval forwarding mode includes targets, each with channel and destination details.":
    "Các đích phân phối tường minh được dùng khi chế độ chuyển tiếp phê duyệt plugin bao gồm targets, mỗi mục có thông tin kênh và đích đến.",
  "Explicit gateway-level tool allowlist when you want a narrow set of tools available at runtime. Use this for locked-down environments where tool scope must be tightly controlled.":
    "Danh sách cho phép công cụ tường minh ở cấp Gateway khi bạn muốn chỉ một tập công cụ giới hạn khả dụng lúc chạy. Dùng mục này cho các môi trường bị khóa chặt, nơi phạm vi công cụ phải được kiểm soát nghiêm ngặt.",
  "Explicit gateway-level tool denylist to block risky tools even if lower-level policies allow them. Use deny rules for emergency response and defense-in-depth hardening.":
    "Danh sách chặn công cụ tường minh ở cấp Gateway để chặn các công cụ rủi ro ngay cả khi chính sách cấp thấp hơn cho phép. Dùng quy tắc chặn cho ứng phó khẩn cấp và tăng cường phòng thủ nhiều lớp.",
  "Explicit hostname allowlist exceptions for SSRF policy checks on browser/network requests. Keep this list minimal and review entries regularly to avoid stale broad access.":
    "Các ngoại lệ danh sách cho phép hostname tường minh cho kiểm tra chính sách SSRF trên các yêu cầu trình duyệt/mạng. Giữ danh sách này ở mức tối thiểu và rà soát các mục thường xuyên để tránh quyền truy cập rộng bị lỗi thời.",
  "Explicit key/value environment variable overrides merged into runtime process environment for OpenClaw. Use this for deterministic env configuration instead of relying only on shell profile side effects.":
    "Các ghi đè biến môi trường key/value tường minh được hợp nhất vào môi trường tiến trình lúc chạy cho OpenClaw. Dùng mục này để cấu hình env mang tính xác định thay vì chỉ dựa vào tác động phụ của shell profile.",
  "Explicit list of configured agents with IDs and optional overrides for model, tools, identity, and workspace. Keep IDs stable over time so bindings, approvals, and session routing remain deterministic.":
    "Danh sách tường minh các tác nhân đã cấu hình với ID và các ghi đè tùy chọn cho model, tools, identity và workspace. Giữ ID ổn định theo thời gian để bindings, approvals và định tuyến phiên vẫn mang tính xác định.",
  "Explicit owner allowlist for owner-only tools/commands. Use channel-native IDs (optionally prefixed like \"whatsapp:+15551234567\"). '*' is ignored.":
    "Danh sách cho phép owner tường minh cho các công cụ/lệnh chỉ dành cho owner. Dùng ID gốc của kênh (có thể có tiền tố như \"whatsapp:+15551234567\"). '*' sẽ bị bỏ qua.",
  "Explicit proxy URL for audio provider traffic when proxy.mode is explicit-proxy. Keep credentials out of inline URLs when possible and prefer secret-backed env injection.":
    "URL proxy tường minh cho lưu lượng của nhà cung cấp âm thanh khi proxy.mode là explicit-proxy. Tránh đưa thông tin xác thực vào URL nội tuyến khi có thể và ưu tiên chèn env được hậu thuẫn bởi secret.",
  "Explicit proxy URL used when request.proxy.mode is explicit-proxy. Credentials embedded in the URL are treated as sensitive and redacted from snapshots.":
    "URL proxy tường minh được dùng khi request.proxy.mode là explicit-proxy. Thông tin xác thực được nhúng trong URL được xem là nhạy cảm và sẽ bị ẩn khỏi snapshots.",
  "Explicit session key override for mapping-delivered messages to control thread continuity. Use stable scoped keys so repeated events correlate without leaking into unrelated conversations.":
    "Ghi đè session key tường minh để ánh xạ các tin nhắn được phân phối nhằm duy trì tính liên tục của luồng điều khiển. Dùng các key có phạm vi ổn định để các sự kiện lặp lại có thể tương quan mà không rò rỉ sang các cuộc trò chuyện không liên quan.",
  "Explicitly allows this plugin to request provider/model overrides in background subagent runs. Keep false unless the plugin is trusted to steer model selection.":
    "Cho phép tường minh plugin này yêu cầu ghi đè provider/model trong các lần chạy tác nhân phụ nền. Giữ là false trừ khi plugin được tin cậy để điều hướng việc chọn model.",
  "Exponential backoff multiplier used between reconnect attempts in web channel retry loops. Keep factor above 1 and tune with jitter for stable large-fleet reconnect behavior.":
    "Hệ số exponential backoff được dùng giữa các lần thử kết nối lại trong vòng lặp retry của kênh web. Giữ hệ số lớn hơn 1 và tinh chỉnh cùng jitter để hành vi kết nối lại của đội triển khai lớn ổn định.",
  "Expose the local browser control server through node proxy routing so remote clients can use this host's browser capabilities. Keep disabled unless remote automation explicitly depends on it.":
    "Công khai máy chủ điều khiển trình duyệt cục bộ thông qua định tuyến proxy của node để các máy khách từ xa có thể dùng khả năng trình duyệt của máy chủ này. Giữ ở trạng thái tắt trừ khi tự động hóa từ xa phụ thuộc rõ ràng vào nó.",
  "External relay settings for relay-backed APNs sends. The gateway uses this relay for push.test, wake nudges, and reconnect wakes after a paired official iOS build publishes a relay-backed registration.":
    "Cài đặt relay bên ngoài cho các lần gửi APNs dùng relay. Gateway dùng relay này cho push.test, wake nudges và reconnect wakes sau khi một bản dựng iOS chính thức đã ghép cặp phát hành đăng ký dùng relay.",
  "Extra headers merged into provider requests after default attribution and auth resolution.":
    "Các header bổ sung được hợp nhất vào các yêu cầu provider sau khi hoàn tất attribution mặc định và phân giải auth.",
  "Extra Memory Paths": "Đường dẫn bộ nhớ bổ sung",
  "Extra node.invoke commands to allow beyond the gateway defaults (array of command strings). Enabling dangerous commands here is a security-sensitive override and is flagged by `openclaw security audit`.":
    "Các lệnh node.invoke bổ sung được phép ngoài mặc định của Gateway (mảng chuỗi lệnh). Việc bật các lệnh nguy hiểm tại đây là một ghi đè nhạy cảm về bảo mật và sẽ được gắn cờ bởi `openclaw security audit`.",
  "Extra stable-channel rollout spread window in hours (default: 12).":
    "Cửa sổ phân bổ rollout kênh ổn định bổ sung tính theo giờ (mặc định: 12).",
  "Extra tool allowlist entries merged on top of the selected tool profile and default policy. Keep this list small and explicit so audits can quickly identify intentional policy exceptions.":
    "Các mục danh sách cho phép công cụ bổ sung được hợp nhất chồng lên hồ sơ công cụ đã chọn và chính sách mặc định. Giữ danh sách này nhỏ và tường minh để việc kiểm tra có thể nhanh chóng xác định các ngoại lệ chính sách có chủ đích.",
  "Failover Window (hours)": "Cửa sổ chuyển đổi dự phòng (giờ)",
  "Failure window (hours) for backoff counters (default: 24).":
    "Cửa sổ lỗi (giờ) cho các bộ đếm backoff (mặc định: 24).",
  "Fallback ACP target agent id used when ACP spawns do not specify an explicit target.":
    "ID tác nhân đích ACP dự phòng được dùng khi các lần sinh ACP không chỉ định đích tường minh.",
  "Fallback session key used for hook deliveries when a request does not provide one through allowed channels. Use a stable but scoped key to avoid mixing unrelated automation conversations.":
    "Session key dự phòng được dùng cho các lần phân phối hook khi một yêu cầu không cung cấp key thông qua các kênh được phép. Dùng một key ổn định nhưng có phạm vi để tránh trộn lẫn các cuộc trò chuyện tự động hóa không liên quan.",
  "Filesystem path to the TLS certificate file used by the gateway when TLS is enabled. Use managed certificate paths and keep renewal automation aligned with this location.":
    "Đường dẫn hệ thống tệp tới tệp chứng chỉ TLS được Gateway dùng khi TLS được bật. Dùng các đường dẫn chứng chỉ được quản lý và giữ tự động hóa gia hạn đồng bộ với vị trí này.",
  "Filesystem path to the TLS private key file used by the gateway when TLS is enabled. Keep this key file permission-restricted and rotate per your security policy.":
    "Đường dẫn hệ thống tệp tới tệp khóa riêng TLS mà gateway sử dụng khi TLS được bật. Giữ quyền truy cập tệp khóa này ở mức hạn chế và xoay vòng theo chính sách bảo mật của bạn.",
  "Filesystem root directory served by canvas host for canvas content and static assets. Use a dedicated directory and avoid broad repo roots for least-privilege file exposure.":
    "Thư mục gốc hệ thống tệp được canvas host phục vụ cho nội dung canvas và tài nguyên tĩnh. Sử dụng một thư mục chuyên dụng và tránh các thư mục gốc repo quá rộng để giảm thiểu việc lộ tệp theo nguyên tắc đặc quyền tối thiểu.",
  "Filters files under each indexed root using a glob pattern, with default `**/*.md`. Use narrower patterns to reduce noise and indexing cost when directories contain mixed file types.":
    "Lọc các tệp dưới mỗi thư mục gốc đã được lập chỉ mục bằng mẫu glob, mặc định là `**/*.md`. Sử dụng các mẫu hẹp hơn để giảm nhiễu và chi phí lập chỉ mục khi thư mục chứa nhiều loại tệp khác nhau.",
  "Fixed delay in milliseconds before retrying an overloaded provider/profile rotation (default: 0).":
    "Độ trễ cố định tính bằng mili giây trước khi thử lại việc xoay vòng provider/profile đang quá tải (mặc định: 0).",
  "Force Reindex After Compaction": "Buộc lập chỉ mục lại sau khi nén gọn",
  "Forces a session memory-search reindex after compaction-triggered transcript updates (default: true). Keep enabled when compacted summaries must be immediately searchable, or disable to reduce write-time indexing pressure.":
    "Buộc lập chỉ mục lại tìm kiếm bộ nhớ phiên sau các cập nhật bản ghi được kích hoạt bởi nén gọn (mặc định: true). Giữ bật khi các bản tóm tắt đã nén gọn cần có thể tìm kiếm ngay lập tức, hoặc tắt để giảm áp lực lập chỉ mục tại thời điểm ghi.",
  "Forces browser launch in headless mode when the local launcher starts browser instances. Keep headless enabled for server environments and disable only when visible UI debugging is required.":
    "Buộc khởi chạy trình duyệt ở chế độ headless khi trình khởi chạy cục bộ khởi động các phiên bản trình duyệt. Giữ headless được bật cho môi trường máy chủ và chỉ tắt khi cần gỡ lỗi UI hiển thị.",
  'Forces pre-compaction memory flush when transcript file size reaches this threshold (bytes or strings like "2mb"). Use this to prevent long-session hangs even when token counters are stale; set to 0 to disable.':
    'Buộc xả bộ nhớ trước khi nén gọn khi kích thước tệp bản ghi đạt ngưỡng này (byte hoặc chuỗi như "2mb"). Dùng tùy chọn này để ngăn phiên dài bị treo ngay cả khi bộ đếm token đã lỗi thời; đặt thành 0 để tắt.',
  "Format string for the echoed transcript message. Use `{transcript}` as a placeholder for the transcribed text. Default: '📝 \"{transcript}\"'.":
    "Chuỗi định dạng cho thông điệp bản ghi được echo. Dùng `{transcript}` làm chỗ giữ chỗ cho văn bản đã được phiên âm. Mặc định: '📝 \"{transcript}\"'.",
  "Forward Exec Approvals": "Chuyển tiếp phê duyệt Exec",
  "Forward Plugin Approvals": "Chuyển tiếp phê duyệt Plugin",
  "Gateway Allow x-real-ip Fallback": "Cho phép dự phòng x-real-ip của Gateway",
  "Gateway APNs Delivery": "Phân phối APNs của Gateway",
  "Gateway APNs Relay": "Relay APNs của Gateway",
  "Gateway APNs Relay Base URL": "URL cơ sở relay APNs của Gateway",
  "Gateway APNs Relay Timeout (ms)": "Thời gian chờ relay APNs của Gateway (ms)",
  "Gateway Auth": "Xác thực Gateway",
  "Gateway Auth Allow Tailscale Identity": "Xác thực Gateway cho phép danh tính Tailscale",
  "Gateway Auth Mode": "Chế độ xác thực Gateway",
  'Gateway auth mode: "none", "token", "password", or "trusted-proxy" depending on your edge architecture. Use token/password for direct exposure, and trusted-proxy only behind hardened identity-aware proxies.':
    'Chế độ xác thực Gateway: "none", "token", "password" hoặc "trusted-proxy" tùy theo kiến trúc edge của bạn. Dùng token/password khi phơi bày trực tiếp, và chỉ dùng trusted-proxy phía sau các proxy nhận biết danh tính đã được tăng cường bảo mật.',
  "Gateway Auth Rate Limit": "Giới hạn tốc độ xác thực Gateway",
  "Gateway Bind Mode": "Chế độ bind Gateway",
  "Gateway Channel Health Check Interval (min)":
    "Khoảng thời gian kiểm tra tình trạng kênh Gateway (phút)",
  "Gateway Channel Max Restarts Per Hour": "Số lần khởi động lại tối đa mỗi giờ của kênh Gateway",
  "Gateway Channel Stale Event Threshold (min)": "Ngưỡng sự kiện cũ của kênh Gateway (phút)",
  "Gateway Custom Bind Host": "Máy chủ bind tùy chỉnh của Gateway",
  "Gateway HTTP API": "API HTTP của Gateway",
  "Gateway HTTP API configuration grouping endpoint toggles and transport-facing API exposure controls. Keep only required endpoints enabled to reduce attack surface.":
    "Cấu hình API HTTP của Gateway nhóm các công tắc bật/tắt endpoint và các biện pháp kiểm soát mức độ hiển thị API đối với lớp truyền tải. Chỉ bật các endpoint cần thiết để giảm bề mặt tấn công.",
  "Gateway HTTP Endpoints": "Các endpoint HTTP của Gateway",
  "Gateway HTTP Security Headers": "Header bảo mật HTTP của Gateway",
  "Gateway Mode": "Chế độ Gateway",
  "Gateway Node Allowlist (Extra Commands)": "Danh sách cho phép nút Gateway (lệnh bổ sung)",
  "Gateway Node Browser Mode": "Chế độ trình duyệt nút Gateway",
  "Gateway Node Browser Pin": "Mã ghim trình duyệt nút Gateway",
  "Gateway Node Denylist": "Danh sách chặn nút Gateway",
  'Gateway operation mode: "local" runs channels and agent runtime on this host, while "remote" connects through remote transport. Keep "local" unless you intentionally run a split remote gateway topology.':
    'Chế độ vận hành của Gateway: "local" chạy các kênh và runtime tác nhân trên máy chủ này, còn "remote" kết nối thông qua lớp truyền tải từ xa. Giữ "local" trừ khi bạn chủ ý chạy cấu trúc liên kết gateway từ xa tách biệt.',
  "Gateway Password": "Mật khẩu Gateway",
  "Gateway Port": "Cổng Gateway",
  "Gateway Push Delivery": "Phân phối đẩy của Gateway",
  "Gateway runtime surface for bind mode, auth, control UI, remote transport, and operational safety controls. Keep conservative defaults unless you intentionally expose the gateway beyond trusted local interfaces.":
    "Bề mặt runtime của Gateway cho chế độ bind, xác thực, Control UI, truyền tải từ xa và các biện pháp kiểm soát an toàn vận hành. Giữ các giá trị mặc định thận trọng trừ khi bạn chủ ý hiển thị gateway ra ngoài các giao diện cục bộ đáng tin cậy.",
  "Gateway Tailscale": "Tailscale của Gateway",
  "Gateway Tailscale Mode": "Chế độ Tailscale của Gateway",
  "Gateway Tailscale Reset on Exit": "Đặt lại Tailscale của Gateway khi thoát",
  "Gateway TLS": "TLS của Gateway",
  "Gateway TLS Auto-Generate Cert": "Tự động tạo chứng chỉ TLS của Gateway",
  "Gateway TLS CA Path": "Đường dẫn CA TLS của Gateway",
  "Gateway TLS Certificate Path": "Đường dẫn chứng chỉ TLS của Gateway",
  "Gateway TLS Enabled": "Bật TLS cho Gateway",
  "Gateway TLS Key Path": "Đường dẫn khóa TLS của Gateway",
  "Gateway Token": "Token Gateway",
  "Gateway Tool Allowlist": "Danh sách cho phép công cụ của Gateway",
  "Gateway Tool Denylist": "Danh sách chặn công cụ của Gateway",
  "Gateway Tool Exposure Policy": "Chính sách hiển thị công cụ của Gateway",
  "Gateway Trusted Proxy Auth": "Xác thực proxy tin cậy của Gateway",
  "Gateway Trusted Proxy CIDRs": "CIDR proxy tin cậy của Gateway",
  "Gateway-level tool exposure allow/deny policy that can restrict runtime tool availability independent of agent/tool profiles. Use this for coarse emergency controls and production hardening.":
    "Chính sách cho phép/chặn hiển thị công cụ ở cấp Gateway có thể hạn chế khả năng dùng công cụ khi chạy, độc lập với hồ sơ tác nhân/công cụ. Dùng mục này cho các biện pháp kiểm soát khẩn cấp ở mức tổng quát và tăng cường an toàn cho môi trường production.",
  "Global ACP feature gate. Keep disabled unless ACP runtime + policy are configured.":
    "Cờ tính năng ACP toàn cục. Giữ ở trạng thái tắt trừ khi ACP runtime + policy đã được cấu hình.",
  "Global audio ingestion settings used before higher-level tools process speech or media content. Configure this when you need deterministic transcription behavior for voice notes and clips.":
    "Thiết lập nhập âm thanh toàn cục được dùng trước khi các công cụ cấp cao hơn xử lý nội dung giọng nói hoặc media. Cấu hình mục này khi bạn cần hành vi phiên âm xác định cho voice note và clip.",
  "Global master switch for thread-bound session routing features and focused thread delivery behavior. Keep enabled for modern thread workflows unless you need to disable thread binding globally.":
    "Công tắc chính toàn cục cho các tính năng định tuyến phiên gắn với luồng và hành vi phân phối theo luồng tập trung. Giữ bật cho các quy trình làm việc theo luồng hiện đại trừ khi bạn cần tắt ràng buộc luồng trên toàn cục.",
  "Global MCP server definitions managed by OpenClaw. Embedded Pi and other runtime adapters can consume these servers without storing them inside Pi-owned project settings.":
    "Các định nghĩa máy chủ MCP toàn cục do OpenClaw quản lý. Pi nhúng và các bộ điều hợp runtime khác có thể sử dụng các máy chủ này mà không cần lưu chúng trong thiết lập dự án do Pi sở hữu.",
  "Global no-progress breaker threshold (default: 30).":
    "Ngưỡng breaker không tiến triển toàn cục (mặc định: 30).",
  "Global queue debounce window in milliseconds before processing buffered inbound messages. Use higher values to coalesce rapid bursts, or lower values for reduced response latency.":
    "Khoảng debounce hàng đợi toàn cục tính bằng mili giây trước khi xử lý các tin nhắn đến đã được đệm. Dùng giá trị cao hơn để gộp các đợt đến nhanh liên tiếp, hoặc thấp hơn để giảm độ trễ phản hồi.",
  "Global scheduler settings for stored cron jobs, run concurrency, delivery fallback, and run-session retention. Keep defaults unless you are scaling job volume or integrating external webhook receivers.":
    "Thiết lập scheduler toàn cục cho các cron job đã lưu, mức đồng thời khi chạy, phương án dự phòng phân phối và lưu giữ run-session. Giữ mặc định trừ khi bạn đang mở rộng khối lượng job hoặc tích hợp bộ nhận webhook bên ngoài.",
  "Global session routing, reset, delivery policy, and maintenance controls for conversation history behavior. Keep defaults unless you need stricter isolation, retention, or delivery constraints.":
    "Các điều khiển toàn cục về định tuyến phiên, đặt lại, chính sách phân phối và bảo trì cho hành vi lịch sử hội thoại. Giữ mặc định trừ khi bạn cần các ràng buộc nghiêm ngặt hơn về cô lập, lưu giữ hoặc phân phối.",
  "Global tool access policy and capability configuration across web, exec, media, messaging, and elevated surfaces. Use this section to constrain risky capabilities before broad rollout.":
    "Chính sách truy cập công cụ và cấu hình khả năng toàn cục trên các bề mặt web, exec, media, nhắn tin và đặc quyền nâng cao. Dùng phần này để hạn chế các khả năng rủi ro trước khi triển khai rộng.",
  "Global tool denylist that blocks listed tools even when profile or provider rules would allow them. Use deny rules for emergency lockouts and long-term defense-in-depth.":
    "Danh sách chặn công cụ toàn cục chặn các công cụ được liệt kê ngay cả khi quy tắc hồ sơ hoặc nhà cung cấp cho phép chúng. Dùng quy tắc chặn cho các tình huống khóa khẩn cấp và chiến lược phòng thủ nhiều lớp lâu dài.",
  "Global tool profile name used to select a predefined tool policy baseline before applying allow/deny overrides. Use this for consistent environment posture across agents and keep profile names stable.":
    "Tên hồ sơ công cụ toàn cục dùng để chọn một đường cơ sở chính sách công cụ được định nghĩa sẵn trước khi áp dụng các ghi đè cho phép/chặn. Dùng mục này để duy trì tư thế môi trường nhất quán trên các tác nhân và giữ tên hồ sơ ổn định.",
  "Gmail Hook Account": "Tài khoản Gmail Hook",
  "Gmail Hook Allow Unsafe External Content":
    "Cho phép nội dung bên ngoài không an toàn cho Gmail Hook",
  "Gmail Hook Callback URL": "URL callback của Gmail Hook",
  "Gmail Hook Include Body": "Bao gồm nội dung thư trong Gmail Hook",
  "Gmail Hook Label": "Nhãn Gmail Hook",
  "Gmail Hook Local Server": "Máy chủ cục bộ Gmail Hook",
  "Gmail Hook Max Body Bytes": "Số byte nội dung tối đa của Gmail Hook",
  "Gmail Hook Model Override": "Ghi đè model của Gmail Hook",
  "Gmail Hook Pub/Sub Topic": "Chủ đề Pub/Sub của Gmail Hook",
  "Gmail Hook Push Token": "Push Token của Gmail Hook",
  "Gmail Hook Renew Interval (min)": "Khoảng thời gian gia hạn Gmail Hook (phút)",
  "Gmail Hook Server Bind Address": "Địa chỉ bind máy chủ của Gmail Hook",
  "Gmail Hook Server Path": "Đường dẫn máy chủ của Gmail Hook",
  "Gmail Hook Server Port": "Cổng máy chủ của Gmail Hook",
  "Gmail Hook Subscription": "Đăng ký của Gmail Hook",
  "Gmail Hook Tailscale": "Tailscale của Gmail Hook",
  "Gmail Hook Tailscale Mode": "Chế độ Tailscale của Gmail Hook",
  "Gmail Hook Tailscale Path": "Đường dẫn Tailscale của Gmail Hook",
  "Gmail Hook Tailscale Target": "Mục tiêu Tailscale của Gmail Hook",
  "Gmail Hook Thinking Override": "Ghi đè suy luận của Gmail Hook",
  "Gmail push integration settings used for Pub/Sub notifications and optional local callback serving. Keep this scoped to dedicated Gmail automation accounts where possible.":
    "Cài đặt tích hợp Gmail push dùng cho thông báo Pub/Sub và tùy chọn phục vụ callback cục bộ. Hãy giới hạn cấu hình này cho các tài khoản tự động hóa Gmail chuyên dụng khi có thể.",
  "Google account identifier used for Gmail watch/subscription operations in this hook integration. Use a dedicated automation mailbox account to isolate operational permissions.":
    "Mã định danh tài khoản Google dùng cho các thao tác watch/subscription của Gmail trong tích hợp hook này. Hãy dùng một tài khoản hộp thư tự động hóa chuyên dụng để tách biệt quyền vận hành.",
  "Google Pub/Sub topic name used by Gmail watch to publish change notifications for this account. Ensure the topic IAM grants Gmail publish access before enabling watches.":
    "Tên chủ đề Google Pub/Sub được Gmail watch dùng để phát hành thông báo thay đổi cho tài khoản này. Hãy bảo đảm IAM của chủ đề cấp quyền publish cho Gmail trước khi bật watch.",
  "Group Chat Rules": "Quy tắc trò chuyện nhóm",
  "Group History Limit": "Giới hạn lịch sử nhóm",
  "Group Mention Patterns": "Mẫu nhắc đến trong nhóm",
  "Group-message handling controls including mention triggers and history window sizing. Keep mention patterns narrow so group channels do not trigger on every message.":
    "Các tùy chọn xử lý tin nhắn nhóm, bao gồm trình kích hoạt nhắc đến và kích thước cửa sổ lịch sử. Hãy giữ các mẫu nhắc đến đủ hẹp để các kênh nhóm không bị kích hoạt với mọi tin nhắn.",
  "Grouping object for mapping match predicates such as path and source before action routing is applied. Keep match criteria specific so unrelated webhook traffic does not trigger automations.":
    "Đối tượng nhóm để ánh xạ các điều kiện khớp như path và source trước khi áp dụng định tuyến hành động. Hãy giữ tiêu chí khớp cụ thể để lưu lượng webhook không liên quan không kích hoạt tự động hóa.",
  "Groups browser-proxy settings for exposing local browser control through node routing. Enable only when remote node workflows need your local browser profiles.":
    "Nhóm các cài đặt browser-proxy để hiển thị quyền điều khiển trình duyệt cục bộ thông qua định tuyến nút. Chỉ bật khi các quy trình làm việc trên nút từ xa cần hồ sơ trình duyệt cục bộ của bạn.",
  "Groups controls for inter-agent session exchanges, including loop prevention limits on reply chaining. Keep defaults unless you run advanced agent-to-agent automation with strict turn caps.":
    "Nhóm các tùy chọn điều khiển cho trao đổi phiên giữa các tác nhân, bao gồm giới hạn ngăn vòng lặp đối với chuỗi phản hồi. Giữ mặc định trừ khi bạn chạy tự động hóa tác nhân với tác nhân nâng cao cùng giới hạn lượt nghiêm ngặt.",
  "Groups exec-approval forwarding behavior including enablement, routing mode, filters, and explicit targets. Configure here when approval prompts must reach operational channels instead of only the origin thread.":
    "Nhóm hành vi chuyển tiếp exec-approval bao gồm bật/tắt, chế độ định tuyến, bộ lọc và đích chỉ định rõ ràng. Cấu hình tại đây khi lời nhắc phê duyệt phải đến các kênh vận hành thay vì chỉ luồng gốc.",
  "Groups plugin-approval forwarding behavior including enablement, routing mode, filters, and explicit targets. Independent of exec approval forwarding. Configure here when plugin approval prompts must reach operational channels.":
    "Nhóm hành vi chuyển tiếp plugin-approval bao gồm bật/tắt, chế độ định tuyến, bộ lọc và đích chỉ định rõ ràng. Độc lập với chuyển tiếp phê duyệt exec. Cấu hình tại đây khi lời nhắc phê duyệt plugin phải đến các kênh vận hành.",
  "Hard cap for web_fetch maxChars (applies to config and tool calls).":
    "Giới hạn cứng cho maxChars của web_fetch (áp dụng cho cấu hình và lệnh gọi công cụ).",
  "Header name used when audio request auth.mode is header. Match the exact upstream expectation, such as x-api-key or authorization.":
    "Tên header được dùng khi auth.mode của yêu cầu âm thanh là header. Phải khớp chính xác với yêu cầu của upstream, chẳng hạn như x-api-key hoặc authorization.",
  "Header value used when audio request auth.mode is header. Keep secrets in env-backed values and avoid duplicating provider-default auth unnecessarily.":
    "Giá trị header được dùng khi auth.mode của yêu cầu âm thanh là header. Giữ bí mật trong các giá trị được hỗ trợ bởi env và tránh sao chép không cần thiết cơ chế xác thực mặc định của nhà cung cấp.",
  "Heartbeat Direct Policy": "Chính sách trực tiếp Heartbeat",
  "Heartbeat Include System Prompt Section": "Heartbeat Bao gồm phần lời nhắc hệ thống",
  "Heartbeat interval in seconds for web channel connectivity and liveness maintenance. Use shorter intervals for faster detection, or longer intervals to reduce keepalive chatter.":
    "Khoảng thời gian Heartbeat tính bằng giây để duy trì kết nối và trạng thái hoạt động của kênh web. Dùng khoảng ngắn hơn để phát hiện nhanh hơn, hoặc khoảng dài hơn để giảm lưu lượng keepalive.",
  "Heartbeat Show Alerts": "Heartbeat Hiển thị cảnh báo",
  "Heartbeat Show OK": "Heartbeat Hiển thị OK",
  "Heartbeat Suppress Tool Error Warnings": "Heartbeat Ẩn cảnh báo lỗi công cụ",
  "Heartbeat Timeout (Seconds)": "Thời gian chờ Heartbeat (Giây)",
  "Heartbeat Use Indicator": "Heartbeat Sử dụng chỉ báo",
  "Hook Mapping Action": "Hành động ánh xạ Hook",
  "Hook Mapping Agent ID": "ID tác nhân ánh xạ Hook",
  "Hook Mapping Allow Unsafe External Content":
    "Ánh xạ Hook cho phép nội dung bên ngoài không an toàn",
  "Hook Mapping Deliver Reply": "Ánh xạ Hook gửi phản hồi",
  "Hook Mapping Delivery Channel": "Kênh phân phối ánh xạ Hook",
  "Hook Mapping Delivery Destination": "Đích phân phối ánh xạ Hook",
  "Hook Mapping ID": "ID ánh xạ Hook",
  "Hook Mapping Match": "Khớp ánh xạ Hook",
  "Hook Mapping Match Path": "Đường dẫn khớp ánh xạ Hook",
  "Hook Mapping Match Source": "Nguồn khớp ánh xạ Hook",
  "Hook Mapping Message Template": "Mẫu tin nhắn ánh xạ Hook",
  "Hook Mapping Model Override": "Ghi đè model ánh xạ Hook",
  "Hook Mapping Name": "Tên ánh xạ Hook",
  "Hook Mapping Session Key": "Khóa phiên ánh xạ Hook",
  "Hook Mapping Text Template": "Mẫu văn bản ánh xạ Hook",
  "Hook Mapping Thinking Override": "Ghi đè suy luận ánh xạ Hook",
  "Hook Mapping Timeout (sec)": "Thời gian chờ ánh xạ Hook (giây)",
  "Hook Mapping Transform": "Biến đổi ánh xạ Hook",
  "Hook Mapping Wake Mode": "Chế độ đánh thức ánh xạ Hook",
  "Hook Mappings": "Ánh xạ Hook",
  "Hook Transform Export": "Xuất biến đổi Hook",
  "Hook Transform Module": "Mô-đun biến đổi Hook",
  "Hooks Allow Request Session Key": "Hooks cho phép khóa phiên yêu cầu",
  "Hooks Allowed Agent IDs": "ID tác nhân được phép cho Hooks",
  "Hooks Allowed Session Key Prefixes": "Tiền tố khóa phiên được phép cho Hooks",
  "Hooks Auth Token": "Token xác thực Hooks",
  "Hooks Default Session Key": "Khóa phiên mặc định của Hooks",
  "Hooks Enabled": "Bật Hooks",
  "Hooks Endpoint Path": "Đường dẫn endpoint của Hooks",
  "Hooks Max Body Bytes": "Số byte nội dung tối đa của Hooks",
  "Hooks Presets": "Preset của Hooks",
  "Hooks Transforms Directory": "Thư mục biến đổi của Hooks",
  'How embedded Pi handles workspace-local `.pi/config/settings.json`: "sanitize" (default) strips shellPath/shellCommandPrefix, "ignore" disables project settings entirely, and "trusted" applies project settings as-is.':
    'Cách Pi nhúng xử lý `.pi/config/settings.json` cục bộ theo workspace: "sanitize" (mặc định) loại bỏ shellPath/shellCommandPrefix, "ignore" vô hiệu hóa hoàn toàn cài đặt dự án, và "trusted" áp dụng nguyên trạng cài đặt dự án.',
  "How long bash waits before backgrounding (default: 2000; 0 backgrounds immediately).":
    "Khoảng thời gian bash chờ trước khi chuyển sang chạy nền (mặc định: 2000; 0 sẽ chạy nền ngay lập tức).",
  "How many minutes a connected channel can go without receiving any event before the health monitor treats it as a stale socket and triggers a restart. Default: 30.":
    "Số phút một kênh đã kết nối có thể không nhận bất kỳ sự kiện nào trước khi bộ giám sát tình trạng xem đó là socket cũ và kích hoạt khởi động lại. Mặc định: 30.",
  "How many trailing run-log lines to retain when a file exceeds maxBytes (default `2000`). Increase for longer forensic history or lower for smaller disks.":
    "Số dòng nhật ký chạy ở cuối cần giữ lại khi một tệp vượt quá maxBytes (mặc định `2000`). Tăng để có lịch sử điều tra dài hơn hoặc giảm để phù hợp với ổ đĩa nhỏ hơn.",
  "How often beta-channel checks run in hours (default: 1).":
    "Tần suất chạy kiểm tra kênh beta theo giờ (mặc định: 1).",
  "HTTP endpoint feature toggles under the gateway API surface for compatibility routes and optional integrations. Enable endpoints intentionally and monitor access patterns after rollout.":
    "Các cờ bật/tắt tính năng endpoint HTTP dưới bề mặt API Gateway cho các route tương thích và tích hợp tùy chọn. Chỉ bật endpoint khi có chủ đích và theo dõi mẫu truy cập sau khi triển khai.",
  "HTTP path on the local Gmail callback server where push notifications are accepted. Keep this consistent with subscription configuration to avoid dropped events.":
    "Đường dẫn HTTP trên máy chủ callback Gmail cục bộ nơi chấp nhận thông báo đẩy. Giữ nhất quán với cấu hình đăng ký để tránh mất sự kiện.",
  "HTTP path used by the hooks endpoint (for example `/hooks`) on the gateway control server. Use a non-guessable path and combine it with token validation for defense in depth.":
    "Đường dẫn HTTP được endpoint hooks sử dụng (ví dụ `/hooks`) trên máy chủ điều khiển Gateway. Sử dụng đường dẫn khó đoán và kết hợp với xác thực token để tăng cường phòng vệ nhiều lớp.",
  "Human Delay Max (ms)": "Độ trễ tối đa của con người (ms)",
  "Human Delay Min (ms)": "Độ trễ tối thiểu của con người (ms)",
  "Human Delay Mode": "Chế độ độ trễ của con người",
  "Human-friendly label for ACP status/diagnostics in this bound conversation.":
    "Nhãn thân thiện với người dùng cho trạng thái/chẩn đoán ACP trong cuộc hội thoại đã liên kết này.",
  "Human-readable mapping display name used in diagnostics and operator-facing config UIs. Keep names concise and descriptive so routing intent is obvious during incident review.":
    "Tên hiển thị ánh xạ dễ đọc dùng trong chẩn đoán và UI cấu hình hướng tới người vận hành. Giữ tên ngắn gọn và mô tả rõ để ý định định tuyến được rõ ràng khi xem xét sự cố.",
  "Id of a registered compaction provider plugin used for summarization. When set and the provider is registered, its summarize() method is called instead of the built-in summarizeInStages pipeline. Falls back to built-in on provider failure. Leave unset to use the default built-in summarization.":
    "Id của plugin nhà cung cấp compaction đã đăng ký dùng cho việc tóm tắt. Khi được đặt và nhà cung cấp đã đăng ký, phương thức summarize() của nó sẽ được gọi thay cho pipeline summarizeInStages tích hợp. Sẽ quay về cơ chế tích hợp nếu nhà cung cấp gặp lỗi. Để trống để dùng tính năng tóm tắt tích hợp mặc định.",
  'Identifier-preservation policy for compaction summaries: "strict" prepends built-in opaque-identifier retention guidance (default), "off" disables this prefix, and "custom" uses identifierInstructions. Keep "strict" unless you have a specific compatibility need.':
    'Chính sách bảo toàn định danh cho bản tóm tắt compaction: "strict" thêm trước hướng dẫn tích hợp về giữ lại định danh mờ đục (mặc định), "off" tắt tiền tố này, và "custom" sử dụng identifierInstructions. Giữ "strict" trừ khi bạn có nhu cầu tương thích cụ thể.',
  "Identity Avatar": "Ảnh đại diện danh tính",
  "Idle runtime TTL in minutes for ACP session workers before eligible cleanup.":
    "TTL runtime nhàn rỗi tính bằng phút cho worker phiên ACP trước khi đủ điều kiện dọn dẹp.",
  "Idle timeout for LLM streaming responses in seconds. If no token is received within this time, the request is aborted. Set to 0 to disable. Default: 60 seconds.":
    "Thời gian chờ nhàn rỗi cho phản hồi streaming của LLM tính bằng giây. Nếu không nhận được token nào trong khoảng thời gian này, yêu cầu sẽ bị hủy. Đặt thành 0 để tắt. Mặc định: 60 giây.",
  "If true (default), stop assistant speech when the user starts speaking in Talk mode. Keep enabled for conversational turn-taking.":
    "Nếu là true (mặc định), dừng giọng nói của trợ lý khi người dùng bắt đầu nói trong chế độ Talk. Nên giữ bật để hỗ trợ luân phiên hội thoại.",
  "Image fetch/validation controls for OpenAI-compatible `image_url` parts.":
    "Điều khiển tìm nạp/xác thực hình ảnh cho các phần `image_url` tương thích OpenAI.",
  "Image Generation Model": "Mô hình tạo ảnh",
  "Image Generation Model Fallbacks": "Phương án dự phòng của mô hình tạo ảnh",
  "Image Max Dimension (px)": "Kích thước tối đa của hình ảnh (px)",
  "Image Model": "Mô hình ảnh",
  "Image Model Fallbacks": "Mô hình ảnh dự phòng",
  "Image Understanding Attachment Policy": "Chính sách tệp đính kèm cho hiểu nội dung hình ảnh",
  "Image Understanding Max Bytes": "Số byte tối đa cho hiểu nội dung hình ảnh",
  "Image Understanding Max Chars": "Số ký tự tối đa cho hiểu nội dung hình ảnh",
  "Image Understanding Models": "Các mô hình hiểu nội dung hình ảnh",
  "Image Understanding Prompt": "Prompt hiểu nội dung hình ảnh",
  "Image Understanding Scope": "Phạm vi hiểu nội dung hình ảnh",
  "Image Understanding Timeout (sec)": "Thời gian chờ hiểu nội dung hình ảnh (giây)",
  "Inbound Debounce": "Chống dội đầu vào",
  "Inbound Debounce by Channel (ms)": "Chống dội đầu vào theo kênh (ms)",
  "Inbound Message Debounce (ms)": "Chống dội tin nhắn đầu vào (ms)",
  "Inbound Message Prefix": "Tiền tố tin nhắn đầu vào",
  "Inbound message queue strategy used to buffer bursts before processing turns. Tune this for busy channels where sequential processing or batching behavior matters.":
    "Chiến lược hàng đợi tin nhắn đầu vào dùng để đệm các đợt tăng đột biến trước khi xử lý lượt. Hãy điều chỉnh mục này cho các kênh bận rộn, nơi việc xử lý tuần tự hoặc hành vi gom lô là quan trọng.",
  "Inbound Queue": "Hàng đợi đầu vào",
  "Inbound webhook automation surface for mapping external events into wake or agent actions in OpenClaw. Keep this locked down with explicit token/session/agent controls before exposing it beyond trusted networks.":
    "Bề mặt tự động hóa webhook đầu vào để ánh xạ các sự kiện bên ngoài thành hành động đánh thức hoặc hành động của tác nhân trong OpenClaw. Hãy khóa chặt tính năng này bằng các cơ chế kiểm soát token/session/tác nhân rõ ràng trước khi mở ra ngoài các mạng đáng tin cậy.",
  'Include absolute timestamps in message envelopes ("on" or "off").':
    'Bao gồm dấu thời gian tuyệt đối trong phong bì tin nhắn ("on" hoặc "off").',
  'Include elapsed time in message envelopes ("on" or "off").':
    'Bao gồm thời gian đã trôi qua trong phong bì tin nhắn ("on" hoặc "off").',
  "Include full message payloads in trace output (default: true).":
    "Bao gồm toàn bộ payload tin nhắn trong đầu ra trace (mặc định: true).",
  "Include prompt text in trace output (default: true).":
    "Bao gồm văn bản prompt trong đầu ra trace (mặc định: true).",
  "Include system prompt in trace output (default: true).":
    "Bao gồm system prompt trong đầu ra trace (mặc định: true).",
  "Includes the default agent's ## Heartbeats system prompt section when true. Turn this off to keep heartbeat runtime behavior while omitting the heartbeat prompt instructions from the agent system prompt.":
    "Bao gồm phần system prompt ## Heartbeats của tác nhân mặc định khi là true. Tắt mục này để giữ hành vi runtime heartbeat nhưng bỏ qua các hướng dẫn prompt heartbeat khỏi system prompt của tác nhân.",
  "Independent dispatch gate for ACP session turns (default: true). Set false to keep ACP commands available while blocking ACP turn execution.":
    "Cổng điều phối độc lập cho các lượt session ACP (mặc định: true). Đặt thành false để giữ các lệnh ACP khả dụng trong khi chặn việc thực thi lượt ACP.",
  "Index on Search (Lazy)": "Lập chỉ mục khi Tìm kiếm (Lazy)",
  "Index on Session Start": "Lập chỉ mục khi Bắt đầu phiên",
  "Indexes session transcripts into memory search so responses can reference prior chat turns. Keep this off unless transcript recall is needed, because indexing cost and storage usage both increase.":
    "Lập chỉ mục bản ghi phiên vào bộ nhớ tìm kiếm để phản hồi có thể tham chiếu các lượt trò chuyện trước đó. Giữ tắt tùy chọn này trừ khi cần nhớ lại bản ghi, vì cả chi phí lập chỉ mục và mức sử dụng lưu trữ đều tăng.",
  "Indexes session transcripts into QMD so recall can include prior conversation content (experimental, default: false). Enable only when transcript memory is required and you accept larger index churn.":
    "Lập chỉ mục bản ghi phiên vào QMD để việc nhớ lại có thể bao gồm nội dung hội thoại trước đó (thử nghiệm, mặc định: false). Chỉ bật khi cần bộ nhớ bản ghi và bạn chấp nhận mức thay đổi chỉ mục lớn hơn.",
  "Initial reconnect delay in milliseconds before the first retry after disconnection. Use modest delays to recover quickly without immediate retry storms.":
    "Độ trễ kết nối lại ban đầu tính bằng mili giây trước lần thử lại đầu tiên sau khi ngắt kết nối. Dùng độ trễ vừa phải để khôi phục nhanh mà không gây bão thử lại ngay lập tức.",
  'Inject agent-visible warning text when bootstrap files are truncated: "off", "once" (default), or "always".':
    'Chèn văn bản cảnh báo hiển thị cho tác nhân khi các tệp bootstrap bị cắt bớt: "off", "once" (mặc định), hoặc "always".',
  "Insecure Control UI Auth Toggle": "Công tắc xác thực Control UI không an toàn",
  "Install metadata for internal hook modules, including source and resolved artifacts for repeatable deployments. Use this as operational provenance and avoid manual drift edits.":
    "Cài đặt siêu dữ liệu cho các mô-đun hook nội bộ, bao gồm nguồn và các tạo phẩm đã phân giải để triển khai có thể lặp lại. Dùng mục này làm nguồn gốc vận hành và tránh chỉnh sửa thủ công gây lệch cấu hình.",
  'Install source ("npm", "archive", or "path").': 'Nguồn cài đặt ("npm", "archive", hoặc "path").',
  "Instruction template for video understanding describing desired summary granularity and focus areas. Keep this stable so output quality remains predictable across model/provider fallbacks.":
    "Mẫu hướng dẫn cho việc hiểu video, mô tả mức độ chi tiết của bản tóm tắt và các khu vực trọng tâm mong muốn. Giữ ổn định mục này để chất lượng đầu ra luôn có thể dự đoán qua các phương án dự phòng model/nhà cung cấp.",
  "Instruction template guiding audio understanding output style, such as concise summary versus near-verbatim transcript. Keep wording consistent so downstream automations can rely on output format.":
    "Mẫu hướng dẫn định hướng kiểu đầu ra của việc hiểu âm thanh, chẳng hạn như tóm tắt ngắn gọn so với bản chép gần nguyên văn. Giữ cách diễn đạt nhất quán để các quy trình tự động phía sau có thể dựa vào định dạng đầu ra.",
  "Instruction template used for image understanding requests to shape extraction style and detail level. Keep prompts deterministic so outputs stay consistent across turns and channels.":
    "Mẫu hướng dẫn dùng cho các yêu cầu hiểu hình ảnh để định hình kiểu trích xuất và mức độ chi tiết. Giữ prompt có tính xác định để đầu ra nhất quán giữa các lượt và các kênh.",
  "Internal Hook Entries": "Mục hook nội bộ",
  "Internal Hook Extra Directories": "Thư mục bổ sung của hook nội bộ",
  "Internal Hook Install Records": "Bản ghi cài đặt hook nội bộ",
  "Internal Hook Loader": "Trình tải hook nội bộ",
  "Internal hook loader settings controlling where handler modules are discovered at startup. Use constrained load roots to reduce accidental module conflicts or shadowing.":
    "Cài đặt trình tải hook nội bộ kiểm soát nơi các mô-đun xử lý được phát hiện khi khởi động. Dùng các gốc tải giới hạn để giảm xung đột hoặc che khuất mô-đun ngoài ý muốn.",
  "Internal hook runtime settings for bundled/custom event handlers loaded from module paths. Use this for trusted in-process automations and keep handler loading tightly scoped.":
    "Cài đặt thời gian chạy hook nội bộ cho các trình xử lý sự kiện đóng gói/tùy chỉnh được tải từ đường dẫn mô-đun. Dùng mục này cho các quy trình tự động trong tiến trình đáng tin cậy và giữ phạm vi tải trình xử lý được giới hạn chặt chẽ.",
  "Internal Hooks": "Hook nội bộ",
  "Internal Hooks Enabled": "Bật hook nội bộ",
  "Interval in milliseconds for periodic telemetry flush from buffers to the collector. Increase to reduce export chatter, or lower for faster visibility during active incident response.":
    "Khoảng thời gian tính bằng mili giây để định kỳ đẩy telemetry từ bộ đệm tới collector. Tăng để giảm lưu lượng xuất dữ liệu, hoặc giảm để có khả năng quan sát nhanh hơn trong quá trình ứng phó sự cố đang diễn ra.",
  "Interval in minutes for automatic channel health probing and status updates. Use lower intervals for faster detection, or higher intervals to reduce periodic probe noise.":
    "Khoảng thời gian tính bằng phút cho việc thăm dò tình trạng kênh và cập nhật trạng thái tự động. Dùng khoảng thấp hơn để phát hiện nhanh hơn, hoặc cao hơn để giảm nhiễu từ các lần thăm dò định kỳ.",
  "ISO timestamp for when the setup wizard most recently completed on this host. Use this to confirm setup recency during support and operational audits.":
    "Dấu thời gian ISO cho lần gần nhất trình hướng dẫn thiết lập hoàn tất trên máy chủ này. Dùng mục này để xác nhận tính gần đây của thiết lập trong hỗ trợ và kiểm tra vận hành.",
  "ISO timestamp of last install/update.": "Dấu thời gian ISO của lần cài đặt/cập nhật gần nhất.",
  "ISO timestamp of the last config write (auto-set).":
    "Dấu thời gian ISO của lần ghi cấu hình gần nhất (tự động đặt).",
  "ISO timestamp when npm package metadata was last resolved for this install record.":
    "Dấu thời gian ISO khi siêu dữ liệu gói npm được phân giải lần gần nhất cho bản ghi cài đặt này.",
  "JSONL output path for cache trace logs (default: $OPENCLAW_STATE_DIR/logs/cache-trace.jsonl).":
    "Đường dẫn đầu ra JSONL cho nhật ký theo dõi bộ nhớ đệm (mặc định: $OPENCLAW_STATE_DIR/logs/cache-trace.jsonl).",
  "Legacy override: allow cross-context sends across all providers.":
    "Ghi đè cũ: cho phép gửi chéo ngữ cảnh trên tất cả nhà cung cấp.",
  "Legacy/alternate hostname allowlist field used by SSRF policy consumers for explicit host exceptions. Use stable exact hostnames and avoid wildcard-like broad patterns.":
    "Trường danh sách cho phép tên máy chủ cũ/thay thế được các thành phần sử dụng chính sách SSRF dùng cho các ngoại lệ máy chủ rõ ràng. Sử dụng tên máy chủ chính xác, ổn định và tránh các mẫu quá rộng kiểu ký tự đại diện.",
  "Lifecycle status reactions that update the emoji on the trigger message as the agent progresses (queued → thinking → tool → done/error).":
    "Các phản ứng trạng thái vòng đời cập nhật emoji trên tin nhắn kích hoạt khi tác nhân tiến triển (queued → thinking → tool → done/error).",
  "Limits how many cron jobs can execute at the same time when multiple schedules fire together. Use lower values to protect CPU/memory under heavy automation load, or raise carefully for higher throughput.":
    "Giới hạn số lượng tác vụ cron có thể thực thi cùng lúc khi nhiều lịch chạy đồng thời. Dùng giá trị thấp hơn để bảo vệ CPU/bộ nhớ khi tải tự động hóa cao, hoặc tăng cẩn thận để đạt thông lượng cao hơn.",
  "Limits how many embedding batch jobs run at the same time during indexing (default: 2). Increase carefully for faster bulk indexing, but watch provider rate limits and queue errors.":
    "Giới hạn số lượng tác vụ lô embedding chạy cùng lúc trong quá trình lập chỉ mục (mặc định: 2). Tăng cẩn thận để lập chỉ mục hàng loạt nhanh hơn, nhưng cần theo dõi giới hạn tốc độ của nhà cung cấp và lỗi hàng đợi.",
  "Limits how many QMD hits are returned into the agent loop for each recall request (default: 6). Increase for broader recall context, or lower to keep prompts tighter and faster.":
    "Giới hạn số lượng kết quả QMD được trả về vào vòng lặp tác nhân cho mỗi yêu cầu truy hồi (mặc định: 6). Tăng để có ngữ cảnh truy hồi rộng hơn, hoặc giảm để giữ prompt gọn hơn và nhanh hơn.",
  "Link Understanding Max Links": "Số liên kết tối đa cho Link Understanding",
  "Link Understanding Models": "Mô hình Link Understanding",
  "Link Understanding Scope": "Phạm vi Link Understanding",
  "Link Understanding Timeout (sec)": "Thời gian chờ Link Understanding (giây)",
  "Lists message triggers that force a session reset when matched in inbound content. Use sparingly for explicit reset phrases so context is not dropped unexpectedly during normal conversation.":
    "Liệt kê các trình kích hoạt tin nhắn buộc đặt lại phiên khi khớp với nội dung đầu vào. Chỉ dùng hạn chế cho các cụm từ đặt lại rõ ràng để ngữ cảnh không bị mất ngoài ý muốn trong hội thoại thông thường.",
  "Live config-reload policy for how edits are applied and when full restarts are triggered. Keep hybrid behavior for safest operational updates unless debugging reload internals.":
    "Chính sách tải lại cấu hình trực tiếp về cách áp dụng chỉnh sửa và thời điểm kích hoạt khởi động lại toàn bộ. Giữ hành vi hybrid để cập nhật vận hành an toàn nhất trừ khi đang gỡ lỗi cơ chế tải lại nội bộ.",
  "Local callback server settings block for directly receiving Gmail notifications without a separate ingress layer. Enable only when this process should terminate webhook traffic itself.":
    "Khối cài đặt máy chủ callback cục bộ để nhận trực tiếp thông báo Gmail mà không cần lớp ingress riêng. Chỉ bật khi tiến trình này cần tự kết thúc lưu lượng webhook.",
  "Local Embedding Model Path": "Đường dẫn mô hình embedding cục bộ",
  "Local service target forwarded by Tailscale Serve/Funnel (for example http://127.0.0.1:8787). Use explicit loopback targets to avoid ambiguous routing.":
    "Đích dịch vụ cục bộ được chuyển tiếp bởi Tailscale Serve/Funnel (ví dụ http://127.0.0.1:8787). Sử dụng đích loopback tường minh để tránh định tuyến mơ hồ.",
  "Log cache trace snapshots for embedded agent runs (default: false).":
    "Ghi nhật ký ảnh chụp theo dõi bộ nhớ đệm cho các lần chạy tác nhân nhúng (mặc định: false).",
  "Log File Path": "Đường dẫn tệp nhật ký",
  "Log Level": "Mức nhật ký",
  Logging: "Ghi nhật ký",
  "Logging behavior controls for severity, output destinations, formatting, and sensitive-data redaction. Keep levels and redaction strict enough for production while preserving useful diagnostics.":
    "Các điều khiển hành vi ghi nhật ký cho mức độ nghiêm trọng, đích đầu ra, định dạng và che giấu dữ liệu nhạy cảm. Giữ mức và việc che giấu đủ nghiêm ngặt cho môi trường production trong khi vẫn bảo toàn chẩn đoán hữu ích.",
  "Login/auth attempt throttling controls to reduce credential brute-force risk at the gateway boundary. Keep enabled in exposed environments and tune thresholds to your traffic baseline.":
    "Các điều khiển giới hạn tốc độ cho lần thử đăng nhập/xác thực nhằm giảm rủi ro dò mật khẩu tại ranh giới Gateway. Giữ bật trong các môi trường công khai và điều chỉnh ngưỡng theo mức lưu lượng cơ sở của bạn.",
  "Loosens strict browser auth checks for Control UI when you must run a non-standard setup. Keep this off unless you trust your network and proxy path, because impersonation risk is higher.":
    "Nới lỏng các kiểm tra xác thực trình duyệt nghiêm ngặt cho Control UI khi bạn buộc phải chạy một thiết lập không tiêu chuẩn. Hãy giữ tùy chọn này ở trạng thái tắt trừ khi bạn tin cậy mạng và đường đi proxy của mình, vì rủi ro mạo danh sẽ cao hơn.",
  "Low-level HTTP request overrides for audio providers, including custom headers, auth, proxy routing, and TLS client settings. Use this for proxy-backed or self-hosted transcription endpoints when plain baseUrl/apiKey fields are not enough.":
    "Các ghi đè yêu cầu HTTP cấp thấp cho nhà cung cấp âm thanh, bao gồm header tùy chỉnh, auth, định tuyến proxy và cài đặt ứng dụng khách TLS. Dùng mục này cho các endpoint phiên âm chạy sau proxy hoặc tự lưu trữ khi các trường baseUrl/apiKey thông thường là không đủ.",
  "Map provider -> channel id -> model override (values are provider/model or aliases).":
    "Ánh xạ provider -> channel id -> ghi đè model (giá trị là provider/model hoặc bí danh).",
  'Mapping action type: "wake" triggers agent wake flow, while "agent" sends directly to agent handling. Use "agent" for immediate execution and "wake" when heartbeat-driven processing is preferred.':
    'Loại hành động ánh xạ: "wake" kích hoạt luồng đánh thức tác nhân, còn "agent" gửi trực tiếp đến xử lý của tác nhân. Dùng "agent" để thực thi ngay lập tức và "wake" khi ưu tiên xử lý theo heartbeat.',
  "Maps canonical identities to provider-prefixed peer IDs so equivalent users resolve to one DM thread (example: telegram:123456). Use this when the same human appears across multiple channels or accounts.":
    "Ánh xạ các danh tính chuẩn tắc tới peer ID có tiền tố provider để những người dùng tương đương được phân giải về một luồng DM duy nhất (ví dụ: telegram:123456). Dùng mục này khi cùng một người xuất hiện trên nhiều kênh hoặc tài khoản.",
  "Marketplace display name recorded for marketplace-backed plugin installs (if available).":
    "Tên hiển thị trên marketplace được ghi lại cho các lượt cài đặt plugin dựa trên marketplace (nếu có).",
  "Master toggle for diagnostics instrumentation output in logs and telemetry wiring paths. Keep enabled for normal observability, and disable only in tightly constrained environments.":
    "Công tắc chính cho đầu ra instrumentation chẩn đoán trong log và các đường dẫn kết nối telemetry. Hãy giữ bật để có khả năng quan sát thông thường, và chỉ tắt trong các môi trường bị ràng buộc chặt chẽ.",
  "Master toggle for memory search indexing and retrieval behavior on this agent profile. Keep enabled for semantic recall, and disable when you want fully stateless responses.":
    "Công tắc chính cho hành vi lập chỉ mục và truy xuất tìm kiếm bộ nhớ trên hồ sơ tác nhân này. Hãy giữ bật để hỗ trợ ghi nhớ ngữ nghĩa, và tắt khi bạn muốn phản hồi hoàn toàn không trạng thái.",
  "Match rule object for deciding when a binding applies, including channel and optional account/peer constraints. Keep rules narrow to avoid accidental agent takeover across contexts.":
    "Đối tượng quy tắc khớp để quyết định khi nào một liên kết được áp dụng, bao gồm kênh và các ràng buộc tài khoản/peer tùy chọn. Hãy giữ quy tắc đủ hẹp để tránh việc tác nhân vô tình tiếp quản trên nhiều ngữ cảnh.",
  "Matches a normalized session-key prefix after internal key normalization steps in policy consumers. Use this for general prefix controls, and prefer rawKeyPrefix when exact full-key matching is required.":
    "Khớp với tiền tố session-key đã được chuẩn hóa sau các bước chuẩn hóa khóa nội bộ trong các bộ tiêu thụ chính sách. Dùng mục này cho các kiểm soát tiền tố chung, và ưu tiên rawKeyPrefix khi cần khớp chính xác toàn bộ khóa.",
  "Matches rule application to a specific channel/provider id (for example discord, telegram, slack). Use this when one channel should permit or deny delivery independently of others.":
    "Khớp việc áp dụng quy tắc với một id kênh/provider cụ thể (ví dụ: discord, telegram, slack). Dùng mục này khi một kênh cần cho phép hoặc từ chối phân phối độc lập với các kênh khác.",
  "Matches rule application to chat type (direct, group, thread) so behavior varies by conversation form. Use this when DM and group destinations require different safety boundaries.":
    "Khớp việc áp dụng quy tắc với loại chat (direct, group, thread) để hành vi thay đổi theo dạng cuộc trò chuyện. Dùng mục này khi đích DM và đích nhóm cần các ranh giới an toàn khác nhau.",
  "Matches the raw, unnormalized session-key prefix for exact full-key policy targeting. Use this when normalized keyPrefix is too broad and you need agent-prefixed or transport-specific precision.":
    "Khớp với tiền tố session-key thô, chưa chuẩn hóa để nhắm mục tiêu chính sách chính xác theo toàn bộ khóa. Dùng mục này khi keyPrefix đã chuẩn hóa quá rộng và bạn cần độ chính xác theo tiền tố tác nhân hoặc theo transport.",
  "Max bytes per fetched/decoded `image_url` image (default: 10MB).":
    "Số byte tối đa cho mỗi ảnh `image_url` được tải/giải mã (mặc định: 10MB).",
  "Max characters of each workspace bootstrap file injected into the system prompt before truncation (default: 20000).":
    "Số ký tự tối đa của mỗi tệp bootstrap workspace được chèn vào system prompt trước khi bị cắt bớt (mặc định: 20000).",
  "Max characters per text field in chat.history responses before truncation (default: 12000).":
    "Số ký tự tối đa cho mỗi trường văn bản trong phản hồi chat.history trước khi bị cắt bớt (mặc định: 12000).",
  "Max characters returned by web_fetch (truncated).":
    "Số ký tự tối đa được trả về bởi web_fetch (bị cắt bớt).",
  "Max cumulative decoded bytes across all `image_url` parts in one request (default: 20MB).":
    "Tổng số byte đã giải mã tối đa trên tất cả các phần `image_url` trong một yêu cầu (mặc định: 20MB).",
  "Max download size before truncation.": "Kích thước tải xuống tối đa trước khi bị cắt bớt.",
  "Max HTTP redirects allowed when fetching `image_url` URLs (default: 3).":
    "Số lần chuyển hướng HTTP tối đa được phép khi tải các URL `image_url` (mặc định: 3).",
  "Max image side length in pixels when sanitizing transcript/tool-result image payloads (default: 1200).":
    "Độ dài cạnh ảnh tối đa tính bằng pixel khi làm sạch payload ảnh của transcript/tool-result (mặc định: 1200).",
  "Max number of `image_url` parts accepted from the latest user message (default: 8).":
    "Số lượng phần `image_url` tối đa được chấp nhận từ tin nhắn người dùng gần nhất (mặc định: 8).",
  "Max reply-back turns between requester and target agents during agent-to-agent exchanges (0-5). Use lower values to hard-limit chatter loops and preserve predictable run completion.":
    "Số lượt phản hồi qua lại tối đa giữa tác nhân yêu cầu và tác nhân đích trong các trao đổi tác nhân với tác nhân (0-5). Dùng giá trị thấp hơn để giới hạn chặt các vòng lặp trao đổi và duy trì việc hoàn tất chạy có thể dự đoán được.",
  "Max request body size in bytes for `/v1/chat/completions` (default: 20MB).":
    "Kích thước thân yêu cầu tối đa tính bằng byte cho `/v1/chat/completions` (mặc định: 20MB).",
  "Max retries for one-shot jobs on transient errors before permanent disable (default: 3).":
    "Số lần thử lại tối đa cho các job one-shot khi gặp lỗi tạm thời trước khi bị vô hiệu hóa vĩnh viễn (mặc định: 3).",
  "Max total characters across all injected workspace bootstrap files (default: 150000).":
    "Tổng số ký tự tối đa trên tất cả các tệp bootstrap workspace được chèn vào (mặc định: 150000).",
  "Maximum accepted audio payload size in bytes before processing is rejected or clipped by policy. Set this based on expected recording length and upstream provider limits.":
    "Kích thước payload âm thanh tối đa được chấp nhận tính bằng byte trước khi quá trình xử lý bị từ chối hoặc bị cắt theo chính sách. Đặt giá trị này dựa trên độ dài bản ghi dự kiến và giới hạn của nhà cung cấp phía thượng nguồn.",
  "Maximum accepted image payload size in bytes before the item is skipped or truncated by policy. Keep limits realistic for your provider caps and infrastructure bandwidth.":
    "Kích thước payload hình ảnh tối đa được chấp nhận tính bằng byte trước khi mục bị bỏ qua hoặc bị cắt ngắn theo chính sách. Giữ giới hạn ở mức thực tế theo giới hạn của nhà cung cấp và băng thông hạ tầng.",
  "Maximum accepted video payload size in bytes before policy rejection or trimming occurs. Tune this to provider and infrastructure limits to avoid repeated timeout/failure loops.":
    "Kích thước payload video tối đa được chấp nhận tính bằng byte trước khi bị từ chối hoặc cắt bớt theo chính sách. Điều chỉnh giá trị này theo giới hạn của nhà cung cấp và hạ tầng để tránh lặp lại vòng lặp timeout/thất bại.",
  "Maximum accepted webhook payload size in bytes before the request is rejected. Keep this bounded to reduce abuse risk and protect memory usage under bursty integrations.":
    "Kích thước payload webhook tối đa được chấp nhận tính bằng byte trước khi yêu cầu bị từ chối. Giữ giới hạn này trong mức hợp lý để giảm rủi ro lạm dụng và bảo vệ mức sử dụng bộ nhớ khi tích hợp tăng đột biến.",
  "Maximum assistant output characters projected per ACP turn before truncation notice is emitted.":
    "Số ký tự đầu ra trợ lý tối đa được dự tính cho mỗi lượt ACP trước khi phát ra thông báo cắt ngắn.",
  "Maximum bytes per cron run-log file before pruning rewrites to the last keepLines entries (for example `2mb`, default `2000000`).":
    "Số byte tối đa cho mỗi tệp nhật ký chạy cron trước khi việc dọn dẹp ghi lại chỉ còn các mục keepLines cuối cùng (ví dụ `2mb`, mặc định `2000000`).",
  "Maximum characters for projected ACP session/update lines (tool/status updates).":
    "Số ký tự tối đa cho các dòng session/update ACP được dự tính (cập nhật công cụ/trạng thái).",
  "Maximum characters retained from audio understanding output to prevent oversized transcript injection. Increase for long-form dictation, or lower to keep conversational turns compact.":
    "Số ký tự tối đa được giữ lại từ đầu ra hiểu âm thanh để ngăn việc chèn bản chép lời quá lớn. Tăng giá trị này cho đọc chính tả dài, hoặc giảm để giữ các lượt hội thoại gọn hơn.",
  "Maximum characters retained from video understanding output to control prompt growth. Raise for dense scene descriptions and lower when concise summaries are preferred.":
    "Số ký tự tối đa được giữ lại từ đầu ra hiểu video để kiểm soát mức tăng của prompt. Tăng lên cho mô tả cảnh dày đặc và giảm xuống khi ưu tiên các bản tóm tắt ngắn gọn.",
  "Maximum characters returned from image understanding output after model response normalization. Use tighter limits to reduce prompt bloat and larger limits for detail-heavy OCR tasks.":
    "Số ký tự tối đa được trả về từ đầu ra hiểu hình ảnh sau khi chuẩn hóa phản hồi của mô hình. Dùng giới hạn chặt hơn để giảm prompt phình to và giới hạn lớn hơn cho các tác vụ OCR nhiều chi tiết.",
  "Maximum chunk size for ACP streamed block projection before splitting into multiple block replies.":
    "Kích thước chunk tối đa cho ACP streamed block projection trước khi tách thành nhiều phản hồi block.",
  "Maximum concurrently active ACP sessions across this gateway process.":
    "Số lượng session ACP hoạt động đồng thời tối đa trên tiến trình Gateway này.",
  "Maximum delay in ms for custom humanDelay (default: 2500).":
    "Độ trễ tối đa tính bằng ms cho humanDelay tùy chỉnh (mặc định: 2500).",
  "Maximum fraction of total context budget allowed for retained history after compaction (range 0.1-0.9). Use lower shares for more generation headroom or higher shares for deeper historical continuity.":
    "Tỷ lệ tối đa của tổng ngân sách ngữ cảnh được phép dành cho lịch sử được giữ lại sau khi nén gọn (phạm vi 0.1-0.9). Dùng tỷ lệ thấp hơn để có thêm khoảng trống cho sinh nội dung hoặc tỷ lệ cao hơn để duy trì tính liên tục lịch sử sâu hơn.",
  "Maximum Gmail payload bytes processed per event when includeBody is enabled. Keep conservative limits to reduce oversized message processing cost and risk.":
    "Số byte payload Gmail tối đa được xử lý cho mỗi sự kiện khi includeBody được bật. Giữ giới hạn ở mức thận trọng để giảm chi phí và rủi ro xử lý các thư quá lớn.",
  "Maximum nesting depth for sub-agent spawning. 1 = no nesting (default), 2 = sub-agents can spawn sub-sub-agents.":
    "Độ sâu lồng tối đa cho việc sinh tác nhân con. 1 = không lồng (mặc định), 2 = tác nhân con có thể sinh tác nhân con cấp tiếp theo.",
  "Maximum number of active children a single agent session can spawn (default: 5).":
    "Số lượng tiến trình con đang hoạt động tối đa mà một session tác nhân có thể sinh ra (mặc định: 5).",
  "Maximum number of concurrent media understanding operations per turn across image, audio, and video tasks. Lower this in resource-constrained deployments to prevent CPU/network saturation.":
    "Số lượng thao tác hiểu media đồng thời tối đa trên mỗi lượt cho các tác vụ hình ảnh, âm thanh và video. Giảm giá trị này trong các môi trường triển khai bị hạn chế tài nguyên để tránh bão hòa CPU/mạng.",
  "Maximum number of health-monitor-initiated channel restarts allowed within a rolling one-hour window. Once hit, further restarts are skipped until the window expires. Default: 10.":
    "Số lần khởi động lại kênh tối đa do health monitor khởi tạo được phép trong một cửa sổ cuộn một giờ. Khi đạt ngưỡng này, các lần khởi động lại tiếp theo sẽ bị bỏ qua cho đến khi cửa sổ hết hạn. Mặc định: 10.",
  "Maximum number of links expanded per turn during link understanding. Use lower values to control latency/cost in chatty threads and higher values when multi-link context is critical.":
    "Số lượng liên kết tối đa được mở rộng trên mỗi lượt trong quá trình hiểu liên kết. Dùng giá trị thấp hơn để kiểm soát độ trễ/chi phí trong các luồng trò chuyện dày đặc và giá trị cao hơn khi ngữ cảnh nhiều liên kết là quan trọng.",
  "Maximum number of memory hits returned from search before downstream reranking and prompt injection. Raise for broader recall, or lower for tighter prompts and faster responses.":
    "Số lượng kết quả bộ nhớ tối đa được trả về từ tìm kiếm trước khi reranking phía sau và chèn vào prompt. Tăng lên để mở rộng khả năng truy hồi, hoặc giảm xuống để prompt gọn hơn và phản hồi nhanh hơn.",
  "Maximum number of PDF pages to process for the PDF tool (default: 20).":
    "Số trang PDF tối đa cần xử lý cho công cụ PDF (mặc định: 20).",
  "Maximum number of prior group messages loaded as context per turn for group sessions. Use higher values for richer continuity, or lower values for faster and cheaper responses.":
    "Số lượng tối đa các tin nhắn nhóm trước đó được tải làm ngữ cảnh cho mỗi lượt trong các phiên nhóm. Dùng giá trị cao hơn để duy trì ngữ cảnh phong phú hơn, hoặc thấp hơn để phản hồi nhanh hơn và tiết kiệm chi phí hơn.",
  "Maximum number of queued inbound items retained before drop policy applies. Keep caps bounded in noisy channels so memory usage remains predictable.":
    "Số lượng tối đa các mục đến đang xếp hàng được giữ lại trước khi áp dụng chính sách loại bỏ. Giữ giới hạn hợp lý trong các kênh nhiều nhiễu để mức sử dụng bộ nhớ luôn có thể dự đoán được.",
  "Maximum number of regeneration retries after a failed safeguard summary quality audit. Use small values to bound extra latency and token cost.":
    "Số lần thử tạo lại tối đa sau khi kiểm tra chất lượng bản tóm tắt bảo vệ thất bại. Dùng giá trị nhỏ để giới hạn độ trễ bổ sung và chi phí token.",
  "Maximum parent-session token count allowed for thread/session inheritance forking. If the parent exceeds this, OpenClaw starts a fresh thread session instead of forking; set 0 to disable this protection.":
    "Số lượng token tối đa của phiên cha được phép cho việc phân nhánh kế thừa luồng/phiên. Nếu phiên cha vượt quá mức này, OpenClaw sẽ bắt đầu một phiên luồng mới thay vì phân nhánh; đặt 0 để tắt cơ chế bảo vệ này.",
  "Maximum PDF file size in megabytes for the PDF tool (default: 10).":
    "Kích thước tệp PDF tối đa tính bằng megabyte cho công cụ PDF (mặc định: 10).",
  "Maximum reconnect attempts before giving up for the current failure sequence (0 means no retries). Use finite caps for controlled failure handling in automation-sensitive environments.":
    "Số lần thử kết nối lại tối đa trước khi dừng đối với chuỗi lỗi hiện tại (0 nghĩa là không thử lại). Dùng giới hạn hữu hạn để xử lý lỗi có kiểm soát trong các môi trường nhạy cảm với tự động hóa.",
  "Maximum reconnect backoff cap in milliseconds to bound retry delay growth over repeated failures. Use a reasonable cap so recovery remains timely after prolonged outages.":
    "Giới hạn backoff kết nối lại tối đa tính bằng mili giây để giới hạn mức tăng độ trễ thử lại qua các lần lỗi lặp lại. Dùng một giới hạn hợp lý để việc khôi phục vẫn kịp thời sau các sự cố kéo dài.",
  "Maximum redirects allowed for web_fetch (default: 3).":
    "Số lượng chuyển hướng tối đa được phép cho web_fetch (mặc định: 3).",
  "Maximum runtime allowed for mapping action execution before timeout handling applies. Use tighter limits for high-volume webhook sources to prevent queue pileups.":
    "Thời gian chạy tối đa được phép cho việc thực thi hành động ánh xạ trước khi áp dụng xử lý hết thời gian. Dùng giới hạn chặt hơn cho các nguồn webhook lưu lượng cao để tránh ùn tắc hàng đợi.",
  "Maximum same-provider auth-profile rotations allowed for overloaded errors before switching to model fallback (default: 1).":
    "Số lần xoay vòng auth-profile cùng nhà cung cấp tối đa được phép đối với lỗi quá tải trước khi chuyển sang model fallback (mặc định: 1).",
  "Maximum same-provider auth-profile rotations allowed for rate-limit errors before switching to model fallback (default: 1).":
    "Số lần xoay vòng auth-profile cùng nhà cung cấp tối đa được phép đối với lỗi giới hạn tốc độ trước khi chuyển sang model fallback (mặc định: 1).",
  "Maximum time (ms) to wait for in-flight operations to complete before forcing a SIGUSR1 restart. Default: 300000 (5 minutes). Lower values risk aborting active subagent LLM calls.":
    "Thời gian tối đa (ms) chờ các thao tác đang chạy hoàn tất trước khi buộc khởi động lại bằng SIGUSR1. Mặc định: 300000 (5 phút). Giá trị thấp hơn có nguy cơ làm gián đoạn các lệnh gọi LLM của subagent đang hoạt động.",
  "Maximum time allowed for the transcription command to finish before it is aborted. Increase this for longer recordings, and keep it tight in latency-sensitive deployments.":
    "Thời gian tối đa được phép để lệnh phiên âm hoàn tất trước khi bị hủy. Tăng giá trị này cho các bản ghi dài hơn, và giữ chặt trong các triển khai nhạy cảm với độ trễ.",
  "Maximum time in milliseconds allowed for shell environment resolution before fallback behavior applies. Use tighter timeouts for faster startup, or increase when shell initialization is heavy.":
    "Thời gian tối đa tính bằng mili giây được phép cho việc phân giải môi trường shell trước khi áp dụng hành vi dự phòng. Dùng thời gian chờ ngắn hơn để khởi động nhanh hơn, hoặc tăng lên khi quá trình khởi tạo shell nặng.",
  "Maximum time in seconds allowed for a heartbeat agent turn before it is aborted. Leave unset to use agents.defaults.timeoutSeconds.":
    "Thời gian tối đa tính bằng giây được phép cho một lượt của tác nhân heartbeat trước khi bị hủy. Để trống để dùng agents.defaults.timeoutSeconds.",
  "Maximum time in seconds allowed for a single compaction operation before it is aborted (default: 900). Increase this for very large sessions that need more time to summarize, or decrease it to fail faster on unresponsive models.":
    "Thời gian tối đa tính bằng giây được phép cho một thao tác compaction trước khi bị hủy (mặc định: 900). Tăng giá trị này cho các phiên rất lớn cần thêm thời gian để tóm tắt, hoặc giảm xuống để thất bại nhanh hơn với các model không phản hồi.",
  "MCP Servers": "Máy chủ MCP",
  'mDNS broadcast mode ("minimal" default, "full" includes cliPath/sshPort, "off" disables mDNS).':
    'Chế độ phát mDNS (mặc định "minimal", "full" bao gồm cliPath/sshPort, "off" tắt mDNS).',
  "mDNS Discovery": "Khám phá mDNS",
  "mDNS discovery configuration group for local network advertisement and discovery behavior tuning. Keep minimal mode for routine LAN discovery unless extra metadata is required.":
    "Nhóm cấu hình khám phá mDNS để tinh chỉnh hành vi quảng bá và khám phá trên mạng cục bộ. Giữ chế độ minimal cho việc khám phá LAN thông thường trừ khi cần thêm siêu dữ liệu.",
  "mDNS Discovery Mode": "Chế độ khám phá mDNS",
  Media: "Phương tiện",
  "Media Generation Auto Provider Fallback":
    "Tự động chuyển sang nhà cung cấp dự phòng cho tạo phương tiện",
  "Media Retention TTL (hours)": "TTL lưu giữ phương tiện (giờ)",
  "Media Understanding Concurrency": "Độ đồng thời hiểu phương tiện",
  "Media Understanding Shared Models": "Mô hình dùng chung cho hiểu phương tiện",
  Memory: "Bộ nhớ",
  "Memory Backend": "Backend bộ nhớ",
  "Memory backend configuration (global).": "Cấu hình backend bộ nhớ (toàn cục).",
  "Memory Chunk Overlap Tokens": "Token chồng lấp khối bộ nhớ",
  "Memory Chunk Tokens": "Token khối bộ nhớ",
  "Memory Citations Mode": "Chế độ trích dẫn bộ nhớ",
  "Memory Plugin": "Plugin bộ nhớ",
  "Memory Search": "Tìm kiếm bộ nhớ",
  "Memory Search Embedding Cache": "Bộ nhớ đệm embedding tìm kiếm bộ nhớ",
  "Memory Search Embedding Cache Max Entries":
    "Số mục tối đa của bộ nhớ đệm embedding tìm kiếm bộ nhớ",
  "Memory Search Fallback": "Dự phòng tìm kiếm bộ nhớ",
  "Memory Search Hybrid": "Tìm kiếm bộ nhớ lai",
  "Memory Search Hybrid Candidate Multiplier": "Hệ số nhân ứng viên tìm kiếm bộ nhớ lai",
  "Memory Search Index Path": "Đường dẫn chỉ mục tìm kiếm bộ nhớ",
  "Memory Search Max Results": "Số kết quả tối đa của tìm kiếm bộ nhớ",
  "Memory Search Min Score": "Điểm tối thiểu của tìm kiếm bộ nhớ",
  "Memory Search MMR Lambda": "Lambda MMR của tìm kiếm bộ nhớ",
  "Memory Search MMR Re-ranking": "Xếp hạng lại MMR của tìm kiếm bộ nhớ",
  "Memory Search Model": "Mô hình tìm kiếm bộ nhớ",
  "Memory Search Multimodal": "Tìm kiếm bộ nhớ đa phương thức",
  "Memory Search Multimodal Max File Bytes":
    "Số byte tệp tối đa cho tìm kiếm bộ nhớ đa phương thức",
  "Memory Search Multimodal Modalities": "Phương thức đa phương thức của Tìm kiếm bộ nhớ",
  "Memory Search Output Dimensionality": "Số chiều đầu ra của Tìm kiếm bộ nhớ",
  "Memory Search Provider": "Nhà cung cấp Tìm kiếm bộ nhớ",
  "Memory Search QMD Collections": "Bộ sưu tập QMD của Tìm kiếm bộ nhớ",
  "Memory Search Session Index (Experimental)": "Chỉ mục phiên Tìm kiếm bộ nhớ (Thử nghiệm)",
  "Memory Search Sources": "Nguồn của Tìm kiếm bộ nhớ",
  "Memory Search Temporal Decay": "Suy giảm theo thời gian của Tìm kiếm bộ nhớ",
  "Memory Search Temporal Decay Half-life (Days)":
    "Chu kỳ bán rã suy giảm theo thời gian của Tìm kiếm bộ nhớ (Ngày)",
  "Memory Search Text Weight": "Trọng số văn bản của Tìm kiếm bộ nhớ",
  "Memory Search Vector Extension Path": "Đường dẫn tiện ích mở rộng vector của Tìm kiếm bộ nhớ",
  "Memory Search Vector Index": "Chỉ mục vector của Tìm kiếm bộ nhớ",
  "Memory Search Vector Weight": "Trọng số vector của Tìm kiếm bộ nhớ",
  "Memory Watch Debounce (ms)": "Độ trễ chống dội của Memory Watch (ms)",
  "Message formatting, acknowledgment, queueing, debounce, and status reaction behavior for inbound/outbound chat flows. Use this section when channel responsiveness or message UX needs adjustment.":
    "Định dạng tin nhắn, xác nhận, xếp hàng, chống dội và hành vi phản ứng trạng thái cho các luồng chat vào/ra. Sử dụng phần này khi cần điều chỉnh độ phản hồi của kênh hoặc trải nghiệm người dùng của tin nhắn.",
  "Message Text-to-Speech": "Chuyển văn bản thành giọng nói cho tin nhắn",
  Messages: "Tin nhắn",
  Metadata: "Siêu dữ liệu",
  "Metadata fields automatically maintained by OpenClaw to record write/version history for this config file. Keep these values system-managed and avoid manual edits unless debugging migration history.":
    "Các trường siêu dữ liệu do OpenClaw tự động duy trì để ghi lại lịch sử ghi/phiên bản cho tệp cấu hình này. Hãy để hệ thống quản lý các giá trị này và tránh chỉnh sửa thủ công trừ khi đang gỡ lỗi lịch sử di chuyển.",
  "Milliseconds of user silence before Talk mode finalizes and sends the current transcript. Leave unset to keep the platform default pause window (700 ms on macOS and Android, 900 ms on iOS).":
    "Số mili giây người dùng im lặng trước khi chế độ Talk hoàn tất và gửi bản chép lời hiện tại. Để trống để giữ khoảng dừng mặc định của nền tảng (700 ms trên macOS và Android, 900 ms trên iOS).",
  "Minimum delay before stable-channel auto-apply starts (default: 6).":
    "Độ trễ tối thiểu trước khi tự động áp dụng kênh ổn định bắt đầu (mặc định: 6).",
  "Minimum delay in ms for custom humanDelay (default: 800).":
    "Độ trễ tối thiểu tính bằng ms cho humanDelay tùy chỉnh (mặc định: 800).",
  "Minimum floor enforced for reserveTokens in Pi compaction paths (0 disables the floor guard). Use a non-zero floor to avoid over-aggressive compression under fluctuating token estimates.":
    "Mức sàn tối thiểu được áp dụng cho reserveTokens trong các đường dẫn nén Pi (0 sẽ tắt bảo vệ mức sàn). Sử dụng mức sàn khác 0 để tránh nén quá mức khi ước lượng token biến động.",
  "Minimum relevance score threshold for including memory results in final recall output. Increase to reduce weak/noisy matches, or lower when you need more permissive retrieval.":
    "Ngưỡng điểm liên quan tối thiểu để đưa kết quả bộ nhớ vào đầu ra truy hồi cuối cùng. Tăng giá trị để giảm các kết quả khớp yếu/nhiễu, hoặc giảm khi cần truy xuất linh hoạt hơn.",
  "Minimum token budget preserved from the most recent conversation window during compaction. Use higher values to protect immediate context continuity and lower values to keep more long-tail history.":
    "Ngân sách token tối thiểu được giữ lại từ cửa sổ hội thoại gần nhất trong quá trình nén. Dùng giá trị cao hơn để bảo vệ tính liên tục của ngữ cảnh tức thời và giá trị thấp hơn để giữ lại nhiều lịch sử dài hạn hơn.",
  "Model Catalog Mode": "Chế độ Danh mục mô hình",
  "Model catalog root for provider definitions, merge/replace behavior, and optional Bedrock discovery integration. Keep provider definitions explicit and validated before relying on production failover paths.":
    "Thư mục gốc danh mục model cho định nghĩa nhà cung cấp, hành vi hợp nhất/thay thế và tích hợp khám phá Bedrock tùy chọn. Giữ định nghĩa nhà cung cấp rõ ràng và đã được xác thực trước khi dựa vào các đường dẫn chuyển đổi dự phòng trong môi trường production.",
  "Model Context Protocol server definitions": "Định nghĩa máy chủ Model Context Protocol",
  "Model Fallbacks": "Mô hình dự phòng",
  "Model Provider API Adapter": "Bộ điều hợp API nhà cung cấp model",
  "Model Provider API Key": "API Key nhà cung cấp model",
  "Model Provider Auth Mode": "Chế độ xác thực nhà cung cấp model",
  "Model Provider Authorization Header": "Header ủy quyền nhà cung cấp model",
  "Model Provider Base URL": "URL cơ sở nhà cung cấp model",
  "Model Provider Headers": "Header nhà cung cấp model",
  "Model Provider Inject num_ctx (OpenAI Compat)":
    "Nhà cung cấp model chèn num_ctx (OpenAI Compat)",
  "Model Provider Model List": "Danh sách model của nhà cung cấp model",
  "Model Provider Request Allow Private Network": "Yêu cầu nhà cung cấp model cho phép mạng riêng",
  "Model Provider Request Auth Header Name": "Tên header xác thực yêu cầu của nhà cung cấp model",
  "Model Provider Request Auth Header Prefix":
    "Tiền tố header xác thực yêu cầu của nhà cung cấp model",
  "Model Provider Request Auth Header Value":
    "Giá trị header xác thực yêu cầu của nhà cung cấp model",
  "Model Provider Request Auth Mode": "Chế độ xác thực yêu cầu của nhà cung cấp model",
  "Model Provider Request Auth Override": "Ghi đè xác thực yêu cầu của nhà cung cấp model",
  "Model Provider Request Bearer Token": "Bearer Token yêu cầu của nhà cung cấp model",
  "Model Provider Request Headers": "Header yêu cầu của nhà cung cấp model",
  "Model Provider Request Overrides": "Ghi đè yêu cầu của nhà cung cấp model",
  "Model Provider Request Proxy": "Proxy yêu cầu của nhà cung cấp model",
  "Model Provider Request Proxy Mode": "Chế độ proxy yêu cầu của nhà cung cấp model",
  "Model Provider Request Proxy TLS": "TLS proxy yêu cầu của nhà cung cấp model",
  "Model Provider Request Proxy TLS CA": "CA TLS proxy yêu cầu của nhà cung cấp model",
  "Model Provider Request Proxy TLS Cert": "Chứng chỉ TLS proxy yêu cầu của nhà cung cấp model",
  "Model Provider Request Proxy TLS Key": "Khóa TLS Proxy Yêu cầu Nhà cung cấp Mô hình",
  "Model Provider Request Proxy TLS Passphrase":
    "Cụm mật khẩu TLS Proxy Yêu cầu Nhà cung cấp Mô hình",
  "Model Provider Request Proxy TLS Server Name":
    "Tên Máy chủ TLS Proxy Yêu cầu Nhà cung cấp Mô hình",
  "Model Provider Request Proxy TLS Skip Verify":
    "Bỏ qua Xác minh TLS Proxy Yêu cầu Nhà cung cấp Mô hình",
  "Model Provider Request Proxy URL": "URL Proxy Yêu cầu Nhà cung cấp Mô hình",
  "Model Provider Request TLS": "TLS Yêu cầu Nhà cung cấp Mô hình",
  "Model Provider Request TLS CA": "CA TLS Yêu cầu Nhà cung cấp Mô hình",
  "Model Provider Request TLS Cert": "Chứng chỉ TLS Yêu cầu Nhà cung cấp Mô hình",
  "Model Provider Request TLS Key": "Khóa TLS Yêu cầu Nhà cung cấp Mô hình",
  "Model Provider Request TLS Passphrase": "Cụm mật khẩu TLS Yêu cầu Nhà cung cấp Mô hình",
  "Model Provider Request TLS Server Name": "Tên Máy chủ TLS Yêu cầu Nhà cung cấp Mô hình",
  "Model Provider Request TLS Skip Verify": "Bỏ qua Xác minh TLS Yêu cầu Nhà cung cấp Mô hình",
  "Model Providers": "Nhà cung cấp Mô hình",
  Models: "Mô hình",
  "Music Generation Model": "Mô hình Tạo nhạc",
  "Music Generation Model Fallbacks": "Phương án dự phòng Mô hình Tạo nhạc",
  "Named auth profiles (provider + mode + optional email).":
    "Các hồ sơ xác thực được đặt tên (nhà cung cấp + chế độ + email tùy chọn).",
  "Named browser profile connection map used for explicit routing to CDP ports or URLs with optional metadata. Keep profile names consistent and avoid overlapping endpoint definitions.":
    "Bản đồ kết nối hồ sơ trình duyệt được đặt tên dùng để định tuyến tường minh đến các cổng hoặc URL CDP kèm siêu dữ liệu tùy chọn. Giữ tên hồ sơ nhất quán và tránh các định nghĩa điểm cuối chồng chéo.",
  "Named export to invoke from the transform module; defaults to module default export when omitted. Set this when one file hosts multiple transform handlers.":
    "Export được đặt tên để gọi từ mô-đun transform; mặc định dùng export mặc định của mô-đun khi bị bỏ qua. Đặt giá trị này khi một tệp chứa nhiều trình xử lý transform.",
  "Named hook preset bundles applied at load time to seed standard mappings and behavior defaults. Keep preset usage explicit so operators can audit which automations are active.":
    "Các gói preset hook được đặt tên, áp dụng tại thời điểm tải để khởi tạo các ánh xạ chuẩn và hành vi mặc định. Giữ việc dùng preset ở dạng tường minh để người vận hành có thể kiểm tra những tự động hóa nào đang hoạt động.",
  "Named MCP server definitions. OpenClaw stores them in its own config and runtime adapters decide which transports are supported at execution time.":
    "Các định nghĩa máy chủ MCP được đặt tên. OpenClaw lưu chúng trong cấu hình riêng của nó và các bộ điều hợp thời gian chạy sẽ quyết định những transport nào được hỗ trợ tại thời điểm thực thi.",
  "Names the mcporter server target used for QMD calls (default: qmd). Change only when your mcporter setup uses a custom server name for qmd mcp keep-alive.":
    "Đặt tên đích máy chủ mcporter dùng cho các lệnh gọi QMD (mặc định: qmd). Chỉ thay đổi khi thiết lập mcporter của bạn dùng tên máy chủ tùy chỉnh cho qmd mcp keep-alive.",
  'Native Codex search context size hint: "low", "medium", or "high".':
    'Gợi ý kích thước ngữ cảnh tìm kiếm Native Codex: "low", "medium", hoặc "high".',
  'Native Codex web search mode: "cached" (default) or "live".':
    'Chế độ tìm kiếm web Native Codex: "cached" (mặc định) hoặc "live".',
  "Native Commands": "Lệnh gốc",
  "Native Skill Commands": "Lệnh Skill gốc",
  'Network bind profile: "auto", "lan", "loopback", "custom", or "tailnet" to control interface exposure. Keep "loopback" or "auto" for safest local operation unless external clients must connect.':
    'Hồ sơ liên kết mạng: "auto", "lan", "loopback", "custom" hoặc "tailnet" để kiểm soát mức độ hiển thị của giao diện. Giữ "loopback" hoặc "auto" để vận hành cục bộ an toàn nhất, trừ khi cần cho phép ứng dụng khách bên ngoài kết nối.',
  "Node binding configuration for exec tooling when command execution is delegated through connected nodes. Use explicit node binding only when multi-node routing is required.":
    "Cấu hình liên kết nút cho công cụ exec khi việc thực thi lệnh được ủy quyền thông qua các nút đã kết nối. Chỉ sử dụng liên kết nút tường minh khi cần định tuyến đa nút.",
  "Node Browser Proxy": "Proxy trình duyệt nút",
  "Node Browser Proxy Allowed Profiles": "Hồ sơ được phép cho Proxy trình duyệt nút",
  "Node Browser Proxy Enabled": "Bật Proxy trình duyệt nút",
  'Node browser routing ("auto" = pick single connected browser node, "manual" = require node param, "off" = disable).':
    'Định tuyến trình duyệt nút ("auto" = chọn nút trình duyệt đã kết nối duy nhất, "manual" = yêu cầu tham số node, "off" = tắt).',
  "Node command names to block even if present in node claims or default allowlist (exact command-name matching only, e.g. `system.run`; does not inspect shell text inside that command).":
    "Tên lệnh nút cần chặn ngay cả khi có trong khai báo của nút hoặc danh sách cho phép mặc định (chỉ khớp chính xác command-name, ví dụ: `system.run`; không kiểm tra nội dung shell bên trong lệnh đó).",
  "Node Host": "Máy chủ nút",
  "Node host controls for features exposed from this gateway node to other nodes or clients. Keep defaults unless you intentionally proxy local capabilities across your node network.":
    "Các tùy chọn kiểm soát máy chủ nút cho những tính năng được cung cấp từ nút gateway này tới các nút hoặc ứng dụng khách khác. Giữ mặc định trừ khi bạn chủ ý proxy các khả năng cục bộ trên mạng nút của mình.",
  "Number of most recent user/assistant turns kept verbatim outside safeguard summarization (default: 3). Raise this to preserve exact recent dialogue context, or lower it to maximize compaction savings.":
    "Số lượt trao đổi người dùng/trợ lý gần nhất được giữ nguyên văn ngoài phần tóm tắt bảo vệ (mặc định: 3). Tăng giá trị này để giữ nguyên ngữ cảnh hội thoại gần đây chính xác hơn, hoặc giảm để tối đa hóa mức tiết kiệm do nén.",
  "Number of results to return (1-10).": "Số lượng kết quả cần trả về (1-10).",
  "OpenAI Chat Completions Allow Image URLs": "Cho phép URL hình ảnh cho OpenAI Chat Completions",
  "OpenAI Chat Completions Endpoint": "Endpoint OpenAI Chat Completions",
  "OpenAI Chat Completions Image Limits": "Giới hạn hình ảnh của OpenAI Chat Completions",
  "OpenAI Chat Completions Image Max Bytes":
    "Số byte tối đa của hình ảnh trong OpenAI Chat Completions",
  "OpenAI Chat Completions Image Max Redirects":
    "Số lần chuyển hướng tối đa của hình ảnh trong OpenAI Chat Completions",
  "OpenAI Chat Completions Image MIME Allowlist":
    "Danh sách cho phép MIME hình ảnh của OpenAI Chat Completions",
  "OpenAI Chat Completions Image Timeout (ms)":
    "Thời gian chờ hình ảnh của OpenAI Chat Completions (ms)",
  "OpenAI Chat Completions Image URL Allowlist":
    "Danh sách cho phép URL hình ảnh của OpenAI Chat Completions",
  "OpenAI Chat Completions Max Body Bytes": "Số byte nội dung tối đa của OpenAI Chat Completions",
  "OpenAI Chat Completions Max Image Parts": "Số phần hình ảnh tối đa của OpenAI Chat Completions",
  "OpenAI Chat Completions Max Total Image Bytes":
    "Tổng số byte hình ảnh tối đa của OpenAI Chat Completions",
  "OpenClaw version recorded at the time of the most recent wizard run on this config. Use this when diagnosing behavior differences across version-to-version setup changes.":
    "Phiên bản OpenClaw được ghi nhận tại thời điểm chạy trình hướng dẫn gần nhất trên cấu hình này. Dùng thông tin này khi chẩn đoán khác biệt hành vi giữa các thay đổi thiết lập qua từng phiên bản.",
  "OpenTelemetry Enabled": "Bật OpenTelemetry",
  "OpenTelemetry Endpoint": "Điểm cuối OpenTelemetry",
  "OpenTelemetry export settings for traces, metrics, and logs emitted by gateway components. Use this when integrating with centralized observability backends and distributed tracing pipelines.":
    "Cài đặt xuất OpenTelemetry cho traces, metrics và logs do các thành phần gateway phát ra. Dùng mục này khi tích hợp với các backend quan sát tập trung và pipeline truy vết phân tán.",
  "OpenTelemetry Flush Interval (ms)": "Khoảng thời gian flush OpenTelemetry (ms)",
  "OpenTelemetry Headers": "Header OpenTelemetry",
  "OpenTelemetry Logs Enabled": "Bật log OpenTelemetry",
  "OpenTelemetry Metrics Enabled": "Bật metric OpenTelemetry",
  "OpenTelemetry Protocol": "Giao thức OpenTelemetry",
  "OpenTelemetry Service Name": "Tên dịch vụ OpenTelemetry",
  "OpenTelemetry Trace Sample Rate": "Tỷ lệ lấy mẫu trace OpenTelemetry",
  "OpenTelemetry Traces Enabled": "Bật trace OpenTelemetry",
  "Optional account selector for multi-account channel setups so the binding applies only to one identity. Use this when account scoping is required for the route and leave unset otherwise.":
    "Bộ chọn tài khoản tùy chọn cho thiết lập kênh nhiều tài khoản để liên kết chỉ áp dụng cho một danh tính. Dùng mục này khi tuyến yêu cầu phạm vi theo tài khoản và để trống nếu không cần.",
  "Optional account selector for multi-account channel setups when approvals must route through a specific account context. Use this only when the target channel has multiple configured identities.":
    "Bộ chọn tài khoản tùy chọn cho thiết lập kênh nhiều tài khoản khi các phê duyệt phải được định tuyến qua một ngữ cảnh tài khoản cụ thể. Chỉ dùng mục này khi kênh đích có nhiều danh tính được cấu hình.",
  "Optional account selector for multi-account channel setups when plugin approvals must route through a specific account context.":
    "Bộ chọn tài khoản tùy chọn cho thiết lập kênh nhiều tài khoản khi các phê duyệt plugin phải được định tuyến qua một ngữ cảnh tài khoản cụ thể.",
  "Optional ACP backend override for this agent's ACP sessions (falls back to global acp.backend).":
    "Ghi đè backend ACP tùy chọn cho các phiên ACP của tác nhân này (dự phòng về acp.backend toàn cục).",
  "Optional ACP harness agent id to use for this OpenClaw agent (for example codex, claude, cursor, gemini, openclaw).":
    "ID tác nhân harness ACP tùy chọn để dùng cho tác nhân OpenClaw này (ví dụ: codex, claude, cursor, gemini, openclaw).",
  "Optional ACP session mode default for this agent (persistent or oneshot).":
    "Chế độ phiên ACP mặc định tùy chọn cho tác nhân này (persistent hoặc oneshot).",
  'Optional allowlist of agent IDs eligible for forwarded approvals, for example `["primary", "ops-agent"]`. Use this to limit forwarding blast radius and avoid notifying channels for unrelated agents.':
    'Danh sách cho phép tùy chọn các ID tác nhân đủ điều kiện cho các phê duyệt được chuyển tiếp, ví dụ `["primary", "ops-agent"]`. Dùng mục này để giới hạn phạm vi ảnh hưởng của việc chuyển tiếp và tránh thông báo đến các kênh cho các tác nhân không liên quan.',
  'Optional allowlist of agent IDs eligible for forwarded plugin approvals, for example `["primary", "ops-agent"]`. Use this to limit forwarding blast radius.':
    'Danh sách cho phép tùy chọn các ID tác nhân đủ điều kiện cho các phê duyệt plugin được chuyển tiếp, ví dụ `["primary", "ops-agent"]`. Dùng mục này để giới hạn phạm vi ảnh hưởng của việc chuyển tiếp.',
  "Optional allowlist of browser profile names exposed through node proxy routing. Leave empty to preserve the default full profile surface, including profile create/delete routes. When set, OpenClaw enforces least-privilege profile access and blocks persistent profile create/delete through the proxy.":
    "Danh sách cho phép tùy chọn các tên hồ sơ trình duyệt được hiển thị qua định tuyến proxy node. Để trống để giữ nguyên toàn bộ bề mặt hồ sơ mặc định, bao gồm các tuyến tạo/xóa hồ sơ. Khi được đặt, OpenClaw sẽ thực thi quyền truy cập hồ sơ theo nguyên tắc đặc quyền tối thiểu và chặn việc tạo/xóa hồ sơ persistent qua proxy.",
  'Optional allowlist of model ids (e.g. "gpt-5.4" or "openai/gpt-5.4").':
    'Danh sách cho phép tùy chọn các model id (ví dụ: "gpt-5.4" hoặc "openai/gpt-5.4").',
  "Optional allowlist of plugin IDs; when set, only listed plugins are eligible to load. Configured bundled chat channels can still activate their bundled plugin when the channel is explicitly enabled in config. Use this to enforce approved extension inventories in controlled environments.":
    "Danh sách cho phép tùy chọn các plugin ID; khi được đặt, chỉ các plugin được liệt kê mới đủ điều kiện để tải. Các kênh chat đi kèm đã cấu hình vẫn có thể kích hoạt plugin đi kèm của chúng khi kênh được bật rõ ràng trong config. Dùng mục này để thực thi danh mục tiện ích mở rộng đã được phê duyệt trong các môi trường được kiểm soát.",
  "Optional allowlist of skills for this agent. If omitted, the agent inherits agents.defaults.skills when set; otherwise skills stay unrestricted. Set [] for no skills. An explicit list fully replaces inherited defaults instead of merging with them.":
    "Danh sách cho phép Skills tùy chọn cho tác nhân này. Nếu bỏ qua, tác nhân sẽ kế thừa agents.defaults.skills khi được đặt; nếu không, Skills sẽ không bị hạn chế. Đặt [] để không có Skills. Danh sách tường minh sẽ thay thế hoàn toàn giá trị mặc định được kế thừa thay vì hợp nhất với chúng.",
  "Optional API key field consumed by plugins that accept direct key configuration in entry settings. Use secret/env substitution and avoid committing real credentials into config files.":
    "Trường API key tùy chọn được các plugin sử dụng nếu chúng chấp nhận cấu hình khóa trực tiếp trong cài đặt mục nhập. Hãy dùng thay thế secret/env và tránh commit thông tin xác thực thật vào tệp config.",
  "Optional auth override for audio provider requests. Use this when the upstream expects a non-default bearer token or custom auth header shape.":
    "Ghi đè auth tùy chọn cho các yêu cầu tới nhà cung cấp âm thanh. Dùng mục này khi upstream yêu cầu bearer token không mặc định hoặc định dạng header auth tùy chỉnh.",
  "Optional CA bundle path for client verification or custom trust-chain requirements at the gateway edge. Use this when private PKI or custom certificate chains are part of deployment.":
    "Đường dẫn gói CA tùy chọn để xác minh máy khách hoặc đáp ứng yêu cầu trust-chain tùy chỉnh tại biên Gateway. Dùng mục này khi triển khai có PKI riêng tư hoặc chuỗi chứng chỉ tùy chỉnh.",
  "Optional CIDR allowlist for container-edge CDP ingress (for example 172.21.0.1/32).":
    "Danh sách cho phép CIDR tùy chọn cho CDP ingress ở biên container (ví dụ 172.21.0.1/32).",
  "Optional CLI backends for text-only fallback (claude-cli, etc.).":
    "Các backend CLI tùy chọn cho phương án dự phòng chỉ văn bản (claude-cli, v.v.).",
  "Optional default skill allowlist inherited by agents that omit agents.list[].skills. Omit for unrestricted skills, set [] to give inheriting agents no skills, and remember explicit agents.list[].skills replaces this default instead of merging with it.":
    "Danh sách cho phép Skills mặc định tùy chọn được các tác nhân kế thừa khi bỏ qua agents.list[].skills. Bỏ qua để Skills không bị hạn chế, đặt [] để các tác nhân kế thừa không có Skills, và lưu ý rằng agents.list[].skills tường minh sẽ thay thế giá trị mặc định này thay vì hợp nhất với nó.",
  "Optional default working directory for this agent's ACP sessions.":
    "Thư mục làm việc mặc định tùy chọn cho các phiên ACP của tác nhân này.",
  "Optional denylist of plugin IDs that are blocked even if allowlists or paths include them. Use deny rules for emergency rollback and hard blocks on risky plugins.":
    "Danh sách chặn tùy chọn của các ID plugin bị chặn ngay cả khi danh sách cho phép hoặc đường dẫn có bao gồm chúng. Dùng quy tắc chặn để rollback khẩn cấp và chặn cứng các plugin rủi ro.",
  "Optional Discord-style guild/server ID constraint for binding evaluation in multi-server deployments. Use this when the same peer identifiers can appear across different guilds.":
    "Ràng buộc ID guild/server kiểu Discord tùy chọn để đánh giá liên kết trong các triển khai nhiều máy chủ. Dùng mục này khi cùng một định danh peer có thể xuất hiện trên các guild khác nhau.",
  "Optional domain allowlist passed to the native Codex web_search tool.":
    "Danh sách cho phép domain tùy chọn được truyền cho công cụ web_search Codex gốc.",
  "Optional file path for persisted log output in addition to or instead of console logging. Use a managed writable path and align retention/rotation with your operational policy.":
    "Đường dẫn tệp tùy chọn cho đầu ra log được lưu trữ, bổ sung hoặc thay cho ghi log ra console. Hãy dùng đường dẫn ghi được được quản lý và căn chỉnh việc lưu giữ/xoay vòng theo chính sách vận hành của bạn.",
  "Optional filesystem root for Control UI assets (defaults to dist/control-ui).":
    "Gốc filesystem tùy chọn cho tài nguyên Control UI (mặc định là dist/control-ui).",
  "Optional Gmail label filter limiting which labeled messages trigger hook events. Keep filters narrow to avoid flooding automations with unrelated inbox traffic.":
    "Bộ lọc nhãn Gmail tùy chọn để giới hạn những thư có nhãn nào sẽ kích hoạt sự kiện hook. Giữ bộ lọc ở phạm vi hẹp để tránh làm ngập các quy trình tự động bằng lưu lượng hộp thư đến không liên quan.",
  "Optional hard max age in hours for thread-bound sessions across providers/channels (0 disables hard cap). Default: 0.":
    "Tuổi tối đa cứng tùy chọn tính theo giờ cho các phiên gắn với luồng trên các nhà cung cấp/kênh (0 sẽ tắt giới hạn cứng). Mặc định: 0.",
  "Optional hostname allowlist for `image_url` URL fetches; supports exact hosts and `*.example.com` wildcards. Empty or omitted lists mean no hostname allowlist restriction.":
    "Danh sách cho phép hostname tùy chọn cho các lần tải URL `image_url`; hỗ trợ hostname chính xác và wildcard `*.example.com`. Danh sách rỗng hoặc bị bỏ qua có nghĩa là không có hạn chế danh sách cho phép hostname.",
  "Optional HTTP response security headers applied by the gateway process itself. Prefer setting these at your reverse proxy when TLS terminates there.":
    "Các header bảo mật phản hồi HTTP tùy chọn do chính tiến trình Gateway áp dụng. Ưu tiên thiết lập các header này tại reverse proxy nếu TLS được kết thúc ở đó.",
  "Optional image model (provider/model) used when the primary model lacks image input.":
    "Model hình ảnh tùy chọn (provider/model) được dùng khi model chính không hỗ trợ đầu vào hình ảnh.",
  "Optional image-generation model (provider/model) used by the shared image generation capability.":
    "Model tạo ảnh tùy chọn (provider/model) được dùng bởi khả năng tạo ảnh dùng chung.",
  "Optional model override for Gmail-triggered runs when mailbox automations should use dedicated model behavior. Keep unset to inherit agent defaults unless mailbox tasks need specialization.":
    "Ghi đè model tùy chọn cho các lần chạy được kích hoạt bởi Gmail khi các quy trình tự động hộp thư cần hành vi model chuyên biệt. Hãy để trống để kế thừa mặc định của tác nhân trừ khi tác vụ hộp thư cần chuyên biệt hóa.",
  "Optional model override for mapping-triggered runs when automation should use a different model than agent defaults. Use this sparingly so behavior remains predictable across mapping executions.":
    "Ghi đè model tùy chọn cho các lần chạy được kích hoạt bởi mapping khi tự động hóa cần dùng model khác với mặc định của tác nhân. Chỉ nên dùng hạn chế để hành vi vẫn có thể dự đoán trên các lần thực thi mapping.",
  'Optional multimodal memory settings for indexing image and audio files from configured extra paths. Keep this off unless your embedding model explicitly supports cross-modal embeddings, and set `memorySearch.fallback` to "none" while it is enabled. Matching files are uploaded to the configured remote embedding provider during indexing.':
    'Cài đặt bộ nhớ đa phương thức tùy chọn để lập chỉ mục các tệp hình ảnh và âm thanh từ các đường dẫn bổ sung đã cấu hình. Hãy giữ tắt tính năng này trừ khi model embedding của bạn hỗ trợ rõ ràng embedding đa phương thức, và đặt `memorySearch.fallback` thành "none" trong khi tính năng này được bật. Các tệp khớp sẽ được tải lên nhà cung cấp embedding từ xa đã cấu hình trong quá trình lập chỉ mục.',
  "Optional music-generation model (provider/model) used by the shared music generation capability.":
    "Model tạo nhạc tùy chọn (provider/model) được dùng bởi khả năng tạo nhạc dùng chung.",
  "Optional operator install/setup command shown by `/acp install` and `/acp doctor` when ACP backend wiring is missing.":
    "Lệnh cài đặt/thiết lập cho operator tùy chọn được hiển thị bởi `/acp install` và `/acp doctor` khi thiếu kết nối backend ACP.",
  "Optional passphrase used to decrypt request.proxy.tls.key.":
    "Cụm mật khẩu tùy chọn dùng để giải mã request.proxy.tls.key.",
  "Optional passphrase used to decrypt request.tls.key.":
    "Cụm mật khẩu tùy chọn dùng để giải mã request.tls.key.",
  "Optional PDF model (provider/model) for the PDF analysis tool. Defaults to imageModel, then session model.":
    "Mô hình PDF tùy chọn (provider/model) cho công cụ phân tích PDF. Mặc định là imageModel, sau đó đến mô hình phiên.",
  "Optional peer matcher for specific conversations including peer kind and peer id. Use this when only one direct/group/channel target should be pinned to an agent.":
    "Bộ khớp peer tùy chọn cho các cuộc hội thoại cụ thể, bao gồm loại peer và id peer. Dùng mục này khi chỉ một đích trực tiếp/nhóm/kênh cần được ghim vào một tác nhân.",
  "Optional per-agent default for fast mode. Applies when no per-message or session fast-mode override is set.":
    "Giá trị mặc định theo tác nhân tùy chọn cho chế độ nhanh. Áp dụng khi không có ghi đè chế độ nhanh theo từng tin nhắn hoặc phiên.",
  "Optional per-agent default reasoning visibility (on|off|stream). Applies when no per-message or session reasoning override is set.":
    "Hiển thị suy luận mặc định theo tác nhân tùy chọn (on|off|stream). Áp dụng khi không có ghi đè suy luận theo từng tin nhắn hoặc phiên.",
  "Optional per-agent default thinking level. Overrides agents.defaults.thinkingDefault for this agent when no per-message or session override is set.":
    "Mức độ suy nghĩ mặc định theo tác nhân tùy chọn. Ghi đè agents.defaults.thinkingDefault cho tác nhân này khi không có ghi đè theo từng tin nhắn hoặc phiên.",
  'Optional per-agent embedded Pi execution contract override. Set "strict-agentic" to keep that agent acting through plan-only turns on OpenAI/OpenAI Codex GPT-5-family runs, or "default" to inherit the standard runner behavior.':
    'Ghi đè hợp đồng thực thi Pi nhúng theo tác nhân tùy chọn. Đặt "strict-agentic" để giữ tác nhân đó hoạt động thông qua các lượt chỉ-lập-kế-hoạch trên các lần chạy OpenAI/OpenAI Codex GPT-5-family, hoặc "default" để kế thừa hành vi runner tiêu chuẩn.',
  "Optional per-agent embedded Pi overrides. Use this to opt specific agents into stricter GPT-5 execution behavior without changing the global default.":
    "Ghi đè Pi nhúng theo tác nhân tùy chọn. Dùng mục này để cho phép các tác nhân cụ thể áp dụng hành vi thực thi GPT-5 nghiêm ngặt hơn mà không thay đổi mặc định toàn cục.",
  "Optional per-agent sessions-directory disk budget (for example `500mb`). Use this to cap session storage per agent; when exceeded, warn mode reports pressure and enforce mode performs oldest-first cleanup.":
    "Ngân sách dung lượng đĩa thư mục phiên theo tác nhân tùy chọn (ví dụ `500mb`). Dùng mục này để giới hạn dung lượng lưu trữ phiên cho mỗi tác nhân; khi vượt quá, chế độ cảnh báo sẽ báo áp lực và chế độ thực thi sẽ dọn dẹp từ cũ nhất trước.",
  "Optional per-binary safe-bin profiles (positional limits + allowed/denied flags).":
    "Hồ sơ safe-bin theo từng binary tùy chọn (giới hạn vị trí + cờ cho phép/từ chối).",
  "Optional per-binding ACP overrides for bindings[].type=acp. This layer overrides agents.list[].runtime.acp defaults for the matched conversation.":
    "Ghi đè ACP theo từng binding tùy chọn cho bindings[].type=acp. Lớp này ghi đè các giá trị mặc định agents.list[].runtime.acp cho cuộc hội thoại khớp.",
  "Optional per-provider overrides for billing backoff (hours).":
    "Ghi đè theo từng provider tùy chọn cho backoff thanh toán (giờ).",
  "Optional prefix prepended to request.auth.value when auth mode is header.":
    "Tiền tố tùy chọn được thêm trước request.auth.value khi chế độ auth là header.",
  "Optional prefix prepended to the custom auth header value, such as Bearer. Leave unset when the upstream expects the raw credential only.":
    "Tiền tố tùy chọn được thêm trước giá trị header auth tùy chỉnh, chẳng hạn như Bearer. Để trống khi upstream chỉ mong đợi thông tin xác thực thô.",
  "Optional provider/model override used only for compaction summarization. Set this when you want compaction to run on a different model than the session default, and leave it unset to keep using the primary agent model.":
    "Ghi đè provider/model tùy chọn chỉ dùng cho tóm tắt compaction. Đặt mục này khi bạn muốn compaction chạy trên một mô hình khác với mặc định của phiên, và để trống nếu muốn tiếp tục dùng mô hình tác nhân chính.",
  'Optional proxy override for model-provider requests. Use "env-proxy" to honor environment proxy settings or "explicit-proxy" to route through a specific proxy URL.':
    'Ghi đè proxy tùy chọn cho các yêu cầu model-provider. Dùng "env-proxy" để tuân theo cài đặt proxy của môi trường hoặc "explicit-proxy" để định tuyến qua một URL proxy cụ thể.',
  "Optional quality-audit retry settings for safeguard compaction summaries. Leave this disabled unless you explicitly want summary audits and one-shot regeneration on failed checks.":
    "Cài đặt thử lại kiểm tra chất lượng tùy chọn cho các bản tóm tắt compaction safeguard. Hãy để mục này tắt trừ khi bạn thực sự muốn kiểm tra bản tóm tắt và tái tạo một lần khi kiểm tra thất bại.",
  "Optional repository root shown in the system prompt runtime line (overrides auto-detect).":
    "Thư mục gốc repository tùy chọn được hiển thị trong dòng runtime của system prompt (ghi đè tự động phát hiện).",
  "Optional request overrides for model-provider requests, including extra headers, auth overrides, proxy routing, TLS client settings, and optional allowPrivateNetwork for trusted self-hosted endpoints. Use these only when your upstream or enterprise network path requires transport customization.":
    "Ghi đè request tùy chọn cho các yêu cầu model-provider, bao gồm header bổ sung, ghi đè auth, định tuyến proxy, cài đặt client TLS và allowPrivateNetwork tùy chọn cho các endpoint tự lưu trữ đáng tin cậy. Chỉ dùng các mục này khi upstream hoặc đường mạng doanh nghiệp của bạn yêu cầu tùy chỉnh truyền tải.",
  "Optional retention window in hours for persisted inbound media cleanup across the full media tree. Leave unset to preserve legacy behavior, or set values like 24 (1 day) or 168 (7 days) when you want automatic cleanup.":
    "Khoảng thời gian lưu giữ tùy chọn tính bằng giờ để dọn dẹp media đầu vào đã lưu trên toàn bộ cây media. Để trống để giữ hành vi cũ, hoặc đặt các giá trị như 24 (1 ngày) hoặc 168 (7 ngày) khi bạn muốn dọn dẹp tự động.",
  "Optional role-based filter list used by providers that attach roles to chat context. Use this to route privileged or operational role traffic to specialized agents.":
    "Danh sách bộ lọc dựa trên vai trò tùy chọn được dùng bởi các provider gắn vai trò vào ngữ cảnh chat. Dùng mục này để định tuyến lưu lượng vai trò đặc quyền hoặc vận hành đến các tác nhân chuyên biệt.",
  "Optional runtime descriptor for this agent. Use embedded for default OpenClaw execution or acp for external ACP harness defaults.":
    "Bộ mô tả runtime tùy chọn cho tác nhân này. Dùng embedded cho thực thi OpenClaw mặc định hoặc acp cho các giá trị mặc định harness ACP bên ngoài.",
  "Optional secret used to HMAC hash owner IDs when ownerDisplay=hash. Prefer env substitution.":
    "Secret tùy chọn dùng để băm HMAC ID chủ sở hữu khi ownerDisplay=hash. Ưu tiên thay thế env.",
  'Optional session-key filters matched as substring or regex-style patterns, for example `["discord:", "^agent:ops:"]`. Use narrow patterns so only intended approval contexts are forwarded to shared destinations.':
    'Bộ lọc session-key tùy chọn được khớp theo chuỗi con hoặc mẫu kiểu regex, ví dụ `["discord:", "^agent:ops:"]`. Hãy dùng các mẫu hẹp để chỉ những ngữ cảnh phê duyệt dự kiến mới được chuyển tiếp đến các đích dùng chung.',
  'Optional session-key filters matched as substring or regex-style patterns, for example `["discord:", "^agent:ops:"]`. Use narrow patterns so only intended approval contexts are forwarded.':
    'Bộ lọc session-key tùy chọn được khớp theo chuỗi con hoặc mẫu kiểu regex, ví dụ `["discord:", "^agent:ops:"]`. Hãy dùng các mẫu hẹp để chỉ những ngữ cảnh phê duyệt dự kiến mới được chuyển tiếp.',
  "Optional SNI/server-name override used when establishing TLS to the proxy.":
    "Ghi đè SNI/server-name tùy chọn được dùng khi thiết lập TLS tới proxy.",
  "Optional SNI/server-name override used when establishing upstream TLS.":
    "Ghi đè SNI/server-name tùy chọn được dùng khi thiết lập TLS upstream.",
  "Optional SSH identity file path (passed to ssh -i).":
    "Đường dẫn tệp định danh SSH tùy chọn (được truyền vào ssh -i).",
  "Optional stable identifier for a hook mapping entry used for auditing, troubleshooting, and targeted updates. Use unique IDs so logs and config diffs can reference mappings unambiguously.":
    "Mã định danh ổn định tùy chọn cho một mục ánh xạ hook, dùng cho kiểm tra, khắc phục sự cố và cập nhật có mục tiêu. Hãy dùng ID duy nhất để nhật ký và phần khác biệt cấu hình có thể tham chiếu ánh xạ một cách rõ ràng.",
  "Optional team/workspace ID constraint used by providers that scope chats under teams. Add this when you need bindings isolated to one workspace context.":
    "Ràng buộc ID team/workspace tùy chọn được dùng bởi các nhà cung cấp có phạm vi chat theo team. Thêm mục này khi bạn cần các liên kết được tách biệt trong một ngữ cảnh workspace.",
  "Optional thinking-effort override for mapping-triggered runs to tune latency versus reasoning depth. Keep low or minimal for high-volume hooks unless deeper reasoning is clearly required.":
    "Ghi đè thinking-effort tùy chọn cho các lần chạy được kích hoạt bởi ánh xạ để điều chỉnh độ trễ so với độ sâu suy luận. Hãy giữ ở mức low hoặc minimal cho các hook khối lượng lớn trừ khi rõ ràng cần suy luận sâu hơn.",
  "Optional thread/topic target for channels that support threaded delivery of forwarded approvals. Use this to keep approval traffic contained in operational threads instead of main channels.":
    "Đích thread/topic tùy chọn cho các kênh hỗ trợ chuyển tiếp phê duyệt theo luồng. Dùng mục này để giữ lưu lượng phê duyệt trong các thread vận hành thay vì các kênh chính.",
  "Optional thread/topic target for channels that support threaded delivery of forwarded plugin approvals.":
    "Đích thread/topic tùy chọn cho các kênh hỗ trợ chuyển tiếp phê duyệt plugin theo luồng.",
  "Optional TLS settings used when connecting directly to the upstream model endpoint.":
    "Thiết lập TLS tùy chọn được dùng khi kết nối trực tiếp tới endpoint mô hình upstream.",
  "Optional TLS settings used when connecting to the configured proxy.":
    "Thiết lập TLS tùy chọn được dùng khi kết nối tới proxy đã cấu hình.",
  "Optional unicast DNS-SD domain for wide-area discovery, such as openclaw.internal. Use this when you intentionally publish gateway discovery beyond local mDNS scopes.":
    "Miền DNS-SD unicast tùy chọn cho khám phá diện rộng, chẳng hạn openclaw.internal. Dùng mục này khi bạn chủ ý công bố khám phá Gateway vượt ra ngoài phạm vi mDNS cục bộ.",
  "Optional URL prefix where the Control UI is served (e.g. /openclaw).":
    "Tiền tố URL tùy chọn nơi Control UI được phục vụ (ví dụ: /openclaw).",
  "Optional video-generation model (provider/model) used by the shared video generation capability.":
    "Mô hình tạo video tùy chọn (provider/model) được dùng bởi khả năng tạo video dùng chung.",
  'Ordered allow/deny rules evaluated before the default action, for example `{ action: "deny", match: { channel: "discord" } }`. Put most specific rules first so broad rules do not shadow exceptions.':
    'Các quy tắc allow/deny có thứ tự được đánh giá trước hành động mặc định, ví dụ `{ action: "deny", match: { channel: "discord" } }`. Hãy đặt các quy tắc cụ thể nhất lên trước để các quy tắc rộng không che khuất các ngoại lệ.',
  "Ordered auth profile IDs per provider (used for automatic failover).":
    "Danh sách ID hồ sơ xác thực theo thứ tự cho mỗi nhà cung cấp (dùng cho tự động chuyển đổi dự phòng).",
  "Ordered fallback image models (provider/model).":
    "Các mô hình hình ảnh dự phòng theo thứ tự (provider/model).",
  "Ordered fallback image-generation models (provider/model).":
    "Các mô hình tạo hình ảnh dự phòng theo thứ tự (provider/model).",
  "Ordered fallback models (provider/model). Used when the primary model fails.":
    "Các mô hình dự phòng theo thứ tự (provider/model). Được dùng khi mô hình chính gặp lỗi.",
  "Ordered fallback music-generation models (provider/model).":
    "Các mô hình tạo nhạc dự phòng theo thứ tự (provider/model).",
  "Ordered fallback PDF models (provider/model).":
    "Các mô hình PDF dự phòng theo thứ tự (provider/model).",
  "Ordered fallback video-generation models (provider/model).":
    "Các mô hình tạo video dự phòng theo thứ tự (provider/model).",
  "Ordered mapping rules that match inbound hook requests and choose wake or agent actions with optional delivery routing. Use specific mappings first to avoid broad pattern rules capturing everything.":
    "Các quy tắc ánh xạ có thứ tự khớp với các yêu cầu hook đến và chọn hành động đánh thức hoặc tác nhân với định tuyến phân phối tùy chọn. Hãy dùng các ánh xạ cụ thể trước để tránh các quy tắc mẫu rộng bắt mọi thứ.",
  "Ordered model preferences specifically for audio understanding, used before shared media model fallback. Choose models optimized for transcription quality in your primary language/domain.":
    "Thứ tự ưu tiên mô hình dành riêng cho việc hiểu âm thanh, được dùng trước khi chuyển sang mô hình media dùng chung. Hãy chọn các mô hình được tối ưu cho chất lượng phiên âm trong ngôn ngữ/lĩnh vực chính của bạn.",
  "Ordered model preferences specifically for image understanding when you want to override shared media models. Put the most reliable multimodal model first to reduce fallback attempts.":
    "Thứ tự ưu tiên mô hình dành riêng cho việc hiểu hình ảnh khi bạn muốn ghi đè các mô hình media dùng chung. Đặt mô hình đa phương thức đáng tin cậy nhất lên trước để giảm số lần thử chuyển dự phòng.",
  "Ordered model preferences specifically for video understanding before shared media fallback applies. Prioritize models with strong multimodal video support to minimize degraded summaries.":
    "Thứ tự ưu tiên mô hình dành riêng cho việc hiểu video trước khi áp dụng chuyển dự phòng media dùng chung. Ưu tiên các mô hình có hỗ trợ video đa phương thức mạnh để giảm thiểu các bản tóm tắt bị suy giảm chất lượng.",
  "Original archive/path used for install (if any).":
    "Archive/path gốc được dùng để cài đặt (nếu có).",
  "Original marketplace source used to resolve the install (for example a repo path or Git URL).":
    "Nguồn marketplace gốc được dùng để phân giải bản cài đặt (ví dụ: đường dẫn repo hoặc Git URL).",
  "Original npm spec used for install (if source is npm).":
    "npm spec gốc được dùng để cài đặt (nếu nguồn là npm).",
  'OTel transport protocol for telemetry export: "http/protobuf" or "grpc" depending on collector support. Use the protocol your observability backend expects to avoid dropped telemetry payloads.':
    'Giao thức truyền OTel để xuất telemetry: "http/protobuf" hoặc "grpc" tùy theo hỗ trợ của collector. Hãy dùng giao thức mà backend observability của bạn yêu cầu để tránh làm rơi payload telemetry.',
  "Outbound Response Prefix": "Tiền tố phản hồi gửi đi",
  "Overloaded Backoff (ms)": "Backoff khi quá tải (ms)",
  "Overloaded Profile Rotations": "Số lần xoay vòng hồ sơ khi quá tải",
  "Override default status reaction emojis. Keys: thinking, compacting, tool, coding, web, done, error, stallSoft, stallHard. Must be valid Telegram reaction emojis.":
    "Ghi đè emoji phản ứng trạng thái mặc định. Keys: thinking, compacting, tool, coding, web, done, error, stallSoft, stallHard. Phải là emoji phản ứng Telegram hợp lệ.",
  "Override default timing. Keys: debounceMs (700), stallSoftMs (25000), stallHardMs (60000), doneHoldMs (1500), errorHoldMs (2500).":
    "Ghi đè thời gian mặc định. Keys: debounceMs (700), stallSoftMs (25000), stallHardMs (60000), doneHoldMs (1500), errorHoldMs (2500).",
  "Override provider request authentication behavior for this provider.":
    "Ghi đè hành vi xác thực yêu cầu của nhà cung cấp cho nhà cung cấp này.",
  "Override User-Agent header for web_fetch requests.":
    "Ghi đè header User-Agent cho các yêu cầu web_fetch.",
  "Overrides reset behavior by chat type (direct, group, thread) when defaults are not sufficient. Use this when group/thread traffic needs different reset cadence than direct messages.":
    "Ghi đè hành vi đặt lại theo loại chat (direct, group, thread) khi giá trị mặc định không đủ. Dùng mục này khi lưu lượng group/thread cần nhịp đặt lại khác với tin nhắn direct.",
  "Overrides the auto-discovered sqlite-vec extension library path (`.dylib`, `.so`, or `.dll`). Use this when your runtime cannot find sqlite-vec automatically or you pin a known-good build.":
    "Ghi đè đường dẫn thư viện tiện ích mở rộng sqlite-vec được tự động phát hiện (`.dylib`, `.so`, hoặc `.dll`). Dùng mục này khi runtime của bạn không thể tự động tìm thấy sqlite-vec hoặc khi bạn cố định một bản build đã biết là ổn định.",
  'Overrides the canonical main session key used for continuity when dmScope or routing logic points to "main". Use a stable value only if you intentionally need custom session anchoring.':
    'Ghi đè khóa phiên chính chuẩn được dùng để duy trì tính liên tục khi dmScope hoặc logic định tuyến trỏ tới "main". Chỉ dùng một giá trị ổn định nếu bạn thực sự cần neo phiên tùy chỉnh.',
  "Overrides the default retry policy for one-shot jobs when they fail with transient errors (rate limit, overloaded, network, server_error). Omit to use defaults: maxAttempts 3, backoffMs [30000, 60000, 300000], retry all transient types.":
    "Ghi đè chính sách thử lại mặc định cho các job one-shot khi chúng thất bại do lỗi tạm thời (rate limit, overloaded, network, server_error). Bỏ qua để dùng mặc định: maxAttempts 3, backoffMs [30000, 60000, 300000], thử lại tất cả các loại lỗi tạm thời.",
  "Overrides the embedding API endpoint, such as an OpenAI-compatible proxy or custom Gemini base URL. Use this only when routing through your own gateway or vendor endpoint; keep provider defaults otherwise.":
    "Ghi đè endpoint API embedding, chẳng hạn như proxy tương thích OpenAI hoặc Gemini base URL tùy chỉnh. Chỉ dùng mục này khi định tuyến qua gateway riêng của bạn hoặc endpoint của nhà cung cấp; nếu không hãy giữ mặc định của nhà cung cấp.",
  "Overrides the exact mcporter tool name used for QMD searches while preserving `searchMode` as the semantic retrieval mode. Use this only when your QMD MCP server exposes a custom tool such as `hybrid_search` and keep it unset for the normal built-in tool mapping.":
    "Ghi đè chính xác tên công cụ mcporter được dùng cho tìm kiếm QMD trong khi vẫn giữ `searchMode` là chế độ truy xuất ngữ nghĩa. Chỉ dùng mục này khi máy chủ QMD MCP của bạn cung cấp một công cụ tùy chỉnh như `hybrid_search` và để trống nếu dùng ánh xạ công cụ tích hợp thông thường.",
  "Overrides where sanitized session exports are written before QMD indexing. Use this when default state storage is constrained or when exports must land on a managed volume.":
    "Ghi đè vị trí ghi các bản xuất phiên đã được làm sạch trước khi lập chỉ mục QMD. Dùng mục này khi nơi lưu trữ trạng thái mặc định bị hạn chế hoặc khi các bản xuất phải được ghi vào một volume được quản lý.",
  "Owner ID Display": "Hiển thị ID chủ sở hữu",
  "Owner ID Hash Secret": "Mã bí mật băm ID chủ sở hữu",
  "Password credential used for remote gateway authentication when password mode is enabled. Keep this secret managed externally and avoid plaintext values in committed config.":
    "Thông tin xác thực mật khẩu được dùng cho xác thực Gateway từ xa khi chế độ mật khẩu được bật. Hãy quản lý bí mật này ở bên ngoài và tránh dùng giá trị văn bản thuần trong config đã commit.",
  "Path match condition for a hook mapping, usually compared against the inbound request path. Use this to split automation behavior by webhook endpoint path families.":
    "Điều kiện khớp đường dẫn cho một ánh xạ hook, thường được so sánh với đường dẫn yêu cầu đến. Dùng mục này để tách hành vi tự động hóa theo các nhóm đường dẫn endpoint webhook.",
  "Path published by Tailscale Serve/Funnel for Gmail callback forwarding when enabled. Keep it aligned with Gmail webhook config so requests reach the expected handler.":
    "Đường dẫn do Tailscale Serve/Funnel công bố để chuyển tiếp callback Gmail khi được bật. Giữ đồng bộ với cấu hình webhook Gmail để yêu cầu đến đúng trình xử lý dự kiến.",
  "Path to the cron job store file used to persist scheduled jobs across restarts. Set an explicit path only when you need custom storage layout, backups, or mounted volumes.":
    "Đường dẫn đến tệp lưu trữ cron job dùng để duy trì các job đã lên lịch qua các lần khởi động lại. Chỉ đặt đường dẫn rõ ràng khi bạn cần bố cục lưu trữ tùy chỉnh, bản sao lưu hoặc mounted volumes.",
  "PDF Max Pages": "Số trang PDF tối đa",
  "PDF Max Size (MB)": "Kích thước PDF tối đa (MB)",
  "PDF Model": "Mô hình PDF",
  "PDF Model Fallbacks": "Phương án dự phòng mô hình PDF",
  'Peer conversation type: "direct", "group", "channel", or legacy "dm" (deprecated alias for direct). Prefer "direct" for new configs and keep kind aligned with channel semantics.':
    'Loại cuộc trò chuyện ngang hàng: "direct", "group", "channel", hoặc "dm" cũ (bí danh không còn được khuyến nghị cho direct). Ưu tiên "direct" cho cấu hình mới và giữ kind phù hợp với ngữ nghĩa của kênh.',
  "Per-agent additive allowlist for tools on top of global and profile policy. Keep narrow to avoid accidental privilege expansion on specialized agents.":
    "Danh sách cho phép bổ sung theo từng tác nhân cho các công cụ, ngoài chính sách toàn cục và hồ sơ. Giữ phạm vi hẹp để tránh vô tình mở rộng đặc quyền trên các tác nhân chuyên biệt.",
  "Per-agent DANGEROUS override for container namespace joins in sandbox Docker network mode.":
    "Ghi đè NGUY HIỂM theo từng tác nhân cho việc tham gia namespace container trong chế độ mạng sandbox Docker.",
  "Per-agent embedded harness fallback. Set none to disable automatic PI fallback for this agent.":
    "Phương án dự phòng harness nhúng theo từng tác nhân. Đặt none để tắt tự động dự phòng PI cho tác nhân này.",
  "Per-agent embedded harness policy override. Use fallback=none to make this agent fail instead of falling back to PI.":
    "Ghi đè chính sách harness nhúng theo từng tác nhân. Dùng fallback=none để tác nhân này thất bại thay vì chuyển sang PI.",
  "Per-agent embedded harness runtime: auto, pi, or a registered plugin harness id such as codex.":
    "Runtime harness nhúng theo từng tác nhân: auto, pi hoặc id plugin harness đã đăng ký như codex.",
  "Per-agent maximum time in seconds allowed for a heartbeat agent turn before it is aborted. Leave unset to inherit the merged heartbeat/default agent timeout.":
    "Thời gian tối đa theo từng tác nhân tính bằng giây được phép cho một lượt tác nhân heartbeat trước khi bị hủy. Để trống để kế thừa thời gian chờ heartbeat/tác nhân mặc định đã hợp nhất.",
  "Per-agent override for CDP source CIDR allowlist.":
    "Ghi đè theo từng tác nhân cho danh sách cho phép CIDR nguồn CDP.",
  'Per-agent override for heartbeat direct/DM delivery policy; use "block" for agents that should only send heartbeat alerts to non-DM destinations.':
    'Ghi đè theo từng tác nhân cho chính sách phân phối trực tiếp/DM của heartbeat; dùng "block" cho các tác nhân chỉ nên gửi cảnh báo heartbeat đến các đích không phải DM.',
  "Per-agent override for sandbox browser Docker network.":
    "Ghi đè theo từng tác nhân cho mạng Docker của trình duyệt sandbox.",
  "Per-agent override for tool profile selection when one agent needs a different capability baseline. Use this sparingly so policy differences across agents stay intentional and reviewable.":
    "Ghi đè theo từng tác nhân cho lựa chọn hồ sơ công cụ khi một tác nhân cần mức năng lực nền khác. Chỉ nên dùng hạn chế để khác biệt chính sách giữa các tác nhân luôn có chủ đích và dễ rà soát.",
  "Per-agent override for whether the default agent's ## Heartbeats system prompt section is injected. Use false to keep heartbeat runtime behavior but omit the heartbeat prompt instructions from that agent's system prompt.":
    "Ghi đè theo từng tác nhân cho việc có chèn phần system prompt ## Heartbeats của tác nhân mặc định hay không. Dùng false để giữ hành vi runtime heartbeat nhưng bỏ qua hướng dẫn prompt heartbeat khỏi system prompt của tác nhân đó.",
  "Per-agent provider-specific tool policy overrides for channel-scoped capability control. Use this when a single agent needs tighter restrictions on one provider than others.":
    "Ghi đè chính sách công cụ theo từng tác nhân, theo từng nhà cung cấp, để kiểm soát năng lực theo phạm vi kênh. Dùng mục này khi một tác nhân cần hạn chế chặt hơn trên một nhà cung cấp so với các nhà cung cấp khác.",
  "Per-channel debounce overrides for queue behavior keyed by provider id. Use this to tune burst handling independently for chat surfaces with different pacing.":
    "Ghi đè debounce theo từng kênh cho hành vi hàng đợi, được khóa theo id nhà cung cấp. Dùng mục này để tinh chỉnh xử lý lưu lượng tăng đột biến một cách độc lập cho các bề mặt chat có nhịp độ khác nhau.",
  "Per-channel inbound debounce overrides keyed by provider id in milliseconds. Use this where some providers send message fragments more aggressively than others.":
    "Ghi đè debounce đầu vào theo từng kênh, được khóa theo id nhà cung cấp, tính bằng mili giây. Dùng mục này khi một số nhà cung cấp gửi các mảnh tin nhắn dồn dập hơn những nhà cung cấp khác.",
  "Per-channel queue mode overrides keyed by provider id (for example telegram, discord, slack). Use this when one channel’s traffic pattern needs different queue behavior than global defaults.":
    "Ghi đè chế độ hàng đợi theo từng kênh, được khóa theo id nhà cung cấp (ví dụ: telegram, discord, slack). Dùng mục này khi mẫu lưu lượng của một kênh cần hành vi hàng đợi khác với mặc định toàn cục.",
  "Per-link understanding timeout budget in seconds before unresolved links are skipped. Keep this bounded to avoid long stalls when external sites are slow or unreachable.":
    "Ngân sách thời gian chờ hiểu liên kết theo từng liên kết, tính bằng giây, trước khi các liên kết chưa được xử lý bị bỏ qua. Giữ giới hạn này hợp lý để tránh bị treo lâu khi các trang bên ngoài chậm hoặc không thể truy cập.",
  "Per-plugin enablement override for a specific entry, applied on top of global plugin policy (restart required). Use this to stage plugin rollout gradually across environments.":
    "Ghi đè bật theo từng plugin cho một mục cụ thể, được áp dụng trên chính sách plugin toàn cục (cần khởi động lại). Dùng mục này để triển khai plugin theo từng giai đoạn trên các môi trường.",
  "Per-plugin environment variable map injected for that plugin runtime context only. Use this to scope provider credentials to one plugin instead of sharing global process environment.":
    "Ánh xạ biến môi trường theo từng plugin chỉ được chèn vào ngữ cảnh runtime của plugin đó. Dùng mục này để giới hạn thông tin xác thực của nhà cung cấp cho một plugin thay vì dùng chung môi trường tiến trình toàn cục.",
  "Per-plugin settings keyed by plugin ID including enablement and plugin-specific runtime configuration payloads. Use this for scoped plugin tuning without changing global loader policy.":
    "Thiết lập theo từng plugin được khóa theo ID plugin, bao gồm trạng thái bật và payload cấu hình runtime riêng của plugin. Dùng mục này để tinh chỉnh plugin trong phạm vi riêng mà không thay đổi chính sách bộ nạp toàn cục.",
  "Per-plugin subagent runtime controls for model override trust and allowlists. Keep this unset unless a plugin must explicitly steer subagent model selection.":
    "Điều khiển runtime subagent theo từng plugin cho độ tin cậy ghi đè model và danh sách cho phép. Để trống mục này trừ khi plugin cần điều hướng rõ ràng việc chọn model của subagent.",
  "Per-plugin typed hook policy controls for core-enforced safety gates. Use this to constrain high-impact hook categories without disabling the entire plugin.":
    "Điều khiển chính sách hook có kiểu theo từng plugin cho các cổng an toàn do lõi thực thi. Dùng mục này để giới hạn các nhóm hook có tác động cao mà không vô hiệu hóa toàn bộ plugin.",
  "Per-profile accent color for visual differentiation in dashboards and browser-related UI hints. Use distinct colors for high-signal operator recognition of active profiles.":
    "Màu nhấn theo từng hồ sơ để phân biệt trực quan trong dashboard và các gợi ý UI liên quan đến trình duyệt. Dùng các màu khác nhau để giúp người vận hành dễ nhận biết hồ sơ đang hoạt động.",
  "Per-profile attach-only override that skips local browser launch and only attaches to an existing CDP endpoint. Useful when one profile is externally managed but others are locally launched.":
    "Ghi đè chỉ-đính-kèm theo từng hồ sơ, bỏ qua việc khởi chạy trình duyệt cục bộ và chỉ đính kèm vào một endpoint CDP hiện có. Hữu ích khi một hồ sơ được quản lý bên ngoài nhưng các hồ sơ khác được khởi chạy cục bộ.",
  'Per-profile browser driver mode. Use "openclaw" (or legacy "clawd") for CDP-based profiles, or use "existing-session" for host-local Chrome DevTools MCP attachment.':
    'Chế độ trình điều khiển trình duyệt theo từng hồ sơ. Dùng "openclaw" (hoặc "clawd" cũ) cho các hồ sơ dựa trên CDP, hoặc dùng "existing-session" để đính kèm Chrome DevTools MCP trên máy chủ cục bộ.',
  "Per-profile CDP websocket URL used for explicit remote browser routing by profile name. Use this when profile connections terminate on remote hosts or tunnels.":
    "URL websocket CDP theo từng hồ sơ được dùng để định tuyến trình duyệt từ xa rõ ràng theo tên hồ sơ. Dùng mục này khi kết nối hồ sơ kết thúc trên máy chủ từ xa hoặc đường hầm.",
  "Per-profile Chromium user data directory for existing-session attachment through Chrome DevTools MCP. Use this for host-local Brave, Edge, Chromium, or non-default Chrome profiles when the built-in auto-connect path would pick the wrong browser data directory.":
    "Thư mục dữ liệu người dùng Chromium theo từng hồ sơ cho việc đính kèm existing-session thông qua Chrome DevTools MCP. Dùng mục này cho các hồ sơ Brave, Edge, Chromium hoặc Chrome không mặc định trên máy chủ cục bộ khi đường dẫn tự động kết nối tích hợp sẽ chọn sai thư mục dữ liệu trình duyệt.",
  "Per-profile local CDP port used when connecting to browser instances by port instead of URL. Use unique ports per profile to avoid connection collisions.":
    "Cổng CDP cục bộ theo từng hồ sơ được dùng khi kết nối tới các phiên bản trình duyệt bằng cổng thay vì URL. Dùng các cổng riêng cho từng hồ sơ để tránh xung đột kết nối.",
  "Per-provider tool allow/deny overrides keyed by channel/provider ID to tailor capabilities by surface. Use this when one provider needs stricter controls than global tool policy.":
    "Ghi đè cho phép/từ chối công cụ theo từng nhà cung cấp, được khóa theo ID kênh/nhà cung cấp để điều chỉnh khả năng theo từng bề mặt. Dùng mục này khi một nhà cung cấp cần kiểm soát chặt hơn chính sách công cụ toàn cục.",
  "Per-sessionUpdate visibility overrides for ACP projection (for example usage_update, available_commands_update).":
    "Ghi đè hiển thị theo từng sessionUpdate cho phép chiếu ACP (ví dụ: usage_update, available_commands_update).",
  "Per-source broadcast destination list where each key is a source peer ID and the value is an array of destination peer IDs. Keep lists intentional to avoid accidental message amplification.":
    "Danh sách đích phát theo từng nguồn, trong đó mỗi khóa là một peer ID nguồn và giá trị là một mảng peer ID đích. Giữ các danh sách này có chủ đích để tránh khuếch đại tin nhắn ngoài ý muốn.",
  "Pin browser routing to a specific node id or name (optional).":
    "Ghim định tuyến trình duyệt vào một node id hoặc tên cụ thể (tùy chọn).",
  "Plugin Allowlist": "Danh sách cho phép plugin",
  "Plugin API Key": "Khóa API plugin",
  "Plugin Approval Agent Filter": "Bộ lọc tác nhân phê duyệt plugin",
  "Plugin Approval Forwarding": "Chuyển tiếp phê duyệt plugin",
  "Plugin Approval Forwarding Mode": "Chế độ chuyển tiếp phê duyệt plugin",
  "Plugin Approval Forwarding Targets": "Đích chuyển tiếp phê duyệt plugin",
  "Plugin Approval Session Filter": "Bộ lọc phiên phê duyệt plugin",
  "Plugin Approval Target Account ID": "ID tài khoản đích phê duyệt plugin",
  "Plugin Approval Target Channel": "Kênh đích phê duyệt plugin",
  "Plugin Approval Target Destination": "Đích đến phê duyệt plugin",
  "Plugin Approval Target Thread ID": "ID luồng đích phê duyệt plugin",
  "Plugin Config": "Cấu hình plugin",
  "Plugin Denylist": "Danh sách chặn plugin",
  "Plugin Enabled": "Bật plugin",
  "Plugin Entries": "Mục plugin",
  "Plugin entry name inside the source marketplace, used for later updates.":
    "Tên mục plugin bên trong marketplace nguồn, được dùng cho các lần cập nhật sau.",
  "Plugin Environment Variables": "Biến môi trường của plugin",
  "Plugin Hook Policy": "Chính sách hook của plugin",
  "Plugin Install Path": "Đường dẫn cài đặt plugin",
  "Plugin Install Records": "Bản ghi cài đặt plugin",
  "Plugin Install Source": "Nguồn cài đặt plugin",
  "Plugin Install Source Path": "Đường dẫn nguồn cài đặt plugin",
  "Plugin Install Spec": "Đặc tả cài đặt plugin",
  "Plugin Install Time": "Thời gian cài đặt plugin",
  "Plugin Install Version": "Phiên bản cài đặt plugin",
  "Plugin Load Paths": "Đường dẫn tải plugin",
  "Plugin Loader": "Trình tải plugin",
  "Plugin loader configuration group for specifying filesystem paths where plugins are discovered. Keep load paths explicit and reviewed to avoid accidental untrusted extension loading.":
    "Nhóm cấu hình trình tải plugin để chỉ định các đường dẫn hệ thống tệp nơi plugin được phát hiện. Giữ các đường dẫn tải rõ ràng và đã được rà soát để tránh vô tình tải các tiện ích mở rộng không đáng tin cậy.",
  "Plugin Marketplace Name": "Tên marketplace plugin",
  "Plugin Marketplace Plugin": "Plugin marketplace plugin",
  "Plugin Marketplace Source": "Nguồn marketplace plugin",
  "Plugin Resolution Time": "Thời gian phân giải plugin",
  "Plugin Resolved Integrity": "Tính toàn vẹn đã phân giải của plugin",
  "Plugin Resolved Package Name": "Tên gói đã phân giải của plugin",
  "Plugin Resolved Package Spec": "Đặc tả gói đã phân giải của plugin",
  "Plugin Resolved Package Version": "Phiên bản gói đã phân giải của plugin",
  "Plugin Resolved Shasum": "Shasum đã phân giải của plugin",
  "Plugin Slots": "Khe plugin",
  "Plugin Subagent Allowed Models": "Các model được phép cho tác nhân phụ của plugin",
  "Plugin Subagent Policy": "Chính sách tác nhân phụ của plugin",
  "Plugin system controls for enabling extensions, constraining load scope, configuring entries, and tracking installs. Keep plugin policy explicit and least-privilege in production environments.":
    "Các điều khiển hệ thống plugin để bật tiện ích mở rộng, giới hạn phạm vi tải, cấu hình mục nhập và theo dõi cài đặt. Giữ chính sách plugin rõ ràng và theo nguyên tắc đặc quyền tối thiểu trong môi trường production.",
  "Plugin-defined configuration payload interpreted by that plugin's own schema and validation rules. Use only documented fields from the plugin to prevent ignored or invalid settings.":
    "Payload cấu hình do plugin xác định, được diễn giải theo schema và quy tắc xác thực riêng của plugin đó. Chỉ sử dụng các trường được plugin tài liệu hóa để tránh các thiết lập bị bỏ qua hoặc không hợp lệ.",
  Plugins: "Plugin",
  "Policy for allowing agent-to-agent tool calls and constraining which target agents can be reached. Keep disabled or tightly scoped unless cross-agent orchestration is intentionally enabled.":
    "Chính sách cho phép các lệnh gọi công cụ giữa tác nhân với tác nhân và giới hạn những tác nhân đích nào có thể được truy cập. Giữ ở trạng thái tắt hoặc giới hạn chặt chẽ trừ khi điều phối liên tác nhân được chủ đích bật.",
  "Port for the local Gmail callback HTTP server when serve mode is enabled. Use a dedicated port to avoid collisions with gateway/control interfaces.":
    "Cổng cho máy chủ HTTP callback Gmail cục bộ khi chế độ serve được bật. Sử dụng một cổng chuyên dụng để tránh xung đột với các giao diện gateway/control.",
  "Post-Compaction Context Sections": "Các phần ngữ cảnh sau nén gọn",
  "Pre-compaction memory flush settings that run an agentic memory write before heavy compaction. Keep enabled for long sessions so salient context is persisted before aggressive trimming.":
    "Thiết lập xả bộ nhớ trước khi nén gọn, chạy một lần ghi bộ nhớ tác nhân trước khi nén gọn mạnh. Nên bật cho các phiên dài để ngữ cảnh quan trọng được lưu lại trước khi cắt giảm mạnh.",
  "Preferred language hint for audio understanding/transcription when provider support is available. Set this to improve recognition accuracy for known primary languages.":
    "Gợi ý ngôn ngữ ưu tiên cho việc hiểu/phiên âm âm thanh khi nhà cung cấp hỗ trợ. Đặt mục này để cải thiện độ chính xác nhận dạng cho các ngôn ngữ chính đã biết.",
  "Preferred model list for link understanding tasks, evaluated in order as fallbacks when supported. Use lightweight models first for routine summarization and heavier models only when needed.":
    "Danh sách model ưu tiên cho các tác vụ hiểu liên kết, được đánh giá theo thứ tự làm phương án dự phòng khi được hỗ trợ. Ưu tiên dùng model nhẹ trước cho tóm tắt thông thường và chỉ dùng model nặng hơn khi cần.",
  "Prefix text prepended to inbound user messages before they are handed to the agent runtime. Use this sparingly for channel context markers and keep it stable across sessions.":
    "Văn bản tiền tố được thêm vào trước các tin nhắn người dùng đến trước khi được chuyển cho runtime của tác nhân. Chỉ nên dùng hạn chế cho các dấu ngữ cảnh kênh và giữ ổn định giữa các phiên.",
  "Prefix text prepended to outbound assistant replies before sending to channels. Use for lightweight branding/context tags and avoid long prefixes that reduce content density.":
    "Văn bản tiền tố được thêm vào trước các phản hồi trợ lý gửi đi trước khi gửi tới các kênh. Dùng cho các thẻ thương hiệu/ngữ cảnh nhẹ và tránh các tiền tố dài làm giảm mật độ nội dung.",
  "Preserve Media Filenames": "Giữ nguyên tên tệp media",
  "Preserves the configured collection label only when the path points outside the agent workspace; paths inside the workspace stay agent-scoped even if a name is provided. Use this for shared cross-agent transcript roots that live outside the workspace.":
    "Chỉ giữ nguyên nhãn bộ sưu tập đã cấu hình khi đường dẫn trỏ ra ngoài workspace của tác nhân; các đường dẫn bên trong workspace vẫn giữ phạm vi theo tác nhân ngay cả khi có cung cấp tên. Dùng mục này cho các thư mục gốc transcript dùng chung giữa nhiều tác nhân nằm ngoài workspace.",
  "Primary accent color used by UI surfaces for emphasis, badges, and visual identity cues. Use high-contrast values that remain readable across light/dark themes.":
    "Màu nhấn chính được các bề mặt UI sử dụng để tạo điểm nhấn, huy hiệu và dấu hiệu nhận diện trực quan. Sử dụng các giá trị tương phản cao để vẫn dễ đọc trên cả giao diện sáng/tối.",
  'Primary log level threshold for runtime logger output: "silent", "fatal", "error", "warn", "info", "debug", or "trace". Keep "info" or "warn" for production, and use debug/trace only during investigation.':
    'Ngưỡng mức log chính cho đầu ra logger runtime: "silent", "fatal", "error", "warn", "info", "debug", hoặc "trace". Giữ ở "info" hoặc "warn" cho production, và chỉ dùng debug/trace khi điều tra.',
  "Primary Model": "Mô hình chính",
  "Primary model (provider/model).": "Model chính (provider/model).",
  "Private key paired with request.proxy.tls.cert for proxy mutual TLS.":
    "Khóa riêng tư được ghép cặp với request.proxy.tls.cert cho mutual TLS của proxy.",
  "Private key paired with request.tls.cert for upstream mutual TLS.":
    "Khóa riêng tư được ghép cặp với request.tls.cert cho mutual TLS của upstream.",
  "Provider API adapter selection controlling request/response compatibility handling for model calls. Use the adapter that matches your upstream provider protocol to avoid feature mismatch.":
    "Lựa chọn adapter API của nhà cung cấp để kiểm soát việc xử lý tương thích request/response cho các lệnh gọi mô hình. Sử dụng adapter khớp với giao thức nhà cung cấp upstream của bạn để tránh không khớp tính năng.",
  "Provider API key for Talk mode.": "Khóa API của nhà cung cấp cho chế độ Talk.",
  "Provider API key used by that speech provider when its plugin requires authenticated TTS access.":
    "Khóa API của nhà cung cấp được nhà cung cấp giọng nói đó sử dụng khi plugin của họ yêu cầu quyền truy cập TTS có xác thực.",
  "Provider credential used for API-key based authentication when the provider requires direct key auth. Use secret/env substitution and avoid storing real keys in committed config files.":
    "Thông tin xác thực của nhà cung cấp dùng cho xác thực dựa trên API key khi nhà cung cấp yêu cầu xác thực khóa trực tiếp. Sử dụng thay thế secret/env và tránh lưu khóa thật trong các tệp cấu hình đã commit.",
  "Provider map keyed by provider ID containing connection/auth settings and concrete model definitions. Use stable provider keys so references from agents and tooling remain portable across environments.":
    "Ánh xạ nhà cung cấp được lập chỉ mục theo ID nhà cung cấp, chứa cài đặt kết nối/xác thực và các định nghĩa mô hình cụ thể. Sử dụng khóa nhà cung cấp ổn định để các tham chiếu từ tác nhân và công cụ vẫn có thể dùng xuyên suốt giữa các môi trường.",
  "Provider-owned Talk config fields for the matching provider id.":
    "Các trường cấu hình Talk do nhà cung cấp sở hữu cho id nhà cung cấp tương ứng.",
  "Provider-specific output vector size override for memory embeddings. Gemini embedding-2 supports 768, 1536, or 3072; Bedrock families such as Titan V2, Cohere V4, and Nova expose their own allowed sizes. Expect a full reindex when you change it because stored vector dimensions must stay consistent.":
    "Ghi đè kích thước vector đầu ra theo từng nhà cung cấp cho memory embeddings. Gemini embedding-2 hỗ trợ 768, 1536 hoặc 3072; các họ Bedrock như Titan V2, Cohere V4 và Nova có các kích thước được phép riêng. Hãy dự kiến phải lập chỉ mục lại toàn bộ khi bạn thay đổi giá trị này vì kích thước vector đã lưu phải luôn nhất quán.",
  "Provider-specific Talk settings keyed by provider id. During migration, prefer this over legacy talk.* keys.":
    "Cài đặt Talk theo từng nhà cung cấp, được lập chỉ mục theo id nhà cung cấp. Trong quá trình di chuyển, hãy ưu tiên dùng mục này thay cho các khóa talk.* cũ.",
  "Provider-specific TTS configuration for one speech provider id. Keep fields scoped to the plugin that owns that provider.":
    "Cấu hình TTS theo từng nhà cung cấp cho một id nhà cung cấp giọng nói. Giữ các trường trong phạm vi của plugin sở hữu nhà cung cấp đó.",
  "Provider-specific TTS settings keyed by speech provider id. Use this instead of bundled provider-specific top-level keys so speech plugins stay decoupled from core config schema.":
    "Cài đặt TTS theo từng nhà cung cấp, được lập chỉ mục theo id nhà cung cấp giọng nói. Hãy dùng mục này thay cho các khóa cấp cao nhất theo từng nhà cung cấp được gộp sẵn để các plugin giọng nói vẫn tách biệt khỏi schema cấu hình lõi.",
  "Provides channel-specific reset overrides keyed by provider/channel id for fine-grained behavior control. Use this only when one channel needs exceptional reset behavior beyond type-level policies.":
    "Cung cấp các ghi đè reset theo từng kênh, được lập chỉ mục theo id nhà cung cấp/kênh để kiểm soát hành vi chi tiết. Chỉ dùng mục này khi một kênh cần hành vi reset ngoại lệ vượt ngoài các chính sách cấp loại.",
  'Proxy mode for audio requests: "env-proxy" uses environment proxy settings, while "explicit-proxy" uses the configured proxy URL only for this request path.':
    'Chế độ proxy cho các request âm thanh: "env-proxy" sử dụng cài đặt proxy của môi trường, còn "explicit-proxy" chỉ sử dụng URL proxy đã cấu hình cho đường dẫn request này.',
  'Proxy override mode for model-provider requests: "env-proxy" or "explicit-proxy".':
    'Chế độ ghi đè proxy cho các request tới nhà cung cấp mô hình: "env-proxy" hoặc "explicit-proxy".',
  "Proxy transport override for audio requests. Use env-proxy to respect process proxy settings, or explicit-proxy to force a dedicated proxy URL for this provider path.":
    "Ghi đè transport proxy cho các request âm thanh. Dùng env-proxy để tuân theo cài đặt proxy của tiến trình, hoặc explicit-proxy để buộc dùng một URL proxy chuyên biệt cho đường dẫn nhà cung cấp này.",
  "Pruning controls for per-job cron run history files under `cron/runs/<jobId>.jsonl`, including size and line retention.":
    "Các điều khiển cắt tỉa cho tệp lịch sử chạy cron theo từng job trong `cron/runs/<jobId>.jsonl`, bao gồm giới hạn kích thước và số dòng được giữ lại.",
  "Pub/Sub subscription consumed by the gateway to receive Gmail change notifications from the configured topic. Keep subscription ownership clear so multiple consumers do not race unexpectedly.":
    "Subscription Pub/Sub được gateway sử dụng để nhận thông báo thay đổi Gmail từ topic đã cấu hình. Giữ quyền sở hữu subscription rõ ràng để nhiều consumer không cạnh tranh ngoài ý muốn.",
  "Public callback URL Gmail or intermediaries invoke to deliver notifications into this hook pipeline. Keep this URL protected with token validation and restricted network exposure.":
    "URL callback công khai mà Gmail hoặc các bên trung gian gọi để chuyển thông báo vào pipeline hook này. Giữ URL này được bảo vệ bằng xác thực token và giới hạn phạm vi truy cập mạng.",
  "Push-delivery settings used by the gateway when it needs to wake or notify paired devices. Configure relay-backed APNs here for official iOS builds; direct APNs auth remains env-based for local/manual builds.":
    "Cài đặt push-delivery được gateway sử dụng khi cần đánh thức hoặc thông báo cho các thiết bị đã ghép cặp. Cấu hình APNs có relay tại đây cho các bản dựng iOS chính thức; xác thực APNs trực tiếp vẫn dựa trên env cho các bản dựng cục bộ/thủ công.",
  "QMD Command Timeout (ms)": "Thời gian chờ lệnh QMD (ms)",
  "QMD Embed Interval": "Khoảng thời gian nhúng QMD",
  "QMD Embed Timeout (ms)": "Thời gian chờ nhúng QMD (ms)",
  "QMD Extra Collection Name": "Tên bộ sưu tập bổ sung QMD",
  "QMD Extra Collection Path": "Đường dẫn bộ sưu tập bổ sung QMD",
  "QMD Extra Collection Pattern": "Mẫu bộ sưu tập bổ sung QMD",
  "QMD Extra Collections": "Các bộ sưu tập bổ sung QMD",
  "QMD Extra Paths": "Các đường dẫn bổ sung QMD",
  "QMD Include Default Memory": "QMD Bao gồm bộ nhớ mặc định",
  "QMD Max Injected Chars": "QMD Số ký tự được chèn tối đa",
  "QMD Max Results": "QMD Số kết quả tối đa",
  "QMD Max Snippet Chars": "QMD Số ký tự đoạn trích tối đa",
  "QMD MCPorter Enabled": "QMD MCPorter đã bật",
  "QMD MCPorter Server Name": "Tên máy chủ QMD MCPorter",
  "QMD MCPorter Start Daemon": "QMD MCPorter khởi động daemon",
  "QMD Path": "Đường dẫn QMD",
  "QMD Path Name": "Tên đường dẫn QMD",
  "QMD Path Pattern": "Mẫu đường dẫn QMD",
  "QMD Search Mode": "Chế độ tìm kiếm QMD",
  "QMD Search Timeout (ms)": "Thời gian chờ tìm kiếm QMD (ms)",
  "QMD Search Tool Override": "QMD Ghi đè công cụ tìm kiếm",
  "QMD Session Export Directory": "Thư mục xuất phiên QMD",
  "QMD Session Indexing": "Lập chỉ mục phiên QMD",
  "QMD Session Retention (days)": "Thời gian lưu giữ phiên QMD (ngày)",
  "QMD Surface Scope": "Phạm vi bề mặt QMD",
  "QMD Update Debounce (ms)": "QMD Độ trễ cập nhật (ms)",
  "QMD Update Interval": "Khoảng thời gian cập nhật QMD",
  "QMD Update on Startup": "Cập nhật QMD khi khởi động",
  "QMD Update Timeout (ms)": "Thời gian chờ cập nhật QMD (ms)",
  "QMD Wait for Boot Sync": "QMD chờ đồng bộ khởi động",
  'Queue behavior mode: "steer", "followup", "collect", "steer-backlog", "steer+backlog", "queue", or "interrupt". Keep conservative modes unless you intentionally need aggressive interruption/backlog semantics.':
    'Chế độ hành vi hàng đợi: "steer", "followup", "collect", "steer-backlog", "steer+backlog", "queue" hoặc "interrupt". Giữ các chế độ bảo thủ trừ khi bạn chủ ý cần ngữ nghĩa ngắt/tồn đọng tích cực.',
  "Queue Capacity": "Dung lượng hàng đợi",
  "Queue Debounce (ms)": "Độ trễ chống dội hàng đợi (ms)",
  "Queue Debounce by Channel (ms)": "Độ trễ chống dội hàng đợi theo kênh (ms)",
  "Queue Drop Strategy": "Chiến lược loại bỏ hàng đợi",
  "Queue Mode": "Chế độ hàng đợi",
  "Queue Mode by Channel": "Chế độ hàng đợi theo kênh",
  "Randomization factor (0-1) applied to reconnect delays to desynchronize clients after outage events. Keep non-zero jitter in multi-client deployments to reduce synchronized spikes.":
    "Hệ số ngẫu nhiên hóa (0-1) áp dụng cho độ trễ kết nối lại để tránh đồng bộ giữa các ứng dụng khách sau sự cố ngừng hoạt động. Giữ jitter khác 0 trong các triển khai nhiều ứng dụng khách để giảm các đợt tăng đột biến đồng bộ.",
  "Rate-Limited Profile Rotations": "Luân chuyển hồ sơ có giới hạn tốc độ",
  "Reconnect backoff policy for web channel reconnect attempts after transport failure. Keep bounded retries and jitter tuned to avoid thundering-herd reconnect behavior.":
    "Chính sách backoff kết nối lại cho các lần thử kết nối lại kênh web sau khi truyền tải thất bại. Giữ số lần thử lại có giới hạn và điều chỉnh jitter phù hợp để tránh hành vi kết nối lại kiểu thundering-herd.",
  "Registers native skill commands so users can invoke skills directly from provider command menus where supported. Keep aligned with your skill policy so exposed commands match what operators expect.":
    "Đăng ký các lệnh skill gốc để người dùng có thể gọi Skills trực tiếp từ menu lệnh của nhà cung cấp ở nơi được hỗ trợ. Giữ đồng bộ với chính sách skill của bạn để các lệnh được hiển thị khớp với kỳ vọng của người vận hành.",
  "Registers native slash/menu commands with channels that support command registration (Discord, Slack, Telegram). Keep enabled for discoverability unless you intentionally run text-only command workflows.":
    "Đăng ký các lệnh slash/menu gốc với các kênh hỗ trợ đăng ký lệnh (Discord, Slack, Telegram). Giữ bật để tăng khả năng khám phá trừ khi bạn chủ ý chỉ chạy quy trình lệnh dạng văn bản.",
  "Relative transform module path loaded from hooks.transformsDir to rewrite incoming payloads before delivery. Keep modules local, reviewed, and free of path traversal patterns.":
    "Đường dẫn mô-đun biến đổi tương đối được tải từ hooks.transformsDir để viết lại payload đến trước khi phân phối. Giữ các mô-đun ở cục bộ, đã được rà soát và không chứa mẫu path traversal.",
  "Remote Batch Concurrency": "Đồng thời batch từ xa",
  "Remote Batch Embedding Enabled": "Bật embedding batch từ xa",
  "Remote Batch Poll Interval (ms)": "Khoảng thời gian thăm dò batch từ xa (ms)",
  "Remote Batch Timeout (min)": "Thời gian chờ batch từ xa (phút)",
  "Remote Batch Wait for Completion": "Batch từ xa chờ hoàn tất",
  "Remote CDP Handshake Timeout (ms)": "Thời gian chờ bắt tay CDP từ xa (ms)",
  "Remote CDP Timeout (ms)": "Thời gian chờ CDP từ xa (ms)",
  "Remote CDP websocket URL used to attach to an externally managed browser instance. Use this for centralized browser hosts and keep URL access restricted to trusted network paths.":
    "URL websocket CDP từ xa được dùng để đính kèm vào một phiên bản trình duyệt được quản lý bên ngoài. Dùng mục này cho các máy chủ trình duyệt tập trung và giới hạn quyền truy cập URL trong các đường mạng đáng tin cậy.",
  'Remote connection transport: "direct" uses configured URL connectivity, while "ssh" tunnels through SSH. Use SSH when you need encrypted tunnel semantics without exposing remote ports.':
    'Phương thức kết nối từ xa: "direct" dùng kết nối URL đã cấu hình, còn "ssh" tạo đường hầm qua SSH. Dùng SSH khi bạn cần ngữ nghĩa đường hầm được mã hóa mà không phải mở các cổng từ xa.',
  "Remote Embedding API Key": "API Key Embedding từ xa",
  "Remote Embedding Base URL": "Base URL Embedding từ xa",
  "Remote Embedding Headers": "Header Embedding từ xa",
  "Remote Gateway": "Gateway từ xa",
  "Remote gateway connection settings for direct or SSH transport when this instance proxies to another runtime host. Use remote mode only when split-host operation is intentionally configured.":
    "Cài đặt kết nối Gateway từ xa cho phương thức truyền trực tiếp hoặc SSH khi phiên bản này làm proxy tới một máy chủ runtime khác. Chỉ dùng chế độ từ xa khi vận hành tách máy chủ được cấu hình có chủ đích.",
  "Remote gateway over SSH (tunnels the gateway port to localhost). Format: user@host or user@host:port.":
    "Gateway từ xa qua SSH (tạo đường hầm cổng Gateway tới localhost). Định dạng: user@host hoặc user@host:port.",
  "Remote Gateway Password": "Mật khẩu Gateway từ xa",
  "Remote Gateway SSH Identity": "Danh tính SSH của Gateway từ xa",
  "Remote Gateway SSH Target": "Đích SSH của Gateway từ xa",
  "Remote Gateway TLS Fingerprint": "Dấu vân tay TLS của Gateway từ xa",
  "Remote Gateway Token": "Token Gateway từ xa",
  "Remote Gateway Transport": "Phương thức truyền Gateway từ xa",
  "Remote Gateway URL": "URL Gateway từ xa",
  "Remote Gateway WebSocket URL (ws:// or wss://).":
    "URL WebSocket Gateway từ xa (ws:// hoặc wss://).",
  "Remove Ack Reaction After Reply": "Xóa phản ứng xác nhận sau khi trả lời",
  "Removes entries older than this duration (for example `30d` or `12h`) during maintenance passes. Use this as the primary age-retention control and align it with data retention policy.":
    "Xóa các mục cũ hơn khoảng thời gian này (ví dụ `30d` hoặc `12h`) trong các lần bảo trì. Dùng đây làm cơ chế kiểm soát lưu giữ theo tuổi chính và căn chỉnh theo chính sách lưu giữ dữ liệu.",
  "Removes the acknowledgment reaction after final reply delivery when enabled. Keep enabled for cleaner UX in channels where persistent ack reactions create clutter.":
    "Xóa phản ứng xác nhận sau khi gửi phản hồi cuối cùng khi được bật. Nên giữ bật để UX gọn gàng hơn trong các kênh mà phản ứng xác nhận tồn tại lâu gây lộn xộn.",
  "Renewal cadence in minutes for Gmail watch subscriptions to prevent expiration. Set below provider expiration windows and monitor renew failures in logs.":
    "Chu kỳ gia hạn tính bằng phút cho các đăng ký watch của Gmail để tránh hết hạn. Đặt thấp hơn các khoảng hết hạn của nhà cung cấp và theo dõi lỗi gia hạn trong log.",
  "Repo Root": "Thư mục gốc repo",
  "Require explicit approval for interpreter inline-eval forms such as `python -c`, `node -e`, `ruby -e`, or `osascript -e`. Prevents silent allowlist reuse and downgrades allow-always to ask-each-time for those forms.":
    "Yêu cầu phê duyệt rõ ràng cho các biểu mẫu inline-eval của interpreter như `python -c`, `node -e`, `ruby -e` hoặc `osascript -e`. Ngăn việc tái sử dụng allowlist một cách âm thầm và hạ cấp allow-always thành hỏi mỗi lần đối với các biểu mẫu đó.",
  "Require Inline-Eval Approval": "Yêu cầu phê duyệt Inline-Eval",
  "Required by default for gateway access (unless using Tailscale Serve identity); required for non-loopback binds.":
    "Được yêu cầu mặc định để truy cập Gateway (trừ khi dùng danh tính Tailscale Serve); được yêu cầu cho các bind không phải loopback.",
  "Required for Tailscale funnel.": "Bắt buộc cho Tailscale funnel.",
  "Requires at least this many appended transcript messages before reindex is triggered (default: 50). Lower this for near-real-time transcript recall, or raise it to reduce indexing churn.":
    "Yêu cầu ít nhất số lượng tin nhắn bản ghi được nối thêm này trước khi kích hoạt lập chỉ mục lại (mặc định: 50). Giảm giá trị này để truy hồi bản ghi gần thời gian thực, hoặc tăng lên để giảm biến động lập chỉ mục.",
  "Requires at least this many newly appended bytes before session transcript changes trigger reindex (default: 100000). Increase to reduce frequent small reindexes, or lower for faster transcript freshness.":
    "Yêu cầu ít nhất số byte mới được nối thêm này trước khi các thay đổi bản ghi phiên kích hoạt lập chỉ mục lại (mặc định: 100000). Tăng để giảm các lần lập chỉ mục lại nhỏ và thường xuyên, hoặc giảm để bản ghi được cập nhật mới nhanh hơn.",
  "Resets Tailscale Serve/Funnel state on gateway exit to avoid stale published routes after shutdown. Keep enabled unless another controller manages publish lifecycle outside the gateway.":
    "Đặt lại trạng thái Tailscale Serve/Funnel khi Gateway thoát để tránh các tuyến đã xuất bản bị cũ sau khi tắt. Giữ bật trừ khi một bộ điều khiển khác quản lý vòng đời xuất bản bên ngoài Gateway.",
  "Resolved exact npm spec (<name>@<version>) from the fetched artifact.":
    "Đã phân giải chính xác npm spec (<name>@<version>) từ artifact đã tải về.",
  "Resolved install directory for the installed plugin bundle.":
    "Đã phân giải thư mục cài đặt cho gói plugin đã cài đặt.",
  "Resolved npm dist integrity hash for the fetched artifact (if reported by npm).":
    "Đã phân giải hash integrity của npm dist cho artifact đã tải về (nếu npm báo cáo).",
  "Resolved npm dist shasum for the fetched artifact (if reported by npm).":
    "Đã phân giải shasum của npm dist cho artifact đã tải về (nếu npm báo cáo).",
  "Resolved npm package name from the fetched artifact.":
    "Đã phân giải tên gói npm từ artifact đã tải về.",
  "Resolved npm package version from the fetched artifact (useful for non-pinned specs).":
    "Đã phân giải phiên bản gói npm từ artifact đã tải về (hữu ích cho các spec không ghim phiên bản).",
  "Restart Deferral Timeout (ms)": "Thời gian chờ hoãn khởi động lại (ms)",
  "Restrict apply_patch paths to the workspace directory (default: true). Set false to allow writing outside the workspace (dangerous).":
    "Giới hạn các đường dẫn apply_patch trong thư mục workspace (mặc định: true). Đặt false để cho phép ghi ra ngoài workspace (nguy hiểm).",
  "Restrict filesystem tools (read/write/edit/apply_patch) to the workspace directory (default: false).":
    "Giới hạn các công cụ hệ thống tệp (read/write/edit/apply_patch) trong thư mục workspace (mặc định: false).",
  "Restricts browser mode to attach-only behavior without starting local browser processes. Use this when all browser sessions are externally managed by a remote CDP provider.":
    "Giới hạn chế độ trình duyệt ở hành vi chỉ attach mà không khởi động các tiến trình trình duyệt cục bộ. Dùng tùy chọn này khi tất cả phiên trình duyệt được quản lý bên ngoài bởi nhà cung cấp CDP từ xa.",
  "Retention for reset transcript archives (`*.reset.<timestamp>`). Accepts a duration (for example `30d`), or `false` to disable cleanup. Defaults to pruneAfter so reset artifacts do not grow forever.":
    "Thời gian lưu giữ cho kho lưu trữ bản ghi đặt lại (`*.reset.<timestamp>`). Chấp nhận một khoảng thời gian (ví dụ `30d`), hoặc `false` để tắt dọn dẹp. Mặc định theo pruneAfter để các artifact đặt lại không tăng mãi.",
  "Rotates the session store when file size exceeds a threshold such as `10mb` or `1gb`. Use this to bound single-file growth and keep backup/restore operations manageable.":
    "Xoay vòng kho phiên khi kích thước tệp vượt quá ngưỡng như `10mb` hoặc `1gb`. Dùng tùy chọn này để giới hạn mức tăng của một tệp đơn và giữ cho các thao tác sao lưu/khôi phục ở mức dễ quản lý.",
  "Routes QMD through an mcporter daemon instead of spawning qmd per request, reducing cold-start overhead for larger models. Keep disabled unless mcporter is installed and configured.":
    "Định tuyến QMD qua daemon mcporter thay vì sinh qmd cho mỗi yêu cầu, giúp giảm chi phí khởi động nguội cho các mô hình lớn hơn. Giữ tắt trừ khi mcporter đã được cài đặt và cấu hình.",
  "Routes QMD work through mcporter (MCP runtime) instead of spawning `qmd` for each call. Use this when cold starts are expensive on large models; keep direct process mode for simpler local setups.":
    "Định tuyến công việc QMD qua mcporter (MCP runtime) thay vì sinh `qmd` cho mỗi lần gọi. Dùng tùy chọn này khi khởi động nguội tốn kém trên các mô hình lớn; giữ chế độ tiến trình trực tiếp cho các thiết lập cục bộ đơn giản hơn.",
  "Runs an initial QMD update once during gateway startup (default: true). Keep enabled so recall starts from a fresh baseline; disable only when startup speed is more important than immediate freshness.":
    "Chạy một lần cập nhật QMD ban đầu trong quá trình khởi động Gateway (mặc định: true). Giữ bật để truy hồi bắt đầu từ một đường cơ sở mới; chỉ tắt khi tốc độ khởi động quan trọng hơn độ mới tức thời.",
  'Runtime type for this agent: "embedded" (default OpenClaw runtime) or "acp" (ACP harness defaults).':
    'Kiểu runtime cho tác nhân này: "embedded" (runtime OpenClaw mặc định) hoặc "acp" (mặc định ACP harness).',
  "Safe case-insensitive regex patterns used to detect explicit mentions/trigger phrases in group chats. Use precise patterns to reduce false positives in high-volume channels; invalid or unsafe nested-repetition patterns are ignored.":
    "Các mẫu regex an toàn không phân biệt hoa thường dùng để phát hiện các lượt nhắc rõ ràng/cụm từ kích hoạt trong trò chuyện nhóm. Dùng các mẫu chính xác để giảm false positive trong các kênh lưu lượng cao; các mẫu lặp lồng nhau không hợp lệ hoặc không an toàn sẽ bị bỏ qua.",
  "Sandbox Browser CDP Source Port Range": "Phạm vi cổng nguồn CDP của trình duyệt Sandbox",
  "Sandbox Browser Network": "Mạng trình duyệt Sandbox",
  "Sandbox Docker Allow Container Namespace Join":
    "Sandbox Docker cho phép tham gia namespace của container",
  "Sandbox Tool Allow/Deny Policy": "Chính sách Cho phép/Từ chối Công cụ Sandbox",
  "Sandbox Tool Policy": "Chính sách Công cụ Sandbox",
  "Scope selector controlling when video understanding is attempted across incoming events. Narrow scope in noisy channels, and broaden only where video interpretation is core to workflow.":
    "Bộ chọn phạm vi kiểm soát thời điểm thử hiểu video trên các sự kiện đến. Thu hẹp phạm vi trong các kênh nhiều nhiễu, và chỉ mở rộng ở nơi việc diễn giải video là cốt lõi của quy trình làm việc.",
  "Scope selector for when audio understanding runs across inbound messages and attachments. Keep focused scopes in high-volume channels to reduce cost and avoid accidental transcription.":
    "Bộ chọn phạm vi cho thời điểm chạy hiểu âm thanh trên các tin nhắn và tệp đính kèm đến. Giữ phạm vi tập trung trong các kênh lưu lượng cao để giảm chi phí và tránh chép lời ngoài ý muốn.",
  "Scope selector for when image understanding is attempted (for example only explicit requests versus broader auto-detection). Keep narrow scope in busy channels to control token and API spend.":
    "Bộ chọn phạm vi cho thời điểm thử hiểu hình ảnh (ví dụ chỉ các yêu cầu rõ ràng so với tự động phát hiện rộng hơn). Giữ phạm vi hẹp trong các kênh bận rộn để kiểm soát mức tiêu thụ token và API.",
  "Scoped SSRF policy overrides for web_fetch. Keep this narrow and opt in only for known local-network proxy environments.":
    "Ghi đè chính sách SSRF theo phạm vi cho web_fetch. Giữ cấu hình này ở phạm vi hẹp và chỉ chọn tham gia trong các môi trường proxy mạng cục bộ đã biết.",
  "Search provider id. Auto-detected from available API keys if omitted.":
    "ID nhà cung cấp tìm kiếm. Tự động phát hiện từ các API key khả dụng nếu bị bỏ qua.",
  'Select the active memory plugin by id, or "none" to disable memory plugins.':
    'Chọn plugin bộ nhớ đang hoạt động theo id, hoặc "none" để tắt các plugin bộ nhớ.',
  'Selects execution target strategy for shell commands. Use "auto" for runtime-aware behavior (sandbox when available, otherwise gateway), or pin sandbox/gateway/node explicitly when you need a fixed surface.':
    'Chọn chiến lược đích thực thi cho các lệnh shell. Dùng "auto" để có hành vi nhận biết runtime (sandbox khi khả dụng, nếu không thì gateway), hoặc cố định rõ sandbox/gateway/node khi bạn cần một bề mặt cố định.',
  'Selects provider auth style: "api-key" for API key auth, "token" for bearer token auth, "oauth" for OAuth credentials, and "aws-sdk" for AWS credential resolution. Match this to your provider requirements.':
    'Chọn kiểu xác thực nhà cung cấp: "api-key" cho xác thực bằng API key, "token" cho xác thực bearer token, "oauth" cho thông tin xác thực OAuth, và "aws-sdk" cho phân giải thông tin xác thực AWS. Hãy khớp tùy chọn này với yêu cầu của nhà cung cấp.',
  'Selects reset strategy: "daily" resets at a configured hour and "idle" resets after inactivity windows. Keep one clear mode per policy to avoid surprising context turnover patterns.':
    'Chọn chiến lược đặt lại: "daily" đặt lại vào một giờ đã cấu hình và "idle" đặt lại sau các khoảng không hoạt động. Giữ một chế độ rõ ràng cho mỗi chính sách để tránh các kiểu thay đổi ngữ cảnh gây bất ngờ.',
  "Selects the active context engine plugin by id so one plugin provides context orchestration behavior.":
    "Chọn plugin công cụ ngữ cảnh đang hoạt động theo id để một plugin cung cấp hành vi điều phối ngữ cảnh.",
  'Selects the embedding backend used to build/query memory vectors: "openai", "gemini", "voyage", "mistral", "bedrock", "ollama", or "local". Keep your most reliable provider here and configure fallback for resilience.':
    'Chọn backend embedding dùng để xây dựng/truy vấn vector bộ nhớ: "openai", "gemini", "voyage", "mistral", "bedrock", "ollama", hoặc "local". Hãy dùng nhà cung cấp đáng tin cậy nhất của bạn ở đây và cấu hình phương án dự phòng để tăng khả năng phục hồi.',
  'Selects the global memory engine: "builtin" uses OpenClaw memory internals, while "qmd" uses the QMD sidecar pipeline. Keep "builtin" unless you intentionally operate QMD.':
    'Chọn công cụ bộ nhớ toàn cục: "builtin" dùng các thành phần bộ nhớ nội bộ của OpenClaw, còn "qmd" dùng pipeline sidecar QMD. Giữ "builtin" trừ khi bạn chủ ý vận hành QMD.',
  'Selects the QMD retrieval path: "query" uses standard query flow, "search" uses search-oriented retrieval, and "vsearch" emphasizes vector retrieval. Keep default unless tuning relevance quality.':
    'Chọn đường dẫn truy xuất QMD: "query" dùng luồng truy vấn tiêu chuẩn, "search" dùng truy xuất theo định hướng tìm kiếm, và "vsearch" nhấn mạnh truy xuất vector. Giữ mặc định trừ khi đang tinh chỉnh chất lượng liên quan.',
  'Selects which multimodal file types are indexed from extraPaths: "image", "audio", or "all". Keep this narrow to avoid indexing large binary corpora unintentionally.':
    'Chọn các loại tệp đa phương thức được lập chỉ mục từ extraPaths: "image", "audio", hoặc "all". Giữ phạm vi này hẹp để tránh vô tình lập chỉ mục các tập dữ liệu nhị phân lớn.',
  "Selects which plugins own exclusive runtime slots such as memory so only one plugin provides that capability. Use explicit slot ownership to avoid overlapping providers with conflicting behavior.":
    "Chọn plugin nào sở hữu các slot runtime độc quyền như bộ nhớ để chỉ một plugin cung cấp khả năng đó. Dùng quyền sở hữu slot tường minh để tránh các nhà cung cấp chồng lấn với hành vi xung đột.",
  "Sender allow rules for elevated tools, usually keyed by channel/provider identity formats. Use narrow, explicit identities so elevated commands cannot be triggered by unintended users.":
    "Quy tắc cho phép người gửi cho các công cụ nâng quyền, thường được khóa theo định dạng danh tính kênh/nhà cung cấp. Hãy dùng các danh tính hẹp, tường minh để các lệnh nâng quyền không thể bị kích hoạt bởi người dùng ngoài ý muốn.",
  "Sensitive Data Redaction Mode": "Chế độ Che giấu Dữ liệu Nhạy cảm",
  'Sensitive redaction mode: "off" disables built-in masking, while "tools" redacts sensitive tool/config payload fields. Keep "tools" in shared logs unless you have isolated secure log sinks.':
    'Chế độ che giấu dữ liệu nhạy cảm: "off" tắt cơ chế che giấu tích hợp, còn "tools" che giấu các trường tải trọng công cụ/cấu hình nhạy cảm. Giữ "tools" trong nhật ký dùng chung trừ khi bạn có các đích nhật ký an toàn, tách biệt.',
  "Separator inserted before next visible assistant text when hidden ACP tool lifecycle events occurred (none|space|newline|paragraph). Default: paragraph.":
    "Dấu phân cách được chèn trước văn bản trợ lý hiển thị tiếp theo khi đã xảy ra các sự kiện vòng đời công cụ ACP bị ẩn (none|space|newline|paragraph). Mặc định: paragraph.",
  "Server-side request forgery guardrail settings for browser/network fetch paths that could reach internal hosts. Keep restrictive defaults in production and open only explicitly approved targets.":
    "Thiết lập hàng rào bảo vệ chống giả mạo yêu cầu phía máy chủ cho các đường dẫn fetch trình duyệt/mạng có thể truy cập các máy chủ nội bộ. Giữ mặc định hạn chế trong môi trường production và chỉ mở cho các đích đã được phê duyệt rõ ràng.",
  "Service discovery settings for local mDNS advertisement and optional wide-area presence signaling. Keep discovery scoped to expected networks to avoid leaking service metadata.":
    "Thiết lập khám phá dịch vụ cho quảng bá mDNS cục bộ và tín hiệu hiện diện diện rộng tùy chọn. Giữ phạm vi khám phá trong các mạng dự kiến để tránh làm lộ siêu dữ liệu dịch vụ.",
  "Service name reported in telemetry resource attributes to identify this gateway instance in observability backends. Use stable names so dashboards and alerts remain consistent over deployments.":
    "Tên dịch vụ được báo cáo trong các thuộc tính tài nguyên telemetry để nhận diện phiên bản gateway này trong các backend quan sát. Dùng tên ổn định để dashboard và cảnh báo duy trì nhất quán qua các lần triển khai.",
  Session: "Phiên",
  "Session Agent-to-Agent": "Phiên tác nhân-tới-tác nhân",
  "Session Daily Reset Hour": "Giờ đặt lại hằng ngày của phiên",
  "Session Delta Bytes": "Byte delta của phiên",
  "Session Delta Messages": "Tin nhắn delta của phiên",
  "Session Disk High-water Target": "Mục tiêu ngưỡng cao dung lượng đĩa của phiên",
  "Session Identity Links": "Liên kết danh tính phiên",
  "Session Idle Minutes": "Số phút nhàn rỗi của phiên",
  "Session Main Key": "Khóa chính của phiên",
  "Session Maintenance": "Bảo trì phiên",
  "Session Maintenance Mode": "Chế độ bảo trì phiên",
  "Session Max Disk Budget": "Ngân sách đĩa tối đa của phiên",
  "Session Max Entries": "Số mục tối đa của phiên",
  "Session Parent Fork Max Tokens": "Số token tối đa của nhánh fork cha của phiên",
  "Session Prune After": "Cắt tỉa phiên sau",
  "Session Prune Days (Deprecated)": "Số ngày cắt tỉa phiên (Không còn dùng)",
  "Session Reset (Direct)": "Đặt lại phiên (Trực tiếp)",
  "Session Reset (DM Deprecated Alias)": "Đặt lại phiên (Bí danh DM không còn dùng)",
  "Session Reset (Group)": "Đặt lại phiên (Nhóm)",
  "Session Reset (Thread)": "Đặt lại phiên (Chuỗi)",
  "Session Reset Archive Retention": "Thời gian lưu trữ bản lưu trữ đặt lại phiên",
  "Session Reset by Channel": "Đặt lại phiên theo kênh",
  "Session Reset by Chat Type": "Đặt lại phiên theo loại chat",
  "Session Reset Idle Minutes": "Số phút nhàn rỗi để đặt lại phiên",
  "Session Reset Mode": "Chế độ đặt lại phiên",
  "Session Reset Policy": "Chính sách đặt lại phiên",
  "Session Reset Triggers": "Trình kích hoạt đặt lại phiên",
  "Session Rotate Size": "Kích thước xoay vòng phiên",
  "Session Scope": "Phạm vi phiên",
  "Session Send Policy": "Chính sách gửi phiên",
  "Session Send Policy Default Action": "Hành động mặc định của chính sách gửi phiên",
  "Session Send Policy Rules": "Quy tắc chính sách gửi phiên",
  "Session Send Rule Action": "Hành động của quy tắc gửi phiên",
  "Session Send Rule Channel": "Kênh của quy tắc gửi phiên",
  "Session Send Rule Chat Type": "Loại chat của quy tắc gửi phiên",
  "Session Send Rule Key Prefix": "Tiền tố khóa của quy tắc gửi phiên",
  "Session Send Rule Match": "Điều kiện khớp của quy tắc gửi phiên",
  "Session Send Rule Raw Key Prefix": "Tiền tố khóa thô của quy tắc gửi phiên",
  "Session Store Path": "Đường dẫn lưu trữ phiên",
  "Session Thread Bindings": "Liên kết luồng phiên",
  "Session Tools Visibility": "Hiển thị công cụ của phiên",
  "Session Typing Interval (seconds)": "Khoảng thời gian gõ của phiên (giây)",
  "Session Typing Mode": "Chế độ gõ của phiên",
  "Sets a best-effort upper bound on cached embeddings kept in SQLite for memory search. Use this when controlling disk growth matters more than peak reindex speed.":
    "Đặt giới hạn trên theo nỗ lực tốt nhất cho các embedding được lưu trong bộ nhớ đệm trong SQLite để tìm kiếm bộ nhớ. Dùng tùy chọn này khi việc kiểm soát tăng trưởng dung lượng đĩa quan trọng hơn tốc độ lập chỉ mục lại tối đa.",
  "Sets a stable collection name for an indexed path instead of deriving it from filesystem location. Use this when paths vary across machines but you want consistent collection identity.":
    "Đặt tên bộ sưu tập ổn định cho một đường dẫn đã được lập chỉ mục thay vì suy ra từ vị trí hệ thống tệp. Dùng tùy chọn này khi đường dẫn khác nhau giữa các máy nhưng bạn muốn danh tính bộ sưu tập nhất quán.",
  'Sets base session grouping strategy: "per-sender" isolates by sender and "global" shares one session per channel context. Keep "per-sender" for safer multi-user behavior unless deliberate shared context is required.':
    'Đặt chiến lược nhóm phiên cơ sở: "per-sender" tách biệt theo người gửi và "global" chia sẻ một phiên cho mỗi ngữ cảnh kênh. Giữ "per-sender" để có hành vi an toàn hơn trong môi trường nhiều người dùng, trừ khi cần chủ đích dùng ngữ cảnh chia sẻ.',
  'Sets fallback action when no sendPolicy rule matches: "allow" or "deny". Keep "allow" for simpler setups, or choose "deny" when you require explicit allow rules for every destination.':
    'Đặt hành động dự phòng khi không có quy tắc sendPolicy nào khớp: "allow" hoặc "deny". Giữ "allow" cho các thiết lập đơn giản hơn, hoặc chọn "deny" khi bạn yêu cầu các quy tắc cho phép rõ ràng cho mọi đích đến.',
  "Sets how often QMD recomputes embeddings (duration string, default: 60m; set 0 to disable periodic embeds). Lower intervals improve freshness but increase embedding workload and cost.":
    "Đặt tần suất QMD tính toán lại embedding (chuỗi thời lượng, mặc định: 60m; đặt 0 để tắt embedding định kỳ). Khoảng thời gian ngắn hơn cải thiện độ mới nhưng làm tăng khối lượng công việc embedding và chi phí.",
  "Sets how often QMD refreshes indexes from source content (duration string, default: 5m). Shorter intervals improve freshness but increase background CPU and I/O.":
    "Đặt tần suất QMD làm mới chỉ mục từ nội dung nguồn (chuỗi thời lượng, mặc định: 5m). Khoảng thời gian ngắn hơn cải thiện độ mới nhưng làm tăng CPU nền và I/O.",
  "Sets inactivity window before reset for idle mode and can also act as secondary guard with daily mode. Use larger values to preserve continuity or smaller values for fresher short-lived threads.":
    "Đặt khoảng thời gian không hoạt động trước khi đặt lại cho chế độ nhàn rỗi và cũng có thể đóng vai trò là lớp bảo vệ phụ với chế độ hằng ngày. Dùng giá trị lớn hơn để duy trì tính liên tục hoặc giá trị nhỏ hơn để có các luồng ngắn hạn mới hơn.",
  "Sets local-hour boundary (0-23) for daily reset mode so sessions roll over at predictable times. Use with mode=daily and align to operator timezone expectations for human-readable behavior.":
    "Đặt mốc giờ cục bộ (0-23) cho chế độ đặt lại hằng ngày để các phiên chuyển sang ngày mới vào thời điểm có thể dự đoán. Dùng với mode=daily và căn theo kỳ vọng múi giờ của người vận hành để có hành vi dễ hiểu với con người.",
  "Sets maximum runtime for each `qmd embed` cycle in milliseconds (default: 120000). Increase for heavier embedding workloads or slower hardware, and lower to fail fast under tight SLAs.":
    "Đặt thời gian chạy tối đa cho mỗi chu kỳ `qmd embed` tính bằng mili giây (mặc định: 120000). Tăng lên cho khối lượng embedding nặng hơn hoặc phần cứng chậm hơn, và giảm xuống để lỗi nhanh trong các SLA chặt chẽ.",
  "Sets maximum runtime for each `qmd update` cycle in milliseconds (default: 120000). Raise this for larger collections; lower it when you want quicker failure detection in automation.":
    "Đặt thời gian chạy tối đa cho mỗi chu kỳ `qmd update` tính bằng mili giây (mặc định: 120000). Tăng giá trị này cho các bộ sưu tập lớn hơn; giảm xuống khi bạn muốn phát hiện lỗi nhanh hơn trong tự động hóa.",
  "Sets MMR relevance-vs-diversity balance (0 = most diverse, 1 = most relevant, default: 0.7). Lower values reduce repetition; higher values keep tightly relevant but may duplicate.":
    "Đặt mức cân bằng MMR giữa độ liên quan và độ đa dạng (0 = đa dạng nhất, 1 = liên quan nhất, mặc định: 0.7). Giá trị thấp hơn giúp giảm lặp lại; giá trị cao hơn giữ mức liên quan chặt chẽ nhưng có thể bị trùng lặp.",
  "Sets per-query QMD search timeout in milliseconds (default: 4000). Increase for larger indexes or slower environments, and lower to keep request latency bounded.":
    "Đặt thời gian chờ tìm kiếm QMD cho mỗi truy vấn tính bằng mili giây (mặc định: 4000). Tăng lên cho chỉ mục lớn hơn hoặc môi trường chậm hơn, và giảm xuống để giữ độ trễ yêu cầu trong giới hạn.",
  "Sets the executable path for the `qmd` binary used by the QMD backend (default: resolved from PATH). Use an explicit absolute path when multiple qmd installs exist or PATH differs across environments.":
    "Đặt đường dẫn thực thi cho tệp nhị phân `qmd` được backend QMD sử dụng (mặc định: phân giải từ PATH). Dùng đường dẫn tuyệt đối tường minh khi có nhiều bản cài qmd hoặc PATH khác nhau giữa các môi trường.",
  "Sets the maximum bytes allowed per multimodal file before it is skipped during memory indexing. Use this to cap upload cost and indexing latency, or raise it for short high-quality audio clips.":
    "Đặt số byte tối đa được phép cho mỗi tệp đa phương thức trước khi bị bỏ qua trong quá trình lập chỉ mục bộ nhớ. Dùng mục này để giới hạn chi phí tải lên và độ trễ lập chỉ mục, hoặc tăng lên cho các đoạn âm thanh ngắn chất lượng cao.",
  "Sets the maximum wait time for a full embedding batch operation in minutes (default: 60). Increase for very large corpora or slower providers, and lower it to fail fast in automation-heavy flows.":
    "Đặt thời gian chờ tối đa cho một thao tác batch embedding đầy đủ tính bằng phút (mặc định: 60). Tăng lên cho kho dữ liệu rất lớn hoặc nhà cung cấp chậm hơn, và giảm xuống để lỗi nhanh trong các luồng tự động hóa nặng.",
  "Sets the minimum delay between consecutive QMD refresh attempts in milliseconds (default: 15000). Increase this if frequent file changes cause update thrash or unnecessary background load.":
    "Đặt độ trễ tối thiểu giữa các lần thử làm mới QMD liên tiếp tính bằng mili giây (mặc định: 15000). Tăng giá trị này nếu thay đổi tệp thường xuyên gây cập nhật dồn dập hoặc tải nền không cần thiết.",
  "Sets the session storage file path used to persist session records across restarts. Use an explicit path only when you need custom disk layout, backup routing, or mounted-volume storage.":
    "Đặt đường dẫn tệp lưu trữ phiên dùng để duy trì bản ghi phiên qua các lần khởi động lại. Chỉ dùng đường dẫn tường minh khi bạn cần bố cục đĩa tùy chỉnh, định tuyến sao lưu hoặc lưu trữ trên mounted-volume.",
  "Sets timeout for QMD maintenance commands such as collection list/add in milliseconds (default: 30000). Increase when running on slower disks or remote filesystems that delay command completion.":
    "Đặt thời gian chờ cho các lệnh bảo trì QMD như collection list/add tính bằng mili giây (mặc định: 30000). Tăng lên khi chạy trên đĩa chậm hoặc hệ thống tệp từ xa làm chậm việc hoàn tất lệnh.",
  "Sets where the SQLite memory index is stored on disk for each agent. Keep the default `~/.openclaw/memory/{agentId}.sqlite` unless you need custom storage placement or backup policy alignment.":
    "Đặt vị trí lưu trữ chỉ mục bộ nhớ SQLite trên đĩa cho mỗi tác nhân. Giữ mặc định `~/.openclaw/memory/{agentId}.sqlite` trừ khi bạn cần vị trí lưu trữ tùy chỉnh hoặc căn chỉnh với chính sách sao lưu.",
  "Setup Wizard State": "Trạng thái trình thiết lập",
  "Setup wizard state tracking fields that record the most recent guided setup run details. Keep these fields for observability and troubleshooting of setup flows across upgrades.":
    "Các trường theo dõi trạng thái trình hướng dẫn thiết lập ghi lại chi tiết lần chạy thiết lập có hướng dẫn gần nhất. Giữ các trường này để phục vụ khả năng quan sát và khắc phục sự cố của các luồng thiết lập qua các lần nâng cấp.",
  "Shared bearer token checked by hooks ingress for request authentication before mappings run. Treat holders as full-trust callers for the hook ingress surface, not as a separate non-owner role. Use environment substitution and rotate regularly when webhook endpoints are internet-accessible.":
    "Bearer token dùng chung được hooks ingress kiểm tra để xác thực yêu cầu trước khi chạy mappings. Xem những người nắm giữ token này là bên gọi có toàn quyền tin cậy đối với bề mặt hook ingress, không phải là một vai trò không phải chủ sở hữu riêng biệt. Dùng thay thế biến môi trường và xoay vòng thường xuyên khi các endpoint webhook có thể truy cập từ internet.",
  "Shared default settings inherited by agents unless overridden per entry in agents.list. Use defaults to enforce consistent baseline behavior and reduce duplicated per-agent configuration.":
    "Cài đặt mặc định dùng chung được các tác nhân kế thừa trừ khi bị ghi đè theo từng mục trong agents.list. Dùng các giá trị mặc định để áp dụng hành vi nền tảng nhất quán và giảm cấu hình lặp lại cho từng tác nhân.",
  "Shared defaults for thread-bound session routing behavior across providers that support thread focus workflows. Configure global defaults here and override per channel only when behavior differs.":
    "Các giá trị mặc định dùng chung cho hành vi định tuyến phiên gắn với luồng trên các nhà cung cấp hỗ trợ quy trình tập trung theo luồng. Cấu hình mặc định toàn cục tại đây và chỉ ghi đè theo từng kênh khi hành vi khác nhau.",
  "Shared fallback model list used by media understanding tools when modality-specific model lists are not set. Keep this aligned with available multimodal providers to avoid runtime fallback churn.":
    "Danh sách model dự phòng dùng chung được các công cụ hiểu phương tiện sử dụng khi chưa đặt danh sách model theo từng modality. Giữ mục này đồng bộ với các nhà cung cấp đa phương thức hiện có để tránh chuyển đổi dự phòng liên tục khi chạy.",
  "Shared secret token required on Gmail push hook callbacks before processing notifications. Use env substitution and rotate if callback endpoints are exposed externally.":
    "Secret token dùng chung bắt buộc trên các callback Gmail push hook trước khi xử lý thông báo. Dùng thay thế biến môi trường và xoay vòng nếu các endpoint callback được công khai ra bên ngoài.",
  "Shell Environment Import": "Nhập môi trường Shell",
  "Shell environment import controls for loading variables from your login shell during startup. Keep this enabled when you depend on profile-defined secrets or PATH customizations.":
    "Các tùy chọn nhập môi trường shell để tải biến từ login shell của bạn trong lúc khởi động. Giữ bật mục này khi bạn phụ thuộc vào secret được định nghĩa trong profile hoặc các tùy chỉnh PATH.",
  "Shell Environment Import Enabled": "Bật nhập môi trường Shell",
  "Shell Environment Import Timeout (ms)": "Thời gian chờ nhập môi trường shell (ms)",
  "Shows degraded/error heartbeat alerts when true so operator channels surface problems promptly. Keep enabled in production so broken channel states are visible.":
    "Hiển thị cảnh báo heartbeat suy giảm/lỗi khi bật để các kênh vận hành nhanh chóng hiển thị sự cố. Hãy giữ bật trong môi trường production để các trạng thái kênh bị lỗi luôn hiển thị.",
  "Shows healthy/OK heartbeat status entries when true in channel status outputs. Keep false in noisy environments and enable only when operators need explicit healthy confirmations.":
    "Hiển thị các mục trạng thái heartbeat khỏe mạnh/OK khi bật trong đầu ra trạng thái kênh. Hãy giữ tắt trong môi trường nhiều nhiễu và chỉ bật khi người vận hành cần xác nhận trạng thái khỏe mạnh một cách rõ ràng.",
  Skills: "Kỹ năng",
  "Skills Watch Debounce (ms)": "Độ trễ chống dội theo dõi Skills (ms)",
  "Skips proxy TLS certificate verification. Use only for controlled development environments.":
    "Bỏ qua xác minh chứng chỉ TLS của proxy. Chỉ dùng cho môi trường phát triển được kiểm soát.",
  "Skips upstream TLS certificate verification. Use only for controlled development environments.":
    "Bỏ qua xác minh chứng chỉ TLS của upstream. Chỉ dùng cho môi trường phát triển được kiểm soát.",
  "Source commit identifier recorded for the last wizard execution in development builds. Use this to correlate setup behavior with exact source state during debugging.":
    "Mã định danh commit nguồn được ghi lại cho lần thực thi wizard gần nhất trong các bản dựng phát triển. Dùng mục này để đối chiếu hành vi thiết lập với trạng thái mã nguồn chính xác trong quá trình gỡ lỗi.",
  "Source match condition for a hook mapping, typically set by trusted upstream metadata or adapter logic. Use stable source identifiers so routing remains deterministic across retries.":
    "Điều kiện khớp nguồn cho một ánh xạ hook, thường được đặt bởi metadata upstream đáng tin cậy hoặc logic adapter. Hãy dùng mã định danh nguồn ổn định để việc định tuyến luôn xác định được qua các lần thử lại.",
  "Specifies the local embedding model source for local memory search, such as a GGUF file path or `hf:` URI. Use this only when provider is `local`, and verify model compatibility before large index rebuilds.":
    "Chỉ định nguồn mô hình embedding cục bộ cho tìm kiếm bộ nhớ cục bộ, chẳng hạn như đường dẫn tệp GGUF hoặc URI `hf:`. Chỉ dùng mục này khi provider là `local`, và hãy xác minh khả năng tương thích của mô hình trước khi xây dựng lại chỉ mục lớn.",
  "Starting local CDP port used for auto-allocated browser profile ports. Increase this when host-level port defaults conflict with other local services.":
    "Cổng CDP cục bộ bắt đầu được dùng cho các cổng hồ sơ trình duyệt được tự động cấp phát. Hãy tăng giá trị này khi các cổng mặc định ở cấp máy chủ xung đột với các dịch vụ cục bộ khác.",
  "Static HTTP headers merged into provider requests for tenant routing, proxy auth, or custom gateway requirements. Use this sparingly and keep sensitive header values in secrets.":
    "Các HTTP header tĩnh được hợp nhất vào yêu cầu của provider để định tuyến tenant, xác thực proxy hoặc đáp ứng yêu cầu Gateway tùy chỉnh. Chỉ nên dùng hạn chế và lưu các giá trị header nhạy cảm trong secrets.",
  "Status Reaction Emojis": "Emoji phản ứng trạng thái",
  "Status Reaction Timing": "Thời điểm phản ứng trạng thái",
  "Status Reactions": "Phản ứng trạng thái",
  "Strict Transport Security Header": "Header Strict Transport Security",
  "Stuck Session Warning Threshold (ms)": "Ngưỡng cảnh báo phiên bị kẹt (ms)",
  "Subagent Tool Allow/Deny Policy": "Chính sách cho phép/từ chối công cụ của tác nhân phụ",
  "Subagent Tool Policy": "Chính sách công cụ của tác nhân phụ",
  "Supplies a dedicated API key for remote embedding calls used by memory indexing and query-time embeddings. Use this when memory embeddings should use different credentials than global defaults or environment variables.":
    "Cung cấp API key chuyên dụng cho các lệnh gọi embedding từ xa dùng cho lập chỉ mục bộ nhớ và embedding tại thời điểm truy vấn. Dùng mục này khi embedding bộ nhớ cần dùng thông tin xác thực khác với mặc định toàn cục hoặc biến môi trường.",
  "Suppress tool error warning payloads during heartbeat runs.":
    "Ẩn payload cảnh báo lỗi công cụ trong các lần chạy heartbeat.",
  "Suppress Tool Error Warnings": "Ẩn cảnh báo lỗi công cụ",
  "System-prompt override for the pre-compaction memory flush turn to control extraction style and safety constraints. Use carefully so custom instructions do not reduce memory quality or leak sensitive context.":
    "Ghi đè system-prompt cho lượt flush bộ nhớ trước khi compaction để kiểm soát kiểu trích xuất và các ràng buộc an toàn. Hãy dùng cẩn thận để các chỉ dẫn tùy chỉnh không làm giảm chất lượng bộ nhớ hoặc làm lộ ngữ cảnh nhạy cảm.",
  "Tailscale exposure configuration block for publishing Gmail callbacks through Serve/Funnel routes. Use private tailnet modes before enabling any public ingress path.":
    "Khối cấu hình phơi bày Tailscale để xuất bản callback Gmail thông qua các tuyến Serve/Funnel. Hãy dùng các chế độ tailnet riêng tư trước khi bật bất kỳ đường ingress công khai nào.",
  'Tailscale exposure mode for Gmail callbacks: "off", "serve", or "funnel". Use "serve" for private tailnet delivery and "funnel" only when public internet ingress is required.':
    'Chế độ phơi bày Tailscale cho callback Gmail: "off", "serve" hoặc "funnel". Dùng "serve" để phân phối riêng tư trong tailnet và chỉ dùng "funnel" khi cần ingress từ internet công cộng.',
  "Tailscale integration settings for Serve/Funnel exposure and lifecycle handling on gateway start/exit. Keep off unless your deployment intentionally relies on Tailscale ingress.":
    "Cài đặt tích hợp Tailscale cho việc hiển thị Serve/Funnel và xử lý vòng đời khi Gateway khởi động/thoát. Giữ tắt trừ khi triển khai của bạn chủ ý dựa vào ingress của Tailscale.",
  'Tailscale publish mode: "off", "serve", or "funnel" for private or public exposure paths. Use "serve" for tailnet-only access and "funnel" only when public internet reachability is required.':
    'Chế độ xuất bản Tailscale: "off", "serve" hoặc "funnel" cho các đường hiển thị riêng tư hoặc công khai. Dùng "serve" cho truy cập chỉ trong tailnet và chỉ dùng "funnel" khi cần khả năng truy cập từ internet công cộng.',
  Talk: "Thoại",
  "Talk Active Provider": "Nhà cung cấp hoạt động cho thoại",
  "Talk Interrupt on Speech": "Ngắt thoại khi phát hiện lời nói",
  "Talk Provider API Key": "API Key của nhà cung cấp thoại",
  "Talk Provider Config": "Cấu hình nhà cung cấp thoại",
  "Talk Provider Settings": "Cài đặt nhà cung cấp thoại",
  "Talk Silence Timeout (ms)": "Thời gian chờ im lặng của thoại (ms)",
  "Talk-mode voice synthesis settings for voice identity, model selection, output format, and interruption behavior. Use this section to tune human-facing voice UX while controlling latency and cost.":
    "Cài đặt tổng hợp giọng nói cho chế độ thoại về danh tính giọng nói, lựa chọn mô hình, định dạng đầu ra và hành vi ngắt. Dùng phần này để tinh chỉnh UX giọng nói hướng tới người dùng đồng thời kiểm soát độ trễ và chi phí.",
  "Target agent ID for mapping execution when action routing should not use defaults. Use dedicated automation agents to isolate webhook behavior from interactive operator sessions.":
    "ID tác nhân đích để ánh xạ thực thi khi định tuyến hành động không nên dùng mặc định. Dùng các tác nhân tự động hóa chuyên dụng để tách biệt hành vi webhook khỏi các phiên vận hành tương tác.",
  "Target agent ID that receives traffic when the corresponding binding match rule is satisfied. Use valid configured agent IDs only so routing does not fail at runtime.":
    "ID tác nhân đích nhận lưu lượng khi quy tắc khớp binding tương ứng được thỏa mãn. Chỉ dùng các ID tác nhân đã được cấu hình hợp lệ để việc định tuyến không bị lỗi khi chạy.",
  "Target size after disk-budget cleanup (high-water mark). Defaults to 80% of maxDiskBytes; set explicitly for tighter reclaim behavior on constrained disks.":
    "Kích thước mục tiêu sau khi dọn dẹp theo ngân sách đĩa (mốc high-water). Mặc định là 80% của maxDiskBytes; đặt rõ ràng để thu hồi chặt chẽ hơn trên các đĩa bị giới hạn.",
  "TCP port used by the canvas host HTTP server when canvas hosting is enabled. Choose a non-conflicting port and align firewall/proxy policy accordingly.":
    "Cổng TCP được máy chủ HTTP của canvas host sử dụng khi bật lưu trữ canvas. Chọn cổng không xung đột và điều chỉnh chính sách tường lửa/proxy cho phù hợp.",
  "TCP port used by the gateway listener for API, control UI, and channel-facing ingress paths. Use a dedicated port and avoid collisions with reverse proxies or local developer services.":
    "Cổng TCP được listener của Gateway sử dụng cho API, Control UI và các đường ingress hướng kênh. Dùng cổng chuyên dụng và tránh xung đột với reverse proxy hoặc dịch vụ phát triển cục bộ.",
  "Template for synthesizing structured mapping input into the final message content sent to the target action path. Keep templates deterministic so downstream parsing and behavior remain stable.":
    "Mẫu để tổng hợp đầu vào ánh xạ có cấu trúc thành nội dung thông điệp cuối cùng được gửi tới đường hành động đích. Giữ mẫu có tính xác định để việc phân tích và hành vi ở phía sau luôn ổn định.",
  "Text Commands": "Lệnh văn bản",
  'Text prefix for cross-context markers (supports "{channel}").':
    'Tiền tố văn bản cho các dấu mốc liên ngữ cảnh (hỗ trợ "{channel}").',
  'Text suffix for cross-context markers (supports "{channel}").':
    'Hậu tố văn bản cho các dấu mốc liên ngữ cảnh (hỗ trợ "{channel}").',
  "Text-only fallback template used when rich payload rendering is not desired or not supported. Use this to provide a concise, consistent summary string for chat delivery surfaces.":
    "Mẫu dự phòng chỉ văn bản dùng khi không muốn hoặc không hỗ trợ hiển thị payload phong phú. Dùng mục này để cung cấp chuỗi tóm tắt ngắn gọn, nhất quán cho các bề mặt gửi chat.",
  "Text-to-speech policy for reading agent replies aloud on supported voice or audio surfaces. Keep disabled unless voice playback is part of your operator/user workflow.":
    "Chính sách chuyển văn bản thành giọng nói để đọc to phản hồi của tác nhân trên các bề mặt thoại hoặc âm thanh được hỗ trợ. Giữ tắt trừ khi phát lại bằng giọng nói là một phần trong quy trình của người vận hành/người dùng.",
  'Thinking effort override for Gmail-driven agent runs: "off", "minimal", "low", "medium", or "high". Keep modest defaults for routine inbox automations to control cost and latency.':
    'Ghi đè mức độ suy luận cho các lần chạy tác nhân do Gmail kích hoạt: "off", "minimal", "low", "medium" hoặc "high". Giữ mặc định ở mức vừa phải cho các tự động hóa hộp thư thông thường để kiểm soát chi phí và độ trễ.',
  "Thread Binding Enabled": "Bật liên kết luồng",
  "Thread Binding Idle Timeout (hours)": "Thời gian chờ không hoạt động của liên kết luồng (giờ)",
  "Thread Binding Max Age (hours)": "Tuổi tối đa của liên kết luồng (giờ)",
  "Threshold distance to compaction (in tokens) that triggers pre-compaction memory flush execution. Use earlier thresholds for safer persistence, or tighter thresholds for lower flush frequency.":
    "Khoảng cách ngưỡng đến compaction (tính bằng token) kích hoạt việc xả bộ nhớ trước compaction. Dùng ngưỡng sớm hơn để lưu bền an toàn hơn, hoặc ngưỡng chặt hơn để giảm tần suất xả.",
  "Timeout in milliseconds for `image_url` URL fetches (default: 10000).":
    "Thời gian chờ tính bằng mili giây cho các lần tải URL `image_url` (mặc định: 10000).",
  "Timeout in milliseconds for connecting to a remote CDP endpoint before failing the browser attach attempt. Increase for high-latency tunnels, or lower for faster failure detection.":
    "Thời gian chờ tính bằng mili giây để kết nối tới một endpoint CDP từ xa trước khi đánh dấu thất bại cho lần thử gắn trình duyệt. Tăng giá trị này cho các tunnel có độ trễ cao, hoặc giảm để phát hiện lỗi nhanh hơn.",
  "Timeout in milliseconds for post-connect CDP handshake readiness checks against remote browser targets. Raise this for slow-start remote browsers and lower to fail fast in automation loops.":
    "Thời gian chờ tính bằng mili giây cho các kiểm tra sẵn sàng bắt tay CDP sau khi kết nối với các đích trình duyệt từ xa. Tăng giá trị này cho các trình duyệt từ xa khởi động chậm và giảm để thất bại nhanh trong các vòng lặp tự động hóa.",
  "Timeout in milliseconds for relay send requests from the gateway to the APNs relay (default: 10000). Increase for slower relays or networks, or lower to fail wake attempts faster.":
    "Thời gian chờ tính bằng mili giây cho các yêu cầu gửi relay từ gateway tới APNs relay (mặc định: 10000). Tăng cho relay hoặc mạng chậm hơn, hoặc giảm để các lần thử đánh thức thất bại nhanh hơn.",
  "Timeout in seconds for audio understanding execution before the operation is cancelled. Use longer timeouts for long recordings and tighter ones for interactive chat responsiveness.":
    "Thời gian chờ tính bằng giây cho việc thực thi hiểu âm thanh trước khi thao tác bị hủy. Dùng thời gian chờ dài hơn cho bản ghi dài và ngắn hơn để tăng độ phản hồi cho trò chuyện tương tác.",
  "Timeout in seconds for each image understanding request before it is aborted. Increase for high-resolution analysis and lower it for latency-sensitive operator workflows.":
    "Thời gian chờ tính bằng giây cho mỗi yêu cầu hiểu hình ảnh trước khi bị hủy bỏ. Tăng cho phân tích độ phân giải cao và giảm cho các quy trình vận hành nhạy cảm với độ trễ.",
  "Timeout in seconds for each video understanding request before cancellation. Use conservative values in interactive channels and longer values for offline or batch-heavy processing.":
    "Thời gian chờ tính bằng giây cho mỗi yêu cầu hiểu video trước khi bị hủy. Dùng giá trị thận trọng trong các kênh tương tác và giá trị dài hơn cho xử lý ngoại tuyến hoặc xử lý hàng loạt nặng.",
  "Timeout in seconds for web_fetch requests.":
    "Thời gian chờ tính bằng giây cho các yêu cầu web_fetch.",
  "Timeout in seconds for web_search requests.":
    "Thời gian chờ tính bằng giây cho các yêu cầu web_search.",
  'Timezone for message envelopes ("utc", "local", "user", or an IANA timezone string).':
    'Múi giờ cho phong bì tin nhắn ("utc", "local", "user", hoặc một chuỗi múi giờ IANA).',
  "TLS certificate and key settings for terminating HTTPS directly in the gateway process. Use explicit certificates in production and avoid plaintext exposure on untrusted networks.":
    "Cài đặt chứng chỉ và khóa TLS để kết thúc HTTPS trực tiếp trong tiến trình gateway. Dùng chứng chỉ chỉ định rõ trong môi trường production và tránh để lộ plaintext trên các mạng không đáng tin cậy.",
  "TLS settings applied when connecting to the configured audio proxy, such as custom CA trust for an internal proxy gateway.":
    "Cài đặt TLS được áp dụng khi kết nối tới audio proxy đã cấu hình, chẳng hạn như CA tùy chỉnh để tin cậy một proxy gateway nội bộ.",
  "Token headroom reserved for reply generation and tool output after compaction runs. Use higher reserves for verbose/tool-heavy sessions, and lower reserves when maximizing retained history matters more.":
    "Phần token dự phòng dành cho việc tạo phản hồi và đầu ra công cụ sau khi compaction chạy. Dùng mức dự phòng cao hơn cho các phiên dài dòng/nhiều công cụ, và mức thấp hơn khi việc tối đa hóa lịch sử được giữ lại quan trọng hơn.",
  "Token overlap between adjacent memory chunks to preserve context continuity near split boundaries. Use modest overlap to reduce boundary misses without inflating index size too aggressively.":
    "Phần token chồng lấp giữa các khối bộ nhớ liền kề để duy trì tính liên tục ngữ cảnh gần ranh giới tách. Dùng mức chồng lấp vừa phải để giảm lỗi hụt ở ranh giới mà không làm tăng kích thước chỉ mục quá mức.",
  "Tool Allowlist": "Danh sách cho phép công cụ",
  "Tool Allowlist Additions": "Phần bổ sung danh sách cho phép công cụ",
  "Tool Denylist": "Danh sách từ chối công cụ",
  "Tool history window size for loop detection (default: 30).":
    "Kích thước cửa sổ lịch sử công cụ để phát hiện vòng lặp (mặc định: 30).",
  "Tool Policy by Provider": "Chính sách công cụ theo nhà cung cấp",
  "Tool policy wrapper for sandboxed agent executions so sandbox runs can have distinct capability boundaries. Use this to enforce stronger safety in sandbox contexts.":
    "Trình bao chính sách công cụ cho các lần thực thi tác nhân trong sandbox để các lần chạy sandbox có thể có ranh giới khả năng riêng biệt. Dùng mục này để áp dụng mức an toàn mạnh hơn trong ngữ cảnh sandbox.",
  "Tool policy wrapper for spawned subagents to restrict or expand tool availability compared to parent defaults. Use this to keep delegated agent capabilities scoped to task intent.":
    "Trình bao chính sách công cụ cho các tác nhân con được sinh ra để hạn chế hoặc mở rộng khả năng dùng công cụ so với mặc định của tác nhân cha. Dùng mục này để giữ cho khả năng của tác nhân được ủy quyền nằm trong phạm vi mục đích tác vụ.",
  "Tool Profile": "Hồ sơ công cụ",
  "Tool-loop Critical Threshold": "Ngưỡng nghiêm trọng của vòng lặp công cụ",
  "Tool-loop Detection": "Phát hiện vòng lặp công cụ",
  "Tool-loop Generic Repeat Detection": "Phát hiện lặp lại chung của vòng lặp công cụ",
  "Tool-loop Global Circuit Breaker Threshold": "Ngưỡng ngắt mạch toàn cục của vòng lặp công cụ",
  "Tool-loop History Size": "Kích thước lịch sử vòng lặp công cụ",
  "Tool-loop Ping-Pong Detection": "Phát hiện ping-pong của vòng lặp công cụ",
  "Tool-loop Poll No-Progress Detection":
    "Phát hiện không có tiến triển khi thăm dò của vòng lặp công cụ",
  "Tool-loop Warning Threshold": "Ngưỡng cảnh báo của vòng lặp công cụ",
  Tools: "Công cụ",
  "Top-level binding rules for routing and persistent ACP conversation ownership. Use type=route for normal routing and type=acp for persistent ACP harness bindings.":
    "Quy tắc liên kết cấp cao nhất cho định tuyến và quyền sở hữu cuộc hội thoại ACP liên tục. Dùng type=route cho định tuyến thông thường và type=acp cho các liên kết harness ACP liên tục.",
  "Top-level media behavior shared across providers and tools that handle inbound files. Keep defaults unless you need stable filenames for external processing pipelines or longer-lived inbound media retention.":
    "Hành vi media cấp cao nhất được chia sẻ giữa các nhà cung cấp và công cụ xử lý tệp đến. Giữ mặc định trừ khi bạn cần tên tệp ổn định cho các pipeline xử lý bên ngoài hoặc thời gian lưu giữ media đến lâu hơn.",
  "Trace sampling rate (0-1) controlling how much trace traffic is exported to observability backends. Lower rates reduce overhead/cost, while higher rates improve debugging fidelity.":
    "Tỷ lệ lấy mẫu trace (0-1) kiểm soát lượng lưu lượng trace được xuất tới các backend quan sát. Tỷ lệ thấp hơn giúp giảm chi phí/độ tải, trong khi tỷ lệ cao hơn cải thiện độ chính xác khi gỡ lỗi.",
  "Transcript Echo Format": "Định dạng echo bản ghi hội thoại",
  "Transform configuration block defining module/export preprocessing before mapping action handling. Use transforms only from reviewed code paths and keep behavior deterministic for repeatable automation.":
    "Khối cấu hình transform xác định tiền xử lý module/export trước khi ánh xạ xử lý hành động. Chỉ dùng transforms từ các đường dẫn mã đã được rà soát và giữ hành vi có tính xác định để tự động hóa có thể lặp lại.",
  "Triggers a memory index sync when a session starts so early turns see fresh memory content. Keep enabled when startup freshness matters more than initial turn latency.":
    "Kích hoạt đồng bộ chỉ mục bộ nhớ khi một phiên bắt đầu để các lượt đầu tiên thấy nội dung bộ nhớ mới nhất. Giữ bật khi độ mới lúc khởi động quan trọng hơn độ trễ của lượt đầu tiên.",
  "Truncate After Compaction": "Cắt bớt sau khi nén gọn",
  "Trusted-proxy auth header mapping for upstream identity providers that inject user claims. Use only with known proxy CIDRs and strict header allowlists to prevent spoofed identity headers.":
    "Ánh xạ header xác thực trusted-proxy cho các nhà cung cấp danh tính upstream chèn user claims. Chỉ dùng với các CIDR proxy đã biết và danh sách cho phép header nghiêm ngặt để ngăn giả mạo header danh tính.",
  "TTS Provider API Key": "Khóa API nhà cung cấp TTS",
  "TTS Provider Config": "Cấu hình nhà cung cấp TTS",
  "TTS Provider Settings": "Cài đặt nhà cung cấp TTS",
  UI: "Giao diện người dùng",
  "UI presentation settings for accenting and assistant identity shown in control surfaces. Use this for branding and readability customization without changing runtime behavior.":
    "Cài đặt trình bày UI cho việc tạo điểm nhấn và danh tính trợ lý hiển thị trong các bề mặt điều khiển. Dùng mục này để tùy chỉnh thương hiệu và khả năng đọc mà không thay đổi hành vi thời gian chạy.",
  "Update Channel": "Kênh cập nhật",
  'Update channel for git + npm installs ("stable", "beta", or "dev").':
    'Kênh cập nhật cho cài đặt git + npm ("stable", "beta", hoặc "dev").',
  "Update Check on Start": "Kiểm tra cập nhật khi khởi động",
  "Update-channel and startup-check behavior for keeping OpenClaw runtime versions current. Use conservative channels in production and more experimental channels only in controlled environments.":
    "Hành vi update-channel và startup-check để giữ cho các phiên bản runtime OpenClaw luôn được cập nhật. Sử dụng các kênh ổn định trong môi trường production và chỉ dùng các kênh thử nghiệm hơn trong môi trường được kiểm soát.",
  Updates: "Cập nhật",
  "Use a glob pattern to restrict which files inside the collection are indexed; keep the default `**/*.md` unless you need a narrower subset.":
    "Sử dụng mẫu glob để giới hạn những tệp nào bên trong bộ sưu tập được lập chỉ mục; giữ mặc định `**/*.md` trừ khi bạn cần một tập con hẹp hơn.",
  "Use Access Groups": "Sử dụng Nhóm truy cập",
  "Use an absolute or workspace-relative filesystem path for the extra QMD collection; keep it pointed at the transcript directory or note folder you actually want this agent to search.":
    "Sử dụng đường dẫn hệ thống tệp tuyệt đối hoặc tương đối theo workspace cho bộ sưu tập QMD bổ sung; giữ nó trỏ đến thư mục transcript hoặc thư mục ghi chú mà bạn thực sự muốn tác nhân này tìm kiếm.",
  "Use Readability to extract main content from HTML (fallbacks to basic HTML cleanup).":
    "Sử dụng Readability để trích xuất nội dung chính từ HTML (dự phòng sang dọn dẹp HTML cơ bản).",
  "Use this when one agent should query another agent's transcript collections; QMD-specific extra collections let you opt into cross-agent memory search without flattening everything into one shared namespace.":
    "Sử dụng tùy chọn này khi một tác nhân cần truy vấn các bộ sưu tập transcript của tác nhân khác; các bộ sưu tập bổ sung dành riêng cho QMD cho phép bạn chọn tham gia tìm kiếm bộ nhớ liên tác nhân mà không gộp mọi thứ vào một không gian tên dùng chung.",
  "Use this when you need directional transcript search across agents; add collections here to scope QMD recalls without creating a shared global transcript namespace.":
    "Sử dụng tùy chọn này khi bạn cần tìm kiếm transcript theo hướng giữa các tác nhân; thêm các bộ sưu tập tại đây để giới hạn phạm vi truy hồi QMD mà không tạo một không gian tên transcript toàn cục dùng chung.",
  "User-prompt template used for the pre-compaction memory flush turn when generating memory candidates. Use this only when you need custom extraction instructions beyond the default memory flush behavior.":
    "Mẫu user-prompt được dùng cho lượt flush bộ nhớ trước khi nén khi tạo các ứng viên bộ nhớ. Chỉ sử dụng tùy chọn này khi bạn cần hướng dẫn trích xuất tùy chỉnh ngoài hành vi flush bộ nhớ mặc định.",
  "Uses lazy sync by scheduling reindex on search after content changes are detected. Keep enabled for lower idle overhead, or disable if you require pre-synced indexes before any query.":
    "Sử dụng đồng bộ hóa lười bằng cách lên lịch lập chỉ mục lại khi tìm kiếm sau khi phát hiện thay đổi nội dung. Giữ bật để giảm chi phí khi nhàn rỗi, hoặc tắt nếu bạn yêu cầu chỉ mục được đồng bộ trước mọi truy vấn.",
  "Value for the Strict-Transport-Security response header. Set only on HTTPS origins that you fully control; use false to explicitly disable.":
    "Giá trị cho header phản hồi Strict-Transport-Security. Chỉ đặt trên các origin HTTPS mà bạn hoàn toàn kiểm soát; dùng false để tắt một cách rõ ràng.",
  "Vector search over MEMORY.md and memory/*.md (per-agent overrides supported).":
    "Tìm kiếm vector trên MEMORY.md và memory/*.md (hỗ trợ ghi đè theo từng tác nhân).",
  "Version recorded at install time (if available).":
    "Phiên bản được ghi nhận tại thời điểm cài đặt (nếu có).",
  "Video Generation Model": "Mô hình tạo video",
  "Video Generation Model Fallbacks": "Phương án dự phòng cho mô hình tạo video",
  "Video Understanding Attachment Policy": "Chính sách tệp đính kèm cho hiểu video",
  "Video Understanding Max Bytes": "Số byte tối đa cho hiểu video",
  "Video Understanding Max Chars": "Số ký tự tối đa cho hiểu video",
  "Video Understanding Models": "Mô hình hiểu video",
  "Video Understanding Prompt": "Prompt hiểu video",
  "Video Understanding Scope": "Phạm vi hiểu video",
  "Video Understanding Timeout (sec)": "Thời gian chờ hiểu video (giây)",
  "Voice and speech settings": "Cài đặt thoại và giọng nói",
  "Waits for batch embedding jobs to fully finish before the indexing operation completes. Keep this enabled for deterministic indexing state; disable only if you accept delayed consistency.":
    "Chờ các tác vụ embedding hàng loạt hoàn tất hoàn toàn trước khi thao tác lập chỉ mục kết thúc. Giữ bật tùy chọn này để có trạng thái lập chỉ mục xác định; chỉ tắt nếu bạn chấp nhận tính nhất quán bị trì hoãn.",
  'Wake scheduling mode: "now" wakes immediately, while "next-heartbeat" defers until the next heartbeat cycle. Use deferred mode for lower-priority automations that can tolerate slight delay.':
    'Chế độ lập lịch đánh thức: "now" đánh thức ngay lập tức, còn "next-heartbeat" sẽ hoãn đến chu kỳ heartbeat tiếp theo. Dùng chế độ hoãn cho các tác vụ tự động hóa ưu tiên thấp có thể chấp nhận độ trễ nhỏ.',
  "Warning threshold for repetitive patterns when detector is enabled (default: 10).":
    "Ngưỡng cảnh báo cho các mẫu lặp lại khi bộ phát hiện được bật (mặc định: 10).",
  "Watch Memory Files": "Theo dõi tệp bộ nhớ",
  "Watch Skills": "Theo dõi Skills",
  "Watches memory files and schedules index updates from file-change events (chokidar). Enable for near-real-time freshness; disable on very large workspaces if watch churn is too noisy.":
    "Theo dõi các tệp bộ nhớ và lên lịch cập nhật chỉ mục từ các sự kiện thay đổi tệp (chokidar). Bật để có độ mới gần như theo thời gian thực; tắt trên các workspace rất lớn nếu việc theo dõi thay đổi quá nhiễu.",
  "Web Channel": "Kênh Web",
  "Web Channel Enabled": "Bật kênh Web",
  "Web Channel Heartbeat Interval (sec)": "Khoảng thời gian heartbeat của kênh Web (giây)",
  "Web Channel Reconnect Policy": "Chính sách kết nối lại kênh Web",
  "Web channel runtime settings for heartbeat and reconnect behavior when operating web-based chat surfaces. Use reconnect values tuned to your network reliability profile and expected uptime needs.":
    "Cài đặt thời gian chạy của kênh Web cho hành vi heartbeat và kết nối lại khi vận hành các bề mặt chat dựa trên web. Dùng các giá trị kết nối lại được tinh chỉnh theo hồ sơ độ ổn định mạng và nhu cầu thời gian hoạt động dự kiến của bạn.",
  "Web Fetch Allow RFC 2544 Benchmark Range": "Cho phép Web Fetch với dải benchmark RFC 2544",
  "Web Fetch Cache TTL (min)": "TTL bộ nhớ đệm Web Fetch (phút)",
  "Web fetch fallback provider id.": "ID nhà cung cấp dự phòng của Web Fetch.",
  "Web Fetch Hard Max Chars": "Số ký tự tối đa cứng của Web Fetch",
  "Web Fetch Max Chars": "Số ký tự tối đa của Web Fetch",
  "Web Fetch Max Download Size (bytes)": "Kích thước tải xuống tối đa của Web Fetch (byte)",
  "Web Fetch Max Redirects": "Số lần chuyển hướng tối đa của Web Fetch",
  "Web Fetch Provider": "Nhà cung cấp Web Fetch",
  "Web Fetch Readability Extraction": "Trích xuất khả năng đọc của Web Fetch",
  "Web Fetch SSRF Policy": "Chính sách SSRF của Web Fetch",
  "Web Fetch Timeout (sec)": "Thời gian chờ Web Fetch (giây)",
  "Web Fetch User-Agent": "User-Agent của Web Fetch",
  "Web Reconnect Backoff Factor": "Hệ số backoff khi kết nối lại Web",
  "Web Reconnect Initial Delay (ms)": "Độ trễ ban đầu khi kết nối lại Web (ms)",
  "Web Reconnect Jitter": "Độ dao động kết nối lại Web",
  "Web Reconnect Max Attempts": "Số lần thử kết nối lại Web tối đa",
  "Web Reconnect Max Delay (ms)": "Độ trễ kết nối lại Web tối đa (ms)",
  "Web Search Cache TTL (min)": "TTL bộ nhớ đệm tìm kiếm Web (phút)",
  "Web Search Max Results": "Số kết quả tìm kiếm Web tối đa",
  "Web Search Provider": "Nhà cung cấp tìm kiếm Web",
  "Web Search Timeout (sec)": "Thời gian chờ tìm kiếm Web (giây)",
  "Web Tools": "Công cụ Web",
  "Web-tool policy grouping for search/fetch providers, limits, and fallback behavior tuning. Keep enabled settings aligned with API key availability and outbound networking policy.":
    "Nhóm chính sách công cụ Web cho các nhà cung cấp search/fetch, giới hạn và tinh chỉnh hành vi fallback. Giữ các cài đặt đang bật phù hợp với khả năng sẵn có của API key và chính sách mạng outbound.",
  "WebChat History Max Chars": "Số ký tự tối đa của lịch sử WebChat",
  "When enabled, rewrites the session JSONL file after compaction to remove entries that were summarized. Prevents unbounded file growth in long-running sessions with many compaction cycles. Default: false.":
    "Khi được bật, ghi lại tệp JSONL của phiên sau khi nén gọn để xóa các mục đã được tóm tắt. Ngăn tệp tăng kích thước không giới hạn trong các phiên chạy dài với nhiều chu kỳ nén gọn. Mặc định: false.",
  "When enabled, sends a brief compaction notice to the user (e.g. '🧹 Compacting context...') when compaction starts. Disabled by default to keep compaction silent and non-intrusive.":
    "Khi được bật, gửi một thông báo nén gọn ngắn cho người dùng (ví dụ: '🧹 Đang nén gọn ngữ cảnh...') khi quá trình nén gọn bắt đầu. Mặc định tắt để giữ quá trình nén gọn im lặng và không gây phiền.",
  "When enabled, uploaded media keeps its original filename instead of a generated temp-safe name. Turn this on when downstream automations depend on stable names, and leave off to reduce accidental filename leakage.":
    "Khi được bật, phương tiện đã tải lên sẽ giữ nguyên tên tệp gốc thay vì tên an toàn tạm thời được tạo ra. Bật tùy chọn này khi các quy trình tự động hóa phía sau phụ thuộc vào tên ổn định, và để tắt để giảm rò rỉ tên tệp ngoài ý muốn.",
  'When to send ack reactions ("group-mentions", "group-all", "direct", "all", "off", "none"). "off"/"none" disables ack reactions entirely.':
    'Khi nào gửi phản ứng ack ("group-mentions", "group-all", "direct", "all", "off", "none"). "off"/"none" sẽ tắt hoàn toàn phản ứng ack.',
  "When true (default), backgrounded exec sessions on exit and node exec lifecycle events enqueue a system event and request a heartbeat.":
    "Khi là true (mặc định), các phiên exec chạy nền khi thoát và các sự kiện vòng đời node exec sẽ đưa một sự kiện hệ thống vào hàng đợi và yêu cầu heartbeat.",
  "When true (default), shared image, music, and video generation automatically appends other auth-backed provider defaults after explicit primary/fallback refs. Set false to disable implicit cross-provider fallback while keeping explicit fallbacks.":
    "Khi là true (mặc định), việc tạo hình ảnh, nhạc và video dùng chung sẽ tự động thêm các giá trị mặc định của nhà cung cấp khác có hỗ trợ auth sau các ref primary/fallback được chỉ định rõ ràng. Đặt false để tắt fallback ngầm giữa các nhà cung cấp trong khi vẫn giữ các fallback được chỉ định rõ ràng.",
  "When true (default), suppress repeated ACP status/tool projection lines in a turn while keeping raw ACP events unchanged.":
    "Khi là true (mặc định), ẩn các dòng chiếu trạng thái/công cụ ACP lặp lại trong một lượt, đồng thời giữ nguyên các sự kiện ACP thô.",
  "When true, allow HTTPS to the model base URL when DNS resolves to private, CGNAT, or similar ranges, via the provider HTTP fetch guard (fetchWithSsrFGuard). OpenAI Responses WebSocket reuses request for headers/TLS but does not use that fetch SSRF path. Use only for operator-controlled self-hosted OpenAI-compatible endpoints (LAN, overlay, split DNS). Default is false.":
    "Khi là true, cho phép HTTPS tới URL cơ sở của model khi DNS phân giải tới các dải private, CGNAT hoặc tương tự, thông qua cơ chế bảo vệ HTTP fetch của nhà cung cấp (fetchWithSsrFGuard). OpenAI Responses WebSocket tái sử dụng request cho header/TLS nhưng không dùng đường dẫn SSRF fetch đó. Chỉ sử dụng cho các endpoint tương thích OpenAI tự lưu trữ do nhà vận hành kiểm soát (LAN, overlay, split DNS). Mặc định là false.",
  "When true, credentials are sent via the HTTP Authorization header even if alternate auth is possible. Use this only when your provider or proxy explicitly requires Authorization forwarding.":
    "Khi là true, thông tin xác thực được gửi qua header HTTP Authorization ngay cả khi có thể dùng phương thức xác thực thay thế. Chỉ dùng tùy chọn này khi nhà cung cấp hoặc proxy của bạn yêu cầu rõ ràng việc chuyển tiếp Authorization.",
  "When true, fetch and include email body content for downstream mapping/agent processing. Keep false unless body text is required, because this increases payload size and sensitivity.":
    "Khi là true, tìm nạp và bao gồm nội dung thân email để ánh xạ/xử lý bởi tác nhân ở bước sau. Giữ false trừ khi cần văn bản nội dung, vì điều này làm tăng kích thước payload và độ nhạy cảm.",
  "When true, mapping content may include less-sanitized external payload data in generated messages. Keep false by default and enable only for trusted sources with reviewed transform logic.":
    "Khi là true, nội dung ánh xạ có thể bao gồm dữ liệu payload bên ngoài ít được làm sạch hơn trong các thông điệp được tạo. Mặc định giữ false và chỉ bật cho các nguồn đáng tin cậy với logic chuyển đổi đã được rà soát.",
  "When true, successful backgrounded exec exits with empty output still enqueue a completion system event (default: false).":
    "Khi là true, các tiến trình exec chạy nền kết thúc thành công với đầu ra rỗng vẫn sẽ đưa một sự kiện hệ thống hoàn tất vào hàng đợi (mặc định: false).",
  "When true, suppress ⚠️ tool-error warnings from being shown to the user. The agent already sees errors in context and can retry. Default: false.":
    "Khi là true, ẩn các cảnh báo lỗi công cụ ⚠️ không hiển thị cho người dùng. Tác nhân đã thấy lỗi trong ngữ cảnh và có thể thử lại. Mặc định: false.",
  "Wide-area Discovery": "Khám phá diện rộng",
  "Wide-area discovery configuration group for exposing discovery signals beyond local-link scopes. Enable only in deployments that intentionally aggregate gateway presence across sites.":
    "Nhóm cấu hình khám phá diện rộng để hiển thị tín hiệu khám phá vượt ra ngoài phạm vi liên kết cục bộ. Chỉ bật trong các triển khai cố ý tổng hợp sự hiện diện của Gateway trên nhiều địa điểm.",
  "Wide-area Discovery Domain": "Miền khám phá diện rộng",
  "Wide-area Discovery Enabled": "Bật khám phá diện rộng",
  'Wizard execution mode recorded as "local" or "remote" for the most recent setup flow. Use this to understand whether setup targeted direct local runtime or remote gateway topology.':
    'Chế độ thực thi trình hướng dẫn được ghi nhận là "local" hoặc "remote" cho luồng thiết lập gần đây nhất. Dùng mục này để biết liệu quá trình thiết lập nhắm đến môi trường chạy cục bộ trực tiếp hay cấu trúc liên kết Gateway từ xa.',
  "Wizard Last Run Command": "Lệnh chạy gần nhất của trình hướng dẫn",
  "Wizard Last Run Commit": "Commit chạy gần nhất của trình hướng dẫn",
  "Wizard Last Run Mode": "Chế độ chạy gần nhất của trình hướng dẫn",
  "Wizard Last Run Timestamp": "Dấu thời gian chạy gần nhất của trình hướng dẫn",
  "Wizard Last Run Version": "Phiên bản chạy gần nhất của trình hướng dẫn",
  "Working directory override for ACP sessions created from this binding.":
    "Ghi đè thư mục làm việc cho các phiên ACP được tạo từ liên kết này.",
  Workspace: "Không gian làm việc",
  "Workspace-only FS tools": "Công cụ FS chỉ cho không gian làm việc",
};
