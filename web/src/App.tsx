import { comparisonSummary, fmtDuration } from './lib/comparison';
import type { ComparisonColumn } from './lib/comparison';
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
import { tickStepMs } from './lib/timelineTicks';
import { Moon3D } from './Moon3D';
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
const DEFAULT_DAYS = 14;
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


function Badge() {
  return <span className="badge">지형 미반영</span>;
}

function MetricCard({ title, value, sub }: { title: string; value: string; sub?: string }) {
  return (
    <div className="metric">
      <div className="title">{title}</div>
      <div className="value">{value}</div>
      <div className="sub">{sub ?? ''}</div>
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
  width,
  barH,
  cursorY,
}: {
  cells: boolean[];
  times: number[];
  rowY: number;
  color: string;
  axisStart: number;
  axisEnd: number;
  t0: number;
  showCursor: boolean;
  width: number;
  barH: number;
  cursorY: [number, number];
}) {
  const W = width;
  const x = (t: number) => ((t - axisStart) / (axisEnd - axisStart)) * W;
  // 1시간 칸을 따로 그리면 칸 경계마다 안티에일리어싱 줄무늬가 비친다.
  // 같은 값이 이어지는 칸은 하나의 사각형으로 합쳐 그린다.
  const runs: { start: number; end: number; v: boolean }[] = [];
  cells.forEach((v, i) => {
    const t = times[i]!;
    const last = runs[runs.length - 1];
    if (last && last.v === v && last.end === t) last.end = t + HOUR_MS;
    else runs.push({ start: t, end: t + HOUR_MS, v });
  });
  return (
    <g>
      {runs.map((r) => (
        <rect
          key={r.start}
          x={x(r.start)}
          y={rowY}
          width={x(r.end) - x(r.start)}
          height={barH}
          fill={r.v ? color : 'var(--dark)'}
          shapeRendering="crispEdges"
        />
      ))}
      {showCursor ? (
        <>
          <line x1={x(t0)} x2={x(t0)} y1={cursorY[0]} y2={cursorY[1]} stroke="var(--panel)" strokeWidth={6} />
          <line x1={x(t0)} x2={x(t0)} y1={cursorY[0]} y2={cursorY[1]} stroke="var(--cursor)" strokeWidth={2.5} />
        </>
      ) : null}
    </g>
  );
}

type Timeline = ReturnType<typeof timeline>;

function Timelines({
  tl,
  t0,
  days,
  axisStart,
  axisEnd,
}: {
  tl: Timeline;
  t0: number;
  days: number;
  axisStart: number;
  axisEnd: number;
}) {
  // svg는 width:100%로 viewBox 600이 화면 폭에 맞게 축소된다. 눈금 글자가
  // 실제 렌더링 기준 11px가 되도록 표시 폭을 재서 viewBox 단위 글자 크기를 역산한다.
  const svgRef = useRef<SVGSVGElement>(null);
  const [renderedW, setRenderedW] = useState(600);
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setRenderedW(el.getBoundingClientRect().width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scale = renderedW > 0 ? renderedW / 600 : 1;
  const font = Math.max(11, 11 / scale);
  // 행 레이블('태양'/'지구')이 막대와 겹치지 않게 레이블 영역을 글자 크기에 맞춘다.
  const labelW = Math.max(36, 2 * font + 8);
  const W = 600 - labelW;
  const x = (t: number) => ((t - axisStart) / (axisEnd - axisStart)) * W;
  // 눈금 간격도 렌더링 px 기준으로 골라 레이블끼리 겹치지 않게 한다.
  const tickStep = tickStepMs(axisEnd - axisStart, W * scale);
  const ticks: number[] = [];
  for (let t = Math.ceil(axisStart / tickStep) * tickStep; t <= axisEnd; t += tickStep)
    ticks.push(t);
  // 낮·밤 띠가 이 화면의 주인공이라 렌더링 기준으로도 충분히 두껍게 그린다.
  const barH = Math.max(28, 22 / scale);
  const gap = 6;
  const sunY = 4;
  const earthY = sunY + barH + gap;
  const axisY = earthY + barH + gap;
  const tickTextY = axisY + 6 + font;
  const vbH = tickTextY + font * 0.4;
  return (
    <div className="timeline-wrap">
      <svg
        className="timeline"
        ref={svgRef}
        viewBox={`0 0 600 ${vbH}`}
        role="img"
        aria-label={`태양과 지구 가시성 타임라인. t0 이후 ${days}일 동안 둘 다 가능한 시간은 ${fmtDuration(tl.bothVisibleMs)}`}
      >
        <text x={0} y={sunY + barH / 2} fontSize={font} fill="var(--muted)" dominantBaseline="central">
          태양
        </text>
        <text x={0} y={earthY + barH / 2} fontSize={font} fill="var(--muted)" dominantBaseline="central">
          지구
        </text>
        <g transform={`translate(${labelW},0)`}>
          {/* 공통 시간축 전체를 옅은 띠로 깔아, 이 열의 관찰 기간이 축의 어디인지 보이게 한다. */}
          <rect x={0} y={sunY} width={W} height={barH} fill="var(--track)" />
          <rect x={0} y={earthY} width={W} height={barH} fill="var(--track)" />
          <TimelineSvg
            cells={tl.sun.cells}
            times={tl.sun.times}
            rowY={sunY}
            color="var(--sunlit)"
            axisStart={axisStart}
            axisEnd={axisEnd}
            t0={t0}
            showCursor
            width={W}
            barH={barH}
            cursorY={[0, axisY]}
          />
          <TimelineSvg
            cells={tl.earth.cells}
            times={tl.earth.times}
            rowY={earthY}
            color="var(--earth)"
            axisStart={axisStart}
            axisEnd={axisEnd}
            t0={t0}
            showCursor={false}
            width={W}
            barH={barH}
            cursorY={[0, axisY]}
          />
          <line x1={0} x2={W} y1={axisY} y2={axisY} stroke="var(--border)" />
          {ticks.map((t) => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={axisY} y2={axisY + 5} stroke="var(--muted)" />
              <text x={x(t)} y={tickTextY} fontSize={font} fill="var(--muted)" textAnchor="middle">
                {fmtDate(t).slice(0, 5)}
              </text>
            </g>
          ))}
        </g>
      </svg>
    </div>
  );
}

function parseCoord(raw: string, lo: number, hi: number): number | null {
  const v = Number(raw);
  return raw.trim() !== '' && Number.isFinite(v) && v >= lo && v <= hi ? v : null;
}

function Column({
  spec,
  index,
  best,
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
  index: number;
  best: boolean;
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

  // applied(외부 리셋 포함)나 D가 바뀌면 한 effect에서 필드를 다시 판정한다.
  // apply 여부는 applied·days만으로 결정되므로, 같은 커밋에서 렌더 시점의
  // 오래된 field로 warn을 되살리는 일이 없다.
  useEffect(() => {
    const external = spec.t0 !== lastApplied.current;
    if (external) lastApplied.current = spec.t0;
    const d = t0DaysChanged(initialT0Field(), spec.t0, days);
    if (d.apply !== null) {
      lastApplied.current = d.apply;
      onChange({ ...spec, t0: d.apply });
      setField(d.field);
    } else if (external) {
      setField(initialT0Field());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.t0, days]);

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
      <div className="column-head">
        <span className="col-no" aria-hidden="true">
          {index}
        </span>
        <h2 className="sr-only">
          {index}열, {isCustom ? '직접 입력 좌표' : site?.name}
        </h2>
        <select
          className="site-select"
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
        </select>
        <button
          className="remove"
          data-remove-col={spec.id}
          onClick={onRemove}
          aria-label="열 제거"
        >
          ×
        </button>
      </div>
      <div className="coords">
        <span>
          {isCustom && spec.lat !== undefined && spec.lonE !== undefined
            ? `위도 ${spec.lat}°, 동경 ${spec.lonE}°`
            : !isCustom && site
              ? `위도 ${site.lat}°, 동경 ${site.lon_e}°`
              : '좌표 미입력'}
        </span>
        {!isCustom && site ? (
          <a className="source" href={site.sourceUrl}>
            좌표 출처
          </a>
        ) : null}
        <Badge />
      </div>
      <label className="controls">
        <span className="t0-label">시작 시각 t0 (UTC)</span>
        <input
          type="datetime-local"
          value={field.draft ?? appliedT0}
          step={60}
          min={T0_MIN}
          max={T0_MAX}
          onChange={(e) => applyDecision(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
          }}
          aria-label="t0 (UTC)"
        />
      </label>
      {field.warn ? <div className="warn">계산 범위 2026-11-01~2027-05-01</div> : null}
      {isCustom ? (
        <form
          noValidate
          className="custom-coords"
          onSubmit={(e) => {
            e.preventDefault();
            applyCoords();
          }}
        >
          <label>
            위도{' '}
            <input
              type="number"
              step="any"
              min={-90}
              max={90}
              value={latDraft}
              onChange={(e) => {
                setLatDraft(e.target.value);
                setCoordError(null);
              }}
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
              onChange={(e) => {
                setLonDraft(e.target.value);
                setCoordError(null);
              }}
              aria-label="동경"
            />
          </label>{' '}
          <button type="submit">적용</button>
          {coordError ? <div className="warn">{coordError}</div> : null}
        </form>
      ) : null}

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
          best={best}
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
  best,
  sun,
  earth,
  t0,
  days,
  axisStart,
  axisEnd,
}: {
  best: boolean;
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

  const tl = timeline(sun, earth, t0, days);

  return (
    <>
      <div className="lead">
        <div className="lead-label">
          태양과 지구가 함께 보이는 시간
          {best ? <span className="best">가장 김</span> : null}
        </div>
        <div className="lead-value">
          {fmtDuration(tl.bothVisibleMs)}
          <span className="lead-of"> / {days}일</span>
        </div>
      </div>
      <Timelines tl={tl} t0={t0} days={days} axisStart={axisStart} axisEnd={axisEnd} />
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
    </>
  );
}

let nextId = 10;

export default function App() {
  const [columns, setColumns] = useState<ColumnSpec[]>(DEFAULT_COLUMNS);
  const [days, setDays] = useState(DEFAULT_DAYS);
  const [data, setData] = useState<Record<string, SiteData>>({});
  const [retries, setRetries] = useState<Record<string, number>>({});
  const [newSite, setNewSite] = useState(SITES[0]!.slug);

  // 열 제거 버튼이나 예시 복원 버튼이 사라져도 포커스가 body로 떨어지지 않게,
  // 사라진 뒤 옮길 대상(다음/이전 열의 제거 버튼, 복원 버튼, 첫 열 지점 선택)을
  // 기억해 둔다.
  const pendingFocus = useRef<number | 'restore' | 'site' | null>(null);
  const removeColumn = (id: number) => {
    const idx = columns.findIndex((x) => x.id === id);
    const next = columns.filter((x) => x.id !== id);
    pendingFocus.current = next.length === 0 ? 'restore' : (next[idx] ?? next[idx - 1])!.id;
    setColumns(next);
  };
  useEffect(() => {
    if (pendingFocus.current === null) return;
    const target = pendingFocus.current;
    pendingFocus.current = null;
    const sel =
      target === 'restore'
        ? '[data-restore]'
        : target === 'site'
          ? '.columns [aria-label="지점"]'
          : `[data-remove-col="${target}"]`;
    document.querySelector<HTMLElement>(sel)?.focus();
  }, [columns]);

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

  // 화면의 질문에 대한 답: 태양과 지구가 함께 보이는 시간이 가장 긴 열.
  // 각 열이 그리는 값과 같은 timeline()에서 계산해 두 곳의 숫자가 어긋나지 않게 한다.
  const { finding, bestNos } = useMemo(() => {
    const states: ComparisonColumn[] = columns.map((c, i) => {
      const no = i + 1;
      const key = columnKey(c);
      if (key === null) return { no, status: 'missing' };
      const d = data[key];
      if (!d) return { no, status: 'loading' };
      if (d.status === 'error' || !d.sun || !d.earth) return { no, status: 'error' };
      return { no, status: 'ready', ms: timeline(d.sun, d.earth, parseT0Input(c.t0), days).bothVisibleMs };
    });
    return comparisonSummary(states, days);
  }, [columns, data, days]);

  const canAdd = columns.length < 4;
  const addColumn = (site: string) =>
    setColumns((c) =>
      c.length >= 4 ? c : [...c, { id: nextId++, site, t0: '2026-11-14T00:00' }]
    );

  return (
    <>
      <header className="hero">
        <div className="hero-text">
          <div className="product">
            <svg className="mark" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <path d="M12 2a10 10 0 0 1 0 20z" fill="currentColor" />
            </svg>
            <h1>달 착륙지 비교</h1>
          </div>
          <p className="finding">{finding}</p>

          <div className="scenario-bar">
            <div className="bar-row">
              <span className="d-label">관찰 기간 D</span>
              <span className="d-preset" role="group" aria-label="관찰 기간 D">
                {[7, 14, 28].map((d) => (
                  <button
                    key={d}
                    className={d === days ? 'active' : ''}
                    aria-pressed={d === days}
                    onClick={() => setDays(d)}
                  >
                    {d}일
                  </button>
                ))}
              </span>
            </div>
            <div className="bar-row">
              <select
                value={newSite}
                onChange={(e) => setNewSite(e.target.value)}
                aria-label="추가할 지점"
              >
                {SITES.map((s) => (
                  <option key={s.slug} value={s.slug}>
                    {s.name}
                  </option>
                ))}
                <option value={CUSTOM}>직접 좌표 입력</option>
              </select>
              <button className="primary" disabled={!canAdd} onClick={() => addColumn(newSite)}>
                열 추가
              </button>
              <button
                onClick={() => {
                  setColumns(DEFAULT_COLUMNS);
                  setDays(DEFAULT_DAYS);
                }}
              >
                이 시나리오를 처음으로
              </button>
            </div>
          </div>

          <p className="map-note">
            달은 끌어서 돌릴 수 있다.{' '}
            {canAdd
              ? '달 위의 지점을 누르면 그 지점이 새 열로 추가된다.'
              : '열은 4개까지 둘 수 있다.'}{' '}
            숫자가 적힌 점은 가까이 모인 지점 묶음이고, 누르면 그쪽으로 확대된다.
          </p>
          <p className="stamp">
            NASA/JPL Horizons 천체력, 2026-11-01부터 2027-05-01까지 1시간 간격
          </p>
        </div>
        <Moon3D columns={columns} canAdd={canAdd} onAdd={addColumn} />
      </header>

      {columns.length === 0 ? (
        <div className="state-box">
          <p>지점을 고르세요</p>
          <button
            data-restore
            onClick={() => {
              // 버튼이 사라지므로 복원 후 첫 열 지점 선택으로 포커스를 옮긴다.
              pendingFocus.current = 'site';
              setColumns(DEFAULT_COLUMNS);
              setDays(DEFAULT_DAYS);
            }}
          >
            예시 시나리오 불러오기
          </button>
        </div>
      ) : (
        <div className="columns">
          {columns.map((c, i) => {
            const key = columnKey(c);
            return (
            <Column
              key={c.id}
              spec={c}
              index={i + 1}
              best={bestNos.has(i + 1)}
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
              onRemove={() => removeColumn(c.id)}
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
        <br />
        달 표면과 고도:{' '}
        <a href="https://svs.gsfc.nasa.gov/4720">NASA SVS CGI Moon Kit</a> (LROC 색 지도, LOLA 고도).
        남극 지방:{' '}
        <a href="https://commons.wikimedia.org/wiki/File:LRO_WAC_South_Pole_Mosaic.jpg">
          LRO WAC South Pole Mosaic
        </a>
        , NASA/GSFC/Arizona State University. 모두 퍼블릭 도메인.
      </div>
    </>
  );
}
