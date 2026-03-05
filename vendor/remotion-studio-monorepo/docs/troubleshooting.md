# Troubleshooting Guide

Common issues and their solutions for Remotion Studio Monorepo.

## Table of Contents

- [Command Issues](#command-issues)
- [Git](#git)
- [Configuration Issues](#configuration-issues)
- [Dependencies & Installation](#dependencies--installation)
- [Runtime Errors](#runtime-errors)
- [Development Server](#development-server)

---

## Command Issues

### `remotion` command not found

**Solution:**

```bash
# Add to specific app
pnpm -F @studio/<app> add -D @remotion/cli

# Or add workspace-wide
pnpm -w add -D @remotion/cli
```

### `pnpm` command not found

**Solution:**

```bash
# Using corepack (Node 20+ recommended)
corepack enable
corepack prepare pnpm@latest --activate

# Or install globally
npm i -g pnpm
```

---

## Git

### `fatal: not a git repository`

**Solution:** Ensure you're running commands at the repository root, not inside a subdirectory.

```bash
cd /path/to/remotion-studio-monorepo
git status
```

---

## Configuration Issues

### `import.meta` warnings

**Cause:** Older `remotion.config.ts` using `import.meta.url`

**Solution:** The template uses `process.cwd()` for path resolution. If you see this warning, update your config:

```ts
// remotion.config.ts
import { Config } from "@remotion/cli/config";
import path from "path";

// Use process.cwd() instead of import.meta.url
Config.overrideWebpackConfig((config) => {
  return {
    ...config,
    resolve: {
      ...config.resolve,
      alias: {
        ...config.resolve?.alias,
        "@": path.resolve(process.cwd(), "src"),
      },
    },
  };
});
```

### TypeScript: `must have at most one *` error

**Cause:** Multiple wildcards in a single `paths` entry in `tsconfig.json`

**Solution:** Split path mappings to have at most one `*` per entry:

```json
{
  "compilerOptions": {
    "paths": {
      "@/*": ["./src/*"],
      "@components/*": ["./src/components/*"]
    }
  }
}
```

### Entry point not found

**Symptoms:** `Error: Entry point not found`

**Solution:** Ensure each app has `src/index.ts` (or `.tsx`) as the Remotion v4 entry point:

```ts
// src/index.ts
import { registerRoot } from "remotion";
import { Root } from "./Root";

registerRoot(Root);
```

**Optional:** Explicitly set entry point in `remotion.config.ts`:

```ts
import { Config } from "@remotion/cli/config";

Config.setEntryPoint("src/index.ts");
```

---

## Dependencies & Installation

### `ffmpeg` not found

**Symptoms:** Rendering fails with `ffmpeg: command not found`

**Solution:**

```bash
# macOS
brew install ffmpeg

# Windows (with Chocolatey)
choco install ffmpeg

# Linux (Debian/Ubuntu)
sudo apt update && sudo apt install ffmpeg

# Linux (RHEL/CentOS/Fedora)
sudo yum install ffmpeg

# Verify installation
ffmpeg -version
```

### Node version issues

**Symptoms:** Errors related to unsupported Node.js features

**Solution:** Use Node.js 18 or higher (20 recommended)

```bash
# Using nvm
nvm install 20
nvm use 20

# Verify
node -v
```

### `pnpm install` fails

**Common causes:**

1. **Network issues** → Try with `--network-timeout 100000`
2. **Lock file conflicts** → Delete `pnpm-lock.yaml` and retry
3. **Cache corruption** → Run `pnpm store prune` then retry

```bash
# Clear cache and reinstall
pnpm store prune
rm -rf node_modules pnpm-lock.yaml
pnpm install
```

---

## Runtime Errors

### Browser module errors (`fs`, `path`, `net`, etc.)

**Symptoms:** `Module not found: Can't resolve 'fs'`

**Cause:** Node.js-only modules imported in browser-executed code (Composition components)

**Solution:**

- Move Node.js code to `scripts/` or `remotion.config.ts`
- Use Webpack aliases to provide browser-compatible alternatives
- Use conditional imports based on environment

```ts
// remotion.config.ts - Add fallbacks for Node modules
Config.overrideWebpackConfig((config) => {
  return {
    ...config,
    resolve: {
      ...config.resolve,
      fallback: {
        fs: false,
        path: false,
        net: false,
      },
    },
  };
});
```

### Missing CSS imports

**Symptoms:** Styles not applied

**Solution:** Explicitly import CSS files:

```ts
// src/index.ts or component file
import "./styles/app.css";
import "your-library/dist/styles.css";
```

### WebGL / Three.js rendering issues

**Solution:** Configure OpenGL renderer in `remotion.config.ts`:

```ts
import { Config } from "@remotion/cli/config";

Config.setChromiumOpenGlRenderer("angle");
// or 'egl' / 'swiftshader' depending on your environment
```

---

## Development Server

### Port conflict (`EADDRINUSE`)

**Symptoms:** `Error: listen EADDRINUSE: address already in use :::3000`

**Solution:**

```bash
# macOS/Linux: Find process using port 3000
lsof -i :3000

# Kill the process
kill -9 <PID>

# Or use a different port
pnpm dev -- --port 3001
```

**Windows:**

```powershell
# Find process
netstat -ano | findstr :3000

# Kill the process
taskkill /PID <PID> /F
```

### Hot reload not working

**Solution:**

1. Check that you're in the correct directory (`apps/<name>`)
2. Restart the dev server: `pnpm dev`
3. Clear browser cache and reload
4. Check for file watcher limits (Linux):

```bash
# Increase file watcher limit
echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

---

## Still Having Issues?

1. **Check official Remotion docs:** https://www.remotion.dev/docs
2. **Search GitHub issues:** https://github.com/remotion-dev/remotion/issues
3. **Join Remotion Discord:** https://remotion.dev/discord
4. **Review this repo's issues:** https://github.com/Takamasa045/remotion-studio-monorepo/issues

---

## Debugging Tips

### Enable verbose logging

```bash
# Run with debug output
DEBUG=* pnpm dev

# Remotion-specific logs
REMOTION_LOGGING=verbose pnpm dev
```

### Check versions alignment

```bash
# Ensure all @remotion/* packages have matching versions
pnpm remotion versions
```

### Clean build

```bash
# Remove all build artifacts and caches
rm -rf node_modules .remotion dist out
pnpm install
```

### Test in isolation

```bash
# Create a fresh test app
pnpm create:project -- test-app
cd apps/test-app
pnpm install
pnpm dev
```
