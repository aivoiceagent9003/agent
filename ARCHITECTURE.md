# Voice Agent — End-to-End Architecture

Multi-tenant multilingual voice agent SaaS. Telephony via **Vobiz**, speech-to-speech
via **Google Gemini Live**, RAG + lookups on **Supabase (Postgres + pgvector)**, and a
**React dashboard** for onboarding, knowledge, calls, and leads.

The active voice engine is chosen by `VOICE_ENGINE`:
- `gemini` (current) → `src/services/gemini-live.js` (Gemini Live, audio-to-audio)
- `realtime` → `src/services/realtime.js` (OpenAI gpt-realtime)
- `pipeline` → `src/services/deepgram.js` (legacy STT→LLM→TTS, rollback)

All three share one interface: `create…Connection(callSid, tenantConfig, sink, streamId, onTranscript, onReady, callerNumber) → { send, finish }`.

---

## 1. System architecture (how everything is wired)

```mermaid
flowchart LR
  P["📞 Caller phone"]

  subgraph TEL["Telephony"]
    V["Vobiz<br/>g711 μ-law 8kHz<br/>bidirectional WebSocket"]
  end

  subgraph BE["Node backend — src/index.js (Express + ws)"]
    ANS["POST /answer<br/>vobizAnswer()"]
    WS["WS /media-stream-vobiz<br/>handleVobizConnection()"]
    ENG["Gemini Live engine<br/>gemini-live.js"]
    LM["LanguageManager<br/>language-manager.js"]
    RAG["RAG retriever<br/>rag.js"]
    LK["Lookups<br/>lookups.js"]
    LEAD["Lead + transcript<br/>leads.js"]
    APIC["Client API<br/>/api/client/*"]
  end

  subgraph GG["Google / OpenAI"]
    GL["Gemini Live API<br/>audio-to-audio + function calling"]
    GC["Gemini flash-lite<br/>language classifier"]
    EMB["OpenAI<br/>text-embedding-3-small"]
  end

  subgraph SB["Supabase"]
    DB[("Postgres + pgvector<br/>tenants, calls, leads,<br/>knowledge_base, documents, lookup_rows")]
    STG[("Storage bucket<br/>knowledge-files")]
  end

  DASH["React dashboard<br/>onboarding · builder · knowledge · calls · leads"]

  P <-->|"voice"| V
  V -->|"webhook"| ANS
  V <-->|"audio frames"| WS
  ANS --> DB
  WS --> ENG
  ENG <-->|"PCM16 audio + tools"| GL
  ENG --> LM --> GC
  ENG --> RAG --> DB
  RAG --> EMB
  ENG --> LK --> DB
  ENG -. "post-call" .-> LEAD --> DB
  DASH -->|"REST"| APIC --> DB
  DASH -->|"file upload"| STG
```

---

## 2. Call lifecycle — pickup to hang-up

```mermaid
sequenceDiagram
  participant C as Caller
  participant Vz as Vobiz
  participant API as Express /answer
  participant WS as Vobiz WS handler
  participant G as Gemini engine
  participant GA as Gemini Live API
  participant DB as Supabase

  C->>Vz: dials business number
  Vz->>API: POST /answer (To, From)
  API->>DB: findTenantByNumber(To)
  API->>DB: insert calls row (status=active)
  API-->>Vz: <Stream> XML (wss URL + callkey)

  Vz->>WS: WS connect, event 'start'
  WS->>DB: resolve tenant by callkey
  WS->>G: createGeminiLiveConnection(...)
  G->>GA: live.connect(model, systemInstruction, tools)
  GA-->>G: onopen
  G->>GA: greeting turn (primary_language)
  GA-->>Vz: greeting audio -> caller

  loop Every turn
    C->>Vz: speech
    Vz->>WS: media frames (μ-law 8k)
    WS->>G: send(audioChunk)
    G->>GA: sendRealtimeInput (PCM16 16k)
    GA-->>G: audio out + transcripts + toolCalls
    G-->>Vz: reply audio (μ-law 8k)
  end

  C->>Vz: hang up
  Vz->>WS: event 'stop'
  WS->>G: finish() (close session)
  WS->>DB: update call (transcript, duration)
  WS->>DB: extractLead -> saveLead
```

---

## 3. Per-turn conversation loop (the core engine)

This is what runs inside `gemini-live.js` on every Gemini message.

```mermaid
flowchart TD
  A["Caller audio frame<br/>μ-law 8kHz (Vobiz)"] --> B["mulawToPcm16<br/>upsample 8k→16k"]
  B --> C["session.sendRealtimeInput()<br/>→ Gemini Live"]
  C --> D{"Gemini serverContent /<br/>toolCall message"}

  D -->|"modelTurn audio"| E["PCM16 24k → downsample 8k<br/>→ pcm16ToMulaw → caller<br/>(log first-audio latency)"]
  D -->|"inputTranscription"| F["userBuf += text<br/>mark lastInputAt"]
  D -->|"outputTranscription"| G["flushUser() then agentBuf += text"]
  D -->|"interrupted"| I["barge-in:<br/>clear caller audio, drop agentBuf"]
  D -->|"turnComplete"| H["flushUser + flushAgent<br/>modelGenerating=false<br/>fire queued language steer"]
  D -->|"toolCall"| J{"which function?"}

  J -->|"search_knowledge"| K["retrieveKnowledge(tenant, query)<br/>RAG: embed → pgvector match → cache"]
  J -->|"lookup tool"| L["runLookup() → http API or table"]
  K --> M["session.sendToolResponse()"]
  L --> M
  M --> D

  F --> FH["handoff keyword? → transferToHuman"]
  G --> N["LanguageManager.ingest(text)<br/>(async, off audio path)"]
  N -->|"returns a language"| O["applySteer():<br/>send now if idle, else queue"]
  O --> H
```

Key safety details:
- **Steering never injected mid-reply** — queued and fired only at `turnComplete` (else the session deadlocks and the call goes silent).
- **First-audio latency** logged as `⏱️ first audio Xms after you stopped speaking`.
- **Reconnect guard** — only reconnects on a genuine mid-call drop (`gotMessage` true), never on an instant setup rejection.

---

## 4. Language decision (LanguageManager state machine)

```mermaid
flowchart TD
  U["Finalized caller utterance"] --> CL["Gemini flash-lite classify →<br/>{language, confidence, explicit_switch, requested_language}"]
  CL --> EX{"explicit_switch?"}
  EX -->|"yes"| SW["switch immediately<br/>languageLocked = true"] --> STEER["Steer model to language"]
  EX -->|"no"| INIT{"initialized?"}
  INIT -->|"no"| FIRST["first meaningful utterance<br/>= conversation language"] --> STEER
  INIT -->|"yes"| SAME{"same as currentLanguage?"}
  SAME -->|"yes / unknown"| STAY["reset pending, no change"]
  SAME -->|"no"| CONF{"confidence ≥ 0.80?"}
  CONF -->|"no"| STAY
  CONF -->|"yes"| STREAK{"2nd consecutive<br/>same new language?"}
  STREAK -->|"no"| PEND["pendingCount++ → keep current"]
  STREAK -->|"yes"| SW2["switch language"] --> STEER
```

Why: callers code-mix ("Mujhe **Kokapet** mein **flat** chahiye" = Hindi). A regex flips
language on every English noun; the classifier reports the **matrix** language, and
hysteresis (2 confident signals) prevents oscillation. Explicit requests bypass hysteresis.

---

## 5. Knowledge ingestion (dashboard → RAG)

```mermaid
flowchart TD
  UP["Dashboard: upload file or paste text<br/>KnowledgeManager.tsx"] --> API["POST /api/client/agent/knowledge[/upload]"]
  API --> EXT["extractTextFromFile()<br/>pdf-parse · mammoth · vision OCR · utf8"]
  EXT --> DOC["createDocument() — documents.js"]
  DOC --> STORE[("Storage: raw file<br/>knowledge-files bucket")]
  DOC --> ING["ingestText() — ingest.js"]
  ING --> CHUNK["chunkText (~500 chars, 100 overlap)"]
  CHUNK --> EMB["embedBatch()<br/>OpenAI text-embedding-3-small"]
  EMB --> KB[("knowledge_base rows<br/>content + embedding + document_id")]
  ING -. "fire-and-forget" .-> KT["extractKeyterms → mergeKeyterms<br/>tenants.config.kb_keyterms<br/>(recognition vocabulary)"]
```

Deleting a document cascades to its `knowledge_base` chunks and removes the Storage file.

---

## 6. Dashboard flows (config + analytics)

```mermaid
flowchart LR
  SU["Signup → tenant + profile row"] --> LOGIN["Login → Supabase JWT"]
  LOGIN --> BUILD["Agent Builder / Onboarding"]

  BUILD -->|"PATCH /api/client/agent"| CFG[("tenants.config (draft)")]
  BUILD -->|"POST /publish"| PUB[("config.status = published")]
  BUILD -->|"POST /test"| TEST["streamAIReply + RAG<br/>(browser test, same pipeline)"]
  BUILD -->|"GET /voices /templates"| META["voices, templates, recommendations"]

  subgraph AN["Analytics (read-only)"]
    OV["Overview"] -->|"/overview"| RPC["tenant_stats +<br/>calls_last_7_days RPC"]
    CALLS["Calls"] -->|"/calls, /calls/:id"| CT[("calls + transcript")]
    LEADS["Leads"] -->|"/leads, /leads/export"| LT[("leads + linked transcript")]
  end
  LOGIN --> AN
```

---

## 7. Data model

```mermaid
erDiagram
  tenants ||--o{ profiles : "has users"
  tenants ||--o{ calls : "receives"
  tenants ||--o{ leads : "generates"
  tenants ||--o{ knowledge_base : "owns chunks"
  tenants ||--o{ documents : "owns files"
  tenants ||--o{ lookup_rows : "owns datasets"
  documents ||--o{ knowledge_base : "chunked into"
  calls ||--o| leads : "produces"

  tenants {
    uuid id
    text name
    text phone_number "number to automate"
    jsonb config "agent persona, voice, primary_language, kb_keyterms, lookups, status"
  }
  calls {
    uuid id
    uuid tenant_id
    text caller_number
    text status "active/completed"
    int duration_seconds
    text transcript "cleaned post-call"
  }
  leads {
    uuid id
    uuid tenant_id
    uuid call_id
    text name
    text intent
    text summary
    text sentiment
    text contact_info
  }
  knowledge_base {
    uuid id
    uuid tenant_id
    uuid document_id
    text content
    vector embedding
  }
```

---

## 8. Post-call processing (zero added live latency)

On `stop` / WS close, `finalize()` runs:
1. Build raw transcript from buffered Agent/Caller turns.
2. `cleanTranscript()` — gpt-4o-mini rewrites garbled caller STT into a readable conversation.
3. Update the `calls` row (status, transcript, duration).
4. `extractLead()` — gpt-4o-mini extracts structured lead JSON → `saveLead()` into `leads`.
5. `clearHistory(callSid)` — free in-memory conversation state.
