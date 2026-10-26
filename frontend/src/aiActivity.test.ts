import { expect, it } from "vitest";
import { parseAiOffice, parseAiActivity, aiActivityLink, type AiActivityRun, type AiOffice } from "./aiActivity";
import { serverStaff, type ServerOfficeView } from "./serverOffice";
const run: AiActivityRun={runId:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",jobId:"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",jobTitle:"합성 AI 기록",status:"running",mode:"codex",review:null,createdAt:"2026-10-26T00:00:00Z",startedAt:null,finishedAt:null};
const data: AiOffice={executionMode:"ai_records",connectionVerified:false,totals:{latestRuns:1,queued:0,running:1,cancelling:0,syntheticLatest:0,codexLatest:1,completed:0,failed:0,cancelled:0,timedOut:0,interrupted:0,reviewPending:0,approved:0,rejected:0},focus:run,recent:[run]};
const view: ServerOfficeView={accountId:"account",data:null,error:"",verifiedAt:null,connection:"자동 갱신 연결됨",ai:{data,error:"",verifiedAt:null}};
it("AI 기록을 검증하고 출처/정량 집계와 독립적으로 작성가에 투영한다",()=>{
 expect(parseAiOffice(data).focus?.runId).toBe(run.runId);
 expect(serverStaff(view).find(p=>p.id==="writer")?.status).toBe("문서 작성 중");
 const params=new URL(aiActivityLink(run),"https://office.invalid").searchParams;expect(params.get("aiRun")).toBe(run.runId);expect(params.has("file")).toBe(false);
});
it("합성 기록은 실제 작업으로 움직이지 않고 단절/오류에는 AI 상태를 유지하지 않는다",()=>{
 const synthetic={...view,ai:{...view.ai!,data:{...data,focus:{...run,mode:"synthetic" as const},recent:[{...run,mode:"synthetic" as const}],totals:{...data.totals,syntheticLatest:1,codexLatest:0}}}};
 const writer=serverStaff(synthetic).find(p=>p.id==="writer")!;expect(writer.status).toBe("대기 중");expect(writer.target).toEqual(writer.home);expect(writer.displayStatus).toContain("합성");
 for(const v of [{...view,connection:"누락 변경 복구 중"},{...view,ai:{...view.ai!,error:"합성 오류"}}])expect(serverStaff(v).find(p=>p.id==="writer")?.displayStatus).toBe("AI 기록 확인 필요");
});
it("AI 카운터·출처·상태·업무 범위와 잘못된 연결 성공 주장을 거부한다",()=>{
 for(const invalid of [null,{...data,connectionVerified:true},{...data,focus:{...run,mode:["codex"]}},{...data,totals:{...data.totals,approved:1}},{...data,recent:[run,run]}])expect(()=>parseAiOffice(invalid)).toThrow();
 expect(()=>parseAiActivity({active:{queued:0,running:1,cancelling:0},latest:run},run.runId)).toThrow();
});
it("AI 사용자 검토 대기는 팀장에게 표시하지만 캐릭터가 승인하지 않는다",()=>{
 const pending={...data,focus:{...run,status:"completed" as const,review:"pending" as const},recent:[{...run,status:"completed" as const,review:"pending" as const}],totals:{...data.totals,running:0,completed:1,reviewPending:1}};
 expect(serverStaff({...view,ai:{...view.ai!,data:pending}}).find(p=>p.id==="lead")?.displayStatus).toBe("AI 초안 검토 대기 1건");
});
