// Verified on Playwright 1.63.0 WebKit in Testbox run 38022560971.
// These are assertion failures, never skipped tests. Native `fails` makes a fix
// fail loudly until its entry is removed; different errors remain failures.
type WebkitExpectedFailure = {
  file: string;
  name: string;
  observed: string;
  cause: string;
  error: string;
  actual?: string;
  expected?: string;
  equalValues?: boolean;
};

export const webkitExpectedFailures: readonly WebkitExpectedFailure[] = [
  {
    file: "src/components/modal-dialog.test.ts",
    name: "openclaw-modal-dialog > occludes native tabs through nested dialogs, closing animations, and removal",
    observed: "Native occlusion reports [[false]] instead of [[false], [true]].",
    cause: "The jsdom fixture may observe native dialog occlusion before WebKit commits opening.",
    error: "expected [ [ false ] ] to deeply equal [ [ false ], [ true ] ]",
  },
  {
    file: "src/components/modal-dialog.test.ts",
    name: "openclaw-modal-dialog > honors autofocus without overriding pointer input (reopened=false)",
    observed: "The autofocus button retains focus instead of the video control.",
    cause: "WebKit may apply native autofocus after the fixture's synthetic pointer input.",
    error: 'to be <video controls tabindex="0"></video>',
    actual: "<button",
    expected: "<video",
  },
  {
    file: "src/components/modal-dialog.test.ts",
    name: "openclaw-modal-dialog > honors autofocus without overriding pointer input (reopened=true)",
    observed: "The autofocus button retains focus instead of the video control after reopening.",
    cause: "WebKit may apply native autofocus after the fixture's synthetic pointer input.",
    error: 'to be <video controls tabindex="0"></video>',
    actual: "<button",
    expected: "<video",
  },
  {
    file: "src/components/modal-dialog.test.ts",
    name: "openclaw-modal-dialog > honors autofocus without overriding keyboard input (reopened=false)",
    observed: "The autofocus button retains focus instead of the video control.",
    cause: "WebKit may apply native autofocus after the fixture's synthetic keyboard input.",
    error: 'to be <video controls tabindex="0"></video>',
    actual: "<button",
    expected: "<video",
  },
  {
    file: "src/components/modal-dialog.test.ts",
    name: "openclaw-modal-dialog > honors autofocus without overriding keyboard input (reopened=true)",
    observed: "The autofocus button retains focus instead of the video control after reopening.",
    cause: "WebKit may apply native autofocus after the fixture's synthetic keyboard input.",
    error: 'to be <video controls tabindex="0"></video>',
    actual: "<button",
    expected: "<video",
  },
  {
    file: "src/components/tooltip.test.ts",
    name: "openclaw-tooltip > skins the body and removes the arrow through shared overlay tokens",
    observed:
      "The queried style text is empty rather than containing the tooltip background token.",
    cause:
      "Native adopted stylesheets do not create the style elements this jsdom assertion reads.",
    error: "expected '' to contain '--wa-tooltip-background-color:'",
  },
  {
    file: "src/pages/chat/chat-composer-overflow.browser.test.ts",
    name: "composer overflow presentation > aligns the expanded 320 px active header and keeps controls above the objective",
    observed: "Shift-Tab focuses Clear goal instead of Pause goal.",
    cause: "WebKit's keyboard navigation through controls may differ from Chromium's Tab order.",
    error: "// Object.is equality",
    actual: 'class="agent-chat__goal-action agent-chat__goal-clear"',
    expected: 'class="agent-chat__goal-action agent-chat__goal-pause"',
  },
  {
    file: "src/pages/chat/chat-composer-overflow.browser.test.ts",
    name: "composer overflow presentation > aligns the expanded 390 px paused header and keeps controls above the objective",
    observed: "Shift-Tab focuses Clear goal instead of Resume goal.",
    cause: "WebKit's keyboard navigation through controls may differ from Chromium's Tab order.",
    error: "// Object.is equality",
    actual: 'class="agent-chat__goal-action agent-chat__goal-clear"',
    expected: 'class="agent-chat__goal-action agent-chat__goal-resume"',
  },
  {
    file: "src/pages/chat/chat-composer-overflow.browser.test.ts",
    name: "composer overflow presentation > aligns the expanded 560 px blocked header and keeps controls above the objective",
    observed: "Shift-Tab focuses Clear goal instead of Resume goal.",
    cause: "WebKit's keyboard navigation through controls may differ from Chromium's Tab order.",
    error: "// Object.is equality",
    actual: 'class="agent-chat__goal-action agent-chat__goal-clear"',
    expected: 'class="agent-chat__goal-action agent-chat__goal-resume"',
  },
  {
    file: "src/pages/chat/components/chat-effort-picker.browser.test.ts",
    name: "effort bar colour and flow > highlights the highest discrete effort in dark mode",
    observed: "The highest effort and maximum effort have the same computed gradient.",
    cause: "WebKit range-input appearance or computed-style resolution may ignore the variant.",
    error: "not to be 'linear-gradient",
    actual: "linear-gradient(",
    expected: "linear-gradient(",
    equalValues: true,
  },
  {
    file: "src/pages/chat/components/chat-effort-picker.browser.test.ts",
    name: "effort bar colour and flow > highlights the highest discrete effort in light mode",
    observed: "The highest effort and maximum effort have the same computed gradient.",
    cause: "WebKit range-input appearance or computed-style resolution may ignore the variant.",
    error: "not to be 'linear-gradient",
    actual: "linear-gradient(",
    expected: "linear-gradient(",
    equalValues: true,
  },
  {
    file: "src/pages/chat/components/chat-effort-picker.browser.test.ts",
    name: "effort bar colour and flow > previews colour without committing and restores the committed level on cancel or blur",
    observed: "Changing the preview leaves its computed appearance equal to the committed level.",
    cause: "WebKit range-input appearance or computed-style resolution may ignore the variant.",
    error: "to not deeply equal",
    actual: '"fill": "linear-gradient(',
    expected: '"glow":',
    equalValues: true,
  },
];
