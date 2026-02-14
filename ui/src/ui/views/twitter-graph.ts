/**
 * Twitter relationships graph visualization
 */

// @ts-expect-error -- echarts CJS module requires allowSyntheticDefaultImports
import * as echarts from "echarts";
import type { TwitterRelationships, TwitterUser } from "../controllers/twitter.js";

export function renderTwitterGraph(
  containerId: string,
  data: TwitterRelationships | null,
  loading: boolean,
): void {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (loading) {
    container.innerHTML = `
      <div class="graph-loading">
        <div class="spinner"></div>
        <p>Loading relationships...</p>
      </div>
    `;
    return;
  }

  if (!data) {
    container.innerHTML = `
      <div class="graph-error">
        <p>Failed to load relationships data.</p>
      </div>
    `;
    return;
  }

  // Initialize ECharts
  const chart = echarts.init(container);

  // Prepare nodes
  const nodes: any[] = [];
  const links: any[] = [];

  // Add current user as center node
  nodes.push({
    id: data.current_user.id,
    name: `@${data.current_user.username}`,
    username: data.current_user.username,
    symbolSize: 80,
    value: "You",
    category: 0,
    label: {
      show: true,
    },
  });

  // Add following users
  data.following.forEach((user: TwitterUser) => {
    nodes.push({
      id: user.id,
      name: user.name || `@${user.username}`,
      username: user.username,
      symbolSize: Math.min(30 + Math.log(user.followers + 1) * 3, 60),
      value: user.followers,
      category: user.isMutual ? 1 : 2,
      avatar: user.avatar,
      verified: user.verified,
      followers: user.followers,
      following: user.following,
      description: user.description,
      label: {
        show: user.followers > 10000 || user.isMutual,
        formatter: `@${user.username}`,
      },
    });

    // Create link from current user to followed user
    links.push({
      source: data.current_user.id,
      target: user.id,
      lineStyle: {
        color: user.isMutual ? "#10b981" : "#6b7280",
        width: user.isMutual ? 2 : 1,
      },
    });
  });

  // Categories for legend
  const categories = [{ name: "You" }, { name: "Mutual" }, { name: "Following" }];

  const option = {
    title: {
      text: "Twitter Relationships Network",
      subtext: `Following: ${data.following.length} | Mutual: ${data.following.filter((u) => u.isMutual).length}`,
      left: "center",
      textStyle: {
        color: "#f3f4f6",
        fontSize: 20,
      },
      subtextStyle: {
        color: "#9ca3af",
        fontSize: 14,
      },
    },
    tooltip: {
      formatter: (params: any) => {
        if (params.dataType === "node") {
          const data = params.data;
          if (data.category === 0) {
            return `<strong>${data.name}</strong><br/>Your account`;
          }
          return `
            <div style="min-width: 200px;">
              <div style="display: flex; align-items: center; margin-bottom: 8px;">
                ${data.avatar ? `<img src="${data.avatar}" style="width: 40px; height: 40px; border-radius: 50%; margin-right: 10px;" />` : ""}
                <div>
                  <strong>${data.name}</strong><br/>
                  <span style="color: #1da1f2;">@${data.username}</span>
                  ${data.verified ? ' <span style="color: #1da1f2;">✓</span>' : ""}
                </div>
              </div>
              ${data.description ? `<div style="margin-bottom: 8px; color: #9ca3af; font-size: 12px;">${data.description}</div>` : ""}
              <div style="display: flex; gap: 12px; font-size: 12px; color: #9ca3af;">
                <span><strong>${data.followers?.toLocaleString()}</strong> followers</span>
                <span><strong>${data.following?.toLocaleString()}</strong> following</span>
              </div>
              ${data.category === 1 ? '<div style="margin-top: 8px; color: #10b981;">↔️ Mutual</div>' : ""}
            </div>
          `;
        }
        return "";
      },
      backgroundColor: "rgba(17, 24, 39, 0.95)",
      borderColor: "#374151",
      textStyle: {
        color: "#f3f4f6",
      },
    },
    legend: [
      {
        data: categories.map((c) => c.name),
        orient: "vertical",
        left: "left",
        top: "middle",
        textStyle: {
          color: "#9ca3af",
        },
      },
    ],
    series: [
      {
        type: "graph",
        layout: "force",
        data: nodes,
        links: links,
        categories: categories,
        roam: true,
        label: {
          position: "right",
          color: "#f3f4f6",
          fontSize: 11,
        },
        labelLayout: {
          hideOverlap: true,
        },
        force: {
          repulsion: 800,
          gravity: 0.1,
          edgeLength: [100, 200],
          layoutAnimation: true,
        },
        emphasis: {
          focus: "adjacency",
          lineStyle: {
            width: 3,
          },
        },
        itemStyle: {
          borderColor: "#1f2937",
          borderWidth: 2,
        },
      },
    ],
  };

  chart.setOption(option);

  // Handle resize
  const resizeObserver = new ResizeObserver(() => {
    chart.resize();
  });
  resizeObserver.observe(container);

  // Store chart instance for cleanup
  (container as any).__echartsInstance = chart;
}

export function cleanupTwitterGraph(containerId: string): void {
  const container = document.getElementById(containerId);
  if (container && (container as any).__echartsInstance) {
    (container as any).__echartsInstance.dispose();
    delete (container as any).__echartsInstance;
  }
}
