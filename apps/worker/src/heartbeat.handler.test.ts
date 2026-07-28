import { createRecordingLogger } from '@platform/observability/testing';
import { describe, expect, it } from 'vitest';
import { createHeartbeatHandler } from './heartbeat.handler.js';
import type { JobEnvelope } from './envelope.js';
import type { HeartbeatPayload } from './queues.js';

const job = (payload: unknown): JobEnvelope<HeartbeatPayload> =>
  ({ correlationId: 'trace', payload }) as JobEnvelope<HeartbeatPayload>;

describe('heartbeat handler', () => {
  it('logs the source', async () => {
    const recording = createRecordingLogger();
    await createHeartbeatHandler(recording.logger)(job({ source: 'api' }));

    expect(recording.at('info')).toHaveLength(1);
    expect(recording.at('info')[0]?.message).toBe('heartbeat');
    expect(recording.at('info')[0]?.fields?.['source']).toBe('api');
  });

  it('rejects a payload with no source', async () => {
    // Job data is deserialised from Redis and may predate the current payload
    // shape after a deploy. One failed job beats a crashed worker.
    const recording = createRecordingLogger();
    await expect(createHeartbeatHandler(recording.logger)(job({}))).rejects.toThrow(
      'missing a source',
    );
  });

  it('rejects a non-string source', async () => {
    const recording = createRecordingLogger();
    await expect(
      createHeartbeatHandler(recording.logger)(job({ source: 42 })),
    ).rejects.toThrow('missing a source');
  });

  it('rejects an empty source', async () => {
    const recording = createRecordingLogger();
    await expect(
      createHeartbeatHandler(recording.logger)(job({ source: '' })),
    ).rejects.toThrow('missing a source');
  });

  it('rejects a missing payload without throwing a type error', async () => {
    const recording = createRecordingLogger();
    await expect(
      createHeartbeatHandler(recording.logger)(job(undefined)),
    ).rejects.toThrow('missing a source');
  });

  it('logs nothing when it rejects', async () => {
    const recording = createRecordingLogger();
    await expect(createHeartbeatHandler(recording.logger)(job({}))).rejects.toThrow();
    expect(recording.records).toHaveLength(0);
  });
});
