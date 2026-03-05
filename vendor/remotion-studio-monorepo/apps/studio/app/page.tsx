import {
  DashboardClient,
  type ProjectListItem,
} from "@/components/dashboard-client";
import {
  buildThumbnailUrl,
  collectProjects,
  formatLastRendered,
} from "@/lib/project-meta";

export const dynamic = "force-dynamic";

export default async function Page() {
  const projects = await collectProjects().catch(() => []);
  const initialProjects: ProjectListItem[] = projects.map((project) => ({
    appId: project.appId,
    title: project.title,
    description: project.description,
    tags: project.tags,
    category: project.category,
    thumbnail: project.thumbnail,
    lastRendered: project.lastRendered,
    lastRenderedLabel: formatLastRendered(project.lastRendered),
    thumbnailUrl: buildThumbnailUrl(project),
    renderCount: project.renderCount,
    latestRenderFile: project.latestRenderFile,
    latestRenderAt: project.latestRenderAt,
  }));

  return <DashboardClient initialProjects={initialProjects} />;
}
