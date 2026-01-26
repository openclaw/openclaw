/**
 * Animation utilities for the landing page
 */

/**
 * Intersection Observer for scroll-triggered animations
 */
export function createScrollObserver(
  options: IntersectionObserverInit = {}
): IntersectionObserver {
  const defaultOptions: IntersectionObserverInit = {
    root: null,
    rootMargin: '0px 0px -10% 0px',
    threshold: 0.1,
    ...options,
  };

  return new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
      }
    });
  }, defaultOptions);
}

/**
 * Parallax scroll effect
 */
export function initParallax(container: HTMLElement): () => void {
  const layers = container.querySelectorAll<HTMLElement>('.parallax-layer');

  function updateParallax() {
    const scrollY = window.scrollY;
    const containerRect = container.getBoundingClientRect();
    const containerTop = containerRect.top + scrollY;
    const relativeScroll = scrollY - containerTop;

    layers.forEach((layer) => {
      const speed = parseFloat(
        getComputedStyle(layer).getPropertyValue('--parallax-speed') || '0.5'
      );
      const yOffset = relativeScroll * speed;
      // Use a CSS custom property so transform compositions aren't overwritten
      layer.style.setProperty('--parallax-y', `${yOffset}px`);
    });
  }

  window.addEventListener('scroll', updateParallax, { passive: true });
  updateParallax();

  return () => window.removeEventListener('scroll', updateParallax);
}

/**
 * Text rotation animation controller
 */
export class TextRotator {
  private element: HTMLElement;
  private texts: string[];
  private currentIndex = 0;
  private interval: number;
  private timerId?: ReturnType<typeof setInterval>;

  constructor(element: HTMLElement, texts: string[], interval = 3000) {
    this.element = element;
    this.texts = texts;
    this.interval = interval;
  }

  start(): void {
    this.render();
    this.timerId = setInterval(() => this.next(), this.interval);
  }

  stop(): void {
    if (this.timerId) {
      clearInterval(this.timerId);
    }
  }

  private next(): void {
    this.currentIndex = (this.currentIndex + 1) % this.texts.length;
    this.animate();
  }

  private animate(): void {
    this.element.style.animation = 'textRotateOut 0.4s ease-in forwards';

    setTimeout(() => {
      this.render();
      this.element.style.animation = 'textRotateIn 0.4s ease-out forwards';
    }, 400);
  }

  private render(): void {
    this.element.textContent = this.texts[this.currentIndex];
  }
}

/**
 * Smooth scroll to anchor
 */
export function smoothScrollTo(target: string | HTMLElement): void {
  const element = typeof target === 'string'
    ? document.querySelector(target)
    : target;

  if (element) {
    element.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  }
}

/**
 * Staggered animation for multiple elements
 */
export function staggerAnimation(
  elements: NodeListOf<Element> | Element[],
  animationClass: string,
  staggerMs = 100
): void {
  Array.from(elements).forEach((el, index) => {
    setTimeout(() => {
      el.classList.add(animationClass);
    }, index * staggerMs);
  });
}

/**
 * Debounce utility for scroll handlers
 */
export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}

/**
 * Throttle utility for scroll handlers
 */
export function throttle<T extends (...args: unknown[]) => void>(
  fn: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle = false;
  return (...args: Parameters<T>) => {
    if (!inThrottle) {
      fn(...args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
}
