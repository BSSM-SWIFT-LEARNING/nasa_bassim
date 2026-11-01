# justn-prototype-1

달 착륙지 비교 도구의 연습용 프로토타입입니다. 대회 제출물이 아니며, 이 저장소의 코드와 데이터는 제출물로 옮기지 않습니다.

- `pipeline/`: Python. Horizons 호출과 지형 계산
- `web/`: Vite + React + TypeScript. 생성된 JSON을 읽는 정적 화면
- `schema/`: 두 쪽이 공유하는 JSON 스키마
- `docs/`: 자료 출처와 AI 사용 기록

## 처음 설정

```bash
git config core.hooksPath .githooks
```

push 전에 `scripts/check.sh`가 돕니다. CI도 같은 스크립트를 실행합니다.

CI 테스트는 Horizons를 호출하지 않고 `pipeline/tests/fixtures/`의 저장된 응답만 씁니다.
