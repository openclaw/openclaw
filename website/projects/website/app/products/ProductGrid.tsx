"use client";

import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { NotionProduct } from "@/lib/notion";
import { parseCourseName } from '@/utils/course.js';
import Link from "next/link";
import Image from "next/image";
import { trackViewCourse } from "@/lib/analytics";

export function ProductGrid() {
  const [language, setLanguage] = useState<"en" | "zh">("en");
  const [selectedCategory, setSelectedCategory] = useState<string>("全部");
  const [products, setProducts] = useState<NotionProduct[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchProducts = async () => {
      try {
        const response = await fetch("/api/products");
        const data = await response.json();
        if (data.success) {
          setProducts(data.data);
        }
      } catch (error) {
        console.error("Error fetching products:", error);
        setProducts([]);
      } finally {
        setLoading(false);
      }
    };

    fetchProducts();
  }, []);

  const en_categories = [
    "all",
    ...Array.from(new Set(products.map((product) => product.en_category))),
  ];
  const zh_categories = [
    "全部",
    ...Array.from(new Set(products.map((product) => product.zh_category))),
  ];

  const filteredProducts =
    selectedCategory === "全部"
      ? products
      : products.filter((product) => product.zh_category === selectedCategory);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary animate-glow"></div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2 animate-fade-in">
        {zh_categories.map((category, index) => (
          <Button
            key={category}
            variant={selectedCategory === category ? "default" : "outline"}
            size="sm"
            onClick={() => setSelectedCategory(category)}
            className={`transition-all duration-200 border-0 hover:from-orange-600 hover:to-pink-600 ${
              selectedCategory === category
                ? "bg-gradient-to-r from-orange-500 to-pink-500 bg-gradient-animate text-white"
                : "text-gray-300 hover:text-white"
            }`}
          >
            {category}
          </Button>
        ))}
      </div>
      <div className="grid grid-cols-1 auto-rows-max gap-5 md:grid-cols-2 lg:grid-cols-3">
        {filteredProducts.map((product, index) => (
          <Link
            key={product.id}
            href={`/products/${product.id}`}
            prefetch
            onClick={() => {
              trackViewCourse({
                id: product.course_id.toString(),
                name: product.zh_name,
                category: product.zh_category,
                price: product.group_price || product.single_price || 0
              });
            }}
          >
            <Card
              key={product.id}
              className={`h-full group p-4 overflow-hidden border-0 bg-card/50 backdrop-blur hover:shadow-3xl transition-all duration-300 hover-lift animate-fade-in`}
              style={{ animationDelay: `${index * 0.1}s` }}
            >
              <CardContent className="px-0 space-y-2">
                <div className="relative overflow-hidden rounded-md h-40">
                  <Image
                    src={product.image || "/placeholder.svg"}
                    alt={product.zh_name}
                    fill
                    sizes="(max-width: 768px) 100vw, (max-width: 1024px) 50vw, 33vw"
                    className="object-cover transition-transform duration-300 group-hover:scale-110"
                    loading="lazy"
                  />
                  {product.featured && (
                    <Badge className="absolute top-2 left-2 animate-glow bg-gradient-to-r from-orange-400 to-pink-500 text-black bg-gradient-animate z-10">
                      精選
                    </Badge>
                  )}
                  {product.course_id !== 6 && (
                    <Badge className="absolute top-2 right-2 bg-gray-600/90 text-white z-10">
                      即將開放
                    </Badge>
                  )}
                  {/* <div className="absolute top-3 right-3 flex items-center gap-1 bg-background/80 backdrop-blur px-2 py-1 rounded-full transition-all duration-200 hover:bg-background/90">
                  <Star className="h-3 w-3 fill-primary text-primary" />
                  <span className="text-xs font-medium">{product.rating}</span>
                </div> */}
                </div>
                    <Badge
                      variant="secondary"
                      className="text-xs transition-colors duration-200 border border-gray-500"
                    >
                      {product.zh_category}
                    </Badge>
                  <h3 className="font-heading text-lg font-semibold transition-colors duration-200">
                    {parseCourseName(product)}
                  </h3>
                  <p className="text-sm text-muted-foreground line-clamp-3">
                    {product.zh_description}
                  </p>
                  {/* <div className="flex items-center justify-between">
                  <span className="font-heading text-lg font-bold text-primary">{product.price}</span>
                  <Button size="sm" className="bg-primary hover:bg-primary/90 hover-lift hover-glow">
                    <ShoppingCart className="h-4 w-4 mr-1" />
                    {language === "en" ? "Add" : "加入"}
                  </Button>
                </div> */}
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      {filteredProducts.length === 0 && (
        <div className="text-center py-12 animate-fade-in">
          <p className="text-muted-foreground">
            No products found in this category.
          </p>
        </div>
      )}
    </div>
  );
}
