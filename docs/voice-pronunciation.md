# Voice pronunciation

The Soniox cascade accepts an optional `tts_pronunciations` object in tenant config.
Keys are exact names from the business catalogue. Values are either a spoken form
for all languages or a map by language (`te`, `hi`, `en`, etc.). For example:

```json
{
  "tts_pronunciations": {
    "Sanjeevani": { "te": "సంజీవని", "hi": "संजीवनी" },
    "HealthShield": "Health Shield"
  }
}
```

Have a speaker familiar with the brand verify each pronunciation by listening.
No tenant-specific overrides are installed automatically. Native-script variants
are selected using the script of the sentence. English-only sentences keep the
original name unless an English or all-language override is supplied.

Overrides affect TTS text only: transcripts, KB queries, and tool arguments keep
the original names. Whole-name matching prevents a short name from changing part
of another name. Compound display names such as `HealthShield` are also separated
into words for speech, and Telugu `andi`/`garu` are rendered in Telugu script.

KB searches never trigger the pipeline's lookup filler. `CASCADE_LOOKUP_FILLER`
defaults to false and enables fillers only for other eligible lookup tools.
Per-round LLM timing separates model response time from retrieval time; total
answer latency still includes endpoint detection, tool rounds, and TTS.
