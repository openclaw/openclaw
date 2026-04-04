'use client';

import { ProductCarousel } from "@/components/product-carousel";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ArrowRight, Users, Route, Sparkles } from "lucide-react";
import { ScrollRevealSection } from "@/components/scroll-reveal-section";
import { ScrollReveal } from "@/components/scroll-reveal";
import Link from "next/link";
import { trackEvent } from "@/lib/analytics";

export default function HomePage() {
  return (
    <>
      <section className="relative overflow-hidden h-screen flex items-center justify-center">
        <div className="container mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
          <div className="text-center max-w-4xl mx-auto">
            <h1 className="font-heading text-4xl sm:text-5xl lg:text-7xl font-bold tracking-tight animate-fade-in text-white">
              開啟無限可能的{" "}
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-orange-400 to-pink-600 animate-glow">
                AI 課程
              </span>
            </h1>
            <p className="mt-6 text-lg lg:text-xl text-gray-400 max-w-2xl mx-auto animate-fade-in animate-delay-200">
              AI 時代來臨，讓 Thinker Cafe 的課程帶您贏在起跑點！
            </p>
            <div className="mt-10 flex flex-col sm:flex-row gap-4 justify-center animate-fade-in animate-delay-300">
              <Button
                size="lg"
                className="max-w-6xl bg-gradient-to-r from-orange-500 to-pink-500 hover:from-orange-600 hover:to-pink-600 text-white border-0 hover-lift hover-glow bg-gradient-animate flex justify-self-center"
                onClick={(e) => {
                  e.preventDefault();
                  trackEvent('click_explore_courses', {
                    source: 'hero_section',
                    location: 'homepage_top'
                  });
                  // 延遲導航，確保事件發送完成
                  setTimeout(() => {
                    window.location.href = '/products';
                  }, 100);
                }}
              >
                <ArrowRight className="mr-2 h-4 w-4" />
                探索課程
              </Button>
              {/* <Button
                size="lg"
                variant="outline"
                className="border-white/20 text-white hover:bg-white/10 hover-lift bg-transparent"
              >
                All Products
              </Button> */}
            </div>
          </div>
        </div>

        <div className="absolute bottom-8 left-1/2 transform -translate-x-1/2 animate-bounce">
          <div className="w-6 h-10 border-2 border-white/30 rounded-full flex justify-center">
            <div className="w-1 h-3 bg-white/50 rounded-full mt-2 animate-pulse"></div>
          </div>
        </div>
      </section>

      {/* Featured Products Section with Box Opening Animation */}
      <ScrollRevealSection className="py-16 sm:py-20 relative overflow-hidden">
        <div className="absolute inset-0 -z-10">
          <div
            className="absolute top-1/4 left-1/4 w-2 h-2 bg-primary/30 rounded-full animate-float-particles"
            style={{ animationDelay: "0s" }}
          />
          <div
            className="absolute top-1/3 right-1/3 w-1 h-1 bg-accent/40 rounded-full animate-float-particles"
            style={{ animationDelay: "2s" }}
          />
          <div
            className="absolute bottom-1/4 left-1/3 w-1.5 h-1.5 bg-primary/20 rounded-full animate-float-particles"
            style={{ animationDelay: "4s" }}
          />
          <div
            className="absolute top-1/2 right-1/4 w-1 h-1 bg-accent/30 rounded-full animate-float-particles"
            style={{ animationDelay: "1s" }}
          />
        </div>

        <div className="container mx-auto px-4 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-2xl text-center mb-12 sm:mb-16">
            <h2 className="font-heading text-2xl sm:text-3xl lg:text-4xl font-bold">
              精選課程
            </h2>
            <p className="mt-3 sm:mt-4 text-gray-400 text-sm sm:text-base">
              看看 Thinker Cafe 最受歡迎的 AI 課程有哪些。
            </p>
          </div>

          <div className="relative">
            <div className="absolute inset-0 -z-10 bg-gradient-to-r from-transparent via-primary/5 to-transparent rounded-2xl blur-2xl transform scale-110" />
            <ProductCarousel />
          </div>
        </div>
      </ScrollRevealSection>

      <ScrollReveal direction="up" delay={100}>
        <section className="py-16 sm:py-20">
          <div className="container mx-auto px-4 sm:px-6 lg:px-8">
            <ScrollReveal direction="fade" delay={200}>
              <div className="mx-auto max-w-2xl text-center">
                <h2 className="font-heading text-2xl sm:text-3xl lg:text-4xl font-bold">
                  為何選擇我們的課程？
                </h2>
                <p className="mt-3 sm:mt-4 text-gray-400 text-sm sm:text-base">
                  Thinker Cafe 的課程皆由 AI 專家 Cruz 親自操刀，帶您從入門到精通，一步步掌握未來必備的 AI 力！
                </p>
              </div>
            </ScrollReveal>

            <div className="mt-12 sm:mt-16 grid gap-6 sm:gap-8 sm:grid-cols-2 lg:grid-cols-3">
              <ScrollReveal direction="up" delay={300}>
                <Card className="border-0 bg-card/50 backdrop-blur hover-lift">
                  <CardContent className="p-4 sm:p-6 text-center">
                    <div className="mx-auto mb-3 sm:mb-4 flex h-10 w-10 sm:h-12 sm:w-12 items-center justify-center rounded-lg bg-primary/10 hover-glow">
                      <Users className="h-5 w-5 sm:h-6 sm:w-6 text-primary" />
                    </div>
                    <h3 className="font-heading text-lg sm:text-xl font-semibold">
                      專家規劃
                    </h3>
                    <p className="mt-2 text-xs sm:text-sm text-muted-foreground">
                      課程由 AI 專家親自規劃。內容嚴謹，專業與實用並重。
                    </p>
                  </CardContent>
                </Card>
              </ScrollReveal>

              <ScrollReveal direction="up" delay={400}>
                <Card className="border-0 bg-card/50 backdrop-blur hover-lift">
                  <CardContent className="p-4 sm:p-6 text-center">
                    <div className="mx-auto mb-3 sm:mb-4 flex h-10 w-10 sm:h-12 sm:w-12 items-center justify-center rounded-lg bg-accent/10 hover-glow">
                      <Route className="h-5 w-5 sm:h-6 sm:w-6 text-accent" />
                    </div>
                    <h3 className="font-heading text-lg sm:text-xl font-semibold">
                      路徑完整
                    </h3>
                    <p className="mt-2 text-xs sm:text-sm text-muted-foreground">
                      從基礎到進階的系統化教學，讓學生能穩健掌握 AI 技能。
                    </p>
                  </CardContent>
                </Card>
              </ScrollReveal>

              <ScrollReveal direction="up" delay={500}>
                <Card className="border-0 bg-card/50 backdrop-blur sm:col-span-2 lg:col-span-1 hover-lift">
                  <CardContent className="p-4 sm:p-6 text-center">
                    <div className="mx-auto mb-3 sm:mb-4 flex h-10 w-10 sm:h-12 sm:w-12 items-center justify-center rounded-lg bg-primary/10 hover-glow">
                      <Sparkles className="h-5 w-5 sm:h-6 sm:w-6 text-primary" />
                    </div>
                    <h3 className="font-heading text-lg sm:text-xl font-semibold">
                      實用性高
                    </h3>
                    <p className="mt-2 text-xs sm:text-sm text-muted-foreground">
                      著重實例與操作，學完後立刻就能在工作或生活中使用。
                    </p>
                  </CardContent>
                </Card>
              </ScrollReveal>
            </div>
          </div>
        </section>
      </ScrollReveal>

      <ScrollReveal direction="up" delay={200}>
        <section className="py-16 sm:py-20">
          <div className="container mx-auto px-4 sm:px-6 lg:px-8">
            <div className="mx-auto max-w-2xl text-center">
              <h2 className="font-heading text-2xl sm:text-3xl font-bold">
                準備好提升你的 AI 力了嗎？
              </h2>
              <p className="mt-3 sm:mt-4 text-gray-400 text-sm sm:text-base">
                立即報名 Thinker Cafe 的課程，開啟你的 AI 學習之旅。
              </p>
              <Button
                size="lg"
                className="bg-gradient-to-r from-orange-500 to-pink-500 hover:from-orange-600 hover:to-pink-600 text-white border-0 hover-lift hover-glow bg-gradient-animate mt-6"
                onClick={(e) => {
                  e.preventDefault();
                  trackEvent('click_explore_courses', {
                    source: 'cta_bottom',
                    location: 'homepage_bottom'
                  });
                  // 延遲導航，確保事件發送完成
                  setTimeout(() => {
                    window.location.href = '/products';
                  }, 100);
                }}
              >
                上課去！
              </Button>
            </div>
          </div>
        </section>
      </ScrollReveal>
    </>
  );
}
