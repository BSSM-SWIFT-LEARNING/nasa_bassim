import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';

import {
  BASE_RADIUS,
  centerOn,
  lookAt,
  normalize,
  projectToScreen,
  quatFromAxisAngle,
  quatMul,
  quatNormalize,
  quatSlerp,
  quatToMat3,
  siteVector,
} from './lib/globe';
import type { Quat, Vec3 } from './lib/globe';
import { SITES } from './sites';

// 달 전체 표면(등장방형 지도)과, 80°S 이남을 더 자세히 담은 남극 모자이크.
const SURFACE = '/img/moon-surface.jpg';
const SOUTH_CAP = '/img/lunar-south-pole.jpg';
// 고도 자료(LOLA)에서 미리 계산한 경사 지도. R은 동쪽, G는 북쪽 경사이고 0.5가 평지다.
const RELIEF = '/img/moon-relief.jpg';

const MAX_ZOOM = 16;
const CLUSTER_PX = 18; // 이보다 가까이 찍히는 지점은 하나로 묶는다

interface View {
  q: Quat; // world → view 회전
  zoom: number;
}

// 전체 보기: 지구에서 보는 앞면을 남쪽으로 조금 기울여 여덟 지점이 모두 보이게 한다.
const WHOLE: View = { q: lookAt(siteVector(-25, 12), [0, 1, 0]), zoom: 1 };
// 남극 보기: 경도 0°(지구 쪽)가 위로 오게 남극 지방을 내려다본다.
const POLE: View = { q: lookAt(siteVector(-85, 15), [0, 0, 1]), zoom: 2.6 };

const VERT = `
attribute vec2 aPos;
varying vec2 vP;
void main() {
  vP = aPos;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// 사각형 하나에 구를 직접 그린다(정사영). 화면의 각 점에서 구 표면의 법선을 구하고,
// 그 법선을 달 좌표계로 돌려 위도·경도를 얻어 표면 사진을 읽는다.
const FRAG = `
precision highp float;
uniform sampler2D uSurface;
uniform sampler2D uCap;
uniform sampler2D uRelief;
uniform mat3 uInv;   // view → world
uniform float uR;    // 달 반지름 (그림 영역 반폭 = 1)
uniform float uPx;   // 화면 1px의 크기 (같은 단위)
varying vec2 vP;

void main() {
  vec2 p = vP / uR;
  float d = length(p);
  if (d > 1.0) { gl_FragColor = vec4(0.0); return; }
  vec3 nv = vec3(p, sqrt(1.0 - d * d));
  vec3 n = uInv * nv;

  float lat = asin(clamp(n.y, -1.0, 1.0));
  float lon = atan(n.x, n.z);
  vec2 uv = vec2(lon / 6.2831853 + 0.5, 0.5 - lat / 3.14159265);
  vec3 col = texture2D(uSurface, uv).rgb * 0.92;

  // 실제 지형의 경사로 법선을 기울여 분화구와 산이 빛을 받게 한다. 경사는 보기 좋게 과장한다.
  vec2 slope = (texture2D(uRelief, uv).rg - 0.5) / 1.25;
  vec3 east = normalize(vec3(n.z, 0.0, -n.x) + vec3(1e-6, 0.0, 0.0));
  vec3 north = cross(n, east);
  vec3 nb = normalize(n - 4.0 * (slope.x * east + slope.y * north));

  // 80°S 이남은 남극 모자이크(극평사도법, 가장자리 80°S, 위쪽이 경도 0°)로 바꿔 그린다.
  // 모자이크에는 그림자가 이미 찍혀 있으므로 그 안에서는 경사 음영을 쓰지 않는다.
  float cap = smoothstep(-1.3963, -1.5010, lat);
  if (cap > 0.0) {
    vec2 q = vec2(n.x, -n.z) / ((1.0 - n.y) * 0.0874887);
    vec3 c = pow(texture2D(uCap, 0.5 + 0.5 * q).rgb, vec3(0.52)) * vec3(1.1, 1.08, 1.04);
    col = mix(col, c, cap);
    nb = normalize(mix(nb, n, cap));
  }

  // 빛은 화면 왼쪽 위에서 온다. 달을 돌려도 둥근 입체감이 유지된다.
  vec3 L = normalize(vec3(-0.55, 0.5, 0.67));
  float lit = max(dot(nb * uInv, L), 0.0) * smoothstep(-0.05, 0.2, dot(nv, L));
  col *= 0.16 + 1.05 * lit;

  float a = clamp((1.0 - d) * uR / (1.5 * uPx), 0.0, 1.0);
  gl_FragColor = vec4(col * a, a);
}`;

interface Renderer {
  gl: WebGLRenderingContext;
  uInv: WebGLUniformLocation | null;
  uR: WebGLUniformLocation | null;
  uPx: WebGLUniformLocation | null;
}

function createRenderer(canvas: HTMLCanvasElement, onTexture: () => void): Renderer | null {
  const gl = canvas.getContext('webgl', { alpha: true, antialias: false });
  if (!gl) return null;
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
  };
  const vs = compile(gl.VERTEX_SHADER, VERT);
  const fs = compile(gl.FRAGMENT_SHADER, FRAG);
  const prog = gl.createProgram();
  if (!vs || !fs || !prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  // 사진이 도착하기 전에는 회색 구로 그린다.
  const texture = (unit: number, name: string, src: string, repeatX: boolean) => {
    const tex = gl.createTexture();
    const bind = () => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
    };
    bind();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 128, 255]));
    gl.uniform1i(gl.getUniformLocation(prog, name), unit);
    const img = new Image();
    img.onload = () => {
      bind();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      const pot = (n: number) => (n & (n - 1)) === 0;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_WRAP_S,
        repeatX && pot(img.width) && pot(img.height) ? gl.REPEAT : gl.CLAMP_TO_EDGE
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      onTexture();
    };
    img.src = src;
  };
  texture(0, 'uSurface', SURFACE, true);
  texture(1, 'uCap', SOUTH_CAP, false);
  texture(2, 'uRelief', RELIEF, true);

  return {
    gl,
    uInv: gl.getUniformLocation(prog, 'uInv'),
    uR: gl.getUniformLocation(prog, 'uR'),
    uPx: gl.getUniformLocation(prog, 'uPx'),
  };
}

// 레이블이 이웃 지점과 겹치지 않게 지점마다 방향을 정해 둔다 (남극 보기 기준).
type Side = 'right' | 'left' | 'top' | 'bottom';
const LABEL_SIDE: Record<string, Side> = {
  mp2: 'left',
  cr1: 'bottom',
  gr2: 'left',
};

// 달 위 레이블에 쓰는 짧은 이름. 없으면 slug를 대문자로 쓴다 (IM-2, SR1 …).
const SHORT_NAME: Record<string, string> = {
  'chandrayaan-3': 'Chandrayaan-3',
  'apollo-11': 'Apollo 11',
};

interface MapColumn {
  site: string; // 큐레이션 slug 또는 'custom'
  lat?: number;
  lonE?: number;
}

interface Mark {
  key: string;
  slug: string | null; // null이면 직접 입력 좌표라 누를 수 없다
  label: string;
  title: string;
  world: Vec3;
  cols: number[]; // 이 지점을 쓰는 열 번호
  side: Side;
}

const pct = (v: number) => `${50 + 50 * v}%`;

function Chips({ cols }: { cols: number[] }) {
  return (
    <>
      {cols.map((n) => (
        <span className="chip" key={n}>
          {n}
        </span>
      ))}
    </>
  );
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function Moon3D({
  columns,
  canAdd,
  onAdd,
}: {
  columns: MapColumn[];
  canAdd: boolean;
  onAdd: (slug: string) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const [failed, setFailed] = useState(false);
  const [size, setSize] = useState(0);
  const [, setTextures] = useState(0);
  const [view, setView] = useState<View>(() => (reducedMotion() ? POLE : WHOLE));

  // 애니메이션과 끌기 핸들러가 최신 값을 읽을 수 있게 거울을 둔다.
  const viewRef = useRef(view);
  const sizeRef = useRef(size);
  useEffect(() => {
    viewRef.current = view;
    sizeRef.current = size;
  });

  const raf = useRef(0);
  const stopAnimation = () => cancelAnimationFrame(raf.current);
  const animateTo = (to: View, ms: number) => {
    stopAnimation();
    if (reducedMotion()) {
      setView(to);
      return;
    }
    const from = viewRef.current;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const e = easeInOut(t);
      setView({
        q: quatSlerp(from.q, to.q, e),
        zoom: Math.exp(Math.log(from.zoom) + (Math.log(to.zoom) - Math.log(from.zoom)) * e),
      });
      if (t < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  };

  // 처음 한 번: 전체 모습에서 남극으로 돌아 들어간다. 달이 입체라는 것을 보여 주는 유일한 연출이다.
  useEffect(() => {
    if (reducedMotion()) return;
    const timer = window.setTimeout(() => animateTo(POLE, 1800), 500);
    return () => {
      window.clearTimeout(timer);
      stopAnimation();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let alive = true;
    const r = createRenderer(canvas, () => {
      if (alive) setTextures((n) => n + 1);
    });
    rendererRef.current = r;
    if (!r) setFailed(true);
    return () => {
      alive = false;
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize(el.getBoundingClientRect().width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 상태가 바뀔 때마다 다시 그린다. 사각형 하나라 비용이 작다.
  useEffect(() => {
    const r = rendererRef.current;
    const canvas = canvasRef.current;
    if (!r || !canvas || size <= 0) return;
    const px = Math.max(1, Math.round(size * Math.min(window.devicePixelRatio || 1, 2)));
    if (canvas.width !== px) {
      canvas.width = px;
      canvas.height = px;
    }
    const { gl } = r;
    gl.viewport(0, 0, px, px);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    // 행 우선 world→view 행렬을 그대로 넘기면 GL은 전치(view→world)로 읽는다.
    gl.uniformMatrix3fv(r.uInv, false, new Float32Array(quatToMat3(view.q)));
    gl.uniform1f(r.uR, BASE_RADIUS * view.zoom);
    gl.uniform1f(r.uPx, 2 / px);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  });

  const marks = useMemo(() => {
    const out: Mark[] = SITES.map((s) => ({
      key: s.slug,
      slug: s.slug,
      label: SHORT_NAME[s.slug] ?? s.slug.toUpperCase(),
      title: s.name,
      world: siteVector(s.lat, s.lon_e),
      cols: columns.flatMap((c, i) => (c.site === s.slug ? [i + 1] : [])),
      side: LABEL_SIDE[s.slug] ?? 'right',
    }));
    // 직접 입력 좌표도 찍는다. 같은 좌표를 쓰는 열은 한 점으로 모은다.
    const custom = new Map<string, Mark>();
    columns.forEach((c, i) => {
      if (c.site !== 'custom' || c.lat === undefined || c.lonE === undefined) return;
      const key = `custom:${c.lat}:${c.lonE}`;
      const existing = custom.get(key);
      if (existing) existing.cols.push(i + 1);
      else
        custom.set(key, {
          key,
          slug: null,
          label: '직접 입력',
          title: `직접 입력 좌표 (위도 ${c.lat}°, 동경 ${c.lonE}°)`,
          world: siteVector(c.lat, c.lonE),
          cols: [i + 1],
          side: 'right',
        });
    });
    return [...out, ...custom.values()];
  }, [columns]);

  // 화면에서 너무 가까운 지점은 하나로 묶는다. 묶음을 누르면 그쪽으로 확대된다.
  const m = quatToMat3(view.q);
  const half = size / 2;
  const groups: { x: number; y: number; members: Mark[] }[] = [];
  for (const mk of marks) {
    const s = projectToScreen(m, view.zoom, mk.world);
    if (!s.visible) continue;
    const g = groups.find((o) => Math.hypot((o.x - s.x) * half, (o.y - s.y) * half) < CLUSTER_PX);
    if (g) g.members.push(mk);
    else groups.push({ x: s.x, y: s.y, members: [mk] });
  }

  const drag = useRef<{ x: number; y: number; id: number } | null>(null);
  const spin = (dx: number, dy: number) =>
    setView((v) => ({
      zoom: v.zoom,
      q: quatNormalize(
        quatMul(quatFromAxisAngle([0, 1, 0], dx), quatMul(quatFromAxisAngle([1, 0, 0], dy), v.q))
      ),
    }));
  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    stopAnimation();
    drag.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    // 표면이 손가락을 그대로 따라오도록 화면 위 달 반지름으로 나눈다.
    const rpx = Math.max(1, (sizeRef.current / 2) * BASE_RADIUS * viewRef.current.zoom);
    spin((e.clientX - d.x) / rpx, (e.clientY - d.y) / rpx);
    d.x = e.clientX;
    d.y = e.clientY;
  };
  const onPointerEnd = (e: PointerEvent<HTMLCanvasElement>) => {
    if (drag.current?.id === e.pointerId) drag.current = null;
  };
  const onKeyDown = (e: KeyboardEvent<HTMLCanvasElement>) => {
    const step = 0.12 / view.zoom;
    const by: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const d = by[e.key];
    if (!d) return;
    e.preventDefault();
    stopAnimation();
    spin(d[0], d[1]);
  };

  const zoomBy = (f: number) =>
    animateTo({ q: view.q, zoom: Math.min(MAX_ZOOM, Math.max(1, view.zoom * f)) }, 300);

  if (failed)
    return (
      <div className="moon">
        <img
          className="moon-fallback"
          src={SOUTH_CAP}
          width={1920}
          height={1920}
          alt="달 남극 80°S 이남을 찍은 LROC 광각 카메라 모자이크"
        />
      </div>
    );

  return (
    <div className="moon" ref={wrapRef}>
      <div className="moon-view">
        <canvas
          ref={canvasRef}
          tabIndex={0}
          role="img"
          aria-label="3D 달. 끌거나 화살표 키로 돌릴 수 있고, 표시된 지점을 누르면 그 지점이 새 열로 추가된다."
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onKeyDown={onKeyDown}
        />
      </div>

      {(size > 0 ? groups : []).map((g) => {
        const style = { left: pct(g.x), top: pct(g.y) };
        const first = g.members[0]!;
        if (g.members.length > 1) {
          const cols = [...new Set(g.members.flatMap((x) => x.cols))].sort((a, b) => a - b);
          const center = normalize(
            g.members.reduce<Vec3>((acc, x) => [acc[0] + x.world[0], acc[1] + x.world[1], acc[2] + x.world[2]], [0, 0, 0])
          );
          const names = g.members.map((x) => x.label).join(', ');
          return (
            <button
              key={`group:${first.key}`}
              type="button"
              className="marker cluster side-right"
              style={style}
              onClick={() =>
                animateTo({ q: centerOn(view.q, center), zoom: Math.min(MAX_ZOOM, view.zoom * 2.6) }, 800)
              }
              aria-label={`${names} 확대해서 보기`}
              title={`${names} 확대해서 보기`}
            >
              {g.members.length}
              <span className="marker-label">
                {g.members.length}곳
                <Chips cols={cols} />
              </span>
            </button>
          );
        }
        const cls = `marker side-${first.side}${first.cols.length > 0 ? ' used' : ''}`;
        const label = (
          <span className="marker-label">
            {first.label}
            <Chips cols={first.cols} />
          </span>
        );
        if (first.slug === null)
          return (
            <span key={first.key} className={cls} style={style} title={first.title}>
              {label}
            </span>
          );
        const slug = first.slug;
        return (
          <button
            key={first.key}
            type="button"
            className={cls}
            style={style}
            disabled={!canAdd}
            onClick={() => onAdd(slug)}
            aria-label={`${first.title} 열 추가`}
            title={canAdd ? `${first.title} 열 추가` : '열은 4개까지 둘 수 있다'}
          >
            {label}
          </button>
        );
      })}

      <div className="moon-tools moon-tools-view" role="group" aria-label="달 보기">
        <button type="button" onClick={() => animateTo(POLE, 900)}>
          남극
        </button>
        <button type="button" onClick={() => animateTo(WHOLE, 900)}>
          전체
        </button>
      </div>
      <div className="moon-tools moon-tools-zoom" role="group" aria-label="확대와 축소">
        <button type="button" onClick={() => zoomBy(1 / 1.6)} disabled={view.zoom <= 1} aria-label="축소">
          −
        </button>
        <button type="button" onClick={() => zoomBy(1.6)} disabled={view.zoom >= MAX_ZOOM} aria-label="확대">
          +
        </button>
      </div>
    </div>
  );
}
