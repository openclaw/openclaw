import { NextResponse } from 'next/server';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';

export const runtime = 'nodejs';

const execFileAsync = promisify(execFile);

const LOCAL_GATEWAY_URL = 'ws://127.0.0.1:18789';
const gatewayToken = (() => {
  try {
    const raw = fs.readFileSync('/Users/popstack/.openclaw/openclaw.json', 'utf-8');
    const cfg = JSON.parse(raw);
    return cfg?.gateway?.auth?.token as string | undefined;
  } catch {
    return undefined;
  }
})();

function ocArgs(args: string[]) {
  // Force loopback gateway to avoid LAN hop latency; token is read server-side.
  if (!gatewayToken) return args;
  return [...args, '--url', LOCAL_GATEWAY_URL, '--token', gatewayToken];
}

async function runJson(cmd: string, args: string[]) {
  const { stdout } = await execFileAsync(cmd, args, {
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function runText(cmd: string, args: string[]) {
  const { stdout } = await execFileAsync(cmd, args, {
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

function giB(n: number) {
  return n / 1024 / 1024 / 1024;
}

async function getMacMetrics() {
  // CPU via top
  const top = await runText('bash', ['-lc', "top -l 1 | head -n 20"]);
  const cpuLine = top
    .split('\n')
    .find((l) => l.toLowerCase().includes('cpu usage'));
  // Example: "CPU usage: 4.75% user, 5.36% sys, 89.88% idle"
  const idleMatch = cpuLine?.match(/([0-9.]+)%\s+idle/i);
  const idle = idleMatch ? Number(idleMatch[1]) : NaN;
  const cpuPct = Number.isFinite(idle) ? Math.max(0, Math.min(100, 100 - idle)) : null;

  const memTotalBytes = Number((await runText('bash', ['-lc', 'sysctl -n hw.memsize'])).trim());

  const vm = await runText('bash', ['-lc', 'vm_stat']);
  const pageSizeMatch = vm.match(/page size of (\d+) bytes/i);
  const pageSize = pageSizeMatch ? Number(pageSizeMatch[1]) : 4096;

  const getPages = (key: string) => {
    const m = vm.match(new RegExp(`${key}:\\s+(\\d+)\\.`));
    return m ? Number(m[1]) : 0;
  };

  const active = getPages('Pages active');
  const inactive = getPages('Pages inactive');
  const speculative = getPages('Pages speculative');
  const wired = getPages('Pages wired down');
  const compressed = getPages('Pages occupied by compressor');

  // Approx used = active + inactive + speculative + wired + compressed
  const usedBytes = (active + inactive + speculative + wired + compressed) * pageSize;
  const memUsedPct = memTotalBytes ? (usedBytes / memTotalBytes) * 100 : null;

  return {
    cpuPct,
    memUsedPct,
    memUsedGiB: giB(usedBytes),
    memTotalGiB: giB(memTotalBytes),
  };
}

async function getLinuxNodeMetrics(nodeId: string) {
  const script = String.raw`
python3 - <<'PY'
import time

def cpu_used_pct():
    def read():
        with open('/proc/stat','r') as f:
            parts=f.readline().split()
        vals=list(map(int, parts[1:]))
        idle=vals[3] + (vals[4] if len(vals)>4 else 0)
        total=sum(vals)
        return total,idle
    t1,i1=read()
    time.sleep(0.2)
    t2,i2=read()
    dt=t2-t1
    di=i2-i1
    if dt<=0: return None
    return max(0.0, min(100.0, (dt-di)*100.0/dt))

def mem_used_pct():
    total=None
    avail=None
    with open('/proc/meminfo','r') as f:
        for line in f:
            if line.startswith('MemTotal:'):
                total=int(line.split()[1]) # KiB
            elif line.startswith('MemAvailable:'):
                avail=int(line.split()[1])
    if not total or avail is None: return None,None,None
    used=total-avail
    return used*100.0/total, used/1024/1024, total/1024/1024

cpu=cpu_used_pct()
memPct, memUsedGiB, memTotalGiB = mem_used_pct()
import json
print(json.dumps({
    'cpuPct': cpu,
    'memUsedPct': memPct,
    'memUsedGiB': memUsedGiB,
    'memTotalGiB': memTotalGiB,
}))
PY`;

  const params = {
    command: ['bash', '-lc', script],
    timeoutMs: 12000,
  };

  const result = await runJson(
    'openclaw',
    ocArgs([
      'nodes',
      'invoke',
      '--node',
      nodeId,
      '--command',
      'system.run',
      '--json',
      '--timeout',
      '15000',
      '--params',
      JSON.stringify(params),
    ])
  );

  const stdout = (result?.payload?.stdout ?? '').trim();
  return stdout ? JSON.parse(stdout) : {};
}

export async function GET() {
  try {
    const nodesStatus = await runJson('openclaw', ocArgs(['nodes', 'status', '--json']));
    const status = await runJson('openclaw', ocArgs(['status', '--json']));

    type NodeStatus = { connected?: boolean; platform?: string; nodeId?: string };
    const connectedNode = (nodesStatus?.nodes ?? []).find(
      (n: NodeStatus) => n?.connected === true && n?.platform === 'linux'
    ) as NodeStatus | undefined;
    const nodeId = connectedNode?.nodeId;

    const [mac, dev] = await Promise.all([
      getMacMetrics(),
      nodeId ? getLinuxNodeMetrics(nodeId) : Promise.resolve({ error: 'DEV-PC-I9 not connected' }),
    ]);

    return NextResponse.json({
      ok: true,
      ts: Date.now(),
      nodes: nodesStatus,
      status,
      metrics: {
        MACMINI: mac,
        'DEV-PC-I9': dev,
      },
    });
  } catch (err: unknown) {
    return NextResponse.json(
      {
        ok: false,
        ts: Date.now(),
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
