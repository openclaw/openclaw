import "@lit/localize";

declare module "@lit/localize" {
  interface MsgOptions {
    args?: Record<string, string | number | boolean | null | undefined>;
  }
}
