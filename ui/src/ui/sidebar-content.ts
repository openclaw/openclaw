export type MarkdownSidebarContent = {
  kind: "markdown";
  content: string;
  title?: string;
};

export type CanvasSidebarContent = {
  kind: "canvas";
  docId: string;
  title?: string;
  entryUrl: string;
  preferredHeight?: number;
  rawText?: string | null;
};

export type SidebarContent = MarkdownSidebarContent | CanvasSidebarContent;
