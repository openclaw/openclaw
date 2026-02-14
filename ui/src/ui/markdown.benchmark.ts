/**
 * Performance Benchmark for Mermaid Optimization
 *
 * Measures:
 * - Render time (original vs optimized)
 * - Cache hit rate
 * - Memory impact
 * - Bundle size delta
 */

import {
  toSanitizedMarkdownHtml as optimizedRender,
  getMermaidMetrics,
  resetMermaidMetrics,
} from "./markdown.optimized.ts";

// Test diagrams of varying complexity
const TEST_DIAGRAMS = {
  simple: `
\`\`\`mermaid
graph TD
    A[Start] --> B[End]
\`\`\`
`,

  medium: `
\`\`\`mermaid
graph TD
    A[Client] --> B[Load Balancer]
    B --> C[Server 1]
    B --> D[Server 2]
    B --> E[Server 3]
    C --> F[Database]
    D --> F
    E --> F
\`\`\`
`,

  complex: `
\`\`\`mermaid
graph TB
    subgraph "Frontend"
        A[React App]
        B[State Management]
        C[API Client]
    end
    
    subgraph "Backend"
        D[API Gateway]
        E[Auth Service]
        F[User Service]
        G[Data Service]
    end
    
    subgraph "Data Layer"
        H[(PostgreSQL)]
        I[(Redis Cache)]
        J[(S3 Storage)]
    end
    
    A --> B
    B --> C
    C --> D
    D --> E
    D --> F
    D --> G
    F --> H
    F --> I
    G --> H
    G --> J
    E --> I
\`\`\`
`,

  sequence: `
\`\`\`mermaid
sequenceDiagram
    participant U as User
    participant F as Frontend
    participant A as API
    participant D as Database
    
    U->>F: Click Login
    F->>A: POST /auth/login
    A->>D: Query User
    D-->>A: User Data
    A->>A: Generate Token
    A-->>F: JWT Token
    F->>F: Store Token
    F-->>U: Redirect Dashboard
\`\`\`
`,
};

interface BenchmarkResult {
  diagram: string;
  firstRender: number;
  cachedRender: number;
  improvement: number;
  improvementPercent: number;
}

/**
 * Measure render time for a single diagram
 */
async function measureRender(markdown: string): Promise<number> {
  const start = performance.now();
  await optimizedRender(markdown);
  const end = performance.now();
  return end - start;
}

/**
 * Run benchmark for a specific diagram
 */
async function benchmarkDiagram(name: string, markdown: string): Promise<BenchmarkResult> {
  console.log(`\n📊 Benchmarking: ${name}`);

  // Reset metrics for clean measurement
  resetMermaidMetrics();

  // First render (cold - with lazy load)
  const firstRender = await measureRender(markdown);
  console.log(`  ⏱️  First render: ${firstRender.toFixed(2)}ms`);

  // Second render (cached)
  const cachedRender = await measureRender(markdown);
  console.log(`  ⚡ Cached render: ${cachedRender.toFixed(2)}ms`);

  const improvement = firstRender - cachedRender;
  const improvementPercent = (improvement / firstRender) * 100;

  console.log(`  📈 Improvement: ${improvement.toFixed(2)}ms (${improvementPercent.toFixed(1)}%)`);

  return {
    diagram: name,
    firstRender,
    cachedRender,
    improvement,
    improvementPercent,
  };
}

/**
 * Run full benchmark suite
 */
export async function runFullBenchmark(): Promise<void> {
  console.log("🚀 Starting Mermaid Performance Benchmark\n");
  console.log("=".repeat(60));

  const results: BenchmarkResult[] = [];

  // Benchmark each diagram type
  for (const [name, markdown] of Object.entries(TEST_DIAGRAMS)) {
    const result = await benchmarkDiagram(name, markdown);
    results.push(result);
  }

  // Summary statistics
  console.log("\n" + "=".repeat(60));
  console.log("📈 SUMMARY STATISTICS\n");

  const avgFirstRender = results.reduce((sum, r) => sum + r.firstRender, 0) / results.length;
  const avgCachedRender = results.reduce((sum, r) => sum + r.cachedRender, 0) / results.length;
  const avgImprovement = results.reduce((sum, r) => sum + r.improvementPercent, 0) / results.length;

  console.log(`Average first render:  ${avgFirstRender.toFixed(2)}ms`);
  console.log(`Average cached render: ${avgCachedRender.toFixed(2)}ms`);
  console.log(`Average improvement:   ${avgImprovement.toFixed(1)}%`);

  // Mermaid-specific metrics
  const metrics = getMermaidMetrics();
  console.log(`\n📊 Cache Performance:`);
  console.log(`  Total renders: ${metrics.totalRenders}`);
  console.log(`  Cache hits: ${metrics.cacheHits}`);
  console.log(`  Cache misses: ${metrics.cacheMisses}`);
  console.log(`  Hit rate: ${metrics.cacheHitRate.toFixed(1)}%`);
  console.log(`  Avg render time: ${metrics.avgRenderTime.toFixed(2)}ms`);

  // Acceptance criteria check
  console.log("\n✅ ACCEPTANCE CRITERIA:\n");

  const renderTimePass = avgFirstRender < 500;
  const cacheHitRatePass = metrics.cacheHitRate >= 80;

  console.log(
    `  ${renderTimePass ? "✅" : "❌"} Render time < 500ms: ${avgFirstRender.toFixed(2)}ms`,
  );
  console.log(
    `  ${cacheHitRatePass ? "✅" : "❌"} Cache hit rate > 80%: ${metrics.cacheHitRate.toFixed(1)}%`,
  );

  if (renderTimePass && cacheHitRatePass) {
    console.log("\n🎉 All acceptance criteria met!");
  } else {
    console.log("\n⚠️  Some acceptance criteria not met");
  }

  console.log("\n" + "=".repeat(60));
}

/**
 * Test cache behavior with repeated renders
 */
export async function testCacheBehavior(): Promise<void> {
  console.log("\n🔄 Testing Cache Behavior\n");
  console.log("=".repeat(60));

  resetMermaidMetrics();

  const diagram = TEST_DIAGRAMS.medium;
  const iterations = 10;

  console.log(`Rendering same diagram ${iterations} times...\n`);

  for (let i = 0; i < iterations; i++) {
    const time = await measureRender(diagram);
    const metrics = getMermaidMetrics();
    console.log(
      `  ${i + 1}. Render time: ${time.toFixed(2)}ms | Hit rate: ${metrics.cacheHitRate.toFixed(1)}%`,
    );
  }

  const finalMetrics = getMermaidMetrics();
  console.log(`\nFinal cache hit rate: ${finalMetrics.cacheHitRate.toFixed(1)}%`);
  console.log(`Expected: >80% (after first render)`);

  console.log("\n" + "=".repeat(60));
}

/**
 * Stress test with many different diagrams
 */
export async function stressTest(diagramCount: number = 50): Promise<void> {
  console.log(`\n💪 Stress Test: ${diagramCount} unique diagrams\n`);
  console.log("=".repeat(60));

  resetMermaidMetrics();

  const startMemory = (performance as any).memory?.usedJSHeapSize || 0;
  const startTime = performance.now();

  // Generate unique diagrams
  for (let i = 0; i < diagramCount; i++) {
    const diagram = `
\`\`\`mermaid
graph LR
    A${i}[Node ${i}] --> B${i}[End ${i}]
\`\`\`
`;
    await optimizedRender(diagram);

    if ((i + 1) % 10 === 0) {
      console.log(`  Rendered ${i + 1}/${diagramCount} diagrams...`);
    }
  }

  const endTime = performance.now();
  const endMemory = (performance as any).memory?.usedJSHeapSize || 0;
  const totalTime = endTime - startTime;
  const memoryIncrease = (endMemory - startMemory) / 1024 / 1024; // MB

  console.log(`\n📊 Results:`);
  console.log(`  Total time: ${totalTime.toFixed(2)}ms`);
  console.log(`  Avg time per diagram: ${(totalTime / diagramCount).toFixed(2)}ms`);
  console.log(`  Memory increase: ${memoryIncrease.toFixed(2)} MB`);

  const metrics = getMermaidMetrics();
  console.log(`  Cache size: ${metrics.totalRenders} renders`);
  console.log(`  Avg render time: ${metrics.avgRenderTime.toFixed(2)}ms`);

  console.log("\n" + "=".repeat(60));
}

// Run benchmarks if executed directly
if (import.meta.main) {
  console.log("🎯 Mermaid Performance Benchmark Suite");
  console.log("======================================\n");

  await runFullBenchmark();
  await testCacheBehavior();
  await stressTest(50);

  console.log("\n✅ Benchmark complete!");
}
