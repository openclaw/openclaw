# Recipes

Quick recipes and code snippets for common tasks.

## 🎨 Animations

### Fade In with Delay

```typescript
import { interpolate, useCurrentFrame } from 'remotion';

const FadeInDelayed = ({ children, delay = 0, duration = 30 }) => {
  const frame = useCurrentFrame();

  const opacity = interpolate(
    frame,
    [delay, delay + duration],
    [0, 1],
    { extrapolateRight: 'clamp' }
  );

  return <div style={{ opacity }}>{children}</div>;
};
```

### Staggered List Animation

```typescript
import { stagger } from '@studio/timing';

const StaggeredList = ({ items }) => {
  return (
    <>
      {items.map((item, index) => (
        <FadeIn
          key={index}
          startFrame={stagger(index, 5)}
          duration={20}
        >
          <ListItem>{item}</ListItem>
        </FadeIn>
      ))}
    </>
  );
};
```

### Bounce Effect

```typescript
import { spring, useCurrentFrame, useVideoConfig } from 'remotion';

const BounceIn = ({ children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const scale = spring({
    frame,
    fps,
    config: {
      damping: 12,
      stiffness: 200,
    },
  });

  return (
    <div style={{ transform: `scale(${scale})` }}>
      {children}
    </div>
  );
};
```

## 📊 Data Visualization

### Animated Counter

```typescript
import { interpolate, useCurrentFrame } from 'remotion';

const Counter = ({ from, to, duration = 60 }) => {
  const frame = useCurrentFrame();

  const value = Math.round(
    interpolate(frame, [0, duration], [from, to], {
      extrapolateRight: 'clamp',
    })
  );

  return <span>{value.toLocaleString()}</span>;
};
```

### Progress Bar

```typescript
const ProgressBar = ({ progress, width = 300, height = 20 }) => {
  return (
    <div
      style={{
        width,
        height,
        backgroundColor: '#e0e0e0',
        borderRadius: height / 2,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          width: `${progress * 100}%`,
          height: '100%',
          backgroundColor: '#4caf50',
          transition: 'width 0.3s ease',
        }}
      />
    </div>
  );
};
```

### Pie Chart Animation

```typescript
const AnimatedPieChart = ({ data, radius = 100 }) => {
  const frame = useCurrentFrame();
  const progress = interpolate(frame, [0, 60], [0, 1]);

  let currentAngle = 0;

  return (
    <svg viewBox="0 0 200 200">
      {data.map((segment, index) => {
        const startAngle = currentAngle;
        const endAngle = currentAngle + segment.value * 2 * Math.PI * progress;
        currentAngle = endAngle;

        const x1 = 100 + radius * Math.cos(startAngle);
        const y1 = 100 + radius * Math.sin(startAngle);
        const x2 = 100 + radius * Math.cos(endAngle);
        const y2 = 100 + radius * Math.sin(endAngle);

        const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;

        return (
          <path
            key={index}
            d={`M 100 100 L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z`}
            fill={segment.color}
          />
        );
      })}
    </svg>
  );
};
```

## 🎬 Video Composition

### Sequential Scenes

```typescript
import { Sequence } from 'remotion';
import { createSequentialSegments } from '@studio/timing';

const SequentialVideo = () => {
  const segments = createSequentialSegments([60, 90, 120]); // durations

  return (
    <>
      <Sequence from={segments[0].start} durationInFrames={segments[0].duration}>
        <Scene1 />
      </Sequence>

      <Sequence from={segments[1].start} durationInFrames={segments[1].duration}>
        <Scene2 />
      </Sequence>

      <Sequence from={segments[2].start} durationInFrames={segments[2].duration}>
        <Scene3 />
      </Sequence>
    </>
  );
};
```

### Crossfade Between Scenes

```typescript
const Crossfade = ({ children, duration = 30, overlap = 10 }) => {
  const scenes = React.Children.toArray(children);

  return (
    <>
      {scenes.map((scene, index) => {
        const start = index * (duration - overlap);
        const fadeOutStart = start + duration - overlap;

        return (
          <Sequence key={index} from={start} durationInFrames={duration}>
            <Fade
              type="in"
              startFrame={0}
              duration={overlap}
            >
              <Fade
                type="out"
                startFrame={duration - overlap}
                duration={overlap}
              >
                {scene}
              </Fade>
            </Fade>
          </Sequence>
        );
      })}
    </>
  );
};
```

## 🎵 Audio

### Audio Reactive Animation

```typescript
import { Audio, useAudioData, visualizeAudio } from 'remotion';

const AudioReactive = () => {
  const frame = useCurrentFrame();
  const audioData = useAudioData('/audio.mp3');

  const visualization = audioData
    ? visualizeAudio({
        fps: 30,
        frame,
        audioData,
        numberOfSamples: 32,
      })
    : new Array(32).fill(0);

  return (
    <>
      <Audio src="/audio.mp3" />
      <div style={{ display: 'flex', gap: 4 }}>
        {visualization.map((v, i) => (
          <div
            key={i}
            style={{
              height: v * 100,
              width: 10,
              backgroundColor: 'white',
            }}
          />
        ))}
      </div>
    </>
  );
};
```

### Sync Animation to Audio

```typescript
const SyncToAudio = () => {
  const { fps } = useVideoConfig();
  const frame = useCurrentFrame();

  // Beat occurs at 2 seconds
  const beatFrame = 2 * fps;
  const timeSinceBeat = (frame - beatFrame) / fps;

  const scale = spring({
    frame: frame - beatFrame,
    fps,
    config: {
      damping: 20,
    },
    durationInFrames: 30,
  });

  return (
    <div style={{ transform: `scale(${frame >= beatFrame ? scale : 1})` }}>
      <Element />
    </div>
  );
};
```

## 🖼️ Image Effects

### Ken Burns Effect

```typescript
const KenBurnsEffect = ({ src, duration = 300 }) => {
  const frame = useCurrentFrame();

  const scale = interpolate(
    frame,
    [0, duration],
    [1, 1.2],
    { extrapolateRight: 'clamp' }
  );

  const translateX = interpolate(
    frame,
    [0, duration],
    [0, -50],
    { extrapolateRight: 'clamp' }
  );

  return (
    <img
      src={src}
      style={{
        transform: `scale(${scale}) translateX(${translateX}px)`,
        width: '100%',
        height: '100%',
        objectFit: 'cover',
      }}
    />
  );
};
```

### Image Reveal

```typescript
const ImageReveal = ({ src, direction = 'left' }) => {
  const frame = useCurrentFrame();

  const progress = interpolate(frame, [0, 60], [0, 100], {
    extrapolateRight: 'clamp',
  });

  const clipPath = direction === 'left'
    ? `inset(0 ${100 - progress}% 0 0)`
    : `inset(0 0 0 ${100 - progress}%)`;

  return (
    <img
      src={src}
      style={{
        clipPath,
        width: '100%',
      }}
    />
  );
};
```

## 📝 Text Effects

### Typewriter Effect

```typescript
const Typewriter = ({ text, speed = 2 }) => {
  const frame = useCurrentFrame();
  const charsToShow = Math.floor(frame / speed);

  return <span>{text.substring(0, charsToShow)}</span>;
};
```

### Text Highlight

```typescript
const TextHighlight = ({ text, highlightColor = 'yellow' }) => {
  const frame = useCurrentFrame();

  const progress = interpolate(frame, [0, 30], [0, 100], {
    extrapolateRight: 'clamp',
  });

  return (
    <span style={{ position: 'relative' }}>
      <span
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          width: `${progress}%`,
          height: '30%',
          backgroundColor: highlightColor,
          zIndex: -1,
        }}
      />
      {text}
    </span>
  );
};
```

### Split Text Animation

```typescript
const SplitTextAnimation = ({ text }) => {
  const frame = useCurrentFrame();
  const letters = text.split('');

  return (
    <div style={{ display: 'flex' }}>
      {letters.map((letter, index) => {
        const delay = index * 2;
        const opacity = interpolate(
          frame,
          [delay, delay + 10],
          [0, 1],
          { extrapolateRight: 'clamp' }
        );

        return (
          <span key={index} style={{ opacity }}>
            {letter}
          </span>
        );
      })}
    </div>
  );
};
```

## 🎯 Utilities

### Conditional Rendering

```typescript
import { useDelayedMount, useFrameRange } from '@studio/hooks';

const ConditionalComponent = () => {
  const shouldShow = useFrameRange(30, 90);

  if (!shouldShow) return null;

  return <Component />;
};
```

### Loop Animation

```typescript
const LoopingAnimation = ({ duration = 60 }) => {
  const frame = useCurrentFrame();
  const loopedFrame = frame % duration;

  const rotation = interpolate(
    loopedFrame,
    [0, duration],
    [0, 360]
  );

  return (
    <div style={{ transform: `rotate(${rotation}deg)` }}>
      <Icon />
    </div>
  );
};
```

### Responsive Layout

```typescript
const ResponsiveLayout = () => {
  const { width, height } = useVideoConfig();
  const isPortrait = height > width;

  return (
    <div
      style={{
        flexDirection: isPortrait ? 'column' : 'row',
        display: 'flex',
      }}
    >
      <Content />
    </div>
  );
};
```

## 🔧 Advanced

### Custom Easing with Keyframes

```typescript
const keyframes = [
  { frame: 0, value: 0 },
  { frame: 20, value: 100 },
  { frame: 40, value: 50 },
  { frame: 60, value: 100 },
];

const KeyframeAnimation = () => {
  const frame = useCurrentFrame();

  const getValue = () => {
    for (let i = 0; i < keyframes.length - 1; i++) {
      const current = keyframes[i];
      const next = keyframes[i + 1];

      if (frame >= current.frame && frame <= next.frame) {
        return interpolate(
          frame,
          [current.frame, next.frame],
          [current.value, next.value]
        );
      }
    }
    return keyframes[keyframes.length - 1].value;
  };

  return (
    <div style={{ transform: `translateY(${getValue()}px)` }}>
      <Element />
    </div>
  );
};
```

### Dynamic Composition

```typescript
export const DynamicVideo: React.FC<{
  data: any[];
}> = ({ data }) => {
  return (
    <>
      {data.map((item, index) => (
        <Sequence
          key={index}
          from={index * 60}
          durationInFrames={60}
        >
          <DynamicScene data={item} />
        </Sequence>
      ))}
    </>
  );
};
```

## 📚 More Resources

- [Official Remotion Examples](https://remotion.dev/docs/examples)
- [Remotion Showcase](https://remotion.dev/showcase)
- [Community Templates](https://github.com/remotion-dev/template)
