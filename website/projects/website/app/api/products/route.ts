import { NextResponse } from "next/server";
import { getProducts } from "@/lib/notion";
import { createClient } from '@/utils/supabase/server.ts';

export async function GET() {
  try {
    const supabase = await createClient();
    const { data: courses, error } = await supabase
      .from('courses')
      .select();

    if (error) {
      const { code, message } = error;
      throw new Error(`[${code}] ${message}`);
    }

    const products = await getProducts();
    const result = courses
      .map(({ course_id }) => products.find(product => product.course_id === course_id))
      .filter(object => object !== undefined)
      .filter(({ published }) => published === true)
      .sort((a, b) => b.sort_desc - a.sort_desc);

    return NextResponse.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("Error fetching products:", error);
    return NextResponse.json(
      {
        success: false,
        message: "Failed to fetch products",
      },
      { status: 500 }
    );
  }
}
