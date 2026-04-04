"use client";

import { useState, useEffect } from "react";
import { useRouter } from 'next/navigation';
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { LanguageToggle } from "@/components/language-toggle";
// import { ThemeToggle } from "@/components/theme-toggle"
import { Menu, X } from "lucide-react";
import { createClient } from '@/utils/supabase/client.ts';

export function Navigation() {
  const [isOpen, setIsOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [user, setUser] = useState(undefined);
  const router = useRouter();
  const supabase = createClient();

  async function onSignOutClick(e) {
    e.preventDefault();
    await supabase.auth.signOut();
    router.refresh();
    router.push('/');
  }

  useEffect(() => {
    let mounted = true;

    async function initUser() {
      const { data: { user } } = await supabase.auth.getUser();
      if (mounted) {
        setUser(user);
      }
    }

    initUser();
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (mounted) {
        setUser(session?.user ?? null);
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    const handleScroll = () => {
      const scrollPosition = window.scrollY;
      setScrolled(scrollPosition > 50);
    };

    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const navItems = [
    { href: "/", label: "Home", labelZh: "首頁" },
    { href: "/products", label: "Products", labelZh: "課程一覽" },
    { href: "/about", label: "About", labelZh: "團隊簡介" },
    { href: "/contact", label: "Contact", labelZh: "聯絡我們" },
  ];
  if (user === null) {
    navItems.push({ href: "/signin", label: "Sign In", labelZh: "登入/註冊" });
  } else {
    navItems.push({ href: '/orders', label: 'My Courses', labelZh: '我的課程' });
  }

  return (
    <nav className="fixed top-5 left-1/2 transform -translate-x-1/2 z-50 w-full max-w-6xl px-5">
      <div
        className={`bg-background/40 backdrop-blur-md rounded-2xl shadow-lg shadow-black/5 px-4 md:px-5 transition-all duration-300 ${
          scrolled
            ? "bg-background/30 border-border/20 shadow-black/5"
            : "bg-background/80 border-border/50 shadow-black/10"
        }`}
      >
        <div className="flex h-14 items-center justify-between">
          {/* Logo */}
          <Link
            href="/"
            className="flex items-center gap-2 flex-shrink-0 text-foreground"
            prefetch
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
              <img src="/logo.png" alt="Logo" className="w-full h-full" />
            </div>
            <span className="font-heading text-xl font-bold hidden sm:block">
              Thinker Cafe
            </span>
            <span className="font-heading text-lg font-bold sm:hidden">Thinker Cafe</span>
          </Link>

          {/* Desktop Navigation */}
          <div className="hidden md:flex items-center gap-6 lg:gap-8">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="text-sm font-medium text-muted-foreground transition-colors hover:text-white relative group "
                prefetch
              >
                {item.labelZh}
                <span className="absolute -bottom-1 left-0 w-0 h-0.5  transition-all duration-300 group-hover:w-full bg-gradient-to-r from-orange-600 to-pink-600"></span>
              </Link>
            ))}
            {user && (
              <a
                href="#"
                className="text-sm font-medium text-muted-foreground transition-colors hover:text-white relative group"
                onClick={onSignOutClick}
              >
                登出
                <span className="absolute -bottom-1 left-0 w-0 h-0.5 transition-all duration-300 group-hover:w-full bg-gradient-to-r from-orange-600 to-pink-600"></span>
              </a>
            )}
            {/*
            <div className="flex items-center gap-2">
              <ThemeToggle />
              <LanguageToggle />
            </div>
            */}
          </div>

          {/* Mobile Menu Button */}
          <Button
            variant="ghost"
            size="sm"
            className="md:hidden p-2 hover:bg-gradient-to-r hover:from-orange-600 hover:to-pink-600"
            onClick={() => setIsOpen(!isOpen)}
            aria-label="Toggle menu"
          >
            {isOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </Button>
        </div>

        {/* Mobile Navigation */}
        {isOpen && (
          <div className="md:hidden border-t border-border/50 py-4 animate-in slide-in-from-top-2 duration-200">
            <div className="flex flex-col gap-4">
              {navItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="text-sm font-medium text-muted-foreground transition-colors hover:text-white py-2 px-2 rounded-md hover:bg-muted/50"
                  onClick={() => setIsOpen(false)}
                  prefetch
                >
                  {item.labelZh}
                </Link>
              ))}
              {user && (
                <a
                  href="#"
                  className="text-sm font-medium text-muted-foreground transition-colors hover:text-white py-2 px-2 rounded-md hover:bg-muted/50"
                  onClick={onSignOutClick}
                >
                  登出
                </a>
              )}
              {/*
              <div className="pt-2 border-t border-border/50 flex items-center justify-between">
                <LanguageToggle />
                <ThemeToggle />
              </div>
              */}
            </div>
          </div>
        )}
      </div>
    </nav>
  );
}
