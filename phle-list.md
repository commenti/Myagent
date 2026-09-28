यह सोच बिल्कुल सही है — पेशेवर तरीका यही है। पहले **इंजन (brain)** बनता है, बाद में उसके ऊपर "स्टीयरिंग व्हील" (UI/commands) चढ़ता है। इससे AI को शुरुआत में साफ़, कम-उलझा हुआ काम मिलता है, और hallucination कम होता है।

नीचे **dependency-order** में लिस्ट है — यानी जो फ़ाइल किसी पर निर्भर नहीं करती, वह सबसे पहले; जो फ़ाइल बाकी सबको जोड़ती है (असली "दिमाग"), वह सबसे आख़िर में इस core-logic ग्रुप के अंदर।

## Phase 1 — नींव (कोई dependency नहीं)

| क्रम | फ़ाइल | क्यों पहले |
|---|---|---|
| 1 | `src/config/ProjectConfig.ts` | हर दूसरी फ़ाइल `.agent-runtime/` पढ़ने-लिखने के लिए इसी पर निर्भर करेगी |
| 2 | `src/config/HomeConfig.ts` | वैसे ही, पर होम-डायरेक्टरी (`~/.agent-cli/`) के लिए |
| 3 | `src/policy/PathGuard.ts` | कोई भी file-tool इसके बिना सुरक्षित नहीं बन सकता |
| 4 | `src/policy/DangerousCommandList.ts` | सिर्फ़ एक data-list + matcher, स्वतंत्र |
| 5 | `src/providers/AdapterBase.ts` | सिर्फ़ interface — बाकी adapters इसी पर टिकेंगे |
| 6 | `src/providers/ErrorClassifier.ts` | स्वतंत्र, कोई और फ़ाइल इस पर निर्भर नहीं इसके अलावा |
| 7 | `src/providers/CapabilityRegistry.ts` | सिर्फ़ मॉडल-डेटा की रजिस्ट्री, स्वतंत्र |
| 8 | `src/recovery/ErrorFingerprint.ts` | स्वतंत्र लॉजिक — error को पहचान बनाना |

## Phase 2 — इन पर टिकी दूसरी परत

| क्रम | फ़ाइल | निर्भर करती है |
|---|---|---|
| 9 | `src/policy/PermissionManager.ts` | ProjectConfig |
| 10 | `src/providers/OpenAICompatibleAdapter.ts` | AdapterBase, ErrorClassifier |
| 11 | `src/providers/ProtocolDetector.ts` | ऊपर के adapters |
| 12 | `src/tools/FileRead.ts` | PathGuard |
| 13 | `src/tools/FilePatchEdit.ts` | PathGuard, FileRead |
| 14 | `src/tools/FileCreate.ts` / `FileDelete.ts` | PathGuard, PermissionManager |
| 15 | `src/tools/GrepSymbolSearch.ts` | PathGuard |
| 16 | `src/tools/TerminalExec.ts` | PathGuard, DangerousCommandList, PermissionManager |
| 17 | `src/tools/VerifyRunner.ts` | TerminalExec |
| 18 | `src/session/SessionLog.ts` | ProjectConfig |
| 19 | `src/memory/MemoryStore.ts` | ProjectConfig |
| 20 | `src/memory/AgentsMdLoader.ts`, `InstructionLoader.ts`, `SkillLoader.ts` | ProjectConfig / HomeConfig |
| 21 | `src/recovery/FailureLedger.ts` | ErrorFingerprint, ProjectConfig |

## Phase 3 — Context और History (Summary/Retrieval सिस्टम)

| क्रम | फ़ाइल | निर्भर करती है |
|---|---|---|
| 22 | `src/context/RepoMap.ts` | tree-sitter |
| 23 | `src/context/WorkingSet.ts` | RepoMap, FileRead |
| 24 | `src/context/TokenBudget.ts` | CapabilityRegistry |
| 25 | `src/context/Summarizer.ts` | providers/*, SessionLog |
| 26 | `src/context/HistoryRetriever.ts` | SessionLog |
| 27 | `src/context/Compaction.ts` | MemoryStore, Summarizer, TokenBudget |
| 28 | `src/session/HandoverPackage.ts` | MemoryStore, SessionLog |

## Phase 4 — असली "दिमाग" (Orchestrator, सबको जोड़ने वाला)

| क्रम | फ़ाइल | निर्भर करती है |
|---|---|---|
| 29 | `src/orchestrator/Planner.ts` | RepoMap |
| 30 | `src/orchestrator/TaskGraph.ts` | MemoryStore |
| 31 | `src/orchestrator/SubAgentLauncher.ts` | providers/*, HandoverPackage |
| 32 | `src/recovery/EscalationLadder.ts` | FailureLedger, SubAgentLauncher |
| 33 | **`src/orchestrator/StateMachine.ts`** | ऊपर की **लगभग हर फ़ाइल** — यही असली इंजन है, plan→execute→verify→retry पूरा लूप यहीं चलता है |
| 34 | `src/session/ResumeManager.ts` | SessionLog, HandoverPackage |

**यहाँ तक बन जाए तो आपका पूरा "दिमाग" तैयार हो चुका होगा** — बिना किसी UI के भी, आप इसे एक साधारण script/test से चलाकर देख सकते हैं कि क्या यह सही तरीके से plan बनाता है, फ़ाइल पढ़ता-बदलता है, verify करता है, error पर retry करता है।

## इसके बाद (Phase 5 — बाद में, अभी नहीं)

यह सब **core logic नहीं है**, ये सिर्फ़ इंसान और इंजन के बीच का इंटरफ़ेस है — इसे core तैयार होने के बाद बनाना बेहतर रहेगा:

- `src/ui/*` (InputBox, ActivityStream, SlashCommandMenu, Renderer)
- `src/commands/*` (`/api`, `/instruction`, `/skills`, `/effort`, `/plan`, `/undo`, `/cost`)
- `src/index.ts` + `bin/agent-cli.js` (सिर्फ़ ऊपर के इंजन को UI से जोड़ने वाली तार)
- `templates/AGENTS.default.md`, `templates/SKILL.default.md`

**सुझाव:** Phase 1 से 4 तक हर फ़ाइल बनने के बाद, `MEMORY.md` में उसकी एंट्री ✅ करते जाइए — इससे जब आप Phase 4 के आख़िर में पहुँचेंगे (StateMachine.ts), तब तक AI को हर बार साफ़-साफ़ पता रहेगा कि अब तक क्या-क्या असल में बन चुका है, कोई कल्पना (hallucination) नहीं करनी पड़ेगी।