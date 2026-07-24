@openclaw-barnacle openclaw-barnacle Bot added the size: M label 2 hours ago
@clawsweeper
clawsweeper Bot
commented
1 hour ago
•
Contributor
Codex review: needs real behavior proof before merge. Reviewed June 24, 2026, 12:57 AM ET / 04:57 UTC.

Summary
Adds a new Rust launcher/ project and a launcher:build package script for an interactive menu that delegates TUI, dashboard, update, and Gateway actions to the OpenClaw CLI.

PR surface: Docs +54, Config +1, Other +363. Total +418 across 5 files.

Reproducibility: yes. for the review finding: source inspection of launcher/src/main.rs shows gateway <subcommand> delegates only the sliced tail arguments. I did not run the launcher because this is a read-only review and the source path is clear.

Review metrics: 1 noteworthy metric.

New build toolchain surface: 1 Cargo-backed script added. The root package script can only build where Rust/Cargo is available, so maintainers should explicitly decide whether core owns this launcher build path.
Merge readiness
Overall: 🧂 unranked krab
Proof: 🧂 unranked krab
Patch quality: 🦪 silver shellfish
Result: blocked until real behavior proof is added.

Overall follows the weaker of proof and patch quality, so missing proof can cap an otherwise strong patch.

Rank-up moves:

[P1] Fix gateway <subcommand> so it invokes openclaw gateway <subcommand>.
[P1] Add redacted terminal output, screenshots, recording, logs, or a linked artifact showing the built launcher menu and delegated flows.
Refresh the branch against current main so reviewers can inspect the real merge result.
Proof guidance:

[P1] Needs real behavior proof before merge: The PR body asserts testing but includes no terminal output, screenshot, recording, logs, or linked artifact; the contributor should add redacted proof of the built menu and delegated commands, then update the PR body to trigger re-review or ask for @clawsweeper re-review.
Mantis proof suggestion
A short terminal or desktop recording would materially prove the new interactive launcher menu and delegation behavior. A maintainer can ask Mantis to capture proof by posting this exact PR comment:

@openclaw-mantis visual task: record the launcher menu delegating to TUI, dashboard, update, and gateway subcommands without persisting tokens.
Risk before merge

[P1] The PR is merge-conflicting against current main, so the exact merged patch still needs refresh before final review.
[P1] The new Rust launcher and root build script are a product/build surface that needs maintainer confirmation rather than only code correctness.
[P1] The contributor has not provided inspectable after-fix real behavior proof for the interactive menu and delegated commands.
Maintainer options:

Decide the mitigation before merge
Keep the branch open only if maintainers want a core launcher; then fix gateway delegation, refresh against main, and require redacted real terminal or recording proof before merge.
Pause or close
Do not merge this PR until maintainers decide whether the risk is worth taking.
Next step before merge

[P1] Contributor proof and maintainer product direction are required before automation should take over this PR, even though the gateway-prefix defect itself is concrete.
Security
Cleared: The revised diff removes the prior plaintext-token and custom-update paths and adds no external Rust dependencies, lifecycle hooks, or secrets handling beyond delegating to the existing CLI.

Review findings

[P2] Preserve the gateway command prefix — launcher/src/main.rs:290-291
Review details
Best possible solution:

Keep the branch open only if maintainers want a core launcher; then fix gateway delegation, refresh against main, and require redacted real terminal or recording proof before merge.

Do we have a high-confidence way to reproduce the issue?

Yes for the review finding: source inspection of launcher/src/main.rs shows gateway <subcommand> delegates only the sliced tail arguments. I did not run the launcher because this is a read-only review and the source path is clear.

Is this the best way to solve the issue?

No, not yet: the thin-wrapper direction is safer than the prior broad installer branch, but the current patch drops a required gateway prefix and lacks maintainer product approval for a new core launcher surface. If maintainers want it, the narrow fix is to preserve exact CLI delegation and prove the real menu flow.

Full review comments:

[P2] Preserve the gateway command prefix — launcher/src/main.rs:290-291
When a user runs openclaw-launcher gateway start, gw_args contains only start, so the launcher runs openclaw start instead of openclaw gateway start. Current OpenClaw registers service actions under the gateway command group, so this breaks the delegated gateway subcommand path.
Confidence: 0.95
Overall correctness: patch is incorrect
Overall confidence: 0.86

AGENTS.md: found and applied where relevant.

Codex review notes: model internal, reasoning high; reviewed against 2ab3b223ed69.

Label changes
Label changes:

add P3: This is a speculative launcher ergonomics feature with limited immediate user impact and a narrow code defect.
add rating: 🧂 unranked krab: Overall readiness is 🧂 unranked krab; proof is 🧂 unranked krab and patch quality is 🦪 silver shellfish.
add status: 📣 needs proof: The PR needs real behavior proof before ClawSweeper can clear the contributor ask. Needs real behavior proof before merge: The PR body asserts testing but includes no terminal output, screenshot, recording, logs, or linked artifact; the contributor should add redacted proof of the built menu and delegated commands, then update the PR body to trigger re-review or ask for @clawsweeper re-review.
Label justifications:

P3: This is a speculative launcher ergonomics feature with limited immediate user impact and a narrow code defect.
rating: 🧂 unranked krab: Overall readiness is 🧂 unranked krab; proof is 🧂 unranked krab and patch quality is 🦪 silver shellfish.
status: 📣 needs proof: The PR needs real behavior proof before ClawSweeper can clear the contributor ask. Needs real behavior proof before merge: The PR body asserts testing but includes no terminal output, screenshot, recording, logs, or linked artifact; the contributor should add redacted proof of the built menu and delegated commands, then update the PR body to trigger re-review or ask for @clawsweeper re-review.
Evidence reviewed
PR surface:

Docs +54, Config +1, Other +363. Total +418 across 5 files.

View PR surface stats
What I checked:

Repository policy read: Root AGENTS.md was read in full; its guidance on exhaustive PR review, optional surfaces, setup/startup sensitivity, and existing-solution preflight affected this review. (AGENTS.md:30, 2ab3b223ed69)
No scoped launcher policy: The checkout has scoped AGENTS.md files, but none apply to the new launcher/ subtree; package.json remains under root policy. (2ab3b223ed69)
Live PR state: Live GitHub state shows this PR is open, external-authored, merge-conflicting, changes 5 files, and has only a ClawSweeper placeholder comment with no review discussion or proof artifacts. (6820c39a6a6e)
Gateway subcommand bug: The proposed gateway <subcommand> branch slices away gateway and delegates only the tail args, so openclaw-launcher gateway start would invoke openclaw start instead of openclaw gateway start. (launcher/src/main.rs:290, 6820c39a6a6e)
Current CLI gateway contract: Current main registers service lifecycle commands under the gateway command group, so the launcher must preserve the gateway prefix when delegating service subcommands. (src/cli/gateway-cli/register.ts:500, 2ab3b223ed69)
Existing canonical surfaces: Current main already has supported tui, dashboard, update, and gateway CLI surfaces that the PR intends to wrap. (src/cli/tui-cli.ts:9, 2ab3b223ed69)
Likely related people:

Josh Lehman: Current blame on README setup guidance and CLI gateway/update/TUI registration points to the recent command refactor commit that carries these surfaces on main. (role: recent area contributor; confidence: medium; commits: f8ed4de460f7; files: README.md, src/cli/gateway-cli/register.ts, src/cli/update-cli.ts)
vincentkoc: Recent history touches macOS packaging and gateway/daemon cold-path command surfaces that are adjacent to a launcher build path. (role: recent adjacent contributor; confidence: medium; commits: cd7e3df1eac9, f8610da4c5cb; files: scripts/package-mac-app.sh, src/cli/gateway-cli/register.ts, src/cli/daemon-cli/register-service-commands.ts)
steipete: History shows earlier gateway service command integration and macOS update restart hardening on the canonical service/update paths this launcher wraps. (role: feature-history contributor; confidence: medium; commits: 9e22f019db0c, 7a63b046da71, 089e038dfeb9; files: src/cli/gateway-cli/register.ts, src/cli/daemon-cli/register-service-commands.ts, src/cli/update-cli/restart-helper.ts)
What the crustacean ranks mean
🦀 challenger crab: rare, exceptional readiness with strong proof, clean implementation, and convincing validation.
🦞 diamond lobster: very strong readiness with only minor maintainer review expected.
🐚 platinum hermit: good normal PR, likely mergeable with ordinary maintainer review.
🦐 gold shrimp: useful signal, but proof or patch confidence is still limited.
🦪 silver shellfish: thin signal; proof, validation, or implementation needs work.
🧂 unranked krab: not merge-ready because proof is missing/unusable or there are serious correctness or safety concerns.
🌊 off-meta tidepool: rating does not apply to this item.
Shiny media proof means a screenshot, video, or linked artifact directly shows the changed behavior. Runtime, network, CSP, and security claims still need visible diagnostics.

How this review workflow works
ClawSweeper keeps one durable marker-backed review comment per issue or PR.
Re-runs edit this comment so the latest verdict, findings, and automation markers stay together instead of adding duplicate bot comments.
A fresh review can be triggered by eligible @clawsweeper re-review comments, exact-item GitHub events, scheduled/background review runs, or manual workflow dispatch.
PR/issue authors and users with repository write access can comment @clawsweeper re-review or @clawsweeper re-run on an open PR or issue to request a fresh review only.
Maintainers can also comment @clawsweeper review to request a fresh review only.
Fresh-review commands do not start repair, autofix, rebase, CI repair, or automerge.
Maintainer-only repair and merge flows require explicit commands such as @clawsweeper autofix, @clawsweeper automerge, @clawsweeper fix ci, or @clawsweeper address review.
Maintainers can comment @clawsweeper explain to ask for more context, or @clawsweeper stop to stop active automation.
@clawsweeper clawsweeper Bot added rating: 🧂 unranked krab status: 📣 needs proof P3 labels 49 minutes ago
