import { NextResponse } from "next/server";
import { apmGet } from "@/lib/apmt";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const facilityCode = searchParams.get("facilityCode")?.trim() ?? "";
    const assetId = searchParams.get("assetId")?.trim() ?? "";
    if (!facilityCode || !assetId) {
      return NextResponse.json({ error: "facilityCode and assetId are required" }, { status: 400 });
    }
    const data = await apmGet("/booking-enquiry", { facilityCode, assetId });
    return NextResponse.json(data);
  } catch (error) {
    console.error("booking-enquiry failed", error);
    return NextResponse.json({ error: "APMT request failed" }, { status: 500 });
  }
}
