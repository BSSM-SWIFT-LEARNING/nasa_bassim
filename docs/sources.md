# 자료 출처

| 자료 | 용도 | 조건 |
|---|---|---|
| [JPL Horizons API](https://ssd-api.jpl.nasa.gov/doc/horizons.html) | 태양·지구 방위각과 고도각 | 응답의 NASA/JPL Horizons 표기 유지 |
| Horizons OBSERVER 테이블 사전 계산 (`web/public/data/*.json`, `web/test/fixtures/*.json`) | 8개 큐레이션 지점 + 기준 지점(-89.9, 0)의 태양·지구 az/el, 2026-11-01~2027-05-01, 1시간 간격 | `pipeline/generate.py`로 생성, 호출 간격 2초, `pipeline/cache/`에 원본 캐시. 각 JSON의 `source` 필드에 응답 signature 기록 |
| `backend/`의 실시간 Horizons 프록시 (`GET /api/ephemeris?lat=&lon_e=&body=`) | 직접 입력 좌표의 태양·지구 az/el, 사전 계산과 같은 범위·간격(2026-11-01~2027-05-01, 1시간) | 단일 순차 큐, 호출 간격 2초, `backend/cache/`에 원본 캐시(gitignore), 오류 응답은 캐시하지 않음 |
| PRD 지점 목록 출처: [LROC](https://lroc.im-ldi.com/images/1401), [DLR](https://www.dlr.de/en/blog/archive/2024/german-instrument-to-study-moons-eternal-shadows-with-private-mission), [De Rosa et al. 2012](https://arxiv.org/abs/1208.5587), [IAU Gazetteer](https://planetarynames.wr.usgs.gov/Feature/16272), [NSSDC](https://nssdc.gsfc.nasa.gov/planetary/lunar/lunar_sites.html) | `web/src/sites.ts` 좌표와 출처 링크 | PRD §5.4 표 그대로 |

# AI 사용 기록

| 날짜 | 도구 | 사용 내용 |
|---|---|---|
| 2026-11-01 | Claude Code | 저장소 구조, Horizons 파서, CI 작성 |
| 2026-11-01 | Devin (SWE-2 Medium, brgr 워커) | 1단계 P0 전체: 생성 CLI와 18개 JSON 생성, 지표 로직+vitest(수용 기준 1~7), 비교 화면, 스키마 갱신, check.sh |
| 2026-11-01 | Devin (SWE-2 Medium, brgr 워커) | Spring Boot Horizons 프록시(backend/)와 파서 이식+테스트, 웹 직접 좌표 입력 열, Vite 프록시, CI/check.sh/문서 갱신 |
