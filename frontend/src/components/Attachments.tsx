import { AlertCircle, Download, File as FileIcon, FileText, ImageIcon, Paperclip, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from "react";
import { api } from "../api/client";
import type { Attachment } from "../api/types";
import { cn, fileSize } from "../lib/format";
import { Spinner } from "./ui";

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 10;

interface Item {
  key: string;
  name: string;
  size: number;
  preview: string | null; // object URL for local image previews
  status: "uploading" | "done" | "error";
  error?: string;
  attachment?: Attachment;
}

/** Uploads files as soon as they're added; the message is sent later with the resulting ids. */
export function useAttachments() {
  const [items, setItems] = useState<Item[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => () => itemsRef.current.forEach((i) => i.preview && URL.revokeObjectURL(i.preview)), []);

  const add = useCallback((files: File[]) => {
    const room = MAX_FILES - itemsRef.current.length;
    for (const original of files.slice(0, Math.max(0, room))) {
      // Pasted screenshots all arrive as "image.png"; give them a distinct name.
      const file = /^image\.(png|jpe?g|gif|webp)$/i.test(original.name)
        ? new File([original], `pasted-${new Date().toISOString().replace(/[:.]/g, "-")}.${original.name.split(".").pop()}`, { type: original.type })
        : original;
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
      const base: Item = { key, name: file.name, size: file.size, preview, status: "uploading" };
      if (file.size > MAX_BYTES) {
        setItems((xs) => [...xs, { ...base, status: "error", error: "Larger than 20 MB" }]);
        continue;
      }
      setItems((xs) => [...xs, base]);
      api.uploadAttachment(file).then(
        (attachment) => setItems((xs) => xs.map((x) => (x.key === key ? { ...x, status: "done", attachment } : x))),
        (e: unknown) => setItems((xs) => xs.map((x) => (x.key === key
          ? { ...x, status: "error", error: e instanceof Error ? e.message : "Upload failed" } : x))),
      );
    }
  }, []);

  const remove = useCallback((key: string) => {
    setItems((xs) => {
      const gone = xs.find((x) => x.key === key);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return xs.filter((x) => x.key !== key);
    });
  }, []);

  const reset = useCallback(() => {
    itemsRef.current.forEach((i) => i.preview && URL.revokeObjectURL(i.preview));
    setItems([]);
  }, []);

  /** Attach pasted files (e.g. screenshots). Returns true if the paste was handled. */
  const onPaste = useCallback((e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (!files.length) return false;
    // Keep normal text pastes; only swallow the event when it's purely files.
    if (!e.clipboardData.getData("text/plain")) e.preventDefault();
    add(files);
    return true;
  }, [add]);

  return {
    items,
    add,
    remove,
    reset,
    onPaste,
    ids: items.flatMap((i) => (i.attachment ? [i.attachment.id] : [])),
    uploading: items.some((i) => i.status === "uploading"),
    hasErrors: items.some((i) => i.status === "error"),
    full: items.length >= MAX_FILES,
  };
}

export type AttachmentsState = ReturnType<typeof useAttachments>;

/** Drop target around a composer. Highlights while files are dragged over it. */
export function DropZone({ state, children, className }: { state: AttachmentsState; children: ReactNode; className?: string }) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes("Files");
  return (
    <div
      className={cn("relative", className)}
      onDragEnter={(e) => { if (hasFiles(e)) { depth.current += 1; setOver(true); } }}
      onDragLeave={() => { depth.current = Math.max(0, depth.current - 1); if (!depth.current) setOver(false); }}
      onDragOver={(e) => { if (hasFiles(e)) e.preventDefault(); }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        state.add(Array.from(e.dataTransfer.files));
      }}
    >
      {children}
      {over && (
        <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-xl border-2 border-dashed border-accent bg-accent-soft/80 text-sm font-medium text-accent">
          <span className="flex items-center gap-2"><Paperclip size={16} /> Drop files to attach</span>
        </div>
      )}
    </div>
  );
}

export function AttachButton({ state }: { state: AttachmentsState }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className="btn-ghost btn-sm" onClick={() => input.current?.click()} disabled={state.full}
        title="Attach files (or paste / drop them)">
        <Paperclip size={15} /> Attach
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          state.add(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
    </>
  );
}

/** Pending attachments in a composer. */
export function AttachmentTray({ state }: { state: AttachmentsState }) {
  if (!state.items.length) return null;
  return (
    <ul className="flex flex-wrap gap-2">
      {state.items.map((i) => (
        <li
          key={i.key}
          className={cn(
            "flex max-w-64 items-center gap-2 rounded-lg border bg-surface-2 py-1.5 pr-1.5 pl-1.5 text-xs",
            i.status === "error" ? "border-danger/60" : "border-border",
          )}
          title={i.error ?? i.name}
        >
          {i.preview
            ? <img src={i.preview} alt="" className="h-9 w-9 shrink-0 rounded object-cover" />
            : <span className="grid h-9 w-9 shrink-0 place-items-center rounded bg-surface-3 text-muted"><FileTypeIcon name={i.name} /></span>}
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{i.name}</div>
            <div className={cn("truncate", i.status === "error" ? "text-danger" : "text-subtle")}>
              {i.status === "error" ? i.error : i.status === "uploading" ? "Uploading…" : fileSize(i.size)}
            </div>
          </div>
          {i.status === "uploading" && <Spinner size={14} />}
          {i.status === "error" && <AlertCircle size={14} className="text-danger" />}
          <button type="button" className="rounded p-1 text-subtle hover:bg-surface-3 hover:text-fg" onClick={() => state.remove(i.key)}
            aria-label={`Remove ${i.name}`}>
            <X size={14} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Attachments on a received/sent message: image thumbnails, then file chips. */
export function MessageAttachments({ attachments }: { attachments: Attachment[] }) {
  if (!attachments.length) return null;
  const images = attachments.filter((a) => a.is_image);
  const files = attachments.filter((a) => !a.is_image);
  return (
    <div className="mt-4 grid gap-3 border-t border-border pt-3">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((a) => (
            <a key={a.id} href={a.url} target="_blank" rel="noreferrer" title={`${a.filename} · ${fileSize(a.size)}`}
              className="group block overflow-hidden rounded-lg border border-border bg-surface-2">
              <img src={a.url} alt={a.filename} loading="lazy" className="h-36 max-w-72 object-cover transition group-hover:opacity-90" />
            </a>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {files.map((a) => (
            <li key={a.id}>
              <a href={a.url} target="_blank" rel="noreferrer"
                className="flex max-w-72 items-center gap-2 rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-xs hover:border-accent">
                <FileTypeIcon name={a.filename} />
                <span className="truncate font-medium">{a.filename}</span>
                <span className="shrink-0 text-subtle">{fileSize(a.size)}</span>
                <Download size={13} className="shrink-0 text-subtle" />
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FileTypeIcon({ name }: { name: string }) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return <ImageIcon size={15} />;
  if (["pdf", "txt", "md", "doc", "docx", "csv", "json"].includes(ext)) return <FileText size={15} />;
  return <FileIcon size={15} />;
}
