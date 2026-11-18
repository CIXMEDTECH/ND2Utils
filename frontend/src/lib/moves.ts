/**
 * Moving files and folders inside the workspace (drag and drop, cut / paste, "Move to…"),
 * with an undo toast.
 */
import { create } from "zustand";
import { t } from "../i18n";
import { useApp } from "../store";
import { moveItems, undoMove, type MoveConflict, type MoveUndo } from "./api";
import { detailMessage } from "./format";

export const DRAG_MIME = "application/x-lucida-items";

export interface MoveSet {
  file_ids: string[];
  folders: string[];
}

/** What is being dragged right now (dragover cannot read the data, only its types). */
let dragging: MoveSet | null = null;

export function startDrag(event: React.DragEvent, items: MoveSet, label: string) {
  dragging = items;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData(DRAG_MIME, JSON.stringify(items));
  event.dataTransfer.setData("text/plain", label);
}

export function endDrag() {
  dragging = null;
}

export function isInternalDrag(event: React.DragEvent): boolean {
  return event.dataTransfer.types.includes(DRAG_MIME);
}

/** Can the dragged items go into `target`? (Not into themselves or their own subfolders.) */
export function canDropInto(target: string): boolean {
  if (!dragging) return true;
  return !dragging.folders.some((f) => target === f || target.startsWith(`${f}/`));
}

export function readDrop(event: React.DragEvent): MoveSet | null {
  try {
    const raw = event.dataTransfer.getData(DRAG_MIME);
    return raw ? (JSON.parse(raw) as MoveSet) : dragging;
  } catch {
    return dragging;
  }
}

/** Selection for an action on `item`: every ticked item if `item` is ticked, else just `item`. */
export function selectionFor(item: { file?: string; folder?: string }): MoveSet {
  const { checked, checkedFolders } = useApp.getState();
  const ticked = (item.file && checked[item.file]) || (item.folder !== undefined && checkedFolders[item.folder]);
  if (ticked) {
    return {
      file_ids: Object.keys(checked).filter((id) => checked[id]),
      folders: Object.keys(checkedFolders).filter((f) => checkedFolders[f]),
    };
  }
  return { file_ids: item.file ? [item.file] : [], folders: item.folder !== undefined && item.folder !== "" ? [item.folder] : [] };
}

export function currentSelection(): MoveSet {
  const { checked, checkedFolders } = useApp.getState();
  return {
    file_ids: Object.keys(checked).filter((id) => checked[id]),
    folders: Object.keys(checkedFolders).filter((f) => checkedFolders[f]),
  };
}

interface MoveToast {
  text: string;
  undo: MoveUndo | null;
  error?: boolean;
  seq: number;
}

export const useMoveToast = create<{ toast: MoveToast | null; dismiss: () => void }>((set) => ({
  toast: null,
  dismiss: () => set({ toast: null }),
}));

let seq = 0;
export function showToast(text: string, undo: MoveUndo | null, error = false) {
  seq += 1;
  useMoveToast.setState({ toast: { text, undo, error, seq } });
}

/** Move `items` into `target`; same-name files are kept side by side unless told otherwise. */
export async function performMove(items: MoveSet, target: string, conflict: MoveConflict = "rename"): Promise<boolean> {
  const app = useApp.getState();
  const lang = app.lang;
  // A folder dropped onto its own parent goes nowhere; drop it from the request.
  const folders = items.folders.filter((f) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "") !== target);
  const fileIds = items.file_ids.filter((id) => app.files.find((f) => f.id === id)?.folder !== target);
  if (!folders.length && !fileIds.length) return false;
  try {
    const result = await moveItems({ file_ids: fileIds, folders, target_folder: target, conflict });
    await app.refreshFiles();
    app.clearSelection();
    app.reveal(target);
    app.setCurrentFolder(target);
    const parts = [`${t(lang, "movedItems")} ${result.moved}`];
    if (result.renamed) parts.push(`${t(lang, "movedRenamed")} ${result.renamed}`);
    if (result.skipped) parts.push(`${t(lang, "movedSkipped")} ${result.skipped}`);
    if (result.replaced) parts.push(`${t(lang, "movedReplaced")} ${result.replaced}`);
    showToast(`${parts.join(" · ")} → /${target}`, result.moved && !result.replaced ? result.undo : null);
    return true;
  } catch (err) {
    showToast(detailMessage(err, lang), null, true);
    return false;
  }
}

export async function undoLastMove(undo: MoveUndo) {
  const app = useApp.getState();
  useMoveToast.getState().dismiss();
  try {
    const result = await undoMove(undo);
    await app.refreshFiles();
    showToast(`${t(app.lang, "moveUndone")} ${result.restored}`, null);
  } catch (err) {
    showToast(detailMessage(err, app.lang), null, true);
  }
}
