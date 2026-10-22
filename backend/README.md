# 업무 접수·보관 API (Phase 3 계정·업무 저장)

Express 5 + TypeScript + Node.js 24 내장 SQLite를 사용합니다. AI 실행기는 없으며 업무 접수 기록은 `received` / `not_connected` 상태입니다. 파일별 정량 집계는 별도 영구 큐와 Node 워커에서 실행합니다. 저장만으로 캐릭터를 이동시키지 않습니다.

## 실행

저장소 루트에서 `npm ci`, `npm run dev`로 API(3001)·Vite(5173)를 함께 시작합니다. `npm run build && npm run preview`는 빌드된 UI와 API를 같은 서버(기본 3001)로 제공합니다. API만 개발하려면 `npm run dev:api`를 사용합니다. `npm run typecheck`, `npm test`는 프론트엔드와 백엔드를 모두 검사합니다.

| 환경 변수        | 기본값                   | 용도                                             |
| ---------------- | ------------------------ | ------------------------------------------------ |
| `PORT`           | `3001`                   | API 및 통합 프리뷰 포트. 개발 프록시는 3001 고정 |
| `HOST`           | `127.0.0.1`              | 로컬 전용 기본 바인딩                            |
| `OFFICE_DB_PATH` | `database/office.sqlite` | 저장소 루트 기준 경로 또는 절대 경로             |
| `NODE_ENV`       | 개발 실행                | `production`이면 쿠키에 Secure 적용. HTTPS 필요  |

비밀 변수·외부 서비스·별도 DB 서버는 필요하지 않습니다. 기본 로컬 계정 인증을 제공합니다. 공개 운영 배포·본인 확인·조직 권한은 미완료입니다.

## API 계약

모든 오류는 `{ "error": "한국어 안내" }` JSON입니다. 목록·상세·이벤트에 세션 토큰이나 내부 소유자 키를 반환하지 않으며 `Cache-Control: no-store`를 적용합니다.

| 요청                              | 응답                                                                     |
| --------------------------------- | ------------------------------------------------------------------------ |
| `GET /api/health`                 | 준비 상태와 `executionMode: not_connected`                               |
| `GET /api/jobs?limit=20&offset=0` | `jobs`, `page: { total, limit, offset, hasMore }`. 생성 시각·ID 내림차순 |
| `POST /api/jobs`                  | 최초 `201`, 같은 요청 재시도 `200`: `{ job, replayed }`                  |
| `GET /api/jobs/:id`               | `{ job, events }`. 다른 소유자·없는 ID는 모두 `404`                      |
| `GET /api/jobs/:id/events`        | `{ events }`, 동일한 소유권 확인                                         |

목록의 `limit`는 1~100, `offset`은 0 이상의 안전한 정수입니다. 모든 업무 조회·저장에 계정 로그인이 필요하며, 유효한 로그인 세션이 없으면 `401`로 거부합니다. 쿠키가 차단된 환경에서 접근할 수 없는 업무를 생성하지 않습니다.

POST 본문 예시:

```json
{
  "kind": "survey",
  "title": "가상 교육 과정 설문 집계 요청",
  "instructions": "가상 응답의 누락 항목을 확인해 주세요."
}
```

- `kind`: `survey`, `notice`, `monitor`, `excel`, `slides`, `schedule` 중 하나.
- `title`: 양끝 공백 제거 후 2~100자. `instructions`: 1~5,000자.
- 그 외 필드는 거부합니다. 담당자·상태·실행 모드·소유권은 서버가 정합니다.
- `Content-Type: application/json`, `X-Office-Request: 1`, `Idempotency-Key` 헤더가 필요합니다.
- 요청 식별자는 영문·숫자·`_`·`-` 8~100자. 소유자와 키의 조합으로 중복 방지. 같은 키·다른 내용은 `409`입니다.
- 응답 유실 시 같은 키로 재시도하세요. UI는 실패 시 입력·키를 유지하고 입력 내용 변경 시 새 키를 만듭니다.
- JSON 본문은 32 KiB 이하이며 초과 시 `413`. 입력 검증 실패는 `400`입니다.

현재 이벤트는 접수 1건입니다. 서버 재시작 후 업무·이벤트·세션 연결을 그대로 읽습니다. 트랜잭션으로 업무와 이벤트를 함께 저장하며 요청 본문을 콘솔 로그에 출력하지 않습니다.

## 계정·세션과 접근 범위

회원가입·로그인·로그아웃·일회용 복구 코드·재발급·기존 이력 가져오기를 구현했습니다. [계정 API와 보안·복구 상세](../docs/AUTHENTICATION.md)를 확인하세요. 현재 비밀번호는 scrypt 해시로, 로그인 세션과 복구 코드는 난수 값의 SHA-256 해시로만 저장합니다. 로그인 쿠키는 7일 유효하며 만료 후 같은 계정으로 로그인하면 업무를 복원합니다.

계정별로 모든 업무·이벤트를 조회하며 다른 계정의 ID는 404입니다. 요청 중복 방지 키도 계정 범위로 적용합니다. 쓰기 요청은 JSON·전용 헤더·동일 Host의 Origin을 요구합니다. CORS를 허용하지 않습니다. 프록시는 원래 Host를 보존하고 운영 시 HTTPS를 제공해야 합니다.

기존 익명 업무는 삭제하지 않습니다. 이전 쿠키가 남아 있으면 로그인 후 명시적으로 가져올 수 있습니다. 가져오기 전에는 계정에 노출하지 않으며 이미 가져온 업무를 다른 계정이 다시 가져갈 수 없습니다. 원래 쿠키가 없으면 익명 소유권을 임의로 추정하지 않습니다.

기본 계정 인증을 구현했지만 공개 운영 준비가 끝난 것은 아닙니다. 본인 확인·조직 권한·분산 시도 제한·보존/삭제·감사 체계·보안 점검은 후속 단계입니다.

## DB와 보존

현재 스키마는 `PRAGMA user_version=10`입니다. v1의 `sessions`, `jobs`, `job_events`를 보존하고 `users`, 세션의 사용자 참조, 업무의 계정 참조·인덱스를 추가합니다. FK·WAL·busy timeout을 사용합니다. DB 파일 권한은 가능한 환경에서 0600, 새 상위 디렉터리는 0700으로 설정합니다. DB는 암호화되지 않습니다. Windows 파일 권한은 별도 점검이 필요합니다.

설치·빌드·서버 시작 시 DB나 업무를 초기화하지 않습니다. DB·WAL·SHM은 Git에서 제외합니다. 복사는 서버를 정상 종료한 뒤 진행하세요. 온라인 백업·보존 기간·삭제 API는 후속 단계입니다. 테스트는 임시 DB 또는 `database/e2e.sqlite`를 사용해 기본 DB와 분리합니다.

AI 자동 분석, 수정·삭제, 조직 결재선, AI 실행 큐, 실제 AI·Python 처리는 아직 없습니다.

XLSX/CSV 첨부·다운로드는 [첨부 안내](../docs/ATTACHMENTS.md)에 정리했습니다. v3는 기존 업무·계정을 보존하고 attachments 테이블을 추가합니다.

v4는 열 선택용 column_selections 테이블을 추가합니다. 미리보기·열 선택 API는 [미리보기 안내](../docs/FILE_PREVIEW.md)에 정리했습니다.

저장된 선택 버전으로 원본 전체를 계산하는 집계 API는 [기초 집계 안내](../docs/BASIC_SUMMARY.md)를 따릅니다. 이 동기 집계 경로는 결과를 별도 저장하지 않고 반환합니다. 백그라운드 실행의 결과 보관은 아래 큐 안내를 참고하세요.

전체 빈도 CSV는 `POST /api/jobs/:id/attachments/:fileId/summary.csv`로 같은 저장 버전과 원본을 재검증해 내려줍니다. 출력 형식·텍스트 보호·20MiB 제한은 [기초 집계 안내](../docs/BASIC_SUMMARY.md)를 따릅니다.

인쇄용 HTML 보고서는 `POST /api/jobs/:id/attachments/:fileId/summary.html`로 같은 검사를 적용합니다. 출력은 이스케이프한 텍스트·내장 CSS만 사용하는 5MiB 이하 단일 파일이며 스키마 변경은 없습니다. 그래프/표의 표시 한도와 API 정책은 [기초 집계 안내](../docs/BASIC_SUMMARY.md)를 따릅니다.

v5는 기존 열 선택에 `questions_json`을 추가합니다. 선택 버전 하나로 설문 문항·척도·필수 여부를 함께 저장하고 모든 집계 다운로드에서 재검증합니다. API·행 유효성·문항 통계의 기준은 [설문 설정 안내](../docs/SURVEY_SETTINGS.md)를 참고하세요.

`POST /api/jobs/:id/attachments/:fileId/summary.xlsx`는 같은 선택 버전의 분석 XLSX를 비캐시 첨부 파일로 반환합니다. `yazl` 3.3.1은 런타임 의존성이며 XLSX 출력 자체는 DB 스키마를 변경하지 않습니다. 텍스트 셀·긴 값 분할·20MiB 제한과 API 정책은 [XLSX 내보내기 안내](../docs/XLSX_EXPORT.md)를 따릅니다.

v6는 파일별 정량 집계 큐·전환 이벤트·큐 소유권을 추가합니다. 상태·접수/취소/결과 API·재시작·한도는 [백그라운드 집계 안내](../docs/BACKGROUND_SUMMARY.md)를 따릅니다. DB에는 완료 집계값도 저장되므로 DB·입력 원본·출력 파일을 함께 비공개 백업하세요.

v7은 `summary_run_artifacts`를 추가합니다. `OFFICE_OUTPUT_DIR` 기본값은 `storage/output/runs`이며 테스트는 별도 출력 경로를 사용합니다. 실행별 CSV/HTML/XLSX 게시·무결성·이전 기록 처리는 [실행 결과 파일 안내](../docs/RUN_ARTIFACTS.md)를 따릅니다.

v8은 summary_run_reviews를 추가합니다. 실행별 승인·반려·대상 해시·영구 검토 이력·재전송 계약은 [결과 검토 안내](../docs/RESULT_REVIEW.md)를 따릅니다.

업무 목록/상세의 `job.activity`는 첨부별 최근 실행·검토 기록과 전체 대기/실행 건수를 반환합니다. 파일 무결성은 읽지 않으며 조회 계약은 v9에서도 유지합니다. 범위·정렬·응답은 [업무 현황 안내](../docs/JOB_ACTIVITY.md)를 따릅니다.

`GET /api/jobs`는 `q`와 `status`를 페이지 조회 전에 적용하고 정규화한 `filters`를 반환합니다. 허용 상태·100자 검색·총건수·잘못된 쿼리 처리 기준은 [업무 검색 안내](../docs/JOB_SEARCH.md)를 따릅니다. 조회 계약은 v9에서도 유지합니다.

계정별 읽기 전용 WebSocket `/api/jobs/updates?account=<UUID>`의 권한·Origin·연결 제한·종료와 스냅샷 복구 계약은 [업무 자동 갱신 안내](../docs/JOB_UPDATES.md)를 따릅니다.

v9는 계정별 영구 변경 이력·커서와 원자적 기록 트리거를 추가합니다. WebSocket의 선택 cursor와 순서별 재생·재설정·마이그레이션 계약은 [영구 이벤트 안내](../docs/EVENT_REPLAY.md)를 따릅니다.

`GET /api/jobs/office`는 계정 전체의 정량 집계 상태·대표 실행·최근 5개 기록을 읽기 전용으로 반환합니다. 검색/페이지 조건을 받지 않으며 상태 분류·인증·무결성 표시 한계는 [서버 오피스 안내](../docs/SERVER_OFFICE.md)를 따릅니다. 오피스 조회 계약은 v10에서도 유지합니다.


v10은 AI 텍스트 초안 전용 실행 기록·lease·영구 상태 이력/결과를 추가합니다. `/api/jobs/:id/ai-runs`의 조회/접수/취소·기본 비활성·운영 등록·중복 방지·미확정 복구·검수 필요 계약은 [AI 큐 안내](../docs/AI_QUEUE.md)를 따릅니다. 기존 정량 집계·검토와 별개이며 실제 모델 호출과 AI 화면은 아직 연결하지 않았습니다.
