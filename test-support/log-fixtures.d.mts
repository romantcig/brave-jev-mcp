import type { BraveLlmContextResponse, FilterCallContext } from '../src/filter/types.js';
import type { JevRequest } from '../src/filter/jev/client.js';

export type LogFixture = {
  id: string;
  purpose: string;
  origin: { sample: string; captured_at: string; source_indices: number[] };
  request: FilterCallContext;
  config: Record<string, unknown>;
  data: BraveLlmContextResponse;
  checks: { source: number; keep?: string[]; absent?: string[] }[];
};
export type Recording = {
  request: JevRequest;
  status: number;
  body: { model: string; answers: Record<string, unknown>; usage: { input_tokens: number } };
};
export function fixtureNames(): string[];
export function loadFixture(name: string): LogFixture;
export function loadRecording(name: string): Recording;
export function assertRecording(recording: Recording, request: JevRequest): void;
export function assertFixtureOutput(fixture: LogFixture, result: BraveLlmContextResponse): void;
