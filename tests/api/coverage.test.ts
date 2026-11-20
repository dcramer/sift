import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FRAMES, READS, WRITES } from '../../src/dashboard/api/index.ts';
import { AREAS } from './areas.ts';

const registered = [...READS.map((r) => `GET ${r.path}`), ...FRAMES.map((r) => `GET ${r.path}`), ...WRITES.map((r) => `POST ${r.path}`)];
const tested: string[] = Object.values(AREAS).flat();

describe('the API integration tests', () => {
  it('run every registered route in some area', () => {
    expect(
      registered.filter((route) => !tested.includes(route)),
      'add these to an area in tests/api/areas.ts, and test them there',
    ).toEqual([]);
  });

  it('name only registered routes, each in one area', () => {
    expect(tested.filter((route) => !registered.includes(route))).toEqual([]);
    expect(tested.filter((route, i) => tested.indexOf(route) !== i)).toEqual([]);
  });

  it('have a file for each area, which checks its routes were answered', () => {
    const file = (area: string) => `tests/api/${area}.test.ts`;
    expect(Object.keys(AREAS).filter((area) => !existsSync(file(area)) || !readFileSync(file(area), 'utf8').includes(`everyRouteAnswered('${area}')`))).toEqual(
      [],
    );
  });
});
