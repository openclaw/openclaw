# Use Cases

Common use cases and examples for the Remotion Studio Monorepo.

## 🎬 Video Production

### Marketing Videos

Create promotional videos with dynamic content:

```typescript
import { FadeIn, SlideIn } from '@studio/transitions';
import { easeOutCubic } from '@studio/easings';
import { useFrameProgress } from '@studio/hooks';

export const PromoVideo = () => {
  const progress = useFrameProgress(0, 90);

  return (
    <>
      <FadeIn startFrame={0} duration={20}>
        <Logo />
      </FadeIn>

      <SlideIn startFrame={20} duration={30} direction="up">
        <ProductShowcase />
      </SlideIn>

      <FadeIn startFrame={60} duration={20}>
        <CallToAction />
      </FadeIn>
    </>
  );
};
```

### Social Media Content

Short-form videos for social platforms:

- **Aspect Ratios**: 1:1 (Instagram), 9:16 (Stories/Reels), 16:9 (YouTube)
- **Duration**: 15-60 seconds
- **Features**: Text animations, brand overlays, dynamic backgrounds

### Explainer Videos

Educational content with animations:

```typescript
import { Sequence } from 'remotion';

export const ExplainerVideo = () => {
  return (
    <>
      <Sequence from={0} durationInFrames={120}>
        <Introduction />
      </Sequence>

      <Sequence from={120} durationInFrames={180}>
        <MainContent />
      </Sequence>

      <Sequence from={300} durationInFrames={60}>
        <Conclusion />
      </Sequence>
    </>
  );
};
```

## 📊 Data Visualization

### Animated Charts

Create dynamic data visualizations:

```typescript
import { interpolate, useCurrentFrame } from 'remotion';
import { getProgress } from '@studio/timing';

export const AnimatedChart = ({ data }) => {
  const frame = useCurrentFrame();
  const progress = getProgress(frame, 0, 60);

  return (
    <svg>
      {data.map((value, index) => (
        <rect
          key={index}
          height={value * progress}
          width={50}
          x={index * 60}
        />
      ))}
    </svg>
  );
};
```

### Infographics

Animated information graphics:

- Timeline visualizations
- Statistical comparisons
- Process flows
- Maps and geography

## 🎓 Educational Content

### Tutorial Videos

Step-by-step tutorials with code highlights:

```typescript
import { CodeBlock } from './components/CodeBlock';
import { Annotation } from './components/Annotation';

export const Tutorial = () => {
  return (
    <>
      <CodeBlock
        code={`function example() {
  return "Hello";
}`}
        highlightLines={[2]}
        startFrame={0}
      />

      <Annotation
        text="This returns a string"
        position={{ x: 100, y: 100 }}
        startFrame={30}
      />
    </>
  );
};
```

### Course Intros

Branded introductions for online courses:

- Instructor introduction
- Course overview
- Learning objectives
- Module previews

## 🎨 Creative Projects

### Music Visualizations

Audio-reactive visualizations:

```typescript
import { Audio, useAudioData, visualizeAudio } from 'remotion';

export const MusicVisualization = () => {
  const audioData = useAudioData('/music.mp3');

  return (
    <>
      <Audio src="/music.mp3" />
      <Visualizer data={audioData} />
    </>
  );
};
```

### Animated Presentations

Dynamic slides with transitions:

- Conference presentations
- Pitch decks
- Product demos
- Portfolio showcases

## 💼 Business Applications

### Report Generation

Automated video reports:

```typescript
export const MonthlyReport = ({ data }) => {
  return (
    <>
      <ReportHeader date={data.month} />
      <MetricsOverview metrics={data.metrics} />
      <TrendChart data={data.trends} />
      <Conclusion insights={data.insights} />
    </>
  );
};
```

### Product Demos

Showcase features and functionality:

- App walkthroughs
- Feature highlights
- Comparison videos
- Release announcements

## 🎮 Gaming & Entertainment

### Game Trailers

Promotional content for games:

- Gameplay footage
- Feature highlights
- Story teasers
- Launch announcements

### Streaming Assets

Graphics for live streams:

- Overlays
- Transitions
- Alerts
- Lower thirds

## 🔄 Automation

### Bulk Video Generation

Generate multiple videos from data:

```typescript
// Generate videos for each product
const products = await fetchProducts();

for (const product of products) {
  await renderVideo({
    compositionId: "ProductVideo",
    inputProps: { product },
    outputLocation: `videos/${product.id}.mp4`,
  });
}
```

### Scheduled Content

Automatically generate and publish:

- Daily news summaries
- Weather forecasts
- Stock market updates
- Social media posts

## 🌐 Localization

### Multi-language Videos

Generate videos in multiple languages:

```typescript
export const LocalizedVideo = ({ language }) => {
  const t = useTranslation(language);

  return (
    <>
      <h1>{t('title')}</h1>
      <p>{t('description')}</p>
    </>
  );
};
```

### Regional Variations

Customize content for different regions:

- Currency formatting
- Date/time formats
- Local imagery
- Cultural adaptations

## 📱 App Features

### User Onboarding

Welcome videos for new users:

- Feature tours
- Getting started guides
- Tips and tricks
- Success stories

### Notifications

Rich notification content:

- Achievement unlocks
- Progress updates
- Milestone celebrations
- Event announcements

## 🎯 Best Practices

### Performance

- Use `<Sequence>` to split compositions
- Optimize asset loading with `staticFile()`
- Use appropriate codecs and quality settings
- Consider rendering concurrency

### Organization

- Group related compositions
- Use shared components
- Maintain consistent naming
- Document inputProps

### Testing

- Preview compositions frequently
- Test at different frame rates
- Verify audio synchronization
- Check edge cases

## 📚 Resources

- [Remotion Documentation](https://remotion.dev)
- [Example Projects](../examples/)
- [Component Library](../packages/@studio/)
- [Scripts and Tools](../scripts/)

## 🤝 Contributing

Have a use case to share? Contribute to this document:

1. Fork the repository
2. Add your use case
3. Include code examples
4. Submit a pull request
