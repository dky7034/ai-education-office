# Codex stdio 통신 어댑터

2026-10-22 기준, CLI **0.163.0**의 비공개 자식 프로세스와 `initialize` → `initialized` 통신을 구현했습니다. 실제 CLI의 초기화 계약도 확인했습니다. 앱의 업무 큐·계정·오피스·AI 모델 실행에는 연결하지 않았습니다. 정량 집계는 기존 Node 워커로 계속 처리합니다.

## 실행

현재 Linux 실행 서버·Node.js 24 이상에서 검증했습니다. 운영자가 신뢰하는 Codex 0.163.0 실행 파일을 별도로 준비하고 절대 경로를 지정합니다. CLI를 저장소에 포함하거나 자동 설치하지 않습니다.

```sh
OFFICE_CODEX_BIN=/absolute/path/to/codex npm run check:codex
```

검사 명령은 버전 출력이 정확히 `codex-cli 0.163.0`인지 확인하고 `app-server --listen stdio://`를 시작합니다. 초기화 응답의 필수 필드와 격리된 CODEX_HOME 경로를 검사하고 `initialized` 알림을 보낸 뒤 종료합니다. 버전 불일치·실행 실패·응답 오류는 비정상 종료 코드입니다. 성공 메시지는 **통신 초기화 성공**만 뜻합니다. 로그인·모델 접근·과금·AI 결과 생성은 검사하지 않습니다. 기본 개발 서버와 빌드는 이 명령을 실행하지 않으며 CLI 설치 없이도 앱을 사용할 수 있습니다.

## 격리와 수명

- `backend/src/codex/connection.ts`는 연결마다 권한 0700의 임시 루트와 별도 HOME/CODEX_HOME을 만듭니다. 작업 디렉터리도 임시 루트입니다. 저장소 설정·원본·출력·사용자 DB를 열지 않습니다.
- 자식 환경은 HOME, CODEX_HOME, PATH(`/usr/bin:/bin`), TMPDIR만 제공합니다. 개발 세션의 인증·API 키·프록시·NODE_OPTIONS·기본 홈 설정은 상속하지 않습니다. 제품 인증을 이 환경에 추가하는 인터페이스는 아직 없습니다.
- 절대 실행 경로를 `shell: false` 기본값으로 호출합니다. 버전 문자열 검사는 신뢰할 수 없는 실행 파일의 진위를 보증하지 않으므로 운영자가 배포 파일을 관리해야 합니다.
- 한 연결에서 시작은 한 번만 가능합니다. `new → starting → ready → closed`이며 오류·종료 후 재시작·자동 재접속·요청 재전송은 없습니다. 초기화 단계 종료는 업무 취소와 다릅니다.
- 호출자는 반드시 `try/finally`에서 `await connection.close()`를 호출합니다. 시작 중 종료도 대기하고, SIGTERM 뒤 500ms 내 종료되지 않으면 SIGKILL한 뒤 임시 폴더를 삭제합니다. 버전 검사 프로세스는 자체 시간 제한에서 SIGKILL로 끝나며 시작 중 close도 이 정리를 기다립니다. 실패한 시작은 스스로 정리합니다. 준비 후 프로세스가 종료된 경우에도 close로 임시 폴더를 정리해야 합니다.

## 계약과 제한

공식 `codex app-server generate-ts`의 `InitializeParams.ts`, `InitializeCapabilities.ts`, `ClientInfo.ts`, `InitializeResponse.ts`에서 확인한 필수 필드를 `protocol.ts`의 좁은 계약으로 구현했습니다. 전체 생성 스키마나 전체 App Server API를 구현한 것은 아닙니다. 출처는 [동일 버전 공식 문서](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/app-server/README.md)입니다. 실험적 인터페이스이므로 버전 변경 시 실제 CLI 계약 검사와 합성 서버 검사를 다시 수행해야 합니다.

- 초기화 요청 ID는 1이며 응답은 한 번만 받습니다. 알 수 없는 ID·중복 응답·결과/오류 동시 포함·필수 필드 누락을 거부합니다. 추가 응답 필드는 허용합니다.
- UTF-8 JSON Lines를 프레임 전체에서 엄격히 해석합니다. 줄당 64KiB, 연결당 수신/송신 각각 1MiB, 초기화 대기 기본 10초(설정 10~60,000ms)입니다. 초과·송신 역압·잘못된 UTF-8/JSON·통신 끊김은 연결을 닫습니다. 이 한도는 초기화용이며 향후 모델 출력 한도와 별도로 설계해야 합니다.
- 승인 정책이 없으므로 모든 서버 요청은 `-32601 Unsupported client request`로 거부합니다. 명령·파일 변경·인증 요청을 실행하지 않고 요청의 params도 응답에 복사하지 않습니다. 알림은 업무 이벤트로 전달하지 않습니다.
- stdout은 제한된 프로토콜 파싱에만 사용하고 stderr는 저장/출력 없이 비웁니다. 공개 오류는 고정 코드만 포함하며 원격 오류 본문·환경·프롬프트를 붙이지 않습니다. 이 단계에는 원격 프롬프트 입력 API가 없습니다.

## 검사와 후속 작업

`backend/test/codexConnection.test.ts`는 실제 stdio 파이프로 실행한 합성 Node 서버를 사용합니다. 정상 초기화·환경 격리·버전 불일치·UTF-8 조각·잘못된 형식·응답 ID·중복·수신 한도·도구 승인 거부·타임아웃·종료 무시·시작 중 종료·준비 후 종료·정리를 확인합니다. 실제 모델을 호출하지 않습니다.

다음 작업은 서비스 인증·사용량·데이터 처리 정책을 정하고 `thread/start`, `turn/start`, 이벤트/서버 요청 계약을 추가하는 것입니다. thread/turn/job 매핑, 영구 실행 접수·중복 방지, 도구 승인 정책, turn 중단·시간 제한, 산출물 검증, 오피스 연결은 아직 미구현입니다. 현재의 재전송 없음은 프로세스 재시작을 넘는 exactly-once 보장이 아닙니다.
