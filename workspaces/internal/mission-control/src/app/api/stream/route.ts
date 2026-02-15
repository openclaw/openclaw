import { taskStore } from '@/lib/taskStore';

export const runtime = 'nodejs';

function encodeSse(data: unknown, event?: string) {
  const lines: string[] = [];
  if (event) lines.push(`event: ${event}`);
  lines.push(`data: ${JSON.stringify(data)}`);
  return lines.join('\n') + '\n\n';
}

export async function GET(req: Request) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();

      // initial payload
      controller.enqueue(enc.encode(encodeSse({ ok: true, tasks: taskStore.list() }, 'snapshot')));

      const off = taskStore.onChange(() => {
        controller.enqueue(enc.encode(encodeSse({ ok: true, tasks: taskStore.list() }, 'tasks')));
      });

      const keepAlive = setInterval(() => {
        controller.enqueue(enc.encode('event: ping\ndata: {}\n\n'));
      }, 15000);

      req.signal.addEventListener('abort', () => {
        clearInterval(keepAlive);
        off();
        try {
          controller.close();
        } catch {
          // ignore
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
