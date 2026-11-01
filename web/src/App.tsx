import { useEffect, useMemo, useRef, useState } from 'react';

import { DATA_RANGE, DAY_MS, clampT0, parseT0Input } from './lib/ephemeris';
import {
  T0_MAX,
  T0_MIN,
  initialT0Field,
  t0Commit,
  t0DaysChanged,
  t0DraftChange,
} from './lib/t0Field';
import type { T0Field } from './lib/t0Field';
import type { Ephemeris } from './lib/ephemeris';
import { eventMetric, stats, timeline } from './lib/metrics';
import { SITES } from './sites';

const HOUR_MS = 3600_000;

interface ColumnSpec {
  id: number;
  site: string;
  t0: string; // datetime-local 값, UTC로 해석한다
}

// PRD 6: 처음 열면 §2 시나리오가 로드돼 있다.
const DEFAULT_COLUMNS: ColumnSpec[] = [
  { id: 1, site: 'im-2', t0: '2026-11-14T00:00' },
  { id: 2, site: 'im-2', t0: '2026-11-28T00:00' },
  { id: 3, site: 'im-2', t0: '2026-12-12T16:17' },
];

interface SiteData {
  status: 'error' | 'ok';
  sun?: Ephemeris;
  earth?: Ephemeris;
}

const fmtDate = (ms: number) => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

const fmtDuration = (ms: number) => {
  const days = Math.floor(ms / DAY_MS);
  const hours = Math.round((ms - days * DAY_MS) / HOUR_MS);
  return `${days}일 ${hours}시간`;
};

function Badge() {
  return <span className="badge">지형 미반영</span>;
}

function MetricCard({ title, value, sub }: { title: string; value: string; sub?: string }) {
  return (
    <div className="metric">
      <div className="title">
        {title}
        <Badge />
      </div>
      <div className="value">{value}</div>
      {sub ? <div className="sub">{sub}</div> : null}
    </div>
  );
}

function TimelineSvg({
  cells,
  times,
  rowY,
  color,
  axisStart,
  axisEnd,
  t0,
  showCursor,
}: {
  cells: boolean[];
  times: number[];
  rowY: number;
  color: string;
  axisStart: number;
  axisEnd: number;
  t0: number;
  showCursor: boolean;
}) {
  const W = 560; // viewBox 600 - 왼쪽 레이블 40
  const x = (t: number) => ((t - axisStart) / (axisEnd - axisStart)) * W;
  const cellW = (HOUR_MS / (axisEnd - axisStart)) * W;
  return (
    <g>
      {cells.map((v, i) => (
        <rect
          key={i}
          x={x(times[i]!)}
          y={rowY}
          width={Math.max(cellW - 0.4, 0.4)}
          height={14}
          fill={v ? color : 'var(--dark)'}
        />
      ))}
      {showCursor ? (
        <line x1={x(t0)} x2={x(t0)} y1={14} y2={58} stroke="#c00" strokeWidth={1.2} />
      ) : null}
    </g>
  );
}

function Timelines({
  sun,
  earth,
  t0,
  days,
  axisStart,
  axisEnd,
}: {
  sun: Ephemeris;
  earth: Ephemeris;
  t0: number;
  days: number;
  axisStart: number;
  axisEnd: number;
}) {
  const tl = timeline(sun, earth, t0, days);
  const W = 560;
  const x = (t: number) => ((t - axisStart) / (axisEnd - axisStart)) * W;
  const spanDays = (axisEnd - axisStart) / DAY_MS;
  const tickStepDays = spanDays > 60 ? 14 : spanDays > 30 ? 7 : spanDays > 15 ? 3 : 1;
  const ticks: number[] = [];
  const firstTick = Math.ceil(axisStart / (tickStepDays * DAY_MS)) * tickStepDays * DAY_MS;
  for (let t = firstTick; t <= axisEnd; t += tickStepDays * DAY_MS) ticks.push(t);
  return (
    <div>
      <svg className="timeline" viewBox="0 0 600 86" role="img">
        <text x={0} y={30} fontSize={10} fill="var(--muted)">
          태양
        </text>
        <text x={0} y={52} fontSize={10} fill="var(--muted)">
          지구
        </text>
        <g transform="translate(36,0)">
          <TimelineSvg
            cells={tl.sun.cells}
            times={tl.sun.times}
            rowY={20}
            color="var(--sunlit)"
            axisStart={axisStart}
            axisEnd={axisEnd}
            t0={t0}
            showCursor
          />
          <TimelineSvg
            cells={tl.earth.cells}
            times={tl.earth.times}
            rowY={42}
            color="var(--earth)"
            axisStart={axisStart}
            axisEnd={axisEnd}
            t0={t0}
            showCursor={false}
          />
          <line x1={0} x2={W} y1={64} y2={64} stroke="var(--border)" />
          {ticks.map((t) => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={64} y2={69} stroke="var(--muted)" />
              <text x={x(t)} y={80} fontSize={9} fill="var(--muted)" textAnchor="middle">
                {fmtDate(t).slice(0, 5)}
              </text>
            </g>
          ))}
        </g>
      </svg>
      <div className="timeline-caption">둘 다 가능 {fmtDuration(tl.bothVisibleMs)}</div>
    </div>
  );
}

function Column({
  spec,
  days,
  data,
  onRetry,
  onChange,
  onRemove,
  axisStart,
  axisEnd,
}: {
  spec: ColumnSpec;
  days: number;
  data: SiteData | undefined;
  onRetry: () => void;
  onChange: (next: ColumnSpec) => void;
  onRemove: () => void;
  axisStart: number;
  axisEnd: number;
}) {
  const site = SITES.find((s) => s.slug === spec.site) ?? SITES[0]!;

  // PRD 6: 범위 밖이면 알리고 범위 안 값으로 되돌린다. 단, 편집 중인 draft는
  // 리셋하지 않는다 — 범위 안 완전값만 즉시 적용하고, 나머지는 blur/Enter에서
  // 커밋한다 (연도 입력이 첫 자리에서 clamp되는 회귀 수정). 판정은 lib/t0Field.
  const [field, setField] = useState<T0Field>(initialT0Field);
  const lastApplied = useRef(spec.t0);

  // 외부(시나리오 초기화 등)에서 applied가 바뀌면 draft와 경고를 리셋한다.
  useEffect(() => {
    if (spec.t0 !== lastApplied.current) {
      lastApplied.current = spec.t0;
      setField(initialT0Field());
    }
  }, [spec.t0]);

  // D 변경으로 t0 + D가 범위 끝을 넘으면 clamp된 t0을 커밋한다.
  useEffect(() => {
    const d = t0DaysChanged(field, spec.t0, days);
    setField(d.field);
    if (d.apply !== null) {
      lastApplied.current = d.apply;
      onChange({ ...spec, t0: d.apply });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  const appliedT0 = spec.t0; // 항상 canonical·clamp된 값
  const t0 = parseT0Input(appliedT0);

  const applyDecision = (raw: string) => {
    const d = t0DraftChange(field, raw, days);
    setField(d.field);
    if (d.apply !== null) {
      lastApplied.current = d.apply;
      onChange({ ...spec, t0: d.apply });
    }
  };

  const commit = () => {
    const d = t0Commit(field, spec.t0, days);
    setField(d.field);
    if (d.apply !== null) {
      lastApplied.current = d.apply;
      onChange({ ...spec, t0: d.apply });
    }
  };

  return (
    <div className="column">
      <div>
        <select
          value={spec.site}
          onChange={(e) => onChange({ ...spec, site: e.target.value })}
          aria-label="지점"
        >
          {SITES.map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.name}
            </option>
          ))}
        </select>{' '}
        <input
          type="datetime-local"
          value={field.draft ?? appliedT0}
          step={3600}
          min={T0_MIN}
          max={T0_MAX}
          onChange={(e) => applyDecision(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
          }}
          aria-label="t0 (UTC)"
        />{' '}
        <button onClick={onRemove} aria-label="열 제거">
          ×
        </button>
      </div>
      {field.warn ? <div className="warn">계산 범위 2026-11-01~2027-05-01</div> : null}
      <h2>
        {site.name} <Badge />
      </h2>
      <div className="coords">
        위도 {site.lat}°, 동경 {site.lon_e}° · t0 {appliedT0.replace('T', ' ')} UTC
      </div>
      <div className="source">
        <a href={site.sourceUrl}>좌표 출처</a>
      </div>

      {!data ? (
        <div className="state-box">데이터 불러오는 중</div>
      ) : data.status === 'error' ? (
        <div className="state-box">
          데이터를 불러오지 못했습니다 · <button onClick={onRetry}>다시 시도</button>
        </div>
      ) : (
        <ColumnBody
          sun={data.sun!}
          earth={data.earth!}
          t0={t0}
          days={days}
          axisStart={axisStart}
          axisEnd={axisEnd}
        />
      )}
    </div>
  );
}

function ColumnBody({
  sun,
  earth,
  t0,
  days,
  axisStart,
  axisEnd,
}: {
  sun: Ephemeris;
  earth: Ephemeris;
  t0: number;
  days: number;
  axisStart: number;
  axisEnd: number;
}) {
  const nextSun = eventMetric(sun, t0, 'sun');
  const nextEarth = eventMetric(earth, t0, 'earth');
  const sunStats = stats(sun, t0, days);
  const earthStats = stats(earth, t0, days);

  const card = (m: typeof nextSun) =>
    m.text !== null
      ? { value: m.text }
      : { value: `${m.days!.toFixed(1)}일`, sub: m.eventTime ? fmtDate(m.eventTime) : undefined };

  return (
    <>
      <div className="metric-grid">
        <MetricCard title={nextSun.title} {...card(nextSun)} />
        <MetricCard title={nextEarth.title} {...card(nextEarth)} />
        <MetricCard
          title="일조 비율"
          value={sunStats.fraction === 0 ? '기간 내 일조 없음' : `${Math.round(sunStats.fraction * 100)}%`}
        />
        <MetricCard
          title="지구 가시 비율"
          value={
            earthStats.fraction === 0
              ? '기간 내 가시 없음'
              : `${Math.round(earthStats.fraction * 100)}%`
          }
        />
        <MetricCard title="최장 연속 암흑" value={`${sunStats.longestDarkHours}시간`} />
        <MetricCard
          title="일조 중 최대 태양 고도"
          value={
            sunStats.maxElevationAboveHorizon === null
              ? '일조 없음'
              : `${sunStats.maxElevationAboveHorizon.toFixed(1)}°`
          }
        />
      </div>
      <Timelines sun={sun} earth={earth} t0={t0} days={days} axisStart={axisStart} axisEnd={axisEnd} />
    </>
  );
}

let nextId = 10;

export default function App() {
  const [columns, setColumns] = useState<ColumnSpec[]>(DEFAULT_COLUMNS);
  const [days, setDays] = useState(14);
  const [data, setData] = useState<Record<string, SiteData>>({});
  const [retries, setRetries] = useState<Record<string, number>>({});
  const [newSite, setNewSite] = useState(SITES[0]!.slug);

  const needed = useMemo(() => [...new Set(columns.map((c) => c.site))], [columns]);
  const inflight = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const slug of needed) {
      if (data[slug] !== undefined || inflight.current.has(slug)) continue;
      inflight.current.add(slug);
      Promise.all([
        fetch(`/data/${slug}_sun.json`).then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          return r.json() as Promise<Ephemeris>;
        }),
        fetch(`/data/${slug}_earth.json`).then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          return r.json() as Promise<Ephemeris>;
        }),
      ])
        .then(([sun, earth]) => setData((d) => ({ ...d, [slug]: { status: 'ok', sun, earth } })))
        .catch(() => setData((d) => ({ ...d, [slug]: { status: 'error' } })))
        .finally(() => inflight.current.delete(slug));
    }
  }, [needed, data, retries]);

  // 공통 시간축: 모든 열의 [t0, t0+D)를 덮는 최소 구간 (PRD 6).
  const { axisStart, axisEnd } = useMemo(() => {
    if (columns.length === 0) return { axisStart: DATA_RANGE.start, axisEnd: DATA_RANGE.start + DAY_MS };
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of columns) {
      const t0 = clampT0(parseT0Input(c.t0), days);
      lo = Math.min(lo, t0);
      hi = Math.max(hi, t0 + days * DAY_MS);
    }
    return { axisStart: lo, axisEnd: hi };
  }, [columns, days]);

  return (
    <>
      <h1>달 착륙지 비교</h1>
      <div className="scenario-bar">
        <span>
          관찰 기간 D:{' '}
          <span className="d-preset">
            {[7, 14, 28].map((d) => (
              <button key={d} className={d === days ? 'active' : ''} onClick={() => setDays(d)}>
                {d}일
              </button>
            ))}
          </span>
        </span>
        <span className="spacer" />
        <select value={newSite} onChange={(e) => setNewSite(e.target.value)} aria-label="추가할 지점">
          {SITES.map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.name}
            </option>
          ))}
        </select>
        <button
          disabled={columns.length >= 4}
          onClick={() =>
            setColumns((c) => [...c, { id: nextId++, site: newSite, t0: '2026-11-14T00:00' }])
          }
        >
          열 추가
        </button>
        <button onClick={() => setColumns(DEFAULT_COLUMNS)}>이 시나리오를 처음으로</button>
      </div>

      {columns.length === 0 ? (
        <div className="state-box" style={{ marginTop: 24 }}>
          <p>지점을 고르세요</p>
          <button onClick={() => setColumns(DEFAULT_COLUMNS)}>예시 시나리오 불러오기</button>
        </div>
      ) : (
        <div className="columns">
          {columns.map((c) => (
            <Column
              key={c.id}
              spec={c}
              days={days}
              data={data[c.site]}
              onRetry={() => {
                setData((d) => {
                  const next = { ...d };
                  delete next[c.site];
                  return next;
                });
                setRetries((r) => ({ ...r, [c.site]: (r[c.site] ?? 0) + 1 }));
              }}
              onChange={(next) => setColumns((cs) => cs.map((x) => (x.id === c.id ? next : x)))}
              onRemove={() => setColumns((cs) => cs.filter((x) => x.id !== c.id))}
              axisStart={axisStart}
              axisEnd={axisEnd}
            />
          ))}
        </div>
      )}

      <div className="footnote">
        지구 상한 limb 기준, 특정 지상국 가시성 아님. 전력량은 패널 방향과 효율에 따라 달라 계산하지
        않는다. 태양 고도가 낮을수록 수평 패널에 불리하다. 모든 지표는 지형 미반영(매끈한 구) 상한선이다.
      </div>
    </>
  );
}
