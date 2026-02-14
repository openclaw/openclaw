/**
 * Twitter data loader for UI
 */

import { loadTwitterData, loadTwitterRelationships } from "./controllers/twitter.ts";
import { renderTwitterGraph, cleanupTwitterGraph } from "./views/twitter-graph.ts";
import { renderTwitterView } from "./views/twitter.ts";

let currentTab: "dashboard" | "relationships" = "dashboard";
let dashboardData: any = null;
let relationshipsData: any = null;

export async function loadAndRenderTwitter(): Promise<void> {
  // Set loading state
  (window as any).__twitter_view_html__ = renderTwitterView(null, true, currentTab);

  // Trigger re-render
  if ((window as any).__openclaw_app__?.requestUpdate) {
    (window as any).__openclaw_app__.requestUpdate();
  }

  // Load dashboard data
  dashboardData = await loadTwitterData();

  // Render view with dashboard
  (window as any).__twitter_view_html__ = renderTwitterView(dashboardData, false, currentTab);

  // Trigger re-render
  if ((window as any).__openclaw_app__?.requestUpdate) {
    (window as any).__openclaw_app__.requestUpdate();
  }

  // Setup tab listeners after render
  setupTabListeners();

  // If on relationships tab, load and render graph
  if (currentTab === "relationships") {
    await loadAndRenderRelationships();
  }
}

async function loadAndRenderRelationships(): Promise<void> {
  const container = document.getElementById("twitter-graph-container");
  if (!container) {
    // Wait a bit and try again (DOM might not be ready)
    setTimeout(loadAndRenderRelationships, 100);
    return;
  }

  // Show loading in graph
  renderTwitterGraph("twitter-graph-container", null, true);

  // Load relationships data
  if (!relationshipsData) {
    relationshipsData = await loadTwitterRelationships(50);
  }

  // Render graph
  renderTwitterGraph("twitter-graph-container", relationshipsData, false);
}

function setupTabListeners(): void {
  const tabButtons = document.querySelectorAll(".tab-button");

  tabButtons.forEach((button) => {
    button.addEventListener("click", async (e) => {
      const target = e.target as HTMLElement;
      const tab = target.getAttribute("data-tab") as "dashboard" | "relationships";

      if (!tab || tab === currentTab) return;

      // Update current tab
      currentTab = tab;

      // Update active states
      tabButtons.forEach((btn) => btn.classList.remove("active"));
      target.classList.add("active");

      const panels = document.querySelectorAll(".tab-panel");
      panels.forEach((panel) => panel.classList.remove("active"));

      const activePanel = document.querySelector(`[data-panel="${tab}"]`);
      if (activePanel) {
        activePanel.classList.add("active");
      }

      // Load relationships if switching to that tab
      if (tab === "relationships") {
        await loadAndRenderRelationships();
      }
    });
  });
}

// Auto-load when tab changes to twitter
if (typeof window !== "undefined") {
  let lastTab = "";
  setInterval(() => {
    const currentPath = window.location.pathname;
    if (currentPath.includes("/twitter") && lastTab !== "twitter") {
      lastTab = "twitter";
      void loadAndRenderTwitter();
    } else if (!currentPath.includes("/twitter")) {
      lastTab = "";
      // Cleanup graph when leaving
      cleanupTwitterGraph("twitter-graph-container");
    }
  }, 500);
}
