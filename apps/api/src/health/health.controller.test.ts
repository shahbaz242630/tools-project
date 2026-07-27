import { HttpException, HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { HealthController } from './health.controller.js';
import { ReadinessService } from './readiness.service.js';
import type { DependencyCheck } from './dependency-check.js';
import { createRecordingLogger } from '../testing/recording-logger.js';

const ok = (name: string): DependencyCheck => ({
  name,
  probe: () => Promise.resolve(),
});

const failing = (name: string): DependencyCheck => ({
  name,
  probe: () => Promise.reject(new Error('down')),
});

function controllerFor(checks: readonly DependencyCheck[]): HealthController {
  return new HealthController(
    new ReadinessService(checks, createRecordingLogger().logger, 50),
  );
}

describe('HealthController', () => {
  describe('liveness', () => {
    it('reports ok', () => {
      expect(controllerFor([]).health()).toEqual({ status: 'ok' });
    });

    it('reports ok even when every dependency is down', () => {
      // Liveness must not consult dependencies. If it did, a database outage
      // would look like a dead process and the orchestrator would restart us
      // in a loop — converting a recoverable failure into a guaranteed one.
      expect(controllerFor([failing('postgres')]).health()).toEqual({ status: 'ok' });
    });
  });

  describe('readiness', () => {
    it('returns the per-dependency status when ready', async () => {
      const response = await controllerFor([ok('postgres'), ok('redis')]).ready();
      expect(response).toEqual({
        status: 'ready',
        checks: { postgres: 'ok', redis: 'ok' },
      });
    });

    it('throws 503 when a dependency is unavailable', async () => {
      const controller = controllerFor([ok('postgres'), failing('redis')]);
      await expect(controller.ready()).rejects.toThrow(HttpException);

      try {
        await controller.ready();
        expect.unreachable('should have thrown');
      } catch (error) {
        const exception = error as HttpException;
        expect(exception.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
        expect(exception.getResponse()).toEqual({
          status: 'not_ready',
          checks: { postgres: 'ok', redis: 'failed' },
        });
      }
    });

    it('names which dependency failed, so 503 is actionable', async () => {
      const controller = controllerFor([failing('postgres'), ok('redis')]);
      try {
        await controller.ready();
        expect.unreachable('should have thrown');
      } catch (error) {
        const body = (error as HttpException).getResponse() as {
          checks: Record<string, string>;
        };
        expect(body.checks['postgres']).toBe('failed');
        expect(body.checks['redis']).toBe('ok');
      }
    });
  });
});
