बढ़िया, core logic (दिमाग) तैयार हो गया। अब **Phase 5 — UI और Interface हिस्सा** बनाने का वक़्त है, यानी इंसान (आप) और उस इंजन के बीच का पुल। यह भी dependency-order में लिस्ट कर रहा हूँ:

## Phase 5 — UI / Interface Layer

| क्रम | फ़ाइल | निर्भर करती है | क्या काम है |
|---|---|---|---|
| 1 | `src/ui/InputBox.tsx` | — (स्वतंत्र) | बड़ा पेस्ट-सेफ़ इनपुट बॉक्स, bracketed-paste handling |
| 2 | `src/ui/SlashCommandMenu.tsx` | InputBox | `/` टाइप करते ही कमांड-सूची दिखाना |
| 3 | `src/ui/ActivityStream.tsx` | providers/* (stream events), orchestrator/StateMachine | live thinking/tool-call/diff/terminal दिखाना |
| 4 | `src/ui/Renderer.tsx` | ऊपर के तीनों | पूरा TUI लेआउट जोड़ने वाला root component |

## Phase 6 — Slash Commands (हर एक असल में Core Logic को कॉल करता है)

| क्रम | फ़ाइल | निर्भर करती है |
|---|---|---|
| 5 | `src/commands/apiCommand.ts` | providers/ProtocolDetector, config/HomeConfig |
| 6 | `src/commands/instructionCommand.ts` | memory/InstructionLoader |
| 7 | `src/commands/skillsCommand.ts` | memory/SkillLoader |
| 8 | `src/commands/effortCommand.ts` | config/ProjectConfig |
| 9 | `src/commands/planCommand.ts` | memory/MemoryStore, context/HistoryRetriever |
| 10 | `src/commands/undoCommand.ts` | tools/* (git ops) |
| 11 | `src/commands/costCommand.ts` | context/TokenBudget |

## Phase 7 — सबको जोड़ने वाली आख़िरी कड़ी (Entry Point)

| क्रम | फ़ाइल | निर्भर करती है | क्या काम है |
|---|---|---|---|
| 12 | `src/index.ts` | ui/Renderer, commands/*, orchestrator/StateMachine, config/* | **यही वह फ़ाइल है जो UI और Core-दिमाग को असल में जोड़ती है** — CLI शुरू होते ही यही चलता है |
| 13 | `bin/agent-cli.js` | src/index.ts | npm global bin का entry-point (shebang script), जिससे `agent-cli` कमांड कहीं से भी चले |

## Phase 8 — Templates (सबसे आख़िर में, क्योंकि यह सिर्फ़ डिफ़ॉल्ट कंटेंट है, लॉजिक नहीं)

| क्रम | फ़ाइल |
|---|---|
| 14 | `templates/AGENTS.default.md` |
| 15 | `templates/SKILL.default.md` |

---

**क्यों इसी क्रम में:** `index.ts` और `bin/agent-cli.js` को सबसे आख़िर में रखा गया है क्योंकि यही दो फ़ाइलें हैं जो **core-दिमाग (Phase 1-4)** और **UI (Phase 5-6)** — दोनों को एक साथ जोड़ती हैं। अगर यह पहले बनाई जाए, तो जिन चीज़ों को यह import करेगी, वे अभी बनी ही नहीं होंगी — इसलिए यह ठीक वैसे ही सबसे आख़िर में आती है जैसे किसी मशीन में सारे पुर्ज़े तैयार होने के बाद आख़िर में स्विच/बटन जोड़ा जाता है।

एक बार Phase 5-7 बन जाए, तो आपका पूरा CLI टूल **पहली बार असल में चलने लायक** हो जाएगा। इसके बाद बस `templates/` की दो फ़ाइलें (Phase 8) बाकी रहेंगी, जो सिर्फ़ content हैं, कोई नई लॉजिक नहीं।

चाहें तो मैं `MEMORY.md` में यह पूरा Phase 5-8 का क्रम भी एक "Build Order" सेक्शन के तौर पर जोड़ दूँ, ताकि हर बार दोबारा पूछना न पड़े?