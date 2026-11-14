# 자료 출처

| 자료 | 용도 | 조건 |
|---|---|---|
| [JPL Horizons API](https://ssd-api.jpl.nasa.gov/doc/horizons.html) | 태양·지구 방위각과 고도각 | 응답의 NASA/JPL Horizons 표기 유지 |
| Horizons OBSERVER 테이블 사전 계산 (`web/public/data/*.json`, `web/test/fixtures/*.json`) | 8개 큐레이션 지점 + 기준 지점(-89.9, 0)의 태양·지구 az/el, 2026-11-01~2027-05-01, 1시간 간격 | `pipeline/generate.py`로 생성, 호출 간격 2초, `pipeline/cache/`에 원본 캐시. 각 JSON의 `source` 필드에 응답 signature 기록 |
| `backend/`의 실시간 Horizons 프록시 (`GET /api/ephemeris?lat=&lon_e=&body=`) | 직접 입력 좌표의 태양·지구 az/el, 사전 계산과 같은 범위·간격(2026-11-01~2027-05-01, 1시간) | 단일 순차 큐, 호출 간격 2초, `backend/cache/`에 원본 캐시(gitignore), 오류 응답은 캐시하지 않음 |
| PRD 지점 목록 출처: [LROC](https://lroc.im-ldi.com/images/1401), [DLR](https://www.dlr.de/en/blog/archive/2024/german-instrument-to-study-moons-eternal-shadows-with-private-mission), [De Rosa et al. 2012](https://arxiv.org/abs/1208.5587), [IAU Gazetteer](https://planetarynames.wr.usgs.gov/Feature/16272), [NSSDC](https://nssdc.gsfc.nasa.gov/planetary/lunar/lunar_sites.html) | `web/src/sites.ts` 좌표와 출처 링크 | PRD §5.4 표 그대로 |
| [LRO WAC South Pole Mosaic](https://commons.wikimedia.org/wiki/File:LRO_WAC_South_Pole_Mosaic.jpg) (NASA/GSFC/Arizona State University) | 3D 달의 80°S 이남 표면 (`web/public/img/lunar-south-pole.jpg`, 1920px) | 퍼블릭 도메인. 극평사도법, 가장자리 80°S, 위쪽이 경도 0°. 화면 각주에 출처 표기, 내려받은 기록은 `web/public/img/credits.json` |
| [NASA SVS CGI Moon Kit](https://svs.gsfc.nasa.gov/4720) `lroc_color_poles_2k.tif` (LROC WAC 색 지도) | 3D 달의 표면 색 (`web/public/img/moon-surface.jpg`, 2048×1024 JPG로 변환) | 퍼블릭 도메인. 등장방형, 가운데가 경도 0° |
| [NASA SVS CGI Moon Kit](https://svs.gsfc.nasa.gov/4720) `ldem_16_uint.tif` (LOLA 고도, 1/16°) | 3D 달의 분화구 음영 (`web/public/img/moon-relief.jpg`: R은 동쪽 경사, G는 북쪽 경사, B는 고도. 2048×1024) | 퍼블릭 도메인. 원본(33MB)은 저장소에 넣지 않고 경사만 계산해 넣음. 화면에서는 경사를 4배 과장해 그림 |

# AI 사용 기록

| 날짜 | 도구 | 사용 내용 |
|---|---|---|
| 2026-11-01 | Claude Code | 저장소 구조, Horizons 파서, CI 작성 |
| 2026-11-01 | Devin (SWE-2 Medium, brgr 워커) | 1단계 P0 전체: 생성 CLI와 18개 JSON 생성, 지표 로직+vitest(수용 기준 1~7), 비교 화면, 스키마 갱신, check.sh |
| 2026-11-01 | Devin (SWE-2 Medium, brgr 워커) | Spring Boot Horizons 프록시(backend/)와 파서 이식+테스트, 웹 직접 좌표 입력 열, Vite 프록시, CI/check.sh/문서 갱신 |
| 2026-11-14 | Claude Code | 비교 화면 디자인 개편(어두운 바탕, 낮·밤 띠 강조), 돌려 볼 수 있는 3D 달과 지점 표시 추가(WebGL, 고도 자료에서 경사 지도 계산) |
