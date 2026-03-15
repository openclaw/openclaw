// novnc.d.ts
declare module "@novnc/novnc/lib/rfb.js" {
  export default class RFB {
    constructor(target: HTMLElement, url: string, options?: unknown);
    addEventListener(event: string, callback: (e?: unknown) => void): void;
    disconnect(): void;
    scaleViewport: boolean;
    clipViewport: boolean;
    resize?(): void;
  }
}

declare module "@novnc/novnc" {
  export default class RFB {
    constructor(target: HTMLElement, url: string, options?: unknown);
    addEventListener(event: string, callback: (e?: unknown) => void): void;
    disconnect(): void;
    scaleViewport: boolean;
    clipViewport: boolean;
    resize?(): void;
  }
}
