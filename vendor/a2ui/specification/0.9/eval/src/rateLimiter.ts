/*
 Copyright 2025 Google LLC

 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at

      https://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
 */

import { logger } from "./logger";
import { ModelConfiguration } from "./models";

interface UsageRecord {
  timestamp: number;
  tokensUsed: number;
  isRequest: boolean;
}

interface ModelRateLimitState {
  usageRecords: UsageRecord[];
}

export class RateLimiter {
  private modelStates: Map<string, ModelRateLimitState> = new Map();
  private _waitingCount = 0;

  private modelPauses: Map<string, number> = new Map();

  get waitingCount(): number {
    return this._waitingCount;
  }

  private getModelState(modelName: string): ModelRateLimitState {
    if (!this.modelStates.has(modelName)) {
      this.modelStates.set(modelName, { usageRecords: [] });
    }
    return this.modelStates.get(modelName)!;
  }

  private cleanUpRecords(state: ModelRateLimitState): void {
    // Use 65 seconds to be safe against clock drift and server bucket alignment
    const minuteAgo = Date.now() - 65 * 1000;
    state.usageRecords = state.usageRecords.filter(
      (record) => record.timestamp > minuteAgo
    );
  }

  reportError(modelConfig: ModelConfiguration, error: any): void {
    const isResourceExhausted =
      error?.status === "RESOURCE_EXHAUSTED" ||
      error?.code === 429 ||
      (error?.message && error.message.includes("429"));

    if (isResourceExhausted) {
      // Try to parse "Please retry in X s" or similar from error message
      // Example: "Please retry in 22.648565753s."
      const message = error?.originalMessage || error?.message || "";
      const match = message.match(/retry in ([0-9.]+)\s*s/i);

      let retrySeconds = 60; // Default to 60s if not found
      if (match && match[1]) {
        retrySeconds = parseFloat(match[1]);
      }

      // Add a small buffer
      const pauseDuration = Math.ceil(retrySeconds * 1000) + 1000;
      const pausedUntil = Date.now() + pauseDuration;

      this.modelPauses.set(modelConfig.name, pausedUntil);

      logger.verbose(
        `RateLimiter: Pausing ${modelConfig.name} for ${pauseDuration}ms due to 429 error. Resuming at ${new Date(pausedUntil).toISOString()}`
      );
    }
  }

  async acquirePermit(
    modelConfig: ModelConfiguration,
    tokensCost: number = 0
  ): Promise<void> {
    this._waitingCount++;
    try {
      const { name, requestsPerMinute, tokensPerMinute } = modelConfig;
      if (!requestsPerMinute && !tokensPerMinute) {
        return; // No limits
      }

      const state = this.getModelState(name);

      // Loop to re-check after waiting, as multiple limits might be in play
      while (true) {
        // Check if model is paused globally due to 429
        const pausedUntil = this.modelPauses.get(name);
        if (pausedUntil && pausedUntil > Date.now()) {
          const pauseWait = pausedUntil - Date.now();
          logger.verbose(
            `Rate limiting ${name}: Paused by circuit breaker for ${pauseWait}ms`
          );
          await new Promise((resolve) => setTimeout(resolve, pauseWait));
          // After waiting, loop again to check normal rate limits
          continue;
        }

        this.cleanUpRecords(state);
        const currentNow = Date.now();
        let rpmWait = 0;
        let tpmWait = 0;

        let currentTokens = 0;
        let currentRequests = 0;
        state.usageRecords.forEach((r) => {
          currentTokens += r.tokensUsed;
          if (r.isRequest) currentRequests++;
        });

        const effectiveTokensPerMinute = tokensPerMinute
          ? Math.floor(tokensPerMinute * 0.9)
          : 0;

        logger.debug(
          `RateLimiter check for ${name}: Cost=${tokensCost}, CurrentTokens=${currentTokens}, Limit=${effectiveTokensPerMinute}, Requests=${currentRequests}, RPM=${requestsPerMinute}`
        );

        // Check RPM
        if (requestsPerMinute && currentRequests + 1 > requestsPerMinute) {
          // Find the oldest REQUEST record
          const oldestRequest = state.usageRecords.find((r) => r.isRequest);
          if (oldestRequest) {
            rpmWait = Math.max(
              0,
              oldestRequest.timestamp + 60 * 1000 - currentNow
            );
          }
        }

        // Check TPM
        if (tokensPerMinute) {
          // Apply a 10% safety buffer to the limit
          const effectiveTokensPerMinute = Math.floor(tokensPerMinute * 0.9);

          if (currentTokens + tokensCost > effectiveTokensPerMinute) {
            // Check if we are ALREADY over limit for the next call
            // We need to shed enough tokens so that (current - shed + cost) <= limit
            // shed >= current + cost - limit
            let tokensToShed =
              currentTokens + tokensCost - effectiveTokensPerMinute;
            let cumulativeTokens = 0;
            for (const record of state.usageRecords) {
              cumulativeTokens += record.tokensUsed;
              if (cumulativeTokens >= tokensToShed) {
                tpmWait = Math.max(
                  tpmWait,
                  record.timestamp + 60 * 1000 - currentNow
                );
                break;
              }
            }
          }
        }

        const requiredWait = Math.max(rpmWait, tpmWait);
        if (requiredWait <= 0) {
          // RESERVE THE PERMIT HERE TO PREVENT RACE CONDITIONS
          state.usageRecords.push({
            timestamp: Date.now(),
            tokensUsed: tokensCost,
            isRequest: true,
          });
          break; // Permit acquired
        }

        logger.verbose(
          `Rate limiting ${name}: Waiting ${requiredWait}ms (RPM wait: ${rpmWait}ms, TPM wait: ${tpmWait}ms)`
        );
        await new Promise((resolve) => setTimeout(resolve, requiredWait));
      }
    } finally {
      this._waitingCount--;
    }
  }

  recordUsage(
    modelConfig: ModelConfiguration,
    tokensUsed: number,
    isRequest: boolean = true
  ): void {
    if (tokensUsed > 0 || isRequest) {
      const state = this.getModelState(modelConfig.name);
      state.usageRecords.push({
        timestamp: Date.now(),
        tokensUsed,
        isRequest,
      });
    }
  }
}

export const rateLimiter = new RateLimiter();
