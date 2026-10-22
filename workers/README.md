# 파일 처리 워커 (Phase 4 이후)

현재 백엔드는 XLSX/CSV 원본 첨부·보관·권한 다운로드를 지원합니다. 이 디렉터리의 워커를 통한 파일 분석·변환은 아직 구현하지 않았습니다. Python·openpyxl·pandas·python-docx·python-pptx 워커는 후속 단계에서 구현합니다.

현재 정량 집계 전용 Node 워커는 `backend/src/summaryWorker.ts`에 있으며 `summaryQueue.ts`가 실행·취소·시간 제한을 관리합니다. 이 폴더의 Python 워커와는 별개입니다. [백그라운드 집계 안내](../docs/BACKGROUND_SUMMARY.md)를 참고하세요.
