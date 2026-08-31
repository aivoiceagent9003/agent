import { useRef, useState } from "react";
import { toast } from "sonner";
import { Trash2, Upload } from "lucide-react";
import { useKnowledge, useAddKnowledge, useDeleteChunk, useClearKnowledge } from "@/lib/data";

export function KnowledgeBase({ tenantId }: { tenantId: string }) {
  const { data: chunks = [] } = useKnowledge(tenantId);
  const addKnowledge = useAddKnowledge(tenantId);
  const deleteChunk = useDeleteChunk(tenantId);
  const clearKnowledge = useClearKnowledge(tenantId);

  const [text, setText] = useState("");
  const busy = addKnowledge.isPending;
  const fileRef = useRef<HTMLInputElement>(null);

  async function addChunks(content: string) {
    if (!content.trim()) return;
    try {
      const res: any = await addKnowledge.mutateAsync(content);
      toast.success(`${res?.chunks_added ?? 0} chunks added`);
      setText("");
    } catch (e: any) {
      toast.error(e.message || "Failed to add chunks");
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const txt = await f.text();
    await addChunks(txt);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function removeChunk(id: string) {
    try {
      await deleteChunk.mutateAsync(id);
      toast.success("Chunk removed");
    } catch (e: any) {
      toast.error(e.message || "Failed to remove chunk");
    }
  }

  async function clearAll() {
    if (!confirm("Delete all knowledge chunks?")) return;
    try {
      await clearKnowledge.mutateAsync();
      toast.success("Knowledge base cleared");
    } catch (e: any) {
      toast.error(e.message || "Failed to clear knowledge base");
    }
  }

  return (
    <div className="grid gap-6">
      <div className="bg-card border border-border rounded-xl p-6 shadow-card grid gap-4">
        <h3 className="font-semibold">Add knowledge</h3>
        <textarea
          rows={5}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste new content here. Split paragraphs by blank lines."
          className="bg-input border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <div className="flex items-center justify-between flex-wrap gap-3">
          <label className="inline-flex items-center gap-2 text-sm border border-border rounded-lg px-3 py-2 cursor-pointer hover:bg-muted">
            <Upload className="w-4 h-4" /> Upload .txt
            <input
              ref={fileRef}
              type="file"
              accept=".txt,text/plain"
              onChange={onFile}
              className="hidden"
            />
          </label>
          <button
            disabled={busy || !text.trim()}
            onClick={() => addChunks(text)}
            className="bg-gradient-primary text-primary-foreground rounded-lg px-4 py-2 text-sm font-medium shadow-glow disabled:opacity-60"
          >
            {busy ? "Adding…" : "Add chunks"}
          </button>
        </div>
      </div>

      <div className="bg-card border border-border rounded-xl p-6 shadow-card">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">{chunks.length} chunks</h3>
          {chunks.length > 0 && (
            <button onClick={clearAll} className="text-sm text-destructive hover:underline">
              Clear all
            </button>
          )}
        </div>
        <div className="mt-4 divide-y divide-border">
          {chunks.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              No knowledge yet — add some above.
            </div>
          ) : (
            chunks.map((c) => (
              <div key={c.id} className="flex items-start gap-3 py-3">
                <p className="flex-1 text-sm">{c.text}</p>
                <button
                  onClick={() => removeChunk(c.id)}
                  className="text-muted-foreground hover:text-destructive p-1"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
