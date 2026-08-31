// KnowledgeManager — client-scoped knowledge file manager.
// Upload files, see every uploaded file with its size + chunk count, download the
// original, and delete it (which removes its chunks via the backend cascade).
// Used both in the onboarding wizard and as the standalone dashboard page so the
// client can manage knowledge any time, not just during first-run setup.

import { useRef, useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Upload, FileText, Trash2, Download } from "lucide-react";
import {
  useClientDocuments,
  useDeleteDocument,
  uploadKnowledgeFile,
  getDocumentDownloadUrl,
} from "@/lib/data";

export function KnowledgeManager() {
  const qc = useQueryClient();
  const { data: docs = [] } = useClientDocuments();
  const deleteDocument = useDeleteDocument();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  async function onUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    let total = 0;
    try {
      for (const file of Array.from(files)) {
        try {
          const res = await uploadKnowledgeFile(file);
          total += res.chunks_added;
          toast.success(`${file.name}: ${res.chunks_added} chunks added`);
        } catch (e: any) {
          toast.error(`${file.name}: ${e.message || "upload failed"}`);
        }
      }
      if (total > 0) {
        qc.invalidateQueries({ queryKey: ["client", "documents"] });
        qc.invalidateQueries({ queryKey: ["client", "knowledge"] });
      }
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function removeDoc(id: string, filename: string) {
    if (!confirm(`Delete "${filename}" and its knowledge? This cannot be undone.`)) return;
    try {
      await deleteDocument.mutateAsync(id);
      toast.success("Document deleted");
    } catch (e: any) {
      toast.error(e.message || "Could not delete document");
    }
  }

  async function downloadDoc(id: string) {
    try {
      const url = await getDocumentDownloadUrl(id);
      window.open(url, "_blank");
    } catch (e: any) {
      toast.error(e.message || "No file to download");
    }
  }

  return (
    <div className="bg-card border border-border rounded-xl p-6 shadow-card grid gap-4">
      <label
        className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed border-border rounded-xl py-10 cursor-pointer hover:bg-muted/30 transition ${uploading ? "opacity-60 pointer-events-none" : ""}`}
      >
        <Upload className="w-6 h-6 text-muted-foreground" />
        <span className="text-sm font-medium">
          {uploading ? "Uploading…" : "Click to upload files"}
        </span>
        <span className="text-xs text-muted-foreground">PDF, DOCX, TXT, CSV, or images</span>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept=".pdf,.txt,.md,.csv,.docx,image/*"
          onChange={(e) => onUpload(e.target.files)}
          className="hidden"
        />
      </label>

      <div>
        <div className="text-xs text-muted-foreground uppercase tracking-wider mb-2">
          {docs.length} {docs.length === 1 ? "file" : "files"}
        </div>
        <div className="divide-y divide-border max-h-96 overflow-auto">
          {docs.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">No files yet.</div>
          ) : (
            docs.map((d) => (
              <div key={d.id} className="flex items-center gap-3 py-3">
                <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate">{d.filename}</p>
                  <p className="text-xs text-muted-foreground">
                    {d.chunk_count} {d.chunk_count === 1 ? "chunk" : "chunks"}
                    {d.size_bytes ? ` · ${(d.size_bytes / 1024).toFixed(0)} KB` : ""}
                    {d.status !== "ready" ? ` · ${d.status}` : ""}
                  </p>
                </div>
                {d.source === "upload" && (
                  <button
                    onClick={() => downloadDoc(d.id)}
                    title="Download original file"
                    className="text-muted-foreground hover:text-foreground p-1 shrink-0"
                  >
                    <Download className="w-4 h-4" />
                  </button>
                )}
                <button
                  onClick={() => removeDoc(d.id, d.filename)}
                  title="Delete file and its knowledge"
                  className="text-muted-foreground hover:text-destructive p-1 shrink-0"
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
