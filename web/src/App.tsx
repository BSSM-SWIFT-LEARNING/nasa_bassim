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

const CUSTOM = 'custom';

interface ColumnSpec {
  id: number;
  site: string; // 큐레이션 slug 또는 'custom'
  t0: string; // datetime-local 값, UTC로 해석한다
  lat?: number; // custom 열에서 적용된 좌표
  lonE?: number;
}

// 사전 계산 열은 slug, 직접 입력 열은 좌표가 데이터 캐시 키다.
// 좌표가 아직 없는 custom 열은 null을 돌려 요청을 만들지 않는다.
function columnKey(c: ColumnSpec): string | null {
  if (c.site !== CUSTOM) return c.site;
  if (c.lat === undefined || c.lonE === undefined) return null;
  return `custom:${c.lat}:${c.lonE}`;
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

// 큐레이션 열은 정적 JSON, 직접 입력 열은 /api/ephemeris 프록시(백엔드)에서 가져온다.
async function fetchSiteData(key: string): Promise<SiteData> {
  const urls = key.startsWith('custom:')
    ? (() => {
        const [, lat, lon] = key.split(':');
        const q = `lat=${lat}&lon_e=${lon}`;
        return [`/api/ephemeris?${q}&body=sun`, `/api/ephemeris?${q}&body=earth`];
      })()
    : [`/data/${key}_sun.json`, `/data/${key}_earth.json`];
  const [sun, earth] = await Promise.all(
    urls.map((u) =>
      fetch(u).then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json() as Promise<Ephemeris>;
      })
    )
  );
  return { status: 'ok', sun, earth };
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

function parseCoord(raw: string, lo: number, hi: number): number | null {
  const v = Number(raw);
  return raw.trim() !== '' && Number.isFinite(v) && v >= lo && v <= hi ? v : null;
}

function Column({
  spec,
  days,
  data,
  loading,
  onRetry,
  onChange,
  onRemove,
  axisStart,
  axisEnd,
}: {
  spec: ColumnSpec;
  days: number;
  data: SiteData | undefined;
  loading: boolean;
  onRetry: () => void;
  onChange: (next: ColumnSpec) => void;
  onRemove: () => void;
  axisStart: number;
  axisEnd: number;
}) {
  const isCustom = spec.site === CUSTOM;
  const site = SITES.find((s) => s.slug === spec.site);

  // 직접 입력 좌표: draft는 입력 중 자유롭게, 적용 버튼에서만 검증 후 요청한다.
  const [latDraft, setLatDraft] = useState(spec.lat?.toString() ?? '');
  const [lonDraft, setLonDraft] = useState(spec.lonE?.toString() ?? '');
  const [coordError, setCoordError] = useState<string | null>(null);

  const applyCoords = () => {
    const lat = parseCoord(latDraft, -90, 90);
    const lon = parseCoord(lonDraft, -360, 360);
    if (lat === null) {
      setCoordError('위도는 -90~90 사이 숫자');
      return;
    }
    if (lon === null) {
      setCoordError('동경은 -360~360 사이 숫자');
      return;
    }
    setCoordError(null);
    onChange({ ...spec, lat, lonE: lon });
  };

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
          <option value={CUSTOM}>직접 좌표 입력</option>
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
      {isCustom ? (
        <div className="custom-coords">
          <label>
            위도{' '}
            <input
              type="number"
              step="any"
              min={-90}
              max={90}
              value={latDraft}
              onChange={(e) => setLatDraft(e.target.value)}
              aria-label="위도"
            />
          </label>{' '}
          <label>
            동경{' '}
            <input
              type="number"
              step="any"
              min={-360}
              max={360}
              value={lonDraft}
              onChange={(e) => setLonDraft(e.target.value)}
              aria-label="동경"
            />
          </label>{' '}
          <button onClick={applyCoords}>적용</button>
          {coordError ? <div className="warn">{coordError}</div> : null}
        </div>
      ) : null}
      <h2>
        {isCustom ? '직접 입력 좌표' : site?.name} <Badge />
      </h2>
      <div className="coords">
        {isCustom && spec.lat !== undefined && spec.lonE !== undefined
          ? `위도 ${spec.lat}°, 동경 ${spec.lonE}° · `
          : !isCustom && site
            ? `위도 ${site.lat}°, 동경 ${site.lon_e}° · `
            : ''}
        t0 {appliedT0.replace('T', ' ')} UTC
      </div>
      <div className="source">
        {isCustom ? (
          spec.lat !== undefined && spec.lonE !== undefined ? (
            <span>
              좌표 {spec.lat}°, {spec.lonE}°E
            </span>
          ) : null
        ) : site ? (
          <a href={site.sourceUrl}>좌표 출처</a>
        ) : null}
      </div>

      {isCustom && spec.lat === undefined ? (
        <div className="state-box">위도와 동경을 입력하고 적용하세요</div>
      ) : loading || !data ? (
        <div className="state-box">
          데이터 불러오는 중
          {isCustom ? <div className="sub">첫 요청은 몇 초 걸릴 수 있습니다</div> : null}
        </div>
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

  const needed = useMemo(
    () => [...new Set(columns.map(columnKey).filter((k): k is string => k !== null))],
    [columns]
  );
  const inflight = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const key of needed) {
      if (data[key] !== undefined || inflight.current.has(key)) continue;
      inflight.current.add(key);
      fetchSiteData(key)
        .then((d) => setData((prev) => ({ ...prev, [key]: d })))
        .catch(() => setData((prev) => ({ ...prev, [key]: { status: 'error' } })))
        .finally(() => inflight.current.delete(key));
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
          <option value={CUSTOM}>직접 좌표 입력</option>
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
          {columns.map((c) => {
            const key = columnKey(c);
            return (
            <Column
              key={c.id}
              spec={c}
              days={days}
              data={key === null ? undefined : data[key]}
              loading={key !== null && data[key] === undefined}
              onRetry={() => {
                if (key === null) return;
                setData((d) => {
                  const next = { ...d };
                  delete next[key];
                  return next;
                });
                setRetries((r) => ({ ...r, [key]: (r[key] ?? 0) + 1 }));
              }}
              onChange={(next) => setColumns((cs) => cs.map((x) => (x.id === c.id ? next : x)))}
              onRemove={() => setColumns((cs) => cs.filter((x) => x.id !== c.id))}
              axisStart={axisStart}
              axisEnd={axisEnd}
            />
            );
          })}
        </div>
      )}

      <div className="footnote">
        지구 상한 limb 기준, 특정 지상국 가시성 아님. 전력량은 패널 방향과 효율에 따라 달라 계산하지
        않는다. 태양 고도가 낮을수록 수평 패널에 불리하다. 모든 지표는 지형 미반영(매끈한 구) 상한선이다.
      </div>
    </>
  );
}
