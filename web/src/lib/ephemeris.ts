export interface Sample {
  t: string;
  az: number;
  el: number;
  flags?: string;
}

export interface Ephemeris {
  site: string;
  name?: string;
  body: 'sun' | 'earth';
  lat: number;
  lon_e: number;
  source?: string;
  samples: Sample[];
}

export const BODY_RADIUS_DEG: Record<Ephemeris['body'], number> = {
  sun: 0.27,
  earth: 0.93,
};

// 사전 계산 범위 (PRD 5.1). 파이프라인이 이 구간을 만든다.
export const DATA_RANGE = {
  start: Date.parse('2026-11-01T00:00:00Z'),
  end: Date.parse('2027-05-01T00:00:00Z'),
};
