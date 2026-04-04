import { MetadataRoute } from 'next'
import { getProducts } from '@/lib/notion'

// Force dynamic rendering (no static generation)
export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // 靜態頁面（總是返回）
  const staticPages: MetadataRoute.Sitemap = [
    {
      url: 'https://www.thinker.cafe',
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 1,
    },
    {
      url: 'https://www.thinker.cafe/products',
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 0.9,
    },
    {
      url: 'https://www.thinker.cafe/about',
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.7,
    },
    {
      url: 'https://www.thinker.cafe/contact',
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.6,
    },
  ]

  try {
    console.log('[Sitemap] Starting to fetch products from Notion...')
    const products = await Promise.race([
      getProducts(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Notion API timeout')), 8000)
      )
    ]) as any[]
    console.log(`[Sitemap] Fetched ${products.length} products from Notion`)

    // 動態課程頁面
    const publishedProducts = products.filter((p: any) => p.published)
    console.log(`[Sitemap] Found ${publishedProducts.length} published products`)

    const productPages: MetadataRoute.Sitemap = publishedProducts.map((product: any) => ({
      url: `https://www.thinker.cafe/products/${product.id}`,
      lastModified: new Date(),
      changeFrequency: 'weekly' as const,
      priority: 0.8,
    }))

    console.log(`[Sitemap] Generated sitemap with ${staticPages.length} static + ${productPages.length} product pages`)
    return [...staticPages, ...productPages]
  } catch (error) {
    console.error('[Sitemap] Error generating sitemap:', error)
    console.error('[Sitemap] Error details:', error instanceof Error ? error.message : String(error))

    // 如果 Notion API 失敗，至少返回靜態頁面
    console.log('[Sitemap] Falling back to static pages only')
    return staticPages
  }
}
