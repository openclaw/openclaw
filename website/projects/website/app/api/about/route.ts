import { NextResponse } from "next/server";
import {
  getOurStoryContent,
  getOurValueContent,
  getOurTeamContent,
  getOurMissionVisionContent,
} from "@/lib/notion";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const section = url.searchParams.get("section");

  try {
    if (section === "story") {
      const data = await getOurStoryContent();
      return NextResponse.json({ success: true, data });
    }
    if (section === "values") {
      const data = await getOurValueContent();
      return NextResponse.json({ success: true, data });
    }
    if (section === "team") {
      const data = await getOurTeamContent();
      return NextResponse.json({ success: true, data });
    }
    if (section === "mission-vision") {
      const data = await getOurMissionVisionContent();
      return NextResponse.json({ success: true, data });
    }

    const [values, team, story, missionVision] = await Promise.all([
      getOurValueContent(),
      getOurTeamContent(),
      getOurStoryContent(),
      getOurMissionVisionContent(),
    ]);
    return NextResponse.json({
      success: true,
      data: { values, team, story, missionVision },
    });
  } catch (error) {
    console.error("Error fetching about content:", error);
    return NextResponse.json(
      { success: false, message: "Failed to fetch about content" },
      { status: 500 }
    );
  }
}
