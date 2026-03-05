"use client";

import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { cva } from "class-variance-authority";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type ProjectListItem = {
  appId: string;
  title: string;
  description: string;
  tags: string[];
  category: string;
  thumbnail: string;
  thumbnailUrl: string;
  lastRendered: string | null;
  lastRenderedLabel: string;
  renderCount: number;
  latestRenderFile: string | null;
  latestRenderAt: string | null;
};

type FilterState = {
  query: string;
  category: string;
  setQuery: (value: string) => void;
  setCategory: (value: string) => void;
};

type MetaDraft = {
  title: string;
  description: string;
  tags: string;
  category: string;
  thumbnail: string;
};

type DevServerState = {
  appId: string;
  pid: number;
  port: number;
  url: string;
  logPath: string;
  startedAt: string;
};

type ForgeStatusPayload = {
  devServers?: DevServerState[];
};

type ForgeDevPayload = {
  message?: string;
  url?: string;
  logPath?: string;
  pid?: number;
  port?: number;
  startedAt?: string;
  alreadyRunning?: boolean;
};

type RenderAsset = {
  relativePath: string;
  fileName: string;
  size: number;
  updatedAt: string;
  url: string;
};

type RenderListPayload = {
  files?: RenderAsset[];
  message?: string;
};

type PreviewState = {
  appId: string;
  title: string;
  relativePath: string;
  url: string;
  updatedAt: string | null;
  size: number | null;
};

type Language = "ja" | "en";
type ForgeRank = "ready" | "warming" | "smooth" | "stable";

const dashboardCopy = {
  ja: {
    topEyebrow: "REEL CONTROL DESK",
    topTitle: "Remotion動画を、迷わず管理。",
    topSubtitle:
      "最新レンダーの確認、プロジェクト管理、Dev起動までをワンストップ。カード上で常時プレビューできます。",
    statsProjects: "全プロジェクト",
    statsProjectsHint: "管理中のアプリ数",
    statsLiveDev: "Dev 稼働",
    statsLiveDevHint: "現在起動中の台数",
    statsRendered: "レンダー済み",
    statsRenderedHint: "動画があるプロジェクト",
    statsRank: "運用ランク",
    statsRankHint: "稼働状況の目安",
    scoreTitle: "運用スコア",
    scoreSummaryPrefix: "稼働中 Dev:",
    scoreSummaryMiddle: "レンダー済み率:",
    scoreSummarySuffix: "スコア判定:",
    rankReady: "準備中",
    rankWarming: "立ち上げ中",
    rankSmooth: "順調",
    rankStable: "安定運用",
    filterPlaceholder: "タイトル / タグで絞り込み",
    filterAll: "全カテゴリ",
    reload: "再読み込み",
    syncing: "dev status syncing...",
    showingPrefix: "表示:",
    showingSuffix: "件",
    noMatchTitle: "一致する作品がありません",
    noMatchBody:
      "フィルタを調整するか、`pnpm create:project` で新しい作品を作成してください。",
    cardBadge: "Spark Card",
    cardPreviewLive: "Live Preview",
    cardPreviewStatic: "Static",
    noTags: "タグ未設定 / No tags",
    lastRendered: "Last Rendered",
    renderFiles: "Render Files",
    latest: "Latest",
    appPath: "App Path",
    latestNone: "未検出 / none",
    startHereTitle: "まずはここから: 作品を見る",
    startHereBody:
      "Dev起動なしで、レンダリング済み動画をそのまま再生できます。",
    actionWatch: "作品を見る",
    actionOpenList: "動画一覧を開く",
    actionCloseList: "動画一覧を閉じる",
    actionRender: "Renderを作成",
    actionDeleteProject: "プロジェクト削除",
    actionDeleteRender: "動画削除",
    renderAssets: "Render Assets",
    refreshList: "一覧更新",
    loading: "読み込み中...",
    noRenderedYet: "レンダリング動画はまだありません。",
    play: "再生",
    othersPrefix: "他",
    othersSuffix: "件",
    advancedMenu: "上級者メニュー（Dev / Meta）",
    devServer: "Dev Server",
    runningOn: "Running on",
    stopped: "停止中 / Stopped",
    actionStopDev: "Dev停止",
    actionRunDev: "Dev起動",
    actionOpenDev: "Devを開く",
    actionCloseMeta: "Meta編集を閉じる",
    actionOpenMeta: "Meta編集",
    placeholderTitle: "title",
    placeholderDescription: "description",
    placeholderTags: "tags (comma separated)",
    placeholderCategory: "category",
    placeholderThumbnail: "thumbnail path (e.g. public/thumbnail.svg)",
    save: "保存",
    quickPreview: "Quick Preview",
    openInNewTab: "新しいタブで開く",
    close: "閉じる",
    appLabel: "App",
    updatedLabel: "Updated",
    sizeLabel: "Size",
    unknown: "unknown",
    neverRendered: "未実行 / Never rendered",
    msgDevStartFailed: "Dev起動に失敗しました。",
    msgDevConnect: "Dev接続",
    msgDevStarted: "Dev起動",
    msgDevStartRequestFailed: "Dev起動リクエストに失敗しました",
    msgDevStopFailed: "Dev停止に失敗しました。",
    msgAlreadyStopped: "既に停止中",
    msgDevStopped: "Dev停止",
    msgDevStopRequestFailed: "Dev停止リクエストに失敗しました",
    msgDevNotFound: "Devサーバーが見つかりません",
    msgRenderListFailed: "Render一覧の取得に失敗",
    msgRenderListUpdated: "Render一覧更新",
    msgNoWatchable: "まだ視聴できる動画がありません",
    msgCreateRender: "Renderを作成してください",
    msgRenderStartFailed: "Render開始に失敗しました。",
    msgRenderStart: "Render開始",
    msgRenderStartRequestFailed: "Render開始リクエストに失敗しました",
    msgMetaSaveFailed: "メタ保存に失敗しました。",
    msgMetaSaved: "メタ保存",
    msgMetaSaveRequestFailed: "メタ保存リクエストに失敗しました",
    msgDeleteProjectFailed: "プロジェクトをゴミ箱へ移動できませんでした。",
    msgDeleteProjectDone: "プロジェクトをゴミ箱へ移動しました",
    msgDeleteRenderFailed: "動画をゴミ箱へ移動できませんでした。",
    msgDeleteRenderDone: "動画をゴミ箱へ移動しました",
    confirmDeleteProject: "このプロジェクトを削除しますか？\n\n対象:",
    confirmDeleteRender: "この動画を削除しますか？\n\n対象:",
  },
  en: {
    topEyebrow: "REEL CONTROL DESK",
    topTitle: "Manage Remotion Videos, Clearly.",
    topSubtitle:
      "Review latest renders, manage projects, and launch dev servers in one place. Every card keeps a live video preview.",
    statsProjects: "Projects",
    statsProjectsHint: "Tracked apps",
    statsLiveDev: "Live Dev",
    statsLiveDevHint: "Running now",
    statsRendered: "Rendered",
    statsRenderedHint: "Projects with video",
    statsRank: "Ops Rank",
    statsRankHint: "Health snapshot",
    scoreTitle: "Operations Score",
    scoreSummaryPrefix: "Live Dev:",
    scoreSummaryMiddle: "Rendered coverage:",
    scoreSummarySuffix: "Rank:",
    rankReady: "Ready",
    rankWarming: "Warming Up",
    rankSmooth: "On Track",
    rankStable: "Stable",
    filterPlaceholder: "Filter by title / tags",
    filterAll: "All categories",
    reload: "Reload",
    syncing: "dev status syncing...",
    showingPrefix: "Showing:",
    showingSuffix: "projects",
    noMatchTitle: "No projects matched",
    noMatchBody:
      "Adjust filters or create a new project with `pnpm create:project`.",
    cardBadge: "Spark Card",
    cardPreviewLive: "Live Preview",
    cardPreviewStatic: "Static",
    noTags: "No tags",
    lastRendered: "Last Rendered",
    renderFiles: "Render Files",
    latest: "Latest",
    appPath: "App Path",
    latestNone: "none",
    startHereTitle: "Start here: Watch video",
    startHereBody: "Play the latest rendered video without launching dev.",
    actionWatch: "Watch",
    actionOpenList: "Open videos",
    actionCloseList: "Close videos",
    actionRender: "Create render",
    actionDeleteProject: "Delete project",
    actionDeleteRender: "Delete video",
    renderAssets: "Render Assets",
    refreshList: "Refresh list",
    loading: "Loading...",
    noRenderedYet: "No rendered videos yet.",
    play: "Play",
    othersPrefix: "and",
    othersSuffix: "more",
    advancedMenu: "Advanced menu (Dev / Meta)",
    devServer: "Dev Server",
    runningOn: "Running on",
    stopped: "Stopped",
    actionStopDev: "Stop Dev",
    actionRunDev: "Run Dev",
    actionOpenDev: "Open Dev",
    actionCloseMeta: "Close Meta edit",
    actionOpenMeta: "Edit Meta",
    placeholderTitle: "title",
    placeholderDescription: "description",
    placeholderTags: "tags (comma separated)",
    placeholderCategory: "category",
    placeholderThumbnail: "thumbnail path (e.g. public/thumbnail.svg)",
    save: "Save",
    quickPreview: "Quick Preview",
    openInNewTab: "Open in new tab",
    close: "Close",
    appLabel: "App",
    updatedLabel: "Updated",
    sizeLabel: "Size",
    unknown: "unknown",
    neverRendered: "Never rendered",
    msgDevStartFailed: "Failed to start dev.",
    msgDevConnect: "Connected to dev",
    msgDevStarted: "Dev started",
    msgDevStartRequestFailed: "Dev start request failed",
    msgDevStopFailed: "Failed to stop dev.",
    msgAlreadyStopped: "Already stopped",
    msgDevStopped: "Dev stopped",
    msgDevStopRequestFailed: "Dev stop request failed",
    msgDevNotFound: "Dev server not found",
    msgRenderListFailed: "Failed to fetch render list",
    msgRenderListUpdated: "Render list updated",
    msgNoWatchable: "No watchable video yet",
    msgCreateRender: "Please create a render first",
    msgRenderStartFailed: "Failed to start render.",
    msgRenderStart: "Render started",
    msgRenderStartRequestFailed: "Render start request failed",
    msgMetaSaveFailed: "Failed to save metadata.",
    msgMetaSaved: "Metadata saved",
    msgMetaSaveRequestFailed: "Metadata save request failed",
    msgDeleteProjectFailed: "Failed to move project to trash.",
    msgDeleteProjectDone: "Project moved to trash",
    msgDeleteRenderFailed: "Failed to move video to trash.",
    msgDeleteRenderDone: "Video moved to trash",
    confirmDeleteProject: "Delete this project?\n\nTarget:",
    confirmDeleteRender: "Delete this video?\n\nTarget:",
  },
} as const;

const useStudioFilterStore = create<FilterState>((set) => ({
  query: "",
  category: "all",
  setQuery: (value) => set({ query: value }),
  setCategory: (value) => set({ category: value }),
}));

const cardToneVariants = cva("transition duration-300 hover:-translate-y-1", {
  variants: {
    tone: {
      default: "hover:border-[#f39800]",
      cyan: "hover:border-[#59b9c6]",
      emerald: "hover:border-[#b9d08b]",
      violet: "hover:border-[#7058a3]",
    },
  },
  defaultVariants: {
    tone: "default",
  },
});

function getTone(category: string): "default" | "cyan" | "emerald" | "violet" {
  const normalized = category.toLowerCase();
  if (normalized.includes("3d") || normalized.includes("animation")) {
    return "cyan";
  }
  if (normalized.includes("template")) {
    return "violet";
  }
  if (normalized.includes("example")) {
    return "emerald";
  }
  return "default";
}

function toBadgeVariant(tone: "default" | "cyan" | "emerald" | "violet") {
  if (tone === "cyan") return "cyan";
  if (tone === "emerald") return "emerald";
  if (tone === "violet") return "violet";
  return "default";
}

function formatLastRendered(value: string | null, language: Language): string {
  if (!value) {
    return dashboardCopy[language].neverRendered;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(language === "ja" ? "ja-JP" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}

function buildThumbnailUrl(project: {
  appId: string;
  thumbnail: string;
  thumbnailUrl?: string;
}): string {
  if (project.thumbnailUrl) {
    return project.thumbnailUrl;
  }
  return `/api/thumbnail?app=${encodeURIComponent(project.appId)}&file=${encodeURIComponent(project.thumbnail)}`;
}

function buildRenderUrl(appId: string, file: string): string {
  return `/api/renders?app=${encodeURIComponent(appId)}&file=${encodeURIComponent(file)}`;
}

function extractFileName(relativePath: string): string {
  const tokens = relativePath.split("/");
  return tokens[tokens.length - 1] ?? relativePath;
}

function openUrlWithFallback(url: string): boolean {
  const popup = window.open(url, "_blank", "noopener,noreferrer");
  if (popup) {
    return true;
  }
  window.location.assign(url);
  return false;
}

function formatFileSize(bytes: number): string {
  if (bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  const power = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** power;
  return `${value.toFixed(power === 0 ? 0 : 1)} ${units[power]}`;
}

function toDevServerState(
  appId: string,
  input: Partial<DevServerState>,
): DevServerState | null {
  if (typeof input.pid !== "number" || input.pid <= 0) {
    return null;
  }
  if (typeof input.port !== "number" || input.port <= 0) {
    return null;
  }

  return {
    appId,
    pid: input.pid,
    port: input.port,
    url:
      typeof input.url === "string" && input.url.trim().length > 0
        ? input.url
        : `http://localhost:${input.port}`,
    logPath: typeof input.logPath === "string" ? input.logPath : "",
    startedAt:
      typeof input.startedAt === "string" && input.startedAt.trim().length > 0
        ? input.startedAt
        : new Date().toISOString(),
  };
}

function resolveForgeRank(score: number): ForgeRank {
  if (score >= 85) {
    return "stable";
  }
  if (score >= 60) {
    return "smooth";
  }
  if (score >= 35) {
    return "warming";
  }
  return "ready";
}

export function DashboardClient({
  initialProjects,
}: {
  initialProjects: ProjectListItem[];
}) {
  const [projects, setProjects] = useState(initialProjects);
  const [message, setMessage] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [openEditors, setOpenEditors] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, MetaDraft>>({});
  const [devServers, setDevServers] = useState<Record<string, DevServerState>>(
    {},
  );
  const [renderAssetsByApp, setRenderAssetsByApp] = useState<
    Record<string, RenderAsset[]>
  >({});
  const [openRenderPanels, setOpenRenderPanels] = useState<
    Record<string, boolean>
  >({});
  const [renderLoadingByApp, setRenderLoadingByApp] = useState<
    Record<string, boolean>
  >({});
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [language, setLanguage] = useState<Language>("ja");
  const [statusLoading, setStatusLoading] = useState(true);
  const t = dashboardCopy[language];

  const query = useStudioFilterStore((state) => state.query);
  const category = useStudioFilterStore((state) => state.category);
  const setQuery = useStudioFilterStore((state) => state.setQuery);
  const setCategory = useStudioFilterStore((state) => state.setCategory);

  const categories = useMemo(() => {
    return Array.from(
      new Set(projects.map((project) => project.category)),
    ).sort((a, b) => a.localeCompare(b, language === "ja" ? "ja" : "en"));
  }, [language, projects]);

  useEffect(() => {
    const nextLanguage: Language = navigator.language
      .toLowerCase()
      .startsWith("ja")
      ? "ja"
      : "en";
    setLanguage(nextLanguage);
  }, []);

  useEffect(() => {
    let active = true;

    const syncDevServers = async () => {
      const response = await fetch("/api/forge", {
        method: "GET",
        cache: "no-store",
      }).catch(() => null);
      if (!response || !active) {
        return;
      }

      const payload = (await response
        .json()
        .catch(() => ({}))) as ForgeStatusPayload;
      if (!response.ok || !Array.isArray(payload.devServers)) {
        return;
      }

      const next: Record<string, DevServerState> = {};
      for (const server of payload.devServers) {
        if (!server || typeof server.appId !== "string") {
          continue;
        }
        const normalized = toDevServerState(server.appId, server);
        if (normalized) {
          next[normalized.appId] = normalized;
        }
      }

      if (active) {
        setDevServers(next);
        setStatusLoading(false);
      }
    };

    void syncDevServers();
    const timer = window.setInterval(() => {
      void syncDevServers();
    }, 15000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const filteredProjects = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return projects.filter((project) => {
      const categoryMatch = category === "all" || project.category === category;
      if (!categoryMatch) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }
      const searchable = [
        project.title,
        project.description,
        project.appId,
        project.tags.join(" "),
      ]
        .join(" ")
        .toLowerCase();
      return searchable.includes(normalizedQuery);
    });
  }, [category, projects, query]);

  const activeDevCount = Object.keys(devServers).length;
  const renderedCount = projects.filter(
    (project) => project.renderCount > 0,
  ).length;
  const forgeScore = Math.min(
    100,
    projects.length * 8 + renderedCount * 14 + activeDevCount * 18,
  );
  const forgeRank = resolveForgeRank(forgeScore);
  const forgeRankLabel =
    forgeRank === "stable"
      ? t.rankStable
      : forgeRank === "smooth"
        ? t.rankSmooth
        : forgeRank === "warming"
          ? t.rankWarming
          : t.rankReady;
  const renderedCoverage = projects.length
    ? Math.round((renderedCount / projects.length) * 100)
    : 0;

  const toggleEditor = (project: ProjectListItem) => {
    setOpenEditors((prev) => ({
      ...prev,
      [project.appId]: !prev[project.appId],
    }));
    setDrafts((prev) => {
      if (prev[project.appId]) {
        return prev;
      }
      return {
        ...prev,
        [project.appId]: {
          title: project.title,
          description: project.description,
          tags: project.tags.join(", "),
          category: project.category,
          thumbnail: project.thumbnail,
        },
      };
    });
  };

  const runDev = async (project: ProjectListItem) => {
    const key = `${project.appId}:dev`;
    setBusyKey(key);
    setMessage(null);

    const popup = window.open("", "_blank");
    try {
      const response = await fetch("/api/forge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId: project.appId, action: "dev" }),
      });
      const payload = (await response
        .json()
        .catch(() => ({}))) as ForgeDevPayload;

      if (!response.ok) {
        popup?.close();
        setMessage(payload.message ?? t.msgDevStartFailed);
        return;
      }

      if (payload.url && popup) {
        popup.location.href = payload.url;
      } else if (payload.url) {
        window.location.assign(payload.url);
      }

      const nextDevServer = toDevServerState(project.appId, {
        appId: project.appId,
        pid: payload.pid,
        port: payload.port,
        url: payload.url,
        logPath: payload.logPath,
        startedAt: payload.startedAt,
      });
      if (nextDevServer) {
        setDevServers((prev) => ({ ...prev, [project.appId]: nextDevServer }));
      }

      setMessage(
        `${payload.alreadyRunning ? t.msgDevConnect : t.msgDevStarted}: ${project.appId}${payload.url ? ` (${payload.url})` : ""}${payload.logPath ? ` / log: ${payload.logPath}` : ""}`,
      );
    } catch {
      popup?.close();
      setMessage(`${t.msgDevStartRequestFailed}: ${project.appId}`);
    } finally {
      setBusyKey(null);
    }
  };

  const stopDev = async (project: ProjectListItem) => {
    const key = `${project.appId}:stop-dev`;
    setBusyKey(key);
    setMessage(null);

    try {
      const response = await fetch("/api/forge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId: project.appId, action: "stop-dev" }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        message?: string;
      };

      if (response.status === 404) {
        setDevServers((prev) => {
          const next = { ...prev };
          delete next[project.appId];
          return next;
        });
        setMessage(`${t.msgAlreadyStopped}: ${project.appId}`);
        return;
      }

      if (!response.ok) {
        setMessage(payload.message ?? t.msgDevStopFailed);
        return;
      }

      setDevServers((prev) => {
        const next = { ...prev };
        delete next[project.appId];
        return next;
      });
      setMessage(payload.message ?? `${t.msgDevStopped}: ${project.appId}`);
    } catch {
      setMessage(`${t.msgDevStopRequestFailed}: ${project.appId}`);
    } finally {
      setBusyKey(null);
    }
  };

  const openDev = (project: ProjectListItem) => {
    const devServer = devServers[project.appId];
    if (!devServer?.url) {
      setMessage(`${t.msgDevNotFound}: ${project.appId}`);
      return;
    }
    openUrlWithFallback(devServer.url);
  };

  const syncRenderAssets = async (
    appId: string,
    options?: { silent?: boolean },
  ): Promise<RenderAsset[] | null> => {
    setRenderLoadingByApp((prev) => ({ ...prev, [appId]: true }));

    const response = await fetch(
      `/api/renders?app=${encodeURIComponent(appId)}`,
      {
        method: "GET",
        cache: "no-store",
      },
    ).catch(() => null);

    if (!response) {
      setRenderLoadingByApp((prev) => ({ ...prev, [appId]: false }));
      if (!options?.silent) {
        setMessage(`${t.msgRenderListFailed}: ${appId}`);
      }
      return null;
    }

    const payload = (await response
      .json()
      .catch(() => ({}))) as RenderListPayload;
    if (!response.ok || !Array.isArray(payload.files)) {
      setRenderLoadingByApp((prev) => ({ ...prev, [appId]: false }));
      if (!options?.silent) {
        setMessage(payload.message ?? `${t.msgRenderListFailed}: ${appId}`);
      }
      return null;
    }

    const files = payload.files ?? [];
    setRenderAssetsByApp((prev) => ({ ...prev, [appId]: files }));
    setProjects((prev) =>
      prev.map((item) => {
        if (item.appId !== appId) {
          return item;
        }
        const latest = files[0];
        const inferredLastRendered = latest?.updatedAt ?? null;
        return {
          ...item,
          renderCount: files.length,
          latestRenderFile: latest?.relativePath ?? null,
          latestRenderAt: latest?.updatedAt ?? null,
          lastRendered: inferredLastRendered,
          lastRenderedLabel: formatLastRendered(inferredLastRendered, language),
        };
      }),
    );
    setRenderLoadingByApp((prev) => ({ ...prev, [appId]: false }));

    if (!options?.silent) {
      setMessage(`${t.msgRenderListUpdated}: ${appId} (${files.length})`);
    }

    return files;
  };

  const toggleRenderPanel = (project: ProjectListItem) => {
    const nextOpen = !openRenderPanels[project.appId];
    setOpenRenderPanels((prev) => ({ ...prev, [project.appId]: nextOpen }));
    if (nextOpen && !renderAssetsByApp[project.appId]) {
      void syncRenderAssets(project.appId, { silent: true });
    }
  };

  const openLatestRender = async (project: ProjectListItem) => {
    const cached = renderAssetsByApp[project.appId] ?? [];
    const firstCached = cached[0];
    if (firstCached) {
      setPreview({
        appId: project.appId,
        title: project.title,
        relativePath: firstCached.relativePath,
        url: firstCached.url,
        updatedAt: firstCached.updatedAt,
        size: firstCached.size,
      });
      return;
    }

    if (project.latestRenderFile) {
      setPreview({
        appId: project.appId,
        title: project.title,
        relativePath: project.latestRenderFile,
        url: buildRenderUrl(project.appId, project.latestRenderFile),
        updatedAt: project.latestRenderAt,
        size: null,
      });
      return;
    }

    const synced = await syncRenderAssets(project.appId, { silent: true });
    const firstSynced = synced?.[0];
    if (firstSynced) {
      setPreview({
        appId: project.appId,
        title: project.title,
        relativePath: firstSynced.relativePath,
        url: firstSynced.url,
        updatedAt: firstSynced.updatedAt,
        size: firstSynced.size,
      });
      return;
    }

    setMessage(`${t.msgNoWatchable}: ${project.appId} (${t.msgCreateRender})`);
  };

  const runRender = async (project: ProjectListItem) => {
    const key = `${project.appId}:render`;
    setBusyKey(key);
    setMessage(null);

    try {
      const response = await fetch("/api/forge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId: project.appId, action: "render" }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        message?: string;
        composition?: string;
        logPath?: string;
      };

      if (!response.ok) {
        setMessage(payload.message ?? t.msgRenderStartFailed);
        return;
      }

      setMessage(
        `${t.msgRenderStart}: ${project.appId}${payload.composition ? ` (${payload.composition})` : ""}${payload.logPath ? ` / log: ${payload.logPath}` : ""}`,
      );
      window.setTimeout(() => {
        void syncRenderAssets(project.appId, { silent: true });
      }, 4000);
    } catch {
      setMessage(`${t.msgRenderStartRequestFailed}: ${project.appId}`);
    } finally {
      setBusyKey(null);
    }
  };

  const deleteRenderAsset = async (
    project: ProjectListItem,
    asset: RenderAsset,
  ) => {
    if (!window.confirm(`${t.confirmDeleteRender} ${asset.relativePath}`)) {
      return;
    }

    const key = `${project.appId}:delete-render:${asset.relativePath}`;
    setBusyKey(key);
    setMessage(null);

    try {
      const response = await fetch(
        `/api/renders?app=${encodeURIComponent(project.appId)}&file=${encodeURIComponent(asset.relativePath)}`,
        {
          method: "DELETE",
        },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        message?: string;
      };

      if (!response.ok) {
        setMessage(payload.message ?? t.msgDeleteRenderFailed);
        return;
      }

      if (
        preview &&
        preview.appId === project.appId &&
        preview.relativePath === asset.relativePath
      ) {
        setPreview(null);
      }
      await syncRenderAssets(project.appId, { silent: true });
      setMessage(`${t.msgDeleteRenderDone}: ${asset.fileName}`);
    } catch {
      setMessage(`${t.msgDeleteRenderFailed}: ${asset.fileName}`);
    } finally {
      setBusyKey(null);
    }
  };

  const deleteProject = async (project: ProjectListItem) => {
    if (!window.confirm(`${t.confirmDeleteProject} ${project.appId}`)) {
      return;
    }

    const key = `${project.appId}:delete-project`;
    setBusyKey(key);
    setMessage(null);

    try {
      const response = await fetch("/api/forge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appId: project.appId,
          action: "delete-project",
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        message?: string;
      };

      if (!response.ok) {
        setMessage(payload.message ?? t.msgDeleteProjectFailed);
        return;
      }

      setProjects((prev) =>
        prev.filter((item) => item.appId !== project.appId),
      );
      setDevServers((prev) => {
        const next = { ...prev };
        delete next[project.appId];
        return next;
      });
      setRenderAssetsByApp((prev) => {
        const next = { ...prev };
        delete next[project.appId];
        return next;
      });
      setOpenRenderPanels((prev) => {
        const next = { ...prev };
        delete next[project.appId];
        return next;
      });
      setRenderLoadingByApp((prev) => {
        const next = { ...prev };
        delete next[project.appId];
        return next;
      });
      setOpenEditors((prev) => {
        const next = { ...prev };
        delete next[project.appId];
        return next;
      });
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[project.appId];
        return next;
      });
      if (preview?.appId === project.appId) {
        setPreview(null);
      }
      setMessage(`${t.msgDeleteProjectDone}: ${project.appId}`);
    } catch {
      setMessage(`${t.msgDeleteProjectFailed}: ${project.appId}`);
    } finally {
      setBusyKey(null);
    }
  };

  const saveMeta = async (project: ProjectListItem) => {
    const draft = drafts[project.appId];
    if (!draft) {
      return;
    }

    const key = `${project.appId}:save`;
    setBusyKey(key);
    setMessage(null);

    try {
      const response = await fetch("/api/project-meta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appId: project.appId,
          meta: {
            title: draft.title,
            description: draft.description,
            tags: draft.tags,
            category: draft.category,
            thumbnail: draft.thumbnail,
          },
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        message?: string;
        meta?: {
          title: string;
          description: string;
          tags: string[];
          thumbnail: string;
          category: string;
          lastRendered: string | null;
        };
      };

      if (!response.ok || !payload.meta) {
        setMessage(payload.message ?? t.msgMetaSaveFailed);
        return;
      }

      setProjects((prev) =>
        prev.map((item) => {
          if (item.appId !== project.appId) {
            return item;
          }
          return {
            ...item,
            title: payload.meta?.title ?? item.title,
            description: payload.meta?.description ?? item.description,
            tags: payload.meta?.tags ?? item.tags,
            category: payload.meta?.category ?? item.category,
            thumbnail: payload.meta?.thumbnail ?? item.thumbnail,
            thumbnailUrl: buildThumbnailUrl({
              appId: item.appId,
              thumbnail: payload.meta?.thumbnail ?? item.thumbnail,
            }),
            lastRendered: payload.meta?.lastRendered ?? item.lastRendered,
            lastRenderedLabel: formatLastRendered(
              payload.meta?.lastRendered ?? item.lastRendered,
              language,
            ),
          };
        }),
      );
      setOpenEditors((prev) => ({ ...prev, [project.appId]: false }));
      setMessage(`${t.msgMetaSaved}: ${project.appId}`);
    } catch {
      setMessage(`${t.msgMetaSaveRequestFailed}: ${project.appId}`);
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <main className="forge-shell min-h-screen px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="relative overflow-hidden rounded-[calc(var(--radius-card)+10px)] border border-white/35 bg-white/30 px-5 py-6 shadow-[0_24px_60px_rgba(0,0,0,0.12)] backdrop-blur-2xl sm:px-7 sm:py-7">
          <div className="pointer-events-none absolute -left-14 -top-10 h-40 w-40 rounded-full bg-[var(--accent)]/25 blur-2xl" />
          <div className="pointer-events-none absolute -right-16 top-8 h-44 w-44 rounded-full bg-[var(--accent-strong)]/20 blur-2xl" />
          <div className="pointer-events-none absolute bottom-0 right-10 h-20 w-20 rounded-full border border-[var(--line-soft)]" />

          <div className="relative">
            <div className="mb-4 flex items-center justify-end">
              <div className="inline-flex items-center rounded-full border border-white/45 bg-white/35 p-1 backdrop-blur-xl">
                <button
                  type="button"
                  onClick={() => setLanguage("ja")}
                  className={cn(
                    "rounded-full px-3 py-1 text-xs font-semibold transition",
                    language === "ja"
                      ? "bg-white text-[var(--text-strong)] shadow"
                      : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
                  )}
                >
                  日本語
                </button>
                <button
                  type="button"
                  onClick={() => setLanguage("en")}
                  className={cn(
                    "rounded-full px-3 py-1 text-xs font-semibold transition",
                    language === "en"
                      ? "bg-white text-[var(--text-strong)] shadow"
                      : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
                  )}
                >
                  English
                </button>
              </div>
            </div>
            <p className="text-xs uppercase tracking-[0.28em] text-[var(--accent-strong)]">
              {t.topEyebrow}
            </p>
            <h1 className="mt-2 text-3xl font-bold tracking-tight text-[var(--text-strong)] sm:text-4xl">
              {t.topTitle}
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--text-secondary)] sm:text-base">
              {t.topSubtitle}
            </p>

            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="forge-chip">
                <span className="forge-chip-label">{t.statsProjects}</span>
                <strong>{projects.length}</strong>
                <span className="text-[11px] text-[var(--text-secondary)]">
                  {t.statsProjectsHint}
                </span>
              </div>
              <div className="forge-chip">
                <span className="forge-chip-label">{t.statsLiveDev}</span>
                <strong>{activeDevCount}</strong>
                <span className="text-[11px] text-[var(--text-secondary)]">
                  {t.statsLiveDevHint}
                </span>
              </div>
              <div className="forge-chip">
                <span className="forge-chip-label">{t.statsRendered}</span>
                <strong>{renderedCount}</strong>
                <span className="text-[11px] text-[var(--text-secondary)]">
                  {t.statsRenderedHint}
                </span>
              </div>
              <div className="forge-chip">
                <span className="forge-chip-label">{t.statsRank}</span>
                <strong>{forgeRankLabel}</strong>
                <span className="text-[11px] text-[var(--text-secondary)]">
                  {t.statsRankHint}
                </span>
              </div>
            </div>

            <div className="mt-4 rounded-2xl border border-white/45 bg-white/45 p-3 backdrop-blur-xl">
              <div className="flex items-center justify-between gap-3 text-xs text-[var(--text-secondary)]">
                <span>{t.scoreTitle}</span>
                <span>{forgeScore}%</span>
              </div>
              <div className="forge-progress mt-2">
                <span style={{ width: `${forgeScore}%` }} />
              </div>
              <p className="mt-2 text-[11px] text-[var(--text-secondary)]">
                {t.scoreSummaryPrefix} {activeDevCount} / {t.scoreSummaryMiddle}{" "}
                {renderedCoverage}% / {t.scoreSummarySuffix} {forgeRankLabel}
              </p>
            </div>

            <div className="mt-5 flex flex-wrap gap-3">
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t.filterPlaceholder}
                className="w-full min-w-[220px] flex-1 rounded-xl border border-white/55 bg-white/50 px-3 py-2 text-sm text-[var(--text-primary)] outline-none ring-[color:var(--accent)] backdrop-blur-xl transition focus:ring-2"
              />
              <select
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                className="rounded-xl border border-white/55 bg-white/50 px-3 py-2 text-sm text-[var(--text-primary)] outline-none ring-[color:var(--accent)] backdrop-blur-xl transition focus:ring-2"
              >
                <option value="all">{t.filterAll}</option>
                {categories.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="rounded-xl border border-white/55 bg-white/55 px-3 py-2 text-sm text-[var(--text-primary)] backdrop-blur-xl transition hover:bg-white"
              >
                {t.reload}
              </button>
            </div>

            <div className="mt-4 text-xs text-[var(--text-secondary)]">
              {t.showingPrefix} {filteredProjects.length}/{projects.length}{" "}
              {t.showingSuffix}
              {statusLoading ? ` / ${t.syncing}` : ""}
            </div>
            {message ? (
              <div className="mt-3 rounded-xl border border-[#f39800]/45 bg-[#fff4df]/70 px-3 py-2 text-xs text-[#8b5600] backdrop-blur-xl">
                {message}
              </div>
            ) : null}
          </div>
        </header>

        {filteredProjects.length === 0 ? (
          <section className="rounded-[var(--radius-card)] border border-dashed border-white/45 bg-white/40 p-8 text-center backdrop-blur-xl">
            <p className="text-lg font-semibold text-[var(--text-primary)]">
              {t.noMatchTitle}
            </p>
            <p className="mt-2 text-sm text-[var(--text-secondary)]">
              {t.noMatchBody}
            </p>
          </section>
        ) : (
          <section className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {filteredProjects.map((project, index) => {
              const tone = getTone(project.category);
              const editorOpen = openEditors[project.appId];
              const draft = drafts[project.appId];
              const devServer = devServers[project.appId];
              const isDevRunning = Boolean(devServer);
              const devButtonKey = isDevRunning
                ? `${project.appId}:stop-dev`
                : `${project.appId}:dev`;
              const deleteProjectKey = `${project.appId}:delete-project`;
              const isDeletingProject = busyKey === deleteProjectKey;
              const renderAssets = renderAssetsByApp[project.appId] ?? [];
              const renderPanelOpen = Boolean(openRenderPanels[project.appId]);
              const renderLoading = Boolean(renderLoadingByApp[project.appId]);
              const latestRenderPath =
                project.latestRenderFile ??
                renderAssets[0]?.relativePath ??
                null;
              const latestRenderUrl = latestRenderPath
                ? buildRenderUrl(project.appId, latestRenderPath)
                : null;
              const canPreview =
                Boolean(latestRenderPath) ||
                renderAssets.length > 0 ||
                project.renderCount > 0;

              return (
                <Card
                  key={project.appId}
                  className={cn(
                    cardToneVariants({ tone }),
                    "forge-card border-white/40 bg-white/42 shadow-[0_24px_44px_rgba(15,23,42,0.14)] backdrop-blur-xl",
                  )}
                  style={{ animationDelay: `${index * 70}ms` }}
                >
                  <div className="relative aspect-video overflow-hidden rounded-t-[var(--radius-card)] border-b border-white/35 bg-[#eaf4fc]">
                    {latestRenderUrl ? (
                      <video
                        key={`${project.appId}:preview`}
                        className="absolute inset-0 h-full w-full object-cover"
                        muted
                        loop
                        playsInline
                        autoPlay
                        preload="metadata"
                        src={latestRenderUrl}
                      />
                    ) : (
                      <img
                        src={project.thumbnailUrl}
                        alt={`${project.title} thumbnail`}
                        className="h-full w-full object-cover"
                        loading="lazy"
                        onError={(event) => {
                          const fallback = `/api/thumbnail?app=${encodeURIComponent(project.appId)}&file=${encodeURIComponent("public/thumbnail.svg")}`;
                          const image = event.currentTarget;
                          if (
                            !image.src.includes("file=public%2Fthumbnail.svg")
                          ) {
                            image.src = fallback;
                          }
                        }}
                      />
                    )}
                    <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/35 to-transparent" />
                    <p className="absolute left-3 top-3 rounded-full border border-white/60 bg-white/72 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-[#595857]">
                      {t.cardBadge}
                    </p>
                    <p className="absolute right-3 top-3 rounded-full border border-white/50 bg-black/35 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-white">
                      {latestRenderUrl
                        ? t.cardPreviewLive
                        : t.cardPreviewStatic}
                    </p>
                  </div>
                  <CardContent>
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <p className="line-clamp-1 text-lg font-bold text-[var(--text-primary)]">
                        {project.title}
                      </p>
                      <Badge variant={toBadgeVariant(tone)}>
                        {project.category}
                      </Badge>
                    </div>
                    <p className="line-clamp-2 text-sm text-[var(--text-secondary)]">
                      {project.description}
                    </p>
                    <div className="mt-4 flex flex-wrap gap-2">
                      {project.tags.length > 0 ? (
                        project.tags.map((tag) => (
                          <span
                            key={`${project.appId}-${tag}`}
                            className="rounded-full border border-[color:var(--line-soft)] bg-[color:var(--bg-surface)] px-2.5 py-1 text-xs text-[var(--text-secondary)]"
                          >
                            #{tag}
                          </span>
                        ))
                      ) : (
                        <span className="text-xs text-[var(--text-secondary)]">
                          {t.noTags}
                        </span>
                      )}
                    </div>
                    <div className="mt-5 rounded-xl border border-white/45 bg-white/45 p-3 text-xs text-[var(--text-secondary)] backdrop-blur-xl">
                      <p className="uppercase tracking-[0.18em] text-[10px] text-[var(--accent-strong)]">
                        {t.lastRendered}
                      </p>
                      <p className="mt-1 text-sm font-semibold text-[var(--text-primary)]">
                        {formatLastRendered(project.lastRendered, language)}
                      </p>
                      <p className="mt-2 text-[11px] text-[var(--text-secondary)]">
                        {t.renderFiles}: {project.renderCount}
                      </p>
                      <p className="mt-1 line-clamp-1 text-[11px] text-[var(--text-secondary)]">
                        {t.latest}: {latestRenderPath ?? t.latestNone}
                      </p>
                      <p className="mt-1 text-[11px] text-[var(--text-secondary)]">
                        {t.appPath}: {project.appId}
                      </p>
                    </div>
                    <div className="mt-4 rounded-xl border border-[#0ea5a5]/35 bg-[#f3fbfb]/80 p-3 backdrop-blur-xl">
                      <p className="text-[11px] font-semibold text-[#0f5f5f]">
                        {t.startHereTitle}
                      </p>
                      <p className="mt-1 text-[11px] text-[#0f5f5f]/80">
                        {t.startHereBody}
                      </p>
                    </div>
                    <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                      <button
                        type="button"
                        onClick={() => void openLatestRender(project)}
                        disabled={!canPreview}
                        className="rounded-lg border border-[#0ea5a5] bg-[#e6fbfb] px-3 py-2 text-sm font-semibold text-[#0f5f5f] transition hover:-translate-y-0.5 disabled:opacity-50"
                      >
                        {t.actionWatch}
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleRenderPanel(project)}
                        className="rounded-lg border border-[#2563eb] bg-[#eaf2ff] px-3 py-2 text-sm font-semibold text-[#1f4c9a] transition hover:-translate-y-0.5"
                      >
                        {renderPanelOpen ? t.actionCloseList : t.actionOpenList}
                      </button>
                      <button
                        type="button"
                        onClick={() => runRender(project)}
                        disabled={busyKey === `${project.appId}:render`}
                        className="rounded-lg border border-[#b9d08b] bg-[#f2f8e8] px-3 py-2 text-sm font-semibold text-[#536f2a] transition hover:-translate-y-0.5 disabled:opacity-50"
                      >
                        {t.actionRender}
                      </button>
                    </div>
                    {renderPanelOpen ? (
                      <div className="mt-3 rounded-xl border border-white/45 bg-white/45 p-3 text-xs text-[var(--text-secondary)] backdrop-blur-xl">
                        <div className="flex items-center justify-between gap-2">
                          <p className="uppercase tracking-[0.18em] text-[10px] text-[var(--accent-strong)]">
                            {t.renderAssets}
                          </p>
                          <button
                            type="button"
                            onClick={() => void syncRenderAssets(project.appId)}
                            disabled={renderLoading}
                            className="rounded-md border border-[#2563eb] bg-white px-2 py-1 text-[10px] font-semibold text-[#1f4c9a] disabled:opacity-50"
                          >
                            {t.refreshList}
                          </button>
                        </div>
                        {renderLoading ? (
                          <p className="mt-2 text-[11px]">{t.loading}</p>
                        ) : renderAssets.length === 0 ? (
                          <p className="mt-2 text-[11px]">{t.noRenderedYet}</p>
                        ) : (
                          <div className="mt-2 space-y-2">
                            {renderAssets.slice(0, 6).map((asset) => (
                              <div
                                key={`${project.appId}:${asset.relativePath}`}
                                className="rounded-lg border border-[color:var(--line-soft)] bg-white px-2 py-2"
                              >
                                <p className="line-clamp-1 font-semibold text-[var(--text-primary)]">
                                  {asset.fileName}
                                </p>
                                <p className="mt-1 line-clamp-1 text-[10px]">
                                  {asset.relativePath}
                                </p>
                                <div className="mt-1 flex items-center justify-between gap-2 text-[10px]">
                                  <span>
                                    {formatFileSize(asset.size)} /{" "}
                                    {formatLastRendered(
                                      asset.updatedAt,
                                      language,
                                    )}
                                  </span>
                                  <div className="flex items-center gap-1">
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setPreview({
                                          appId: project.appId,
                                          title: project.title,
                                          relativePath: asset.relativePath,
                                          url: asset.url,
                                          updatedAt: asset.updatedAt,
                                          size: asset.size,
                                        })
                                      }
                                      className="rounded-md border border-[#0ea5a5] bg-[#e6fbfb] px-2 py-1 font-semibold text-[#0f5f5f]"
                                    >
                                      {t.play}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        void deleteRenderAsset(project, asset)
                                      }
                                      disabled={
                                        busyKey ===
                                        `${project.appId}:delete-render:${asset.relativePath}`
                                      }
                                      className="rounded-md border border-[#dc2626] bg-[#fff1f1] px-2 py-1 font-semibold text-[#9f1239] disabled:opacity-50"
                                    >
                                      {t.actionDeleteRender}
                                    </button>
                                  </div>
                                </div>
                              </div>
                            ))}
                            {renderAssets.length > 6 ? (
                              <p className="text-[10px] text-[var(--text-secondary)]">
                                {t.othersPrefix} {renderAssets.length - 6}{" "}
                                {t.othersSuffix}
                              </p>
                            ) : null}
                          </div>
                        )}
                      </div>
                    ) : null}
                    <details className="mt-3 rounded-xl border border-white/45 bg-white/45 p-3 backdrop-blur-xl">
                      <summary className="cursor-pointer text-xs font-semibold text-[var(--text-secondary)]">
                        {t.advancedMenu}
                      </summary>
                      <div className="mt-3 rounded-xl border border-white/45 bg-white p-3 text-xs text-[var(--text-secondary)]">
                        <p className="uppercase tracking-[0.18em] text-[10px] text-[var(--accent-strong)]">
                          {t.devServer}
                        </p>
                        {isDevRunning ? (
                          <>
                            <p className="mt-1 text-sm font-semibold text-[#286f79]">
                              {t.runningOn} :{devServer?.port}
                            </p>
                            <p className="mt-1 break-all text-[11px]">
                              PID: {devServer?.pid} / Log:{" "}
                              {devServer?.logPath || "(none)"}
                            </p>
                          </>
                        ) : (
                          <p className="mt-1 text-sm text-[var(--text-secondary)]">
                            {t.stopped}
                          </p>
                        )}
                      </div>
                      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                        <button
                          type="button"
                          onClick={() =>
                            isDevRunning ? stopDev(project) : runDev(project)
                          }
                          disabled={busyKey === devButtonKey}
                          className={cn(
                            "rounded-lg px-2 py-2 text-xs font-semibold transition hover:-translate-y-0.5 disabled:opacity-50",
                            isDevRunning
                              ? "border border-[#f39800] bg-[#fff1e1] text-[#8b5600]"
                              : "border border-[#59b9c6] bg-[#e8f7f9] text-[#286f79]",
                          )}
                        >
                          {isDevRunning ? t.actionStopDev : t.actionRunDev}
                        </button>
                        <button
                          type="button"
                          onClick={() => openDev(project)}
                          disabled={!isDevRunning}
                          className="rounded-lg border border-[#59b9c6] bg-[#eaf4fc] px-2 py-2 text-xs font-semibold text-[#2f6270] transition hover:-translate-y-0.5 disabled:opacity-50"
                        >
                          {t.actionOpenDev}
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleEditor(project)}
                          className="rounded-lg border border-[#7058a3] bg-[#efe9f8] px-2 py-2 text-xs font-semibold text-[#4e327f] transition hover:-translate-y-0.5"
                        >
                          {editorOpen ? t.actionCloseMeta : t.actionOpenMeta}
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={() => void deleteProject(project)}
                        disabled={isDeletingProject}
                        className="mt-2 w-full rounded-lg border border-[#dc2626] bg-[#fff1f1] px-2 py-2 text-xs font-semibold text-[#9f1239] transition hover:-translate-y-0.5 disabled:opacity-50"
                      >
                        {t.actionDeleteProject}
                      </button>
                    </details>
                    {editorOpen && draft ? (
                      <div className="mt-4 space-y-2 rounded-xl border border-white/45 bg-[#faf9f6]/75 p-3 backdrop-blur-xl">
                        <input
                          value={draft.title}
                          onChange={(event) =>
                            setDrafts((prev) => ({
                              ...prev,
                              [project.appId]: {
                                ...draft,
                                title: event.target.value,
                              },
                            }))
                          }
                          placeholder={t.placeholderTitle}
                          className="w-full rounded-lg border border-[color:var(--line-soft)] bg-white px-2 py-1.5 text-xs text-[var(--text-primary)]"
                        />
                        <textarea
                          value={draft.description}
                          onChange={(event) =>
                            setDrafts((prev) => ({
                              ...prev,
                              [project.appId]: {
                                ...draft,
                                description: event.target.value,
                              },
                            }))
                          }
                          placeholder={t.placeholderDescription}
                          className="h-20 w-full rounded-lg border border-[color:var(--line-soft)] bg-white px-2 py-1.5 text-xs text-[var(--text-primary)]"
                        />
                        <input
                          value={draft.tags}
                          onChange={(event) =>
                            setDrafts((prev) => ({
                              ...prev,
                              [project.appId]: {
                                ...draft,
                                tags: event.target.value,
                              },
                            }))
                          }
                          placeholder={t.placeholderTags}
                          className="w-full rounded-lg border border-[color:var(--line-soft)] bg-white px-2 py-1.5 text-xs text-[var(--text-primary)]"
                        />
                        <input
                          value={draft.category}
                          onChange={(event) =>
                            setDrafts((prev) => ({
                              ...prev,
                              [project.appId]: {
                                ...draft,
                                category: event.target.value,
                              },
                            }))
                          }
                          placeholder={t.placeholderCategory}
                          className="w-full rounded-lg border border-[color:var(--line-soft)] bg-white px-2 py-1.5 text-xs text-[var(--text-primary)]"
                        />
                        <input
                          value={draft.thumbnail}
                          onChange={(event) =>
                            setDrafts((prev) => ({
                              ...prev,
                              [project.appId]: {
                                ...draft,
                                thumbnail: event.target.value,
                              },
                            }))
                          }
                          placeholder={t.placeholderThumbnail}
                          className="w-full rounded-lg border border-[color:var(--line-soft)] bg-white px-2 py-1.5 text-xs text-[var(--text-primary)]"
                        />
                        <button
                          type="button"
                          onClick={() => saveMeta(project)}
                          disabled={busyKey === `${project.appId}:save`}
                          className="w-full rounded-lg border border-[#f39800] bg-[#fff1e1] px-2 py-2 text-xs font-semibold text-[#8b5600] transition hover:-translate-y-0.5 disabled:opacity-50"
                        >
                          {t.save}
                        </button>
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              );
            })}
          </section>
        )}
        {preview ? (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
            onClick={() => setPreview(null)}
          >
            <div
              className="w-full max-w-5xl rounded-2xl border border-white/35 bg-[#0f172a]/75 p-4 text-white shadow-2xl backdrop-blur-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.18em] text-cyan-200">
                    {t.quickPreview}
                  </p>
                  <p className="mt-1 text-lg font-semibold">{preview.title}</p>
                  <p className="text-xs text-cyan-100">
                    {extractFileName(preview.relativePath)}
                  </p>
                  <p className="text-xs text-slate-300">
                    {preview.relativePath}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => openUrlWithFallback(preview.url)}
                    className="rounded-lg border border-cyan-300/60 bg-cyan-400/10 px-3 py-2 text-xs font-semibold text-cyan-100"
                  >
                    {t.openInNewTab}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreview(null)}
                    className="rounded-lg border border-white/30 bg-white/10 px-3 py-2 text-xs font-semibold text-white"
                  >
                    {t.close}
                  </button>
                </div>
              </div>
              <div className="overflow-hidden rounded-xl border border-white/10 bg-black">
                <video
                  key={preview.url}
                  controls
                  autoPlay
                  playsInline
                  preload="metadata"
                  className="aspect-video w-full"
                  src={preview.url}
                />
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-300">
                <span>
                  {t.appLabel}: {preview.appId}
                </span>
                <span>
                  {t.updatedLabel}:{" "}
                  {preview.updatedAt
                    ? formatLastRendered(preview.updatedAt, language)
                    : t.unknown}
                </span>
                <span>
                  {t.sizeLabel}:{" "}
                  {preview.size !== null
                    ? formatFileSize(preview.size)
                    : t.unknown}
                </span>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </main>
  );
}
