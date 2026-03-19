# Vendored npm tarballs

This directory holds packed third-party dependencies that must install from a prebuilt tarball instead of a raw Git dependency.

## `tloncorp-api-0.0.2.tgz`

Used by `extensions/tlon`.

Why it is vendored:
- the upstream dependency was pinned as a GitHub repo (`git+https://github.com/tloncorp/api-beta.git#7eede1c1a756977b09f96aa14a92e2b06318ae87`)
- Git dependencies run `prepare` during install
- that upstream `prepare` build currently fails in clean environments, which breaks repo installs and external builders

The tarball was packed locally from the already-built package contents with:

```bash
npm pack --ignore-scripts --pack-destination vendor/npm
```

This preserves the working `dist/` artifacts while avoiding the broken upstream source build during installation.
